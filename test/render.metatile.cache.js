const fs = require('fs');
const assert = require('./support/assert');
const MapnikBackend = require('..');
const util = require('util');

describe('Render Metatile Cache Headers ', function() {
    const scenario = [
        { coords : [0, 0, 0], metatileCacheHeader: 'MISS' },

        { coords : [1, 0, 0], metatileCacheHeader: 'MISS' },
        { coords : [1, 0, 1], metatileCacheHeader: 'HIT' },
        { coords : [1, 1, 0], metatileCacheHeader: 'HIT' },
        { coords : [1, 1, 1], metatileCacheHeader: 'HIT' },

        { coords : [2, 0, 0], metatileCacheHeader: 'MISS' },
        { coords : [2, 0, 1], metatileCacheHeader: 'HIT' },
        { coords : [2, 1, 0], metatileCacheHeader: 'HIT' },
        { coords : [2, 1, 1], metatileCacheHeader: 'HIT' },

        { coords : [2, 0, 2], metatileCacheHeader: 'MISS' },
        { coords : [2, 0, 3], metatileCacheHeader: 'HIT' },
        { coords : [2, 1, 2], metatileCacheHeader: 'HIT' },
        { coords : [2, 1, 3], metatileCacheHeader: 'HIT' },

        { coords : [2, 2, 0], metatileCacheHeader: 'MISS' },
        { coords : [2, 2, 1], metatileCacheHeader: 'HIT' },
        { coords : [2, 3, 0], metatileCacheHeader: 'HIT' },
        { coords : [2, 3, 1], metatileCacheHeader: 'HIT' },

        { coords : [2, 2, 2], metatileCacheHeader: 'MISS' },
        { coords : [2, 2, 3], metatileCacheHeader: 'HIT' },
        { coords : [2, 3, 2], metatileCacheHeader: 'HIT' },
        { coords : [2, 3, 3], metatileCacheHeader: 'HIT' }
    ];

    describe('getTile()', function() {
        let source;

        before(function(done) {
            const xml = fs.readFileSync('./test/data/world.xml', 'utf8');
            const uri = {
                protocol: 'mapnik:',
                pathname: './test/data/world.xml',
                query:{
                    metatile: 2
                },
                xml
            };

            new MapnikBackend(uri, (err, _source) => {
                if (err) {
                    return done(err);
                }

                source = _source;
                done();
            });
        });

        scenario.forEach(({ coords, metatileCacheHeader }) => {
            it(`Carto-Metatile-Cache for tile ${coords.join(',')} should be equal to ${metatileCacheHeader}`, function (done) {
                const [ z, x, y ] = coords;
                source.getTile(z, x, y, (err, tile, headers, stats) => {
                    if (err) {
                        return done(err);
                    }

                    assert.equal(headers['Carto-Metatile-Cache'], metatileCacheHeader, `Tile: ${coords.join(',')}; Expected: ${metatileCacheHeader}; Actual: ${headers['Carto-Metatile-Cache']}`);
                    done();
                });
            });
        });
    });
});
