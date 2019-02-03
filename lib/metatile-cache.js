'use strict';

const LockingCache = require('./lockingcache');
const calculateMetatile = require('./metatile');

// Creates a locking cache that generates tiles. When requesting the same tile
// multiple times, they'll be grouped to one request.
module.exports = function createMetatileCache (source, options) {
    const cacheOptions = {
        timeout: options.ttl,
        deleteOnHit: options.deleteOnHit // purge immediately after callbacks
    };

    return new LockingCache(metatileCacheGenerator(source), cacheOptions);
};

function metatileCacheGenerator (source) {
    return function metatileCacheGeneratorFn (cacheInput) {
        const cache = this;
        const coords = cacheInput.split(',');
        const options = {
            metatile: source._uri.query.metatile,
            tileSize: source._uri.query.tileSize,
            buffer_size: source._uri.query.bufferSize,
            limits: source._uri.query.limits,
            format: coords[0],
            z: +coords[1],
            x: +coords[2],
            y: +coords[3],
            metrics: source._uri.query.metrics,
            variables: source._uri.query.variables || {}
        };

        // Calculate bbox from xyz, respecting metatile settings.
        const metatile = calculateMetatile(options);

        // Set x, y, z based on the metatile boundary
        options.x = metatile.x;
        options.y = metatile.y;
        options.variables.zoom = options.z;

        const cache_keys = metatile.tiles.map((tile) => options.format + ',' + tile.join(','));

        source._renderMetatile(options, metatile, (err, tiles) => {
            if (err) {
                // Push error objects to all entries that were supposed to be generated.
                return cache_keys.forEach((key) => cache.put(key, err));
            }

            // Put all the generated tiles into the locking cache.
            cache_keys.forEach((key) => cache.put(key, null, tiles[key].image, tiles[key].headers, tiles[key].stats));
        });

        return cache_keys;
    };
};
