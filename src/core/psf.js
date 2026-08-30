/* 波面 → 瞳関数 → PSF。SPEC.md §5.5 / §5.6 / §5.7、規約 R-5 / R-6。
 *
 *   W  = Σ a_j Z_j            [rad]
 *   P  = A · exp(i·W)
 *   PSF = |FFT2(P)|^2 を総和で正規化
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  /* coeffs: { nollJ: value[rad] } または Map。非ゼロ項だけを走査する（AR-4）。 */
  function nonZeroModes(coeffs, excludePistonTilt) {
    var out = [];
    var arr = [];
    if (coeffs instanceof Map) {
      coeffs.forEach(function (v, k) { arr.push([Number(k), v]); });
    } else {
      Object.keys(coeffs).forEach(function (k) { arr.push([Number(k), coeffs[k]]); });
    }
    for (var i = 0; i < arr.length; i++) {
      var j = arr[i][0];
      var v = arr[i][1];
      if (!v) continue;
      if (excludePistonTilt && j <= 3) continue;
      var nm = ZPV.noll.nollToNM(j);
      out.push({ j: j, n: nm.n, m: nm.m, value: v });
    }
    out.sort(function (a, b) { return a.j - b.j; });
    return out;
  }

  /* マスク内サンプルの波面 [rad] */
  function computeWavefront(grid, cache, coeffs, excludePistonTilt) {
    var modes = nonZeroModes(coeffs, excludePistonTilt);
    var wf = new Float64Array(grid.count);
    for (var k = 0; k < modes.length; k++) {
      var basis = cache.get(modes[k].n, modes[k].m);
      var c = modes[k].value;
      for (var i = 0; i < grid.count; i++) wf[i] += c * basis[i];
    }
    return wf;
  }

  /* 瞳関数を N x N の複素配列に展開して FFT し、|.|^2 を返す（fftshift 前）。 */
  function computeIntensity(grid, wf, scratch) {
    var N = grid.N;
    var size = N * N;
    var re = scratch && scratch.re && scratch.re.length === size ? scratch.re : new Float64Array(size);
    var im = scratch && scratch.im && scratch.im.length === size ? scratch.im : new Float64Array(size);
    re.fill(0);
    im.fill(0);

    var idx = grid.index;
    var amp = grid.amp;
    for (var i = 0; i < grid.count; i++) {
      var p = idx[i];
      var a = amp[i];
      var w = wf ? wf[i] : 0;
      re[p] = a * Math.cos(w);
      im[p] = a * Math.sin(w);
    }

    ZPV.fft.fft2(re, im, N, { rowMin: grid.rowMin, rowMax: grid.rowMax });

    var out = new Float64Array(size);
    var sum = 0;
    for (var t = 0; t < size; t++) {
      var v = re[t] * re[t] + im[t] * im[t];
      out[t] = v;
      sum += v;
    }
    return { intensity: out, sum: sum, scratch: { re: re, im: im } };
  }

  /* 総和 1 に正規化し、fftshift した PSF（Float32Array）を返す。 */
  function computePsf(grid, wf, scratch) {
    var r = computeIntensity(grid, wf, scratch);
    var N = grid.N;
    var size = N * N;
    var norm = r.sum > 0 ? 1 / r.sum : 0;
    var shifted = new Float32Array(size);
    var h = N >> 1;
    var peak = 0;
    var peakIndex = 0;
    for (var row = 0; row < N; row++) {
      var sr = (row + h) % N;
      for (var col = 0; col < N; col++) {
        var v = r.intensity[sr * N + ((col + h) % N)] * norm;
        var d = row * N + col;
        shifted[d] = v;
        if (v > peak) { peak = v; peakIndex = d; }
      }
    }
    return {
      psf: shifted,
      peak: peak,
      peakRow: (peakIndex / N) | 0,
      peakCol: peakIndex % N,
      rawSum: r.sum,
      scratch: r.scratch
    };
  }

  /* マスク内の波面を N x N の表示用 Float32Array に展開する。 */
  function expandToFull(grid, packed, fillValue) {
    var out = new Float32Array(grid.N * grid.N);
    if (fillValue) out.fill(fillValue);
    for (var i = 0; i < grid.count; i++) out[grid.index[i]] = packed[i];
    return out;
  }

  function maskFull(grid) {
    var out = new Uint8Array(grid.N * grid.N);
    for (var i = 0; i < grid.count; i++) out[grid.index[i]] = 1;
    return out;
  }

  ZPV.psf = {
    nonZeroModes: nonZeroModes,
    computeWavefront: computeWavefront,
    computeIntensity: computeIntensity,
    computePsf: computePsf,
    expandToFull: expandToFull,
    maskFull: maskFull
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
