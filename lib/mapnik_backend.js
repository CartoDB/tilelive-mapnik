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

// node-mapnik >= 1.3 no long auto-registers plugins
// so we do it here
if (mapnik.register_default_input_plugins) {
    mapnik.register_default_input_plugins();
}

const cache = {};

function MapnikSource(uri, callback) {
    this.uri = normalizeURI(uri);

    if (this.uri.protocol && this.uri.protocol !== 'mapnik:') {
        return callback(new Error('Only the mapnik protocol is supported'));
    }

    if (this.uri.query && this.uri.query.limits && this.uri.query.limits.render > 0) {
        this.getTile = timeoutDecorator(this.getTile.bind(this), this.uri.query.limits.render);
        this.getGrid = timeoutDecorator(this.getGrid.bind(this), this.uri.query.limits.render);
    }

    // cache used to skip encoding of solid images
    this.solidCache = {};

    // by default we use an internal self-caching mechanism but
    // calling applications can pass `internal_cache:false` to disable
    // TODO - consider removing completely once https://github.com/mapbox/tilemill/issues/1893
    // is in place and a solid reference implementation of external caching
    if (this.uri.query.internal_cache === false) {
        this._open(callback);
    } else {
        const key = JSON.stringify(this.uri);

        // https://github.com/mapbox/tilelive-mapnik/issues/47
        if (!cache[key]) {
            cache[key] = this;
            this._self_cache_key = key;
            return this._open(callback);
        }

        const source = cache[key];
        if (source.open) return callback(null, source);

        return this._open((err, source) => {
            if (err) {
                cache[key] = false;
            }
            callback(err, source);
        });
    }
}

MapnikSource.mapnik = mapnik;

// Finds all XML files in the filepath and returns their tilesource URI.
MapnikSource.list = function(filepath, callback) {
    filepath = path.resolve(filepath);
    fs.readdir(filepath, function(err, files) {
        if (err) return callback(err);
        for (var result = {}, i = 0; i < files.length; i++) {
            var name = files[i].match(/^([\w-]+)\.xml$/);
            if (name) result[name[1]] = 'mapnik://' + path.join(filepath, name[0]);
        }
        return callback(null, result);
    });
};

// Finds an XML file with the given ID in the filepath and returns a
// tilesource URI.
MapnikSource.findID = function(filepath, id, callback) {
    filepath = path.resolve(filepath);
    var file = path.join(filepath, id + '.xml');
    fs.stat(file, function(err, stats) {
        if (err) return callback(err);
        else return callback(null, 'mapnik://' + file);
    });
};

MapnikSource.registerProtocols = function (tilelive) {
    tilelive.protocols['mapnik:'] = MapnikSource;
};

MapnikSource.prototype.toJSON = function() {
    return url.format(this.uri);
};

MapnikSource.prototype.close = function(callback) {
    if (cache[this._self_cache_key]) {
        delete cache[this._self_cache_key];
    }

    if (this._tileCache) {
        this._tileCache.clear();
    }

    if (this._pool) {
        this._pool.drain()
            .then(() => {
                this._pool.clear();
                return callback();
            });
    }
};

// Render handler for a given tile request.
MapnikSource.prototype.getTile = function(z, x, y, callback) {
    z = +z; x = +x; y = +y;
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
        return callback(new Error('Invalid coordinates: '+z+'/'+x+'/'+y));
    }

    var max = Math.pow(2, z);
    if (!isFinite(max) || x >= max || x < 0 || y >= max || y < 0) {
        return callback(new Error('Coordinates out of range: '+z+'/'+x+'/'+y));
    }

    var format = (this._info && this._info.format) || 'png';
    var key = [format, z, x, y].join(',');
    this._tileCache.get(key, function(err, tile, headers, stats) {
        if (err) return callback(err);
        callback(null, tile, headers, stats);
    });
};

MapnikSource.prototype.getGrid = function(z, x, y, callback) {
    z = +z; x = +x; y = +y;
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
        return callback(new Error('Invalid coordinates: '+z+'/'+x+'/'+y));
    }

    var max = Math.pow(2, z);
    if (!isFinite(max) || x >= max || x < 0 || y >= max || y < 0) {
        return callback(new Error('Coordinates out of range: '+z+'/'+x+'/'+y));
    } else if (!this._info ||
        !this._info.interactivity_fields ||
        !this._info.interactivity_layer) {
        if (!this._info) {
            return callback(new Error('Tilesource info is missing, cannot rendering interactivity'));
        } else {
            return callback(new Error('Tileset has no interactivity'));
        }
    } else if (!mapnik.supports.grid) {
        return callback(new Error('Mapnik is missing grid support'));
    }

    var key = ['utf', z, x, y].join(',');
    this._tileCache.get(key, function(err, grid, headers, stats) {
        if (err) return callback(err);
        delete grid.solid;
        callback(null, grid, headers, stats);
    });
};

MapnikSource.prototype.getInfo = function(callback) {
    if (this._info) callback(null, this._info);
    else callback(new Error('Info is unavailable'));
};

// Exposes cache for testing purposes
MapnikSource.prototype._cache = cache;

MapnikSource.prototype._open = function(callback) {
    this._stats = {
        render: 0,          // # of times a render is requested from mapnik
        total: 0,           // # of tiles returned from source
        encoded: 0,         // # of tiles encoded
        solid: 0,           // # of tiles isSolid
        solidPainted: 0     // # of tiles isSolid && painted
    };
    this._internal_cache = this.uri.query.internal_cache;
    this._autoLoadFonts = this.uri.query.autoLoadFonts;
    this._base = this.uri.query.base;
    this.uri.query.metatile = +this.uri.query.metatile;
    this.uri.query.resolution = +this.uri.query.resolution;
    this.uri.query.bufferSize = +this.uri.query.bufferSize;
    this.uri.query.tileSize = +this.uri.query.tileSize;

    // Public API to announce how we're metatiling.
    this.metatile = this.uri.query.metatile;
    this.bufferSize = this.uri.query.bufferSize;

    // This defaults to true. To disable font auto-loading
    // Set ?autoLoadFonts=false in the mapnik URL to disable
    if (this._autoLoadFonts) {
        if (mapnik.register_default_fonts) mapnik.register_default_fonts();
        if (mapnik.register_system_fonts) mapnik.register_system_fonts();
    }

    // Initialize this map. This wraps `localize()` and calls `create()`
    // afterwards to actually create a new Mapnik map object.
    this._loadXML((err, xml) => {
        if (err) return callback(err);

        this._createMetatileCache(this.uri.query.metatileCache);
        this._createPool(xml);
        this._populateInfo((err) => {
            if (!err) this.open = true;
            return callback(err, this);
        });
    });
};

// Loads the XML file from the specified path. Calls `callback` when the mapfile
// can be expected to be in `mapfile`. If this isn't successful, `callback` gets
// an error as its first argument.
MapnikSource.prototype._loadXML = function(callback) {
    this._base = path.resolve(path.dirname(this.uri.pathname));

    // This is a string-based map file. Pass it on literally.
    if (this.uri.xml) return callback(null, this.uri.xml);

    // Load XML from file.
    fs.readFile(path.resolve(this.uri.pathname), 'utf8', callback);
};

// Create a new mapnik map object at `this.mapnik`. Requires that the mapfile
// be localized with `this.localize()`. This can be called in repetition because
// it won't recreate `this.mapnik`.
MapnikSource.prototype._createPool = function(xml) {
    if (this._pool) return;

    const factory = {
        // This function should never reject ¯\_(ツ)_/¯
        // see https://github.com/coopernurse/node-pool/issues/175
        // see https://github.com/coopernurse/node-pool/issues/183
        create: () => {
            return new Promise((resolve) => {
                try {
                    const { tileSize, bufferSize } = this.uri.query;
                    const map = new mapnik.Map(tileSize, tileSize);

                    map.bufferSize = bufferSize;

                    const map_opts = {strict: this.uri.strict || false, base: this._base + '/'};
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
        max: this.uri.query.poolSize || cpusNumber,
        maxWaitingClients: this.uri.query.poolMaxWaitingClients ? this.uri.query.poolMaxWaitingClients : 32
    };

    this._pool = Pool.createPool(factory, options);
};

MapnikSource.prototype._populateInfo = function(callback) {
    var id = path.basename(this.uri.pathname, path.extname(this.uri.pathname));
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
            for (const key in p) info[key] = p[key];
            if (p.bounds) info.bounds = p.bounds.split(',').map(parseFloat);
            if (p.center) info.center = p.center.split(',').map(parseFloat);
            if (p.minzoom) info.minzoom = parseInt(p.minzoom, 10);
            if (p.maxzoom) info.maxzoom = parseInt(p.maxzoom, 10);
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
MapnikSource.prototype._createMetatileCache = function(options) {
    const source = this;
    this._tileCache = new LockingCache(function(cache_input) {
        const cache = this;

        const coords = cache_input.split(',');
        const options = {
            metatile: source.uri.query.metatile,
            tileSize: source.uri.query.tileSize,
            buffer_size: source.bufferSize,
            limits: source.uri.query.limits,
            format: coords[0],
            z: +coords[1],
            x: +coords[2],
            y: +coords[3],
            metrics: source.uri.query.metrics,
            variables: source.uri.query.variables || {}
        };

        // Calculate bbox from xyz, respecting metatile settings.
        const metatile = calculateMetatile(options);

        // Set x, y, z based on the metatile boundary
        options.x = metatile.x;
        options.y = metatile.y;
        options.variables.zoom = options.z;

        const cache_keys = metatile.tiles.map(function(tile) {
            return options.format + ',' + tile.join(',');
        });

        source._renderMetatile(options, metatile, function(err, tiles) {
            if (err) {
                // Push error objects to all entries that were supposed to be generated.
                cache_keys.forEach((key) => cache.put(key, err));
            } else {
                // Put all the generated tiles into the locking cache.
                cache_keys.forEach((key) => cache.put(key, null, tiles[key].image, tiles[key].headers, tiles[key].stats));
            }
        });

        return cache_keys;
    },
    { timeout: options.ttl, deleteOnHit: options.deleteOnHit }); // purge immediately after callbacks
};

// Render png/jpg/tif image or a utf grid and return an encoded buffer
MapnikSource.prototype._renderMetatile = function(options, meta, callback) {
    let image = null;

    // Set default options.
    if (options.format === 'utf') {
        options.layer = this._info.interactivity_layer;
        options.fields = this._info.interactivity_fields;
        options.resolution = this.uri.query.resolution;
        options.headers = { 'Content-Type': 'application/json' };
        image = new mapnik.Grid(meta.width, meta.height);
    } else {
        // NOTE: formats use mapnik syntax like `png8:m=h` or `jpeg80`
        // so we need custom handling for png/jpeg
        if (options.format.indexOf('png') !== -1) {
            options.headers = { 'Content-Type': 'image/png' };
        } else if (options.format.indexOf('jpeg') !== -1 ||
                   options.format.indexOf('jpg') !== -1) {
            options.headers = { 'Content-Type': 'image/jpeg' };
        } else {
            // will default to 'application/octet-stream' if unable to detect
            options.headers = { 'Content-Type': mime.getType(options.format.split(':')[0]) };
        }
        image = new mapnik.Image(meta.width, meta.height);
    }
    options.scale = +this.uri.query.scale;
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
                            sliceMetatile(this, image, options, meta, renderStats, (err, tiles) => {
                                return callback(err, tiles);
                            });
                        } else {
                            renderStats.render = Date.now() - renderStartTime;
                            encodeSingleTile(this, image, options, meta, renderStats, (err, tiles) => {
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

function sliceMetatile(source, source_image, options, meta, stats, callback) {
    const tiles_length = meta.tiles.length;
    if (tiles_length === 0) {
        callback(null, {});
    }

    const tiles = {};
    const err_num = 0;
    let tile_num = 0;

    meta.tiles.forEach(c => {
        const key = [options.format, c[0], c[1], c[2]].join(',');
        const encodeStartTime = Date.now();
        const x = (c[1] - meta.x) * options.tileSize;
        const y = (c[2] - meta.y) * options.tileSize;
        getImage(source, source_image, options, x, y, (err, image) => {
            tile_num++;
            if (err) {
                if (!err_num) return callback(err);
                err_num++;
            } else {
                const stats_tile = Object.assign(
                        stats,
                        { encode: Date.now() - encodeStartTime },
                        source_image.get_metrics());
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
}

function encodeSingleTile(source, source_image, options, meta, stats, callback) {
    var tiles = {};
    var key = [options.format, options.z, options.x, options.y].join(',');
    var encodeStartTime = Date.now();
    getImage(source, source_image, options, 0, 0, function(err, image) {
        if (err) return callback(err);
        stats.encode = Date.now() - encodeStartTime;
        stats = Object.assign(stats, source_image.get_metrics());
        tiles[key] = { image: image, headers: options.headers, stats: stats };
        callback(null, tiles);
    });
}

function getImage(source, image, options, x, y, callback) {
    var view = image.view(x, y, options.tileSize, options.tileSize);
    view.isSolid(function(err, solid, pixel) {
        if (err) return callback(err);
        var pixel_key = '';
        if (solid) {
            if (options.format === 'utf') {
                // TODO https://github.com/mapbox/tilelive-mapnik/issues/56
                pixel_key = pixel.toString();
            } else {
                // https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Operators/Bitwise_Operators
                var a = (pixel>>>24) & 0xff;
                var r = pixel & 0xff;
                var g = (pixel>>>8) & 0xff;
                var b = (pixel>>>16) & 0xff;
                pixel_key = options.format + r +','+ g + ',' + b + ',' + a;
            }
        }
        // Add stats.
        options.source._stats.total++;
        if (solid !== false) options.source._stats.solid++;
        if (solid !== false && image.painted()) options.source._stats.solidPainted++;
        // If solid and image buffer is cached skip image encoding.
        if (solid && source.solidCache[pixel_key]) return callback(null, source.solidCache[pixel_key]);
        // Note: the second parameter is needed for grid encoding.
        options.source._stats.encoded++;
        try {
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
                        source.solidCache[pixel_key] = buffer;
                    }
                }
                return callback(null, buffer);
            }

            if (options.format === 'utf') {
                view.encode(options, encodeCallback);
            } else {
                view.encode(options.format, options, encodeCallback);
            }
        } catch (err) {
            return callback(err);
        }
    });
}

module.exports = MapnikSource;
