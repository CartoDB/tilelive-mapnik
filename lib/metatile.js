'use strict';

const LockingCache = require('./lockingcache');

const EARTH_RADIUS = 6378137;
const EARTH_DIAMETER = EARTH_RADIUS * 2;
const EARTH_CIRCUMFERENCE = EARTH_DIAMETER * Math.PI;
const MAX_RES = EARTH_CIRCUMFERENCE / 256;
const ORIGIN_SHIFT = EARTH_CIRCUMFERENCE/2;

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

        const cache_keys = metatile.tiles.map((tile) => {
            return options.format + ',' + tile.join(',');
        });

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

function calculateMetatile (options) {
    const { metatile, tileSize } = options;
    const { z, x, y } = parseCoords(options);
    const total = Math.pow(2, z);
    const resolution = MAX_RES / total;

    // Make sure we don't calculcate a metatile that is larger than the bounds.
    const metaWidth  = Math.min(metatile, total, total - x);
    const metaHeight = Math.min(metatile, total, total - y);

    const tiles = getMetatileCoords({ z, x, y, metaWidth, metaHeight });
    const bbox = getBoundingBox({ z, x, y, resolution, metaWidth, metaHeight });

    return {
        width: metaWidth * tileSize,
        height: metaHeight * tileSize,
        x,
        y,
        tiles,
        bbox
    };
};

// Expose for testing purposes
module.exports.calculateMetatile = calculateMetatile;

function parseCoords (options) {
    const z = +options.z;
    let x = +options.x;
    let y = +options.y;

    // Make sure we start at a metatile boundary.
    x -= x % options.metatile;
    y -= y % options.metatile;

    return { z, x, y };
}

// Generate all tile coordinates that are within the metatile.
function getMetatileCoords ({ z, x, y, metaWidth, metaHeight }) {
    const coords = [];

    for (let dx = 0; dx < metaWidth; dx++) {
        for (let dy = 0; dy < metaHeight; dy++) {
            coords.push([ z, x + dx, y + dy ]);
        }
    }

    return coords;
}

function getBoundingBox ({ z, x, y, resolution, metaWidth, metaHeight }) {
    const minx = (x * 256) * resolution - ORIGIN_SHIFT;
    const miny = -((y + metaHeight) * 256) * resolution + ORIGIN_SHIFT;
    const maxx = ((x + metaWidth) * 256) * resolution - ORIGIN_SHIFT;
    const maxy = -((y * 256) * resolution - ORIGIN_SHIFT);

    return [ minx, miny, maxx, maxy ];
}
