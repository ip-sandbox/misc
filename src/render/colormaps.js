/* カラーマップ。256 段の LUT を制御点から線形補間して作る。SPEC.md §9.3 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var ANCHORS = {
    viridis: [
      [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
      [31, 158, 137], [53, 183, 121], [109, 205, 89], [253, 231, 37]
    ],
    inferno: [
      [0, 0, 4], [22, 11, 57], [66, 10, 104], [106, 23, 110], [147, 38, 103],
      [188, 55, 84], [229, 92, 48], [248, 148, 65], [252, 255, 164]
    ],
    hot: [[0, 0, 0], [128, 0, 0], [255, 0, 0], [255, 128, 0], [255, 255, 0], [255, 255, 255]],
    grayscale: [[0, 0, 0], [255, 255, 255]],
    // 発散型: 0 を中央の白に置く（波面表示用）
    coolwarm: [[59, 76, 192], [122, 157, 247], [221, 221, 221], [247, 145, 120], [180, 4, 38]]
  };

  var cache = {};

  function lut(name) {
    if (cache[name]) return cache[name];
    var anchors = ANCHORS[name] || ANCHORS.viridis;
    var out = new Uint8Array(256 * 3);
    var segs = anchors.length - 1;
    for (var i = 0; i < 256; i++) {
      var t = (i / 255) * segs;
      var k = Math.min(Math.floor(t), segs - 1);
      var f = t - k;
      for (var c = 0; c < 3; c++) {
        out[i * 3 + c] = Math.round(anchors[k][c] + (anchors[k + 1][c] - anchors[k][c]) * f);
      }
    }
    cache[name] = out;
    return out;
  }

  ZPV.colormaps = {
    names: Object.keys(ANCHORS),
    lut: lut,
    labels: {
      viridis: 'viridis',
      inferno: 'inferno',
      hot: 'hot',
      grayscale: 'グレースケール',
      coolwarm: 'coolwarm (発散型)'
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
