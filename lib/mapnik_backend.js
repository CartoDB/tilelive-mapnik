'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');
const mapnik = require('@carto/mapnik');
const Pool = require("generic-pool");
const normalizeURI = require('./uri');
const calculateMetatile = require('./metatile');
const LockingCache = require('./lockingcache');
const timeoutDecorator = require('./utils/timeout-decorator');
const cpusNumber = require('os').cpus().length;
const mime = require('mime');

mapnik.register_default_input_plugins();
mapnik.register_default_fonts();
mapnik.register_system_fonts();

const cache = {};

function MapnikSource(uri, callback) {
    this._uri = normalizeURI(uri);

    this._stats = {
        render: 0,          // # of times a render is requested from mapnik
        total: 0,           // # of tiles returned from source
        encoded: 0,         // # of tiles encoded
        solid: 0,           // # of tiles isSolid
        solidPainted: 0     // # of tiles isSolid && painted
    };

    // Public API to announce how we're metatiling.
    this.metatile = this._uri.query.metatile;
    this.bufferSize = this._uri.query.bufferSize;

    if (this._uri.protocol && this._uri.protocol !== 'mapnik:') {
        return callback(new Error('Only the mapnik protocol is supported'));
    }

    if (this._uri.query && this._uri.query.limits && this._uri.query.limits.render > 0) {
        this.getTile = timeoutDecorator(this.getTile.bind(this), this._uri.query.limits.render);
        this.getGrid = timeoutDecorator(this.getGrid.bind(this), this._uri.query.limits.render);
    }

    // cache used to skip encoding of solid images
    this.solidCache = {};

    this._init(callback);
}

MapnikSource.mapnik = mapnik;

// Finds all XML files in the filepath and returns their tilesource URI.
MapnikSource.list = function (filepath, callback) {
    filepath = path.resolve(filepath);
    fs.readdir(filepath, function (err, files) {
        if (err) {
            return callback(err);
        }

        const result = {};

        for (i = 0; i < files.length; i++) {
            const name = files[i].match(/^([\w-]+)\.xml$/);

            if (name) {
                result[name[1]] = 'mapnik://' + path.join(filepath, name[0]);
            }
        }

        return callback(null, result);
    });
};

// Finds an XML file with the given ID in the filepath and returns a
// tilesource URI.
MapnikSource.findID = function (filepath, id, callback) {
    filepath = path.resolve(filepath);
    const file = path.join(filepath, id + '.xml');

    fs.stat(file, function (err, stats) {
        if (err) {
            return callback(err);
        }

        return callback(null, 'mapnik://' + file);
    });
};

MapnikSource.registerProtocols = function (tilelive) {
    tilelive.protocols['mapnik:'] = MapnikSource;
};

MapnikSource.prototype.toJSON = function () {
    return url.format(this._uri);
};

MapnikSource.prototype.close = function (callback) {
    if (cache[this._self_cache_key]) {
        delete cache[this._self_cache_key];
    }

    if (this._tileCache) {
        this._tileCache.clear();
    }

    if (this._pool) {
        return this._pool.drain()
            .then(() => {
                this._pool.clear();
                return callback();
            });
    }
};

// Render handler for a given tile request.
MapnikSource.prototype.getTile = function (z, x, y, callback) {
    z = +z;
    x = +x;
    y = +y;

    try {
        areValidCoords({ z, x, y });
    } catch (err) {
        return callback(err);
    }

    const format = (this._info && this._info.format) || 'png';
    const key = [format, z, x, y].join(',');
    this._tileCache.get(key, function (err, tile, headers, stats) {
        if (err) {
            return callback(err);
        }

        return callback(null, tile, headers, stats);
    });
};

MapnikSource.prototype.getGrid = function (z, x, y, callback) {
    z = +z;
    x = +x;
    y = +y;

    try {
        areValidCoords({ z, x, y });
    } catch (err) {
        return callback(err);
    }

    if (!this._info) {
        return callback(new Error('Tilesource info is missing, cannot rendering interactivity'));
    }

    if (!this._info.interactivity_fields || !this._info.interactivity_layer) {
        return callback(new Error('Tileset has no interactivity'));
    }

    if (!mapnik.supports.grid) {
        return callback(new Error('Mapnik is missing grid support'));
    }

    const key = ['utf', z, x, y].join(',');
    this._tileCache.get(key, function (err, grid, headers, stats) {
        if (err) {
            return callback(err);
        }

        delete grid.solid;

        return callback(null, grid, headers, stats);
    });
};

function areValidCoords ({ z, x, y }) {
    areCoordsNumbers({ z, x, y });
    areCoordsInRange({ z, x, y });
}

function areCoordsNumbers ({ z, x, y }) {
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
        throw new Error('Invalid coordinates: '+z+'/'+x+'/'+y);
    }
}

function areCoordsInRange ({ z, x, y }) {
    const max = Math.pow(2, z);

    if (!isFinite(max) || x >= max || x < 0 || y >= max || y < 0) {
        throw new Error('Coordinates out of range: '+z+'/'+x+'/'+y);
    }
}

// TODO: change order, folow node style
MapnikSource.prototype.getInfo = function(callback) {
    if (this._info) {
        return callback(null, this._info);
    }

    return callback(new Error('Info is unavailable'));
};

// Exposes cache for testing purposes
MapnikSource.prototype._cache = cache;

MapnikSource.prototype._init = function (callback) {
    // by default we use an internal self-caching mechanism but
    // calling applications can pass `internal_cache:false` to disable
    // TODO - consider removing completely once https://github.com/mapbox/tilemill/issues/1893
    // is in place and a solid reference implementation of external caching
    if (this._uri.query.internal_cache === false) {
        return this._open(callback);
    }

    const key = JSON.stringify(this._uri);

    // https://github.com/mapbox/tilelive-mapnik/issues/47
    if (!cache[key]) {
        cache[key] = this;
        this._self_cache_key = key;

        return this._open(callback);
    }

    const source = cache[key];

    if (source.open) {
        return callback(null, source);
    }

    this._open((err, source) => {
        if (err) {
            cache[key] = false;
        }

        return callback(err, source);
    });
}

MapnikSource.prototype._open = function (callback) {
    // Initialize this map. This wraps `localize()` and calls `create()`
    // afterwards to actually create a new Mapnik map object.
    this._loadXML((err, xml) => {
        if (err) {
            return callback(err);
        }

        this._createMetatileCache(this._uri.query.metatileCache);
        this._createPool(xml);
        this._populateInfo((err) => {
            if (!err) {
                this.open = true;
            }

            return callback(err, this);
        });
    });
};

// Loads the XML file from the specified path. Calls `callback` when the mapfile
// can be expected to be in `mapfile`. If this isn't successful, `callback` gets
// an error as its first argument.
MapnikSource.prototype._loadXML = function (callback) {
    if (this._uri.xml) {
        return callback(null, this._uri.xml);
    }

    fs.readFile(path.resolve(this._uri.pathname), 'utf8', callback);
};

// Create a new mapnik map object at `this.mapnik`. Requires that the mapfile
// be localized with `this.localize()`. This can be called in repetition because
// it won't recreate `this.mapnik`.
MapnikSource.prototype._createPool = function (xml) {
    if (this._pool) {
        return;
    }

    const factory = {
        // This function should never reject ¯\_(ツ)_/¯
        // see https://github.com/coopernurse/node-pool/issues/175
        // see https://github.com/coopernurse/node-pool/issues/183
        create: () => {
            return new Promise((resolve) => {
                try {
                    const { tileSize, bufferSize } = this._uri.query;
                    const map = new mapnik.Map(tileSize, tileSize);

                    map.bufferSize = bufferSize;

                    const map_opts = {
                        strict: this._uri.strict || false,
                        base: this._uri.query.base + '/'
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
        },
        destroy : (map) => {
            return new Promise((resolve) => {
                // see: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Delete_in_strict_mode
                map = null;

                return resolve();
            });
        }
    };

    const options = {
        max: this._uri.query.poolSize || cpusNumber,
        maxWaitingClients: this._uri.query.poolMaxWaitingClients ? this._uri.query.poolMaxWaitingClients : 32
    };

    this._pool = Pool.createPool(factory, options);
};

MapnikSource.prototype._populateInfo = function (callback) {
    const id = path.basename(this._uri.pathname, path.extname(this._uri.pathname));

    this._pool.acquire()
        .then((resource) => {
            if (!(resource instanceof mapnik.Map)) {
                const err = resource;
                this._pool.release(resource)

                throw err;
            }

            const map = resource;
            const info = { id: id, name: id, minzoom: 0, maxzoom: 22, autoscale: true };

            const p = map.parameters;
            for (const key in p) {
                info[key] = p[key];
            }

            if (p.bounds) {
                info.bounds = p.bounds.split(',').map(parseFloat);
            }

            if (p.center) {
                info.center = p.center.split(',').map(parseFloat);
            }

            if (p.minzoom) {
                info.minzoom = parseInt(p.minzoom, 10);
            }

            if (p.maxzoom) {
                info.maxzoom = parseInt(p.maxzoom, 10);
            }

            if (p.interactivity_fields) {
                info.interactivity_fields = p.interactivity_fields.split(',');
            }

            if (!info.bounds || info.bounds.length !== 4) {
                info.bounds = [ -180, -85.05112877980659, 180, 85.05112877980659 ];
            }

            if (!info.center || info.center.length !== 3) {
                info.center = [
                    (info.bounds[2] - info.bounds[0]) / 2 + info.bounds[0],
                    (info.bounds[3] - info.bounds[1]) / 2 + info.bounds[1],
                    2
                ];
            }

            this._info = info;
            this._pool.release(map);

            return callback(null);
        })
        .catch((err) => {
            return callback(err);
        });
};

// Creates a locking cache that generates tiles. When requesting the same tile
// multiple times, they'll be grouped to one request.
MapnikSource.prototype._createMetatileCache = function (options) {
    const self = this;

    function cacheGenerator (cacheInput) {
        const cache = this;
        const coords = cacheInput.split(',');
        const options = {
            metatile: self._uri.query.metatile,
            tileSize: self._uri.query.tileSize,
            buffer_size: self._uri.query.bufferSize,
            limits: self._uri.query.limits,
            format: coords[0],
            z: +coords[1],
            x: +coords[2],
            y: +coords[3],
            metrics: self._uri.query.metrics,
            variables: self._uri.query.variables || {}
        };

        // Calculate bbox from xyz, respecting metatile settings.
        const metatile = calculateMetatile(options);

        // Set x, y, z based on the metatile boundary
        options.x = metatile.x;
        options.y = metatile.y;
        options.variables.zoom = options.z;

        const cache_keys = metatile.tiles.map(function (tile) {
            return options.format + ',' + tile.join(',');
        });

        self._renderMetatile(options, metatile, function (err, tiles) {
            if (err) {
                // Push error objects to all entries that were supposed to be generated.
                return cache_keys.forEach((key) => cache.put(key, err));
            }

            // Put all the generated tiles into the locking cache.
            cache_keys.forEach((key) => cache.put(key, null, tiles[key].image, tiles[key].headers, tiles[key].stats));
        });

        return cache_keys;
    }

    const cacheOptions = {
        timeout: options.ttl,
        deleteOnHit: options.deleteOnHit // purge immediately after callbacks
    };

    this._tileCache = new LockingCache(cacheGenerator, cacheOptions);
};

// Render png/jpg/tif image or a utf grid and return an encoded buffer
MapnikSource.prototype._renderMetatile = function(options, meta, callback) {
    let image = null;

    // Set default options.
    if (options.format === 'utf') {
        options.layer = this._info.interactivity_layer;
        options.fields = this._info.interactivity_fields;
        options.resolution = this._uri.query.resolution;
        options.headers = { 'Content-Type': 'application/json' };

        image = new mapnik.Grid(meta.width, meta.height);
    } else {
        // NOTE: formats use mapnik syntax like `png8:m=h` or `jpeg80`
        // so we need custom handling for png/jpeg
        if (options.format.indexOf('png') !== -1) {
            options.headers = { 'Content-Type': 'image/png' };
        } else if (options.format.indexOf('jpeg') !== -1 || options.format.indexOf('jpg') !== -1) {
            options.headers = { 'Content-Type': 'image/jpeg' };
        } else {
            // will default to 'application/octet-stream' if unable to detect
            options.headers = { 'Content-Type': mime.getType(options.format.split(':')[0]) };
        }

        image = new mapnik.Image(meta.width, meta.height);
    }

    options.scale = +this._uri.query.scale;
    // Add reference to the source allowing debug/stat reporting to be compiled.
    options.source = this;

    // Enable metrics if requested
    image.metrics_enabled = options.metrics || false;

    // acquire can throw if pool is draining
    try {
        this._pool.acquire()
            .then((resource) => {
                if (!(resource instanceof mapnik.Map)) {
                    const err = resource;
                    this._pool.release(resource)

                    throw err;
                }

                const map = resource;
                map.resize(meta.width, meta.height);
                map.extent = meta.bbox;
                try {
                    this._stats.render++;
                    const renderStats = {};
                    const renderStartTime = Date.now();
                    map.render(image, options, (err, image) => {
                        this._pool.release(map);
                        if (err) {
                            return callback(err);
                        }
                        if (meta.tiles.length > 1) {
                            renderStats.render = Math.round((Date.now() - renderStartTime) / meta.tiles.length);
                            this._sliceMetatile(image, options, meta, renderStats, (err, tiles) => {
                                return callback(err, tiles);
                            });
                        } else {
                            renderStats.render = Date.now() - renderStartTime;
                            this._encodeSingleTile(image, options, meta, renderStats, (err, tiles) => {
                                return callback(err, tiles);
                            });
                        }
                    });
                } catch(err) {
                    this._pool.release(map);
                    return callback(err);
                }
            })
            .catch((err) => {
                return callback(err);
            });
    } catch (err) {
        return callback(err);
    }
};

MapnikSource.prototype._sliceMetatile = function (source_image, options, meta, stats, callback) {
    const tiles_length = meta.tiles.length;
    if (tiles_length === 0) {
        callback(null, {});
    }

    // TODO: handle async in a standard way
    const tiles = {};
    const err_num = 0;
    let tile_num = 0;

    meta.tiles.forEach(c => {
        const key = [options.format, c[0], c[1], c[2]].join(',');
        const encodeStartTime = Date.now();
        const x = (c[1] - meta.x) * options.tileSize;
        const y = (c[2] - meta.y) * options.tileSize;

        this._getImage(source_image, options, x, y, (err, image) => {
            tile_num++;
            if (err) {
                if (!err_num) {
                    return callback(err);
                }

                err_num++;
            } else {
                const encodeElapsedTime = Date.now() - encodeStartTime;
                const stats_tile = Object.assign(stats, { encode: encodeElapsedTime }, source_image.get_metrics());
                const tile = {
                    image: image,
                    headers: options.headers,
                    stats: stats_tile
                };

                tiles[key] = tile;

                if (tile_num === tiles_length) {
                    return callback(null, tiles);
                }
            }
        });
    });
};

MapnikSource.prototype._encodeSingleTile = function (source_image, options, meta, stats, callback) {
    const tiles = {};
    const key = [options.format, options.z, options.x, options.y].join(',');
    const encodeStartTime = Date.now();

    this._getImage(source_image, options, 0, 0, function (err, image) {
        if (err) {
            return callback(err);
        }

        stats.encode = Date.now() - encodeStartTime;
        stats = Object.assign(stats, source_image.get_metrics());
        tiles[key] = { image: image, headers: options.headers, stats: stats };

        return callback(null, tiles);
    });
};

MapnikSource.prototype._getImage = function (image, options, x, y, callback) {
    const view = image.view(x, y, options.tileSize, options.tileSize);

    view.isSolid((err, solid, pixel) => {
        if (err) {
            return callback(err);
        }

        let pixel_key = '';
        if (solid) {
            if (options.format === 'utf') {
                // TODO https://github.com/mapbox/tilelive-mapnik/issues/56
                pixel_key = pixel.toString();
            } else {
                // https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Operators/Bitwise_Operators
                const a = (pixel>>>24) & 0xff;
                const r = pixel & 0xff;
                const g = (pixel>>>8) & 0xff;
                const b = (pixel>>>16) & 0xff;
                pixel_key = options.format + r +','+ g + ',' + b + ',' + a;
            }
        }
        // Add stats.
        options.source._stats.total++;
        if (solid !== false) {
            options.source._stats.solid++;
        }

        if (solid !== false && image.painted()) {
            options.source._stats.solidPainted++;
        }

        // If solid and image buffer is cached skip image encoding.
        if (solid && this.solidCache[pixel_key]) {
            return callback(null, this.solidCache[pixel_key]);
        }

        // Note: the second parameter is needed for grid encoding.
        options.source._stats.encoded++;

        try {
            const solidCache = this.solidCache;
            function encodeCallback (err, buffer) {
                if (err) {
                    return callback(err);
                }

                if (solid !== false) {
                    // @TODO for 'utf' this attaches an extra, bogus 'solid' key to
                    // to the grid as it is not a buffer but an actual JS object.
                    // Fix is to propagate a third parameter through callbacks all
                    // the way back to tilelive source #getGrid.
                    buffer.solid = pixel_key;

                    if (options.format !== 'utf') {
                        solidCache[pixel_key] = buffer;
                    }
                }

                return callback(null, buffer);
            }

            if (options.format === 'utf') {
                return view.encode(options, encodeCallback);
            }

            view.encode(options.format, options, encodeCallback);
        } catch (err) {
            return callback(err);
        }
    });
}

module.exports = MapnikSource;
