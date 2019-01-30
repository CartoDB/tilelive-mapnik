'use strict';

const EARTH_RADIUS = 6378137;
const EARTH_DIAMETER = EARTH_RADIUS * 2;
const EARTH_CIRCUMFERENCE = EARTH_DIAMETER * Math.PI;
const MAX_RES = EARTH_CIRCUMFERENCE / 256;
const ORIGIN_SHIFT = EARTH_CIRCUMFERENCE/2;

module.exports = function calculateMetatile (options) {
    const z = +options.z;
    let x = +options.x;
    let y = +options.y;
    const total = Math.pow(2, z);
    const resolution = MAX_RES / total;

    // Make sure we start at a metatile boundary.
    x -= x % options.metatile;
    y -= y % options.metatile;

    // Make sure we don't calculcate a metatile that is larger than the bounds.
    const metaWidth  = Math.min(options.metatile, total, total - x);
    const metaHeight = Math.min(options.metatile, total, total - y);

    // Generate all tile coordinates that are within the metatile.
    const tiles = [];
    for (let dx = 0; dx < metaWidth; dx++) {
        for (let dy = 0; dy < metaHeight; dy++) {
            tiles.push([ z, x + dx, y + dy ]);
        }
    }

    const minx = (x * 256) * resolution - ORIGIN_SHIFT;
    const miny = -((y + metaHeight) * 256) * resolution + ORIGIN_SHIFT;
    const maxx = ((x + metaWidth) * 256) * resolution - ORIGIN_SHIFT;
    const maxy = -((y * 256) * resolution - ORIGIN_SHIFT);

    return {
        width: metaWidth * options.tileSize,
        height: metaHeight * options.tileSize,
        x: x,
        y: y,
        tiles: tiles,
        bbox: [ minx, miny, maxx, maxy ]
    };
}
