'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');
const mapnik = require('@carto/mapnik');
const normalizeURI = require('./uri');
const createMetatileCache = require('./metatile-cache');
const createMapPool = require('./map-pool');
const areValidCoords = require('./utils/coords');
const timeoutDecorator = require('./utils/timeout-decorator');
const headers = require('./utils/headers');
const mime = require('mime');

mapnik.register_default_input_plugins();

function MapnikSource(uri, callback) {
    this.open = false;

    this._uri = normalizeURI(uri);

    if (this._uri.protocol && this._uri.protocol !== 'mapnik:') {
        return callback(new Error('Only the mapnik protocol is supported'));
    }

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
    if (!this.open) {
        return callback();
    }

    this._metatileCache.clear();

    return this._mapPool.drain()
        .then(() => {
            this._mapPool.clear();
            this.open = false;
            return callback();
        });
};

// Render handler for a given tile request.
MapnikSource.prototype.getTile = function (z, x, y, callback) {
    const format = (this._info && this._info.format) || 'png';
    this._renderTile(format, z, x, y, callback);
};

MapnikSource.prototype.getGrid = function (z, x, y, callback) {
    const format = 'utf';
    this._renderTile('utf', z, x, y, callback);
};

MapnikSource.prototype._renderTile = function (format, z, x, y, callback) {
    z = +z;
    x = +x;
    y = +y;

    try {
        areValidCoords({ z, x, y });
    } catch (err) {
        return callback(err);
    }

    const key = [format, z, x, y].join(',');

    this._metatileCache.get(key, callback);
};

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
                    if (!map.parameters.interactivity_layer || !map.parameters.interactivity_fields) {
                        return callback(new Error('Tileset has no interactivity'));
                    }

                    options.layer = map.parameters.interactivity_layer;
                    options.fields = map.parameters.interactivity_fields.split(',');
                    options.resolution = this._uri.query.resolution;
                }

                const renderStartTime = Date.now();

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

    Promise.all(metatile.tiles.map((coords) => {
        return new Promise((resolve, reject) => {
            const key = [ options.format, coords[0], coords[1], coords[2] ].join(',');
            const encodeStartTime = Date.now();
            const x = (coords[1] - metatile.x) * options.tileSize;
            const y = (coords[2] - metatile.y) * options.tileSize;

            try {
                const view = image.view(x, y, options.tileSize, options.tileSize);

                const params = options.format === 'utf' ? [ options ] : [ options.format, options ];
                view.encode(...params, (err, encodedImage) => {
                    if (err) {
                        return reject(err);
                    }

                    resolve({
                        [key]: {
                            image: encodedImage,
                            headers: headers(options.format),
                            stats: Object.assign(stats, { encode: Date.now() - encodeStartTime }, image.get_metrics())
                        }
                    });
                });
            } catch (err) {
                return reject(err);
            }
        });
    }))
    .then((tiles) => callback(null, Object.assign({}, ...tiles)))
    .catch((err) => callback(err));
};

module.exports = MapnikSource;
