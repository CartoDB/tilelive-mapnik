var fs = require('fs');
var assert = require('assert');
var mapnik_backend = require('..');

describe('Closing behavior ', function() {

    it('should close cleanly 1', function (done) {

        new mapnik_backend({ xml: fs.readFileSync('./test/data/world.xml', 'utf8') }, function (err, source) {
            assert.equal(err, undefined);
            assert.equal(source.open, true);
            source.close(function (err) {
                assert.equal(err, undefined);
                assert.equal(source.open, false);
                done();
            });
        });
    });

    it('should close cleanly 2', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/world.xml', 'utf8'), base: './test/data/' }, function(err, source) {
            assert.equal(err, undefined);
            assert.equal(source.open, true);
            source.getTile(0,0,0, function (err) {
                assert.equal(err, undefined);
                assert.equal(source.open, true);
                // now close the source
                source.close(function(err){
                    assert.equal(err, undefined);
                    assert.equal(source.open, false);
                    done();
                });
            });
        });
    });

    it('should throw with invalid usage (close before getTile)', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/world.xml', 'utf8') }, function(err, source) {
            if (err) throw err;
            // now close the source
            // now that the pool is draining further
            // access to the source is invalid and should throw
            source.close(function(err){
                // pool will be draining...
            });
            source.getTile(0,0,0, function(err, info, headers) {
                assert.equal(err.message,'pool is draining and cannot accept work');
                done();
            });
        });
    });

    it('should throw with invalid usage (close after getTile)', function(done) {
        new mapnik_backend({ xml: fs.readFileSync('./test/data/world.xml', 'utf8') }, function(err, source) {
            if (err) throw err;
            source.getTile(0,0,0, function(err, info, headers) {
                // now close the source
                source.close(function(err){
                    // pool will be draining...
                });
                // now that the pool is draining further
                // access to the source is invalid and should throw
                source.getTile(0,0,0, function(err, info, headers) {
                    assert.equal(err.message,'pool is draining and cannot accept work');
                    done();
                });
            });
        });
    });

});
