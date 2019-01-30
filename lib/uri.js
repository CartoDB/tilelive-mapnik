'use strict';

const path = require('path');
const url = require('url');

module.exports = function normalizeURI (uri) {
    if (typeof uri === 'string') {
        uri = url.parse(uri, true);
    }

    if (uri.hostname === '.' || uri.hostname === '..') {
        uri.pathname = uri.hostname + uri.pathname;
        delete uri.hostname;
        delete uri.host;
    }

    if (typeof uri.pathname !== 'undefined') {
        uri.pathname = path.resolve(uri.pathname);
    }

    uri.query = uri.query || {};

    if (typeof uri.query === 'string') {
        uri.query = qs.parse(uri.query);
    }

    // cache self unless explicitly set to false
    if (typeof uri.query.internal_cache === 'undefined') {
        uri.query.internal_cache = true;
    } else {
        uri.query.internal_cache = asBool(uri.query.internal_cache);
    }

    if (!uri.query.base) {
        uri.query.base = '';
    }

    if (!uri.query.metatile) {
        uri.query.metatile = 2;
    }

    if (!uri.query.resolution) {
        uri.query.resolution = 4;
    }

    if (!Number.isFinite(uri.query.bufferSize)) {
        uri.query.bufferSize = 128;
    }

    if (!uri.query.tileSize) {
        uri.query.tileSize = 256;
    }

    if (!uri.query.scale) {
        uri.query.scale = 1;
    }

    // autoload fonts unless explicitly set to false
    if (typeof uri.query.autoLoadFonts === 'undefined') {
        uri.query.autoLoadFonts = true;
    } else {
        uri.query.autoLoadFonts = asBool(uri.query.autoLoadFonts);
    }

    uri.query.limits = uri.query.limits || {};

    if (typeof uri.query.limits.render === 'undefined') {
        uri.query.limits.render = 0;
    }

    uri.query.metatileCache = uri.query.metatileCache || {};

    // Time to live in ms for cached tiles/grids
    // When set to 0 and `deleteOnHit` set to `false` object won't be removed
    // from cache until they are requested
    // When set to > 0 objects will be removed from cache after the number of ms
    uri.query.metatileCache.ttl = uri.query.metatileCache.ttl || 0;

    // Overrides object removal behaviour when ttl>0 by removing objects from
    // from cache even if they had a ttl set
    uri.query.metatileCache.deleteOnHit = uri.query.metatileCache.hasOwnProperty('deleteOnHit') ?
        asBool(uri.query.metatileCache.deleteOnHit) :
        false;

    if (typeof uri.query.metrics === 'undefined')  {
        uri.query.metrics = false;
    } else {
        uri.query.metrics = asBool(uri.query.metrics);
    }

    return uri;
};

function asBool(val) {
    var num = +val;
    return !isNaN(num) ? !!num : !!String(val).toLowerCase().replace(!!0,'');
}
