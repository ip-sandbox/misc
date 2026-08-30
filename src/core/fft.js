/* radix-2 Cooley-Tukey による複素 FFT。SPEC.md §5.10。
 *
 * 2 次元版は行→列の 2 パス。瞳の外側の行は全要素 0 なので、行パスは
 * [rowMin, rowMax] の範囲だけ計算すればよい（SPEC.md §3.5 の最適化 1）。
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var twiddleCache = new Map();

  function twiddles(n) {
    var hit = twiddleCache.get(n);
    if (hit) return hit;
    // 各段 length = 2,4,...,n の w = exp(-2*pi*i/length) の冪乗を平坦に格納
    var cos = new Float64Array(n);
    var sin = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var ang = (-2 * Math.PI * i) / n;
      cos[i] = Math.cos(ang);
      sin[i] = Math.sin(ang);
    }
    var rev = new Int32Array(n);
    var bits = Math.log2(n) | 0;
    for (var j = 0; j < n; j++) {
      var r = 0;
      for (var b = 0; b < bits; b++) if (j & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[j] = r;
    }
    var t = { cos: cos, sin: sin, rev: rev, n: n };
    twiddleCache.set(n, t);
    return t;
  }

  /* re/im の [offset, offset + n*stride) を in-place で 1 次元 FFT する。 */
  function fft1d(re, im, n, offset, stride, tw) {
    var rev = tw.rev;
    var i, j, a, b, len, half, step, k, ar, ai, br, bi, wr, wi, tr, ti;

    for (i = 0; i < n; i++) {
      j = rev[i];
      if (i < j) {
        a = offset + i * stride;
        b = offset + j * stride;
        tr = re[a]; re[a] = re[b]; re[b] = tr;
        ti = im[a]; im[a] = im[b]; im[b] = ti;
      }
    }

    for (len = 2; len <= n; len <<= 1) {
      half = len >> 1;
      step = n / len;
      for (i = 0; i < n; i += len) {
        for (k = 0; k < half; k++) {
          wr = tw.cos[k * step];
          wi = tw.sin[k * step];
          a = offset + (i + k) * stride;
          b = offset + (i + k + half) * stride;
          br = re[b]; bi = im[b];
          tr = br * wr - bi * wi;
          ti = br * wi + bi * wr;
          ar = re[a]; ai = im[a];
          re[b] = ar - tr; im[b] = ai - ti;
          re[a] = ar + tr; im[a] = ai + ti;
        }
      }
    }
  }

  var BLOCK = 32;

  /* 正方行列の in-place 転置（キャッシュのためブロック単位で行う）。 */
  function transpose(a, N) {
    for (var i0 = 0; i0 < N; i0 += BLOCK) {
      for (var j0 = i0; j0 < N; j0 += BLOCK) {
        var iMax = Math.min(i0 + BLOCK, N);
        var jMax = Math.min(j0 + BLOCK, N);
        for (var i = i0; i < iMax; i++) {
          for (var j = j0 === i0 ? i + 1 : j0; j < jMax; j++) {
            var p = i * N + j;
            var q = j * N + i;
            var t = a[p];
            a[p] = a[q];
            a[q] = t;
          }
        }
      }
    }
  }

  /* N x N の複素配列（row-major）を in-place で 2 次元 FFT する。
   *
   * 列パスは stride N のアクセスになりキャッシュミスで極端に遅くなるため、
   * ブロック転置してから行パスを掛け、転置で戻す。N=1024 で列パスが
   * 134 ms -> 29 ms になる（転置 2 回分を含めても 3 倍以上速い）。
   *
   * opts.rowMin / opts.rowMax を与えると、その範囲外の行の行パスを省略する
   * （その行が全て 0 であることが前提）。 */
  function fft2(re, im, N, opts) {
    var tw = twiddles(N);
    var rowMin = 0;
    var rowMax = N - 1;
    if (opts && opts.rowMin !== undefined && opts.rowMax !== undefined && opts.rowMax >= opts.rowMin) {
      rowMin = opts.rowMin;
      rowMax = opts.rowMax;
    }
    var row;
    for (row = rowMin; row <= rowMax; row++) fft1d(re, im, N, row * N, 1, tw);

    transpose(re, N);
    transpose(im, N);
    for (row = 0; row < N; row++) fft1d(re, im, N, row * N, 1, tw);
    transpose(re, N);
    transpose(im, N);
  }

  /* 素朴な DFT。テスト用の参照。 */
  function dft1dNaive(re, im) {
    var n = re.length;
    var outRe = new Float64Array(n);
    var outIm = new Float64Array(n);
    for (var k = 0; k < n; k++) {
      var sr = 0;
      var si = 0;
      for (var t = 0; t < n; t++) {
        var ang = (-2 * Math.PI * k * t) / n;
        var c = Math.cos(ang);
        var s = Math.sin(ang);
        sr += re[t] * c - im[t] * s;
        si += re[t] * s + im[t] * c;
      }
      outRe[k] = sr;
      outIm[k] = si;
    }
    return { re: outRe, im: outIm };
  }

  /* 象限を入れ替えて原点を配列中央に移す（表示用）。 */
  function fftshift(src, N, dst) {
    var out = dst || new Float32Array(N * N);
    var h = N >> 1;
    for (var row = 0; row < N; row++) {
      var sr = (row + h) % N;
      for (var col = 0; col < N; col++) {
        out[row * N + col] = src[sr * N + ((col + h) % N)];
      }
    }
    return out;
  }

  ZPV.fft = { fft1d: fft1d, fft2: fft2, fftshift: fftshift, dft1dNaive: dft1dNaive, twiddles: twiddles, transpose: transpose };
})(typeof globalThis !== 'undefined' ? globalThis : this);
