'use strict';

const Pool = require("generic-pool");
const mapnik = require('@carto/mapnik');
const cpusNumber = require('os').cpus().length;

// Create a new mapnik map object at `this.mapnik`. Requires that the mapfile
// be localized with `this.localize()`. This can be called in repetition because
// it won't recreate `this.mapnik`.
module.exports = function createMapPool (source, xml) {
    const factory = {
        create: mapCreateFunctor(source, xml),
        destroy : mapDestoryFunctor()
    };
    const options = {
        max: source._uri.query.poolSize || cpusNumber,
        maxWaitingClients: source._uri.query.poolMaxWaitingClients ? source._uri.query.poolMaxWaitingClients : 32
    };

    return Pool.createPool(factory, options);
};

function mapCreateFunctor (source, xml) {

    // This function should never reject ¯\_(ツ)_/¯
    // see https://github.com/coopernurse/node-pool/issues/175
    // see https://github.com/coopernurse/node-pool/issues/183
    return function mapCreate () {
        return new Promise((resolve) => {
            try {
                const { tileSize, bufferSize } = source._uri.query;
                const map = new mapnik.Map(tileSize, tileSize);

                map.bufferSize = bufferSize;

                const map_opts = {
                    strict: source._uri.strict || false,
                    base: source._uri.query.base + '/'
                };

                map.fromString(xml, map_opts, (err, map) => {
                    if (err) {
                        return resolve(err)
                    }

                    return resolve(map);
                });
            } catch (err) {
                return resolve(err);
            }
        });
    };
}

function mapDestoryFunctor () {
    return function mapDestroy (map) {
        return new Promise((resolve) => {
            // see: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Delete_in_strict_mode
            map = null;

            return resolve();
        });
    };
}
