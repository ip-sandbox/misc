/* 瞳グリッドと瞳マスク。SPEC.md §5.4 / §5.6、規約 R-4。
 *
 * グリッドは参照実装と同じ「端点を含む」格子:
 *     x[i] = -1 + 2i/(N-1),  rho = q * sqrt(x^2 + y^2),  theta = atan2(y, x)
 * したがって瞳直径は (N-1)/q 画素になる（画素中心格子ではない）。
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var DEFAULT_PUPIL = {
    shape: 'circular', // 'circular' | 'rectangular'
    obscurationRatio: 0,
    spider: { count: 0, widthPixels: 2, rotationDeg: 0 },
    apodization: { type: 'none', width: 1 }, // 'none' | 'gaussian'
    rect: { halfWidth: 1, halfHeight: 1 }
  };

  function merge(base, over) {
    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    if (over) {
      for (k in over) {
        if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
          out[k] = merge(base[k] || {}, over[k]);
        } else if (over[k] !== undefined) {
          out[k] = over[k];
        }
      }
    }
    return out;
  }

  /* 入力の検証。異常値で黙って空の結果を返さないようにする（SPEC.md IT-05）。
   * 2 のべき乗が要るのは FFT だけなので、格子生成では要求しない
   * （直交性の検証には q=1, N=513 のような格子を使う）。 */
  function validate(N, q, requirePowerOfTwo) {
    if (typeof N !== 'number' || !isFinite(N) || N !== Math.floor(N) || N < 8 || N > 8192) {
      throw new RangeError('配列サイズ N は 8〜8192 の整数である必要があります: ' + N);
    }
    if (requirePowerOfTwo && (N & (N - 1)) !== 0) {
      throw new RangeError('FFT を使うため配列サイズ N は 2 のべき乗である必要があります: ' + N);
    }
    if (typeof q !== 'number' || !isFinite(q) || q <= 0) {
      throw new RangeError('サンプリング q は正の有限値である必要があります: ' + q);
    }
  }

  /* N x N の格子を作り、マスク内サンプルだけをパックして返す。 */
  function buildGrid(N, q, pupilOpts) {
    validate(N, q, false);
    var opt = merge(DEFAULT_PUPIL, pupilOpts);
    var step = 2 / (N - 1);
    var xs = new Float64Array(N);
    for (var i = 0; i < N; i++) xs[i] = -1 + step * i;

    var eps = opt.obscurationRatio || 0;
    var spider = opt.spider || DEFAULT_PUPIL.spider;
    var spiderHalf = spider.count > 0 ? (spider.widthPixels * step) / 2 : 0;
    var spiderRot = ((spider.rotationDeg || 0) * Math.PI) / 180;
    var apod = opt.apodization || DEFAULT_PUPIL.apodization;
    var rect = opt.rect || DEFAULT_PUPIL.rect;

    // 1 パス目: マスク内画素数と行範囲を数える
    var idx = [];
    var rowMin = N;
    var rowMax = -1;
    var row, col, x, y, r, rr, inside, a, k, ang, dist;

    for (row = 0; row < N; row++) {
      y = xs[row];
      for (col = 0; col < N; col++) {
        x = xs[col];
        rr = Math.sqrt(x * x + y * y);
        r = q * rr;
        if (opt.shape === 'rectangular') {
          inside = q * Math.abs(x) <= rect.halfWidth && q * Math.abs(y) <= rect.halfHeight;
        } else {
          inside = r <= 1 && r >= eps;
        }
        if (inside && spider.count > 0 && spiderHalf > 0) {
          // count は「腕の本数」。各腕は中心から外向きの半直線なので、
          // 直線ではなく半直線（射影が正の側）だけを遮蔽する。
          for (k = 0; k < spider.count; k++) {
            ang = spiderRot + (2 * Math.PI * k) / spider.count;
            var dxk = Math.cos(ang);
            var dyk = Math.sin(ang);
            if (x * dxk + y * dyk < 0) continue; // 反対側は別の腕が担当する
            dist = Math.abs(x * dyk - y * dxk);
            if (dist <= spiderHalf) {
              inside = false;
              break;
            }
          }
        }
        if (inside) {
          idx.push(row * N + col);
          if (row < rowMin) rowMin = row;
          if (row > rowMax) rowMax = row;
        }
      }
    }

    var count = idx.length;
    var grid = {
      N: N,
      q: q,
      pupilDiameterPx: (N - 1) / q,
      count: count,
      index: Int32Array.from(idx),
      rho: new Float64Array(count),
      theta: new Float64Array(count),
      amp: new Float64Array(count),
      rowMin: rowMin < 0 ? 0 : rowMin,
      rowMax: rowMax < 0 ? -1 : rowMax,
      options: opt,
      ampSum: 0,
      ampSqSum: 0
    };

    for (var t = 0; t < count; t++) {
      var lin = grid.index[t];
      row = (lin / N) | 0;
      col = lin - row * N;
      y = xs[row];
      x = xs[col];
      r = q * Math.sqrt(x * x + y * y);
      grid.rho[t] = r;
      grid.theta[t] = Math.atan2(y, x);
      a = 1;
      if (apod.type === 'gaussian') a = Math.exp(-Math.pow(r / (apod.width || 1), 2));
      grid.amp[t] = a;
      grid.ampSum += a;
      grid.ampSqSum += a * a;
    }
    return grid;
  }

  /* グリッドの同一性判定に使うキー。変わったら基底キャッシュを捨てる。 */
  function gridKey(N, q, pupilOpts) {
    return JSON.stringify([N, q, merge(DEFAULT_PUPIL, pupilOpts)]);
  }

  ZPV.pupil = {
    DEFAULT_PUPIL: DEFAULT_PUPIL,
    validate: validate,
    buildGrid: buildGrid,
    gridKey: gridKey,
    merge: merge
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
