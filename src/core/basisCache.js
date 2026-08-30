/* Zernike 基底マップの遅延生成・パック格納・LRU キャッシュ。SPEC.md §4.3。
 *
 * AR-1 マスク内画素のみを Float32Array にパックして保持
 * AR-2 係数が非ゼロになった項だけ生成する（遅延生成）
 * AR-3 LRU で上限（既定 128 MB）を守る
 * AR-5 グリッドが変わったら全破棄
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var DEFAULT_LIMIT_BYTES = 128 * 1024 * 1024;

  function BasisCache(limitBytes) {
    this.limitBytes = limitBytes || DEFAULT_LIMIT_BYTES;
    this.map = new Map(); // key -> Float32Array（Map は挿入順を保つので LRU に使える）
    this.bytes = 0;
    this.gridKey = null;
    this.grid = null;
    this.hits = 0;
    this.misses = 0;
  }

  BasisCache.prototype.setGrid = function (grid, gridKey) {
    if (this.gridKey !== gridKey) {
      this.map.clear();
      this.bytes = 0;
      this.gridKey = gridKey;
    }
    this.grid = grid;
  };

  BasisCache.prototype.get = function (n, m) {
    if (!this.grid) throw new Error('グリッドが未設定です');
    var key = n + ':' + m;
    var hit = this.map.get(key);
    if (hit) {
      this.hits++;
      this.map.delete(key); // 末尾に移動して最近使用扱いにする
      this.map.set(key, hit);
      return hit;
    }
    this.misses++;
    var mapData = ZPV.zernike.zernikeMapPacked(n, m, this.grid);
    this.map.set(key, mapData);
    this.bytes += mapData.byteLength;
    this.evict();
    return mapData;
  };

  BasisCache.prototype.evict = function () {
    while (this.bytes > this.limitBytes && this.map.size > 1) {
      var oldest = this.map.keys().next().value;
      var v = this.map.get(oldest);
      this.map.delete(oldest);
      this.bytes -= v.byteLength;
    }
  };

  BasisCache.prototype.stats = function () {
    return { entries: this.map.size, bytes: this.bytes, hits: this.hits, misses: this.misses };
  };

  ZPV.BasisCache = BasisCache;
  ZPV.DEFAULT_BASIS_LIMIT_BYTES = DEFAULT_LIMIT_BYTES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
