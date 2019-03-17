var fs = require('fs');
var assert = require('./support/assert');
var mapnik_backend = require('..');
var util = require('util');

describe('Handling Errors ', function() {

    it('invalid style', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/invalid_style.xml', 'utf8'), base: './test/data/' }, function (err, source) {
            assert.ok(err);
            // first message is from rapidxml, second is from libxml2
            assert.ok((err.message.search('expected < at line 1') !== -1) || (err.message.search('XML document not') !== -1));
            done();
        });
    });

    // See https://github.com/mapbox/tilelive-mapnik/pull/74
    it('invalid font, strict', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/invalid_font_face.xml', 'utf8'), base: './test/data/', strict: true }, function (err, source) {
            assert.ok(err);
            assert.ok(err.message.search("font face") !== -1, err.message);
            done();
        });
    });

    // See https://github.com/mapbox/tilelive-mapnik/pull/74
    it('invalid font, non-strict (default)', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/invalid_font_face.xml', 'utf8'), base: './test/data/' }, function(err, source) {
            assert.ok(!err, err);
            source.close(done);
        });
    });

    it('missing data', function(done) {
        new mapnik_backend({}, function(err) {
            assert.ok(err);
            assert.equal(err.message, 'No XML provided');
            done();
        });
    });

    it('bad style', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/world_bad.xml', 'utf8'), base: './test/data/' }, function (err, source) {
            assert.ok(err);
            assert.ok((err.message.search('invalid closing tag') !== -1) || (err.message.search('XML document not well formed') !== -1));
            done();
        });
    });

    it('invalid image format', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/test.xml', 'utf8'), base: './test/data/' }, function(err, source) {
            if (err) throw err;
            source._format = 'this is an invalid image format';
            source.getTile(0,0,0, function(err) {
                assert.equal(err.message,'unknown file type: this is an invalid image format');
                source.close(done);
            });
        });
    });

    it('invalid image format 2', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/test.xml', 'utf8'), base: './test/data/' }, function(err, source) {
            if (err) throw err;
            source._format = 'png8:z=20';
            source.getTile(0,0,0, function(err, tile, headers) {
                assert(err.message.match(/invalid compression parameter: 20 \(only -1 through (9|10) are valid\)/), 'error message mismatch: ' + err.message);
                source.close(done);
            });
        });
    });

    ['getTile', 'getGrid'].forEach(function(method) {

        it('coordinates out of range: ' + method, function(done) {
            new mapnik_backend({ xml: fs.readFileSync('./test/data/test.xml', 'utf8'), base: './test/data/' }, function(err, source) {
                if (err) throw err;
                source[method](0, -1, 0, function(err) {
                    assert(err.message.match(/Coordinates out of range/), 'error message mismatch: ' + err.message);
                    source.close(done);
                });
            });
        });

        it('coordinates out of range, not finite: ' + method, function(done) {
            new mapnik_backend({ xml: fs.readFileSync('./test/data/test.xml', 'utf8'), base: './test/data/' }, function(err, source) {
                if (err) throw err;
                source[method](1024, 0, 0, function(err) {
                    assert(err.message.match(/Coordinates out of range/), 'error message mismatch: ' + err.message);
                    source.close(done);
                });
            });
        });
    });

});
