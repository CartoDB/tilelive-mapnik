'use strict';

const mapnik = require('@carto/mapnik');
const mime = require('mime');

const MapnikSource = require('./mapnik_backend');

exports['sliceMetatile'] = sliceMetatile;
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

exports['encodeSingleTile'] = encodeSingleTile;
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
        } else if (options.format.indexOf('jpeg') !== -1 ||
                   options.format.indexOf('jpg') !== -1) {
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
                callback(err);
            });
    } catch (err) {
        return callback(err);
    }
};
