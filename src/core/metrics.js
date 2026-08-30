/* 評価指標。SPEC.md §5.8。位相の単位は rad。 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  /* マスク内の PV と、振幅二乗で重み付けした RMS。 */
  function wavefrontStats(grid, wf) {
    var n = grid.count;
    if (n === 0) return { pv: 0, rms: 0, mean: 0 };
    var wsum = 0;
    var wwsum = 0;
    var min = Infinity;
    var max = -Infinity;
    var i, a2, v;
    for (i = 0; i < n; i++) {
      v = wf[i];
      a2 = grid.amp[i] * grid.amp[i];
      wsum += a2 * v;
      wwsum += a2;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var mean = wwsum > 0 ? wsum / wwsum : 0;
    var acc = 0;
    for (i = 0; i < n; i++) {
      a2 = grid.amp[i] * grid.amp[i];
      v = wf[i] - mean;
      acc += a2 * v * v;
    }
    return { pv: max - min, rms: wwsum > 0 ? Math.sqrt(acc / wwsum) : 0, mean: mean };
  }

  /* 定義値の Strehl 比: |Σ A e^{iW}|^2 / (Σ A)^2 */
  function strehlDefinition(grid, wf) {
    var sr = 0;
    var si = 0;
    var sa = 0;
    for (var i = 0; i < grid.count; i++) {
      var a = grid.amp[i];
      var w = wf ? wf[i] : 0;
      sr += a * Math.cos(w);
      si += a * Math.sin(w);
      sa += a;
    }
    if (sa <= 0) return 0;
    return (sr * sr + si * si) / (sa * sa);
  }

  /* Maréchal 近似（rad 単位の RMS を使う） */
  function marechal(rmsRad) {
    return Math.exp(-rmsRad * rmsRad);
  }

  /* PSF の放射平均プロファイル。半径の単位は λ/D。 */
  function radialProfile(psf, N, q, centerRow, centerCol, maxRadiusPx) {
    var maxR = Math.min(maxRadiusPx || N / 2, N / 2);
    var nbin = Math.ceil(maxR);
    var sum = new Float64Array(nbin + 1);
    var cnt = new Float64Array(nbin + 1);
    for (var row = 0; row < N; row++) {
      var dy = row - centerRow;
      for (var col = 0; col < N; col++) {
        var dx = col - centerCol;
        var r = Math.sqrt(dx * dx + dy * dy);
        if (r > maxR) continue;
        var b = Math.round(r);
        sum[b] += psf[row * N + col];
        cnt[b] += 1;
      }
    }
    var radiusLD = new Float64Array(nbin + 1);
    var value = new Float64Array(nbin + 1);
    for (var b2 = 0; b2 <= nbin; b2++) {
      radiusLD[b2] = b2 / q;
      value[b2] = cnt[b2] > 0 ? sum[b2] / cnt[b2] : 0;
    }
    return { radiusLD: radiusLD, value: value };
  }

  /* 半値全幅 [λ/D]。放射平均プロファイルを線形補間して求める。 */
  function fwhm(profile) {
    var v = profile.value;
    var r = profile.radiusLD;
    if (v.length === 0 || v[0] <= 0) return NaN;
    var half = v[0] / 2;
    for (var i = 1; i < v.length; i++) {
      if (v[i] <= half) {
        var t = (v[i - 1] - half) / (v[i - 1] - v[i]);
        return 2 * (r[i - 1] + t * (r[i] - r[i - 1]));
      }
    }
    return NaN;
  }

  /* 半径 radiusLD [λ/D] 内のエネルギー比。psf は総和 1 に正規化済みであること。 */
  function encircledEnergy(psf, N, q, centerRow, centerCol, radiusLD) {
    var rpx = radiusLD * q;
    var r2 = rpx * rpx;
    var acc = 0;
    var lo = Math.max(0, Math.floor(centerRow - rpx));
    var hi = Math.min(N - 1, Math.ceil(centerRow + rpx));
    for (var row = lo; row <= hi; row++) {
      var dy = row - centerRow;
      var span = Math.sqrt(Math.max(0, r2 - dy * dy));
      var c0 = Math.max(0, Math.floor(centerCol - span));
      var c1 = Math.min(N - 1, Math.ceil(centerCol + span));
      for (var col = c0; col <= c1; col++) {
        var dx = col - centerCol;
        if (dx * dx + dy * dy <= r2) acc += psf[row * N + col];
      }
    }
    return acc;
  }

  /* 理想 Airy 分布（強度、ピーク 1）。v = pi * r[λ/D] */
  function airy(rLD) {
    if (rLD === 0) return 1;
    var v = Math.PI * rLD;
    return Math.pow((2 * besselJ1(v)) / v, 2);
  }

  /* 1 次ベッセル関数（Abramowitz & Stegun 9.4.4 / 9.4.6 の多項式近似） */
  function besselJ1(x) {
    var ax = Math.abs(x);
    var y, ans1, ans2, ans;
    if (ax < 8) {
      y = x * x;
      ans1 = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 + y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))));
      ans2 = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
      ans = ans1 / ans2;
    } else {
      var z = 8 / ax;
      y = z * z;
      var xx = ax - 2.356194491;
      ans1 = 1.0 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
      ans2 = 0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
      ans = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * ans1 - z * Math.sin(xx) * ans2);
      if (x < 0) ans = -ans;
    }
    return ans;
  }

  ZPV.metrics = {
    wavefrontStats: wavefrontStats,
    strehlDefinition: strehlDefinition,
    marechal: marechal,
    radialProfile: radialProfile,
    fwhm: fwhm,
    encircledEnergy: encircledEnergy,
    airy: airy,
    besselJ1: besselJ1
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
