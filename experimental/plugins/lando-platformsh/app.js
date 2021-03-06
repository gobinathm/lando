'use strict';

// Modules
const _ = require('lodash');
const fs = require('fs');
const mkdirp = require('mkdirp');
const open = require('./lib/open');
const path = require('path');
const pshconf = require('./lib/config');
const runconf = require('./lib/run');
const utils = require('./lib/utils');
const warnings = require('./lib/warnings');
const PlatformshApiClient = require('platformsh-client').default;
const {getLandoServices} = require('./lib/services');

// Only do this on platformsh recipes
module.exports = (app, lando) => {
  if (_.get(app, 'config.recipe') === 'platformsh') {
    // Reset the ID if we can
    app.id = _.get(app, 'config.config.id', app.id);
    app.log.verbose('identified a platformsh app');
    app.log.debug('reset app id to %s', app.id);
    // Sanitize any platformsh auth
    app.log.alsoSanitize('platformsh-auth');

    // Explicitly add a path for config and make sure it exists
    app.configPath = path.join(app._config.userConfRoot, 'config', app.name);
    if (!fs.existsSync(app.configPath)) mkdirp.sync(app.configPath);
    app.log.debug(`ensured ${app.configPath} exists`);

    // Start by loading in all the platform files we can
    app.platformsh = {config: pshconf.loadConfigFiles(app.root)};
    // And then augment with a few other things
    app.platformsh.domain = `${app.name}.${app._config.domain}`;
    app.platformsh.id = app.id;
    app.platformsh.tokenCache = 'platformsh.tokens';
    app.platformsh.tokens = lando.cache.get(app.platformsh.tokenCache) || [];
    app.log.silly('loaded platform config files', app.platformsh);


    /*
     * This event is intended to parse and interpret the platform config files
     * loaded above into things we can use elsewhere, eg if there is any useful
     * non-trivial data mutation that needs to happen ANYWHERE else in the
     * recipe it probably should happen here
     */
    app.events.on('pre-init', 1, () => {
      // Error if we don't have at least one .platform.app.yml
      if (_.isEmpty(app.platformsh.config.applications)) {
        lando.log.error(`Could not detect any valid .platform.app.yaml files in ${app.root} or its subdirs!`);
      }

    /*
     * Warn user of unsupported services
     * This event exists to
     */
      app.events.on('post-start', 9, () => {
        const allServices = _.map(app.platformsh.services, 'name');
        const supportedServices = _.map(getLandoServices(app.platformsh.services), 'name');
        const unsupportedServices = _.difference(allServices, supportedServices);
        if (!_.isEmpty(unsupportedServices)) {
          app.addWarning(warnings.unsupportedServices(unsupportedServices.join(', ')));
        }
      });

      // Get the platform raw platform config
      const platformConfig = app.platformsh.config;

      // Add the parsed routes config
      app.platformsh.routes = pshconf.parseRoutes(platformConfig.routes, app.platformsh.domain);
      app.log.verbose('parsed platformsh routes');
      app.log.silly('platformsh routes are', app.platformsh.routes);

      // Add the parsed applications config
      // @TODO: the parsing here should happen
      app.platformsh.applications = pshconf.parseApps(platformConfig.applications, platformConfig.applicationFiles);
      app.log.verbose('parsed platformsh applications');
      app.log.silly('platformsh applications are', app.platformsh.applications);

      // Find the closest application
      app.platformsh.closestApp = _.find(app.platformsh.applications, {configFile: pshconf.findClosestApplication()});
      app.platformsh.closestOpenCache = lando.cache.get(`${app.name}.${app.platformsh.closestApp.name}.open.cache`);
      app.log.verbose('the closest platform app is at %s', app.platformsh.closestApp.configFile);
      app.log.verbose('the closest open cache is %s', app.platformsh.closestOpenCache);

      // Add relationships keyed by the service name
      app.platformsh.relationships = pshconf.parseRelationships(
        platformConfig.applications,
        app.platformsh.closestOpenCache
      );
      app.log.verbose('determined platformsh relationships');
      app.log.silly('platformsh relationships are', app.platformsh.relationships);

      // Add the parsed services config
      app.platformsh.services = pshconf.parseServices(platformConfig.services, app.platformsh.relationships);
      app.log.verbose('parsed platformsh services');
      app.log.silly('platformsh services ares', app.platformsh.services);

      // Go through our platform config and generate an array of configuration files for each
      // container so we can inject /run/config.json
      app.platformsh.runConfig = runconf.buildRunConfig(app);
      app.log.verbose('built platformsh config jsons');
      app.log.silly('generated platformsh runtime config is', app.platformsh.runConfig);
    });

    /*
     * This event is intended to make sure we reset the active token and cache when it is passed in
     * via the lando pull or lando push commands
     */
    _.forEach(['pull', 'push'], command => {
      app.events.on(`post-${command}`, (config, answers) => {
        // Only run if answer.auth is set, this allows these commands to all be
        // overriden without causing a failure here
        if (answers.auth) {
          const api = new PlatformshApiClient({api_token: answers.auth});
          return api.getAccountInfo().then(me => {
            // This is a good token, lets update our cache
            const cache = {token: answers.auth, email: me.mail, date: _.toInteger(_.now() / 1000)};
            // Update lando's store of platformsh machine tokens
            const tokens = lando.cache.get(app.platformsh.tokenCache) || [];
            lando.cache.set(app.platformsh.tokenCache, utils.sortTokens(tokens, [cache]), {persist: true});
            // Update app metdata
            const metaData = lando.cache.get(`${app.name}.meta.cache`);
            lando.cache.set(`${app.name}.meta.cache`, _.merge({}, metaData, cache), {persist: true});
          });
        }
      });
    });

    /*
     * This event makes sure we refresh the config we inject into /run/config.json when a first
     * start/rebuild happens
     */
    app.events.on('post-init', () => {
      app.events.on('pre-start', 1, () => {
        if (!lando.cache.get(app.preLockfile)) {
          _.forEach(app.platformsh.runConfig, service => {
            fs.writeFileSync(service.file, JSON.stringify(service.data));
            app.log.debug(`dumped platform config file for ${service.service} to ${service.file}`);
          });
        }
      });
    });

    /*
     * This event makes sure we collect any information that is only available once the service is on
     * like the IP address, we use docker inspect under the hood
     */
    app.events.on('post-init', () => {
      // Get service containers
      const services = utils.getNonApplicationServices(app.config.services);
      app.events.on('post-start', 1, () => lando.Promise.resolve(services)
      .map(service => app.engine.scan({id: `${app.project}_${service.name}_1`}).then(data => {
        // Find the config for this service
        const serviceConfig = _.find(app.config.services, {name: service.name});
        // Add some helpful things to augment our applicaiton OPENER
        // @TODO: is this a good list?
        serviceConfig.platformsh.openMerge = {
          cluster: 'bespin',
          fragment: null,
          hostname: `${app.name}.${serviceConfig.name}.service._.lndo.site`,
          ip: open.getIPAddress(data, `${app.project}_default`),
          rel: serviceConfig.platformsh.hostname,
          service: serviceConfig.name,
          type: [serviceConfig.platformsh.type, serviceConfig.version].join(':'),
        };
      })));
    });

    /*
     * This event handles the platform OPEN lifecycle event. This collects information we get on stdout
     * when we run /etc/platform/commands/open on non-application conatiners, parses it, mixes in other information
     * we got previously like the IP address and then uses that to do the same open command on each application
     * container
     *
     * This is required to expose the application container to the world, eg it starts up nginx/fpm on exposed ports
     * and to set the PLATFORM_RELATIONSHIPS envvar.
     */
    app.events.on('post-init', () => {
      // Get lists of application and services
      const services = utils.getNonApplicationServices(app.config.services);
      const appservers = utils.getApplicationServices(app.config.services);
      app.log.verbose('preparing to OPEN up platformsh containers...');
      app.log.debug('found platformsh services to open', _.map(services, 'name'));
      app.log.debug('found platformsh appservers to open', _.map(appservers, 'name'));

      // Open up services and collect their output
      app.events.on('post-start', 8, () => {
        return lando.Promise.map(services, service => lando.Promise.retry(() => lando.engine.run({
           id: `${app.project}_${service.name}_1`,
           cmd: ['/helpers/psh-open.sh', service.platformsh.opener],
           compose: app.compose,
           project: app.project,
           opts: {
             mode: 'attach',
             services: [service.name],
             user: 'root',
             noTTY: true,
             cstdio: ['ignore', 'pipe', 'ignore'],
             silent: true,
           },
        }))
        // Modify the data a bit so we can inject it better
        .then(data => {
          try {
            // Try to get the data
            const parsedData = open.parseOpenData(data);
            // Merge in other open data
            _.forEach(parsedData, endpoint => _.merge(endpoint, service.platformsh.openMerge));
            // And return
            return [service.name, parsedData];
          // TODO: We probably need a better error message, fallback, etc here
          } catch (e) {
            app.log.error('could not parse json', e, data);
            return;
          }
        }))
        // Inject it into each appserver
        .then(data => {
          // Mutate the data into something easier to use
          const serviceData = _.fromPairs(data);
          app.log.debug('collected open data from platform services', serviceData);

          // Open all the appservers
          return lando.Promise.map(appservers, appserver => {
            const relationships = open.parseRelationships(appserver.platformsh.relationships);
            const openPayload = open.generateOpenPayload(serviceData, relationships);
            const openCache = `${app.name}.${appserver.name}.open.cache`;
            app.log.verbose(`${appserver} has relationship config`, relationships);
            app.log.verbose(`generated open payload for ${appserver.name}`, openPayload);
            lando.cache.set(openCache, openPayload, {persist: true});
            app.log.debug(`cached open payload data to ${openCache}`);

            // OPEN
            return lando.engine.run({
              id: `${app.project}_${appserver.name}_1`,
              cmd: ['/helpers/psh-open.sh', JSON.stringify({relationships: openPayload})],
              compose: app.compose,
              project: app.project,
              opts: {
                hijack: false,
                services: [appserver.name],
                user: 'root',
                cstdio: ['inherit', 'pipe', 'pipe'],
                silent: true,
              },
            });
          });
        });
      });
    });
  }
};
