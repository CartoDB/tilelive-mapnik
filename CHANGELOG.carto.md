# tilelive-mapnik changelog

## 0.6.18-cdb21
2019-XX-XX
- Update @carto/mapnik to [`3.6.2-carto.13`](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto.13/CHANGELOG.carto.md#362-carto13).

## 0.6.18-cdb20
2019-03-19
- Add header to know when a tile comes from cache (metatiling)


## 0.6.18-cdb19
2019-03-19
- Upgrade generic-pool to version 3.6.1
- Removed:
  - `.findID()`
  - `.toJSON()`
  - `.getInfo()`
  - `.list()`
  - `pathname` is no longer supported as input


## 0.6.18-cdb18
* Huge refactor to have under control this module. Tons of work done, it keeps compatibility with the current tilelive interface and removes unnecessary complexity. A list of highlights:
  - Split functionality in different modules to reflect the main pieces of this module.
  - Follow Node.js rules and remove bad practices.
  - Remove duplications, dead code and, redundant checks.
  - Remove unused internals caches (solid and global).
  - Handle parallel tasks with promises.


## 0.6.18-cdb17
* Be able to load maps with custom pool size and max waiting clients
* Update `generic-pool` to `3.5.0`.

## 0.6.18-cdb16
* Make all modules to use strict mode semantics.

## 0.6.18-cdb15
* Update @carto/mapnik to [`3.6.2-carto.11`](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto.11/CHANGELOG.carto.md#362-carto11).
* Dev: Set mocha dependency to `5.2.0`.
* Update `generic-pool` to `2.5.4`.
* Remove `step` and calls to `nextTick`.
* Remove unused `sphericalmercator`.
* Remove EventEmitter inheritance.

## 0.6.18-cdb14
* Set @carto/mapnik to [`3.6.2-carto.10`](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto/CHANGELOG.carto.md#362-carto10)

## 0.6.18-cdb13
* Set @carto/mapnik to [`3.6.2-carto.9`](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto/CHANGELOG.carto.md#362-carto9)

## 0.6.18-cdb12
* Set @carto/mapnik to [`3.6.2-carto.8`](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto/CHANGELOG.carto.md#362-carto8)

## 0.6.18-cdb11
* Add support for render time variables
* Return Mapnik metrics with metatiles

## 0.6.18-cdb10
* Set @carto/mapnik to [`3.6.2-carto.7`](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto/CHANGELOG.carto.md#362-carto7)

## 0.6.18-cdb9
* Set @carto/mapnik to [`3.6.2-carto.6`](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto/CHANGELOG.carto.md#362-carto6)

## 0.6.18-cdb8
* Set @carto/mapnik to `3.6.2-carto.4`, which includes improvements for the cache for raster symbols. See the [changelog](https://github.com/CartoDB/node-mapnik/blob/v3.6.2-carto/CHANGELOG.carto.md#362-carto4)

## 0.6.18-cdb7
* Revert module updates from 0.6.18-cdb6
* Set @carto/mapnik to `3.6.2-carto.2`

## 0.6.18-cdb6

* Remove unused module `sphericalmercator`
* Point CI tags to our forks
* Update step to `1.0.0`
* Update @carto/mapnik to `3.6.2-carto.3`
* Update mime to `2.2.0`
* Update generic-pool to `2.5.4`

## 0.6.18-cdb5

* Enable support to capture mapnik metrics (grid, image)

## 0.6.18-cdb4

* Upgrade mapnik to @carto/mapnik ~3.6.2-carto.0

## 0.6.18-cdb3

* Be able to configure tile timeout.

## 0.6.18-cdb2

* Allow to configure buffer-size to 0

## 0.6.x-cdb

* Support zoom > 30
* Exposes LockingCache configuration to adjust ttl and expire policy
