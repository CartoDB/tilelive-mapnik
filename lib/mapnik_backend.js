'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');
const mapnik = require('@carto/mapnik');
const normalizeURI = require('./uri');
const createMetatileCache = require('./metatile-cache');
const createMapPool = require('./map-pool');
const timeoutDecorator = require('./utils/timeout-decorator');
const mime = require('mime');

mapnik.register_default_input_plugins();

function MapnikSource(uri, callback) {
    this.open = false;

    // cache used to skip encoding of solid images
    this.solidCache = {};

    this._uri = normalizeURI(uri);

    // Public API to announce how we're metatiling.
    this.metatile = this._uri.query.metatile;
    this.bufferSize = this._uri.query.bufferSize;

    if (this._uri.protocol && this._uri.protocol !== 'mapnik:') {
        return callback(new Error('Only the mapnik protocol is supported'));
    }

    this._stats = {
        render: 0,          // # of times a render is requested from mapnik
        total: 0,           // # of tiles returned from source
        encoded: 0,         // # of tiles encoded
        solid: 0,           // # of tiles isSolid
        solidPainted: 0     // # of tiles isSolid && painted
    };

    if (this._uri.query.limits && this._uri.query.limits.render > 0) {
        this.getTile = timeoutDecorator(this.getTile.bind(this), this._uri.query.limits.render);
        this.getGrid = timeoutDecorator(this.getGrid.bind(this), this._uri.query.limits.render);
    }

    this._open(callback);
}

MapnikSource.mapnik = mapnik;

// Finds all XML files in the filepath and returns their tilesource URI.
MapnikSource.list = function (filepath, callback) {
    filepath = path.resolve(filepath);
    fs.readdir(filepath, (err, files) => {
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

    fs.stat(file, (err, stats) => {
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
    if (this._metatileCache) {
        this._metatileCache.clear();
    }

    if (this._mapPool) {
        return this._mapPool.drain()
            .then(() => {
                this._mapPool.clear();
                this.open = false;
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
    this._metatileCache.get(key, (err, tile, headers, stats) => {
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
    this._metatileCache.get(key, (err, grid, headers, stats) => {
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

MapnikSource.prototype.getInfo = function(callback) {
    if (!this._info) {
        return callback(new Error('Info is unavailable'));
    }

    return callback(null, this._info);
};

MapnikSource.prototype._open = function (callback) {
    if (this.open) {
        return callback(null, this);
    }

    this._loadXML((err, xml) => {
        if (err) {
            return callback(err);
        }

        this._metatileCache = createMetatileCache(this, this._uri.query.tileSize, this._uri.query.metatile, this._uri.query.metatileCache);
        this._mapPool = createMapPool(this._uri, xml);

        this._populateInfo((err) => {
            if (err) {
                return callback(err);
            }

            this.open = true;

            return callback(null, this);
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

MapnikSource.prototype._populateInfo = function (callback) {
    const id = path.basename(this._uri.pathname, path.extname(this._uri.pathname));

    this._mapPool.acquire()
        .then((resource) => {
            if (!(resource instanceof mapnik.Map)) {
                const err = resource;
                this._mapPool.release(resource);

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
            this._mapPool.release(map);

            return callback(null);
        })
        .catch((err) => {
            return callback(err);
        });
};

// Render png/jpg/tif image or a utf grid and return an encoded buffer
MapnikSource.prototype._renderMetatile = function (format, z, x, y, metatile, callback) {
    this._mapPool.acquire()
        .then((resource) => {
            if (!(resource instanceof mapnik.Map)) {
                const err = resource;
                this._mapPool.release(resource)

                throw err;
            }

            const map = resource;

            try {
                const options = {
                    tileSize: this._uri.query.tileSize,
                    buffer_size: this._uri.query.bufferSize,
                    format: format,
                    z: z,
                    x: metatile.x,
                    y: metatile.y,
                    metrics: this._uri.query.metrics,
                    variables: this._uri.query.variables || {},
                    scale: this._uri.query.scale
                };

                // Set x, y, z based on the metatile boundary
                options.variables.zoom = options.z;

                // Set default options.
                if (options.format === 'utf') {
                    options.layer = map.parameters.interactivity_layer;
                    options.fields = map.parameters.interactivity_fields.split(',');
                    options.resolution = this._uri.query.resolution;
                }

                const renderStartTime = Date.now();

                this._stats.render++;

                const image = new mapnik[format === 'utf' ? 'Grid' : 'Image'](metatile.width, metatile.height);

                image.metrics_enabled = options.metrics;

                map.resize(metatile.width, metatile.height);
                map.extent = metatile.bbox;

                map.render(image, options, (err, image) => {
                    this._mapPool.release(map);

                    if (err) {
                        return callback(err);
                    }

                    const renderStats = {
                        render: Math.round((Date.now() - renderStartTime) / metatile.tiles.length)
                    };

                    return this._sliceMetatile(image, options, metatile, renderStats, callback);
                });
            } catch(err) {
                this._mapPool.release(map);
                return callback(err);
            }
        })
        .catch((err) => {
            return callback(err);
        });
};

MapnikSource.prototype._sliceMetatile = function (image, options, metatile, stats, callback) {
    if (metatile.tiles.length === 0) {
        return callback(null, {});
    }

    // TODO: handle async in a standard way
    const tiles = {};
    const err_num = 0;
    let tile_num = 0;

    metatile.tiles.forEach((coords) => {
        const key = [ options.format, coords[0], coords[1], coords[2] ].join(',');
        const encodeStartTime = Date.now();
        const x = (coords[1] - metatile.x) * options.tileSize;
        const y = (coords[2] - metatile.y) * options.tileSize;

        this._getImage(image, options, x, y, (err, encodedImage) => {
            tile_num++;
            if (err) {
                if (!err_num) {
                    return callback(err);
                }

                err_num++;

                return;
            }

            tiles[key] = {
                image: encodedImage,
                headers: this._getHeaders(options.format),
                stats: Object.assign(stats, { encode: Date.now() - encodeStartTime }, image.get_metrics())
            };

            if (tile_num === metatile.tiles.length) {
                return callback(null, tiles);
            }
        });
    });
};

MapnikSource.prototype._getHeaders = function (format) {
    const headers = {};

    if (format === 'utf') {
        headers['Content-Type'] = 'application/json';
        return headers;
    }

    // NOTE: formats use mapnik syntax like `png8:m=h` or `jpeg80`
    // so we need custom handling for png/jpeg
    if (format.indexOf('png') !== -1) {
        headers['Content-Type'] = 'image/png';
        return headers;
    }

    if (format.indexOf('jpeg') !== -1 || format.indexOf('jpg') !== -1) {
        headers['Content-Type'] = 'image/jpeg';
        return headers;
    }

    // will default to 'application/octet-stream' if unable to detect
    headers['Content-Type'] = mime.getType(options.format.split(':')[0]);
    return headers;
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
        this._stats.total++;

        if (solid !== false) {
            this._stats.solid++;
        }

        if (solid !== false && image.painted()) {
            this._stats.solidPainted++;
        }

        // If solid and image buffer is cached skip image encoding.
        if (solid && this.solidCache[pixel_key]) {
            return callback(null, this.solidCache[pixel_key]);
        }

        this._stats.encoded++;

        try {
            const params = options.format === 'utf' ? [ options ] : [ options.format, options ];

            view.encode(...params, (err, buffer) => {
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
                        this.solidCache[pixel_key] = buffer;
                    }
                }

                return callback(null, buffer);
            });
        } catch (err) {
            return callback(err);
        }
    });
}

module.exports = MapnikSource;
