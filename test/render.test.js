var fs = require('fs');
var assert = require('./support/assert');
var mapnik_backend = require('..');
var util = require('util');

describe('Render ', function() {

    it('getTile() override format', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/test.xml', 'utf8'), base: './test/data/' }, function(err, source) {
            if (err) throw err;
            assert.equal(source._format,undefined); // so will default to png in getTile
            source._format = 'jpeg:quality=20';
            source.getTile(0,0,0, function(err, tile, headers, stats) {
                assert.ok(stats);
                assert.ok(stats.hasOwnProperty('render'));
                assert.ok(stats.hasOwnProperty('encode'));
                assert.imageEqualsFile(tile, 'test/fixture/tiles/world-jpeg20.jpeg', 0.05, 'jpeg:quality=20', function(err, similarity) {
                    if (err) throw err;
                    assert.deepEqual(headers, {
                        "Content-Type": "image/jpeg"
                    });
                    source.close(function(err){
                        done();
                    });
                });
            });
        });
    });

    it('getTile() renders zoom>30', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/test.xml', 'utf8'), base: './test/data/' }, function(err, source) {
            if (err) throw err;
            source.getTile(31, 0, 0, function(err, tile, headers) {
                assert.imageEqualsFile(tile, 'test/fixture/tiles/zoom-31.png', function(err) {
                    if (err) throw err;
                    assert.deepEqual(headers, {
                        "Content-Type": "image/png"
                    });
                    source.close(function(){
                        done();
                    });
                });
            });
        });
    });

    var tileCoords = [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [1, 1, 0],
        [1, 1, 1],
        [2, 0, 0],
        [2, 0, 1],
        [2, 0, 2],
        [2, 0, 3],
        [2, 1, 0],
        [2, 1, 1],
        [2, 1, 2],
        [2, 1, 3],
        [2, 2, 0],
        [2, 2, 1],
        [2, 2, 2],
        [2, 2, 3],
        [2, 3, 0],
        [2, 3, 1],
        [2, 3, 2],
        [2, 3, 3]
    ];

    var tileCoordsCompletion = {};
    tileCoords.forEach(function(coords) {
        tileCoordsCompletion['tile_' + coords[0] + '_' + coords[1] + '_' + coords[2]] = true;
    });

    describe('getTile() ', function() {
        var source;
        var completion = {};
        before(function(done) {

            new mapnik_backend({ xml: fs.readFileSync('./test/data/world.xml', 'utf8'), base: './test/data/' }, function(err, s) {
                if (err) throw err;
                source = s;
                done();
            });
        })
        it('validates', function(done) {
            var count = 0;
            tileCoords.forEach(function(coords,idx,array) {
                source._format = 'png32';
                source.getTile(coords[0], coords[1], coords[2],
                   function(err, tile, headers) {
                      if (err) throw err;
                      if (tile.solid) {
                        assert.equal(Object.keys(source.solidCache).length, 1);
                      }
                      var key = coords[0] + '_' + coords[1] + '_' + coords[2];
                      assert.imageEqualsFile(tile, 'test/fixture/tiles/transparent_' + key + '.png', function(err, similarity) {
                          completion['tile_' + key] = true;
                          if (err) throw err;
                          assert.deepEqual(headers, {
                              "Content-Type": "image/png"
                          });
                          ++count;
                          if (count == array.length) {
                              assert.deepEqual(completion,tileCoordsCompletion);
                              source.close(function(err){
                                  done();
                              });
                          }
                      });
                });
            });
        });
    });

    describe('getTile() with XML string', function() {
        var source;
        var completion = {};
        before(function(done) {
            new mapnik_backend({
                protocol: 'mapnik:',
                search: '?' + Date.now(), // prevents caching
                xml: fs.readFileSync('./test/data/world.xml', 'utf8'),
                base: './test/data/'
            } , function(err, s) {
                    if (err) throw err;
                    source = s;
                    done();
            });
        })
        it('validates', function(done) {
            var count = 0;
            tileCoords.forEach(function(coords,idx,array) {
                source._format = 'png32';
                source.getTile(coords[0], coords[1], coords[2],
                   function(err, tile, headers) {
                      if (err) throw err;
                      var key = coords[0] + '_' + coords[1] + '_' + coords[2];
                      assert.imageEqualsFile(tile, 'test/fixture/tiles/transparent_' + key + '.png', function(err, similarity) {
                          completion['tile_' + key] = true;
                          if (err) throw err;
                          assert.deepEqual(headers, {
                              "Content-Type": "image/png"
                          });
                          ++count;
                          if (count == array.length) {
                              assert.deepEqual(completion,tileCoordsCompletion);
                              source.close(function(err){
                                  done();
                              });
                          }
                      });
                });
            });
        });
    });

    describe('getTile() with XML string and buffer-size', function() {
        var tileCompletion = {};
        var tiles = [[1, 0, 0], [2, 1, 1]];
        tiles.forEach(function (coords) {
            tileCompletion['tile_buffer_size_' + coords[0] + '_' + coords[1] + '_' + coords[2]] = true;
        });

        var source;
        var completion = {};
        before(function(done) {
            new mapnik_backend({
                protocol: 'mapnik:',
                search: '?' + Date.now(), // prevents caching
                xml: fs.readFileSync('./test/data/world_labels.xml', 'utf8'),
                base: './test/data/',
                query: {
                    bufferSize: 0
                }} , function(err, s) {
                    if (err) throw err;
                    source = s;
                    done();
            });
        })
        it('validates buffer-size', function(done) {
            var count = 0;
            tiles.forEach(function (coords, idx, array) {
                source._format = 'png32';
                source.getTile(coords[0], coords[1], coords[2],
                   function(err, tile, headers) {
                      if (err) throw err;
                      var key = coords[0] + '_' + coords[1] + '_' + coords[2];
                      var filepath = 'test/fixture/tiles/buffer_size_' + key + '.png';
                      var resultImage = new mapnik_backend.mapnik.Image.fromBytesSync(tile);
                      resultImage.save(filepath);
                      assert.imageEqualsFile(tile, filepath, function(err, similarity) {
                          completion['tile_buffer_size_' + key] = true;
                          if (err) throw err;
                          assert.deepEqual(headers, {
                              "Content-Type": "image/png"
                          });
                          ++count;
                          if (count == array.length) {

                              assert.deepEqual(completion,tileCompletion);
                              source.close(function(err){
                                    done(err);
                              });
                          }
                      });
                });
            });
        });
    });

    var TESTCOLOR = [ '#A3D979', '#fffacd', '#082910' ];
    describe('Works with render time variables', function() {
        TESTCOLOR.forEach(function (custom_color) {

            it('Color ' + custom_color, function(done) {
                var uri = {
                    protocol : "mapnik:",
                    xml : fs.readFileSync('./test/data/world_variable.xml', 'utf8'),
                    base: './test/data/',
                    query : {
                        variables : { "customColor" : custom_color }
                    }
                };

                new mapnik_backend(uri, function(err, source) {
                    if (err) throw err;
                    source.getTile(2, 2, 2, function(err, tile, headers) {
                        if (err) throw err;
                        assert.imageEqualsFile(tile, 'test/fixture/tiles/transparent_2_2_2_' + custom_color + '.png', function(err, similarity) {
                            if (err) throw err;
                            assert.deepEqual(headers, {
                                "Content-Type": "image/png"
                            });
                            source.close(done);
                        });
                    });
                })
            });
        });
    });

    it('Works with metatiles', function(done) {
        var uri = {
            protocol : "mapnik:",
            xml : fs.readFileSync('./test/data/world.xml', 'utf8'),
            base: './test/data/',
            metatile: 4,
            query : {
                metrics : true
            }
        };

        new mapnik_backend(uri, function(err, source) {
            if (err) throw err;
            source.getTile(2, 2, 2, function(err, info, headers, stats) {
                assert(!err);
                assert.ok(stats.hasOwnProperty('Mapnik'));
                source.close(done);
            });
        });
    });

});


describe('getTile() metrics', function() {

    it('Gets metrics', function(done) {
        var uri = {
            protocol : "mapnik:",
            xml : fs.readFileSync('./test/data/world.xml', 'utf8'),
            base: './test/data/',
            query : {
                metrics : true
            }
        };

        new mapnik_backend(uri, function(err, source) {
            if (err) throw err;
            source.getTile(0, 0, 0, function(err, info, headers, stats) {
                assert(!err);
                assert.ok(stats.hasOwnProperty('Mapnik'));
                source.close(done);
            });
        });
    });
});
