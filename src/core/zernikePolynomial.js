/* Zernike 多項式。SPEC.md §5.2 / §5.10、規約 R-2 / R-3。
 *
 * 動径多項式の係数は BigInt で厳密に計算する。n = 20 では定義式に
 * 20! = 2.43e18 が現れ、倍精度の整数厳密範囲 2^53 を超えるため。
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var FACT = [1n];
  function factorial(k) {
    for (var i = FACT.length; i <= k; i++) FACT[i] = FACT[i - 1] * BigInt(i);
    return FACT[k];
  }

  /* R_n^|m|(rho) を rho^|m| * P(rho^2) の形に分解したときの P の係数。
   * 返り値 coeffs[t] は rho^(|m| + 2t) の係数（t 昇順）。すべて整数。 */
  var radialCache = new Map();
  function radialCoefficients(n, m) {
    var am = Math.abs(m);
    if (am > n || (n - am) % 2 !== 0) return null; // R は恒等的に 0
    var key = n + ':' + am;
    var hit = radialCache.get(key);
    if (hit) return hit;

    var half = (n - am) / 2;
    var coeffs = new Float64Array(half + 1);
    for (var s = 0; s <= half; s++) {
      var num = factorial(n - s);
      var den = factorial(s) * factorial((n + am) / 2 - s) * factorial(half - s);
      if (num % den !== 0n) {
        throw new Error('Zernike 動径係数が整数になりません: n=' + n + ', m=' + m + ', s=' + s);
      }
      var c = Number(num / den);
      // rho^(n-2s) = rho^(|m| + 2t) なので t = half - s
      coeffs[half - s] = s % 2 === 0 ? c : -c;
    }
    radialCache.set(key, coeffs);
    return coeffs;
  }

  /* 正規化係数（規約 R-2）。n = m = 0 のピストンは 1。 */
  function normFactor(n, m) {
    if (m === 0) return n === 0 ? 1 : Math.sqrt(n + 1);
    return Math.sqrt(2) * Math.sqrt(n + 1);
  }

  /* R_n^|m|(rho) を Horner 法で評価する。 */
  function radial(n, m, rho) {
    var coeffs = radialCoefficients(n, m);
    if (!coeffs) return 0;
    var r2 = rho * rho;
    var acc = coeffs[coeffs.length - 1];
    for (var t = coeffs.length - 2; t >= 0; t--) acc = acc * r2 + coeffs[t];
    var am = Math.abs(m);
    return am === 0 ? acc : acc * Math.pow(rho, am);
  }

  /* 正規化済み Zernike Z_j(rho, theta)（規約 R-2 / R-3）。 */
  function zernike(n, m, rho, theta) {
    if (n === 0 && m === 0) return 1;
    var r = radial(n, m, rho) * normFactor(n, m);
    if (m === 0) return r;
    return m > 0 ? r * Math.cos(m * theta) : r * Math.sin(-m * theta);
  }

  /* グリッドのマスク内サンプルに対して 1 モードを評価する。
   * 既定はメモリ節約のため Float32Array（SPEC.md AR-1）。
   * useFloat64 = true で倍精度の配列を返す（参照 fixture との突き合わせ用）。 */
  function zernikeMapPacked(n, m, grid, useFloat64) {
    var count = grid.count;
    var out = useFloat64 ? new Float64Array(count) : new Float32Array(count);
    var rho = grid.rho;
    var theta = grid.theta;
    if (n === 0 && m === 0) {
      out.fill(1);
      return out;
    }
    var coeffs = radialCoefficients(n, m);
    if (!coeffs) return out; // 恒等的に 0
    var nf = normFactor(n, m);
    var am = Math.abs(m);
    var last = coeffs.length - 1;
    for (var i = 0; i < count; i++) {
      var p = rho[i];
      var r2 = p * p;
      var acc = coeffs[last];
      for (var t = last - 1; t >= 0; t--) acc = acc * r2 + coeffs[t];
      if (am !== 0) acc *= Math.pow(p, am);
      acc *= nf;
      if (m > 0) acc *= Math.cos(m * theta[i]);
      else if (m < 0) acc *= Math.sin(am * theta[i]);
      out[i] = acc;
    }
    return out;
  }

  ZPV.zernike = {
    radialCoefficients: radialCoefficients,
    normFactor: normFactor,
    radial: radial,
    zernike: zernike,
    zernikeMapPacked: zernikeMapPacked
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
