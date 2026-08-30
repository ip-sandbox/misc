/* UT-06〜UT-08: FFT。SPEC.md §10.1 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers');

const ZPV = loadCore();

function seeded(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

test('UT-06: 1 次元 FFT が素朴な DFT と一致', () => {
  const n = 64;
  const rnd = seeded(12345);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = rnd();
    im[i] = rnd();
  }
  const ref = ZPV.fft.dft1dNaive(Float64Array.from(re), Float64Array.from(im));
  const tw = ZPV.fft.twiddles(n);
  ZPV.fft.fft1d(re, im, n, 0, 1, tw);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    worst = Math.max(worst, Math.abs(re[i] - ref.re[i]), Math.abs(im[i] - ref.im[i]));
  }
  assert.ok(worst < 1e-10, `最大誤差 ${worst}`);
});

test('UT-06b: 2 次元 FFT が行・列の分離 DFT と一致', () => {
  const N = 16;
  const rnd = seeded(999);
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    re[i] = rnd();
    im[i] = rnd();
  }
  const refRe = Float64Array.from(re);
  const refIm = Float64Array.from(im);
  // 参照: 行方向 DFT -> 列方向 DFT
  for (let r = 0; r < N; r++) {
    const row = ZPV.fft.dft1dNaive(refRe.slice(r * N, r * N + N), refIm.slice(r * N, r * N + N));
    refRe.set(row.re, r * N);
    refIm.set(row.im, r * N);
  }
  for (let c = 0; c < N; c++) {
    const cr = new Float64Array(N);
    const ci = new Float64Array(N);
    for (let r = 0; r < N; r++) {
      cr[r] = refRe[r * N + c];
      ci[r] = refIm[r * N + c];
    }
    const col = ZPV.fft.dft1dNaive(cr, ci);
    for (let r = 0; r < N; r++) {
      refRe[r * N + c] = col.re[r];
      refIm[r * N + c] = col.im[r];
    }
  }
  ZPV.fft.fft2(re, im, N);
  let worst = 0;
  for (let i = 0; i < N * N; i++) {
    worst = Math.max(worst, Math.abs(re[i] - refRe[i]), Math.abs(im[i] - refIm[i]));
  }
  assert.ok(worst < 1e-10, `最大誤差 ${worst}`);
});

test('UT-07: パーセバル則', () => {
  const N = 64;
  const rnd = seeded(4242);
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  let before = 0;
  for (let i = 0; i < N * N; i++) {
    re[i] = rnd();
    im[i] = rnd();
    before += re[i] * re[i] + im[i] * im[i];
  }
  ZPV.fft.fft2(re, im, N);
  let after = 0;
  for (let i = 0; i < N * N; i++) after += re[i] * re[i] + im[i] * im[i];
  const rel = Math.abs(after / (N * N) - before) / before;
  assert.ok(rel < 1e-10, `相対誤差 ${rel}`);
});

test('UT-08: ゼロ行スキップ最適化の等価性', () => {
  const N = 128;
  const grid = ZPV.pupil.buildGrid(N, 4, { shape: 'circular' });
  assert.ok(grid.rowMin > 0 && grid.rowMax < N - 1, '瞳の外に空行があること');

  const build = () => {
    const re = new Float64Array(N * N);
    const im = new Float64Array(N * N);
    for (let i = 0; i < grid.count; i++) {
      re[grid.index[i]] = grid.amp[i] * Math.cos(0.3 * i);
      im[grid.index[i]] = grid.amp[i] * Math.sin(0.3 * i);
    }
    return { re, im };
  };

  const a = build();
  const b = build();
  ZPV.fft.fft2(a.re, a.im, N); // 全行
  ZPV.fft.fft2(b.re, b.im, N, { rowMin: grid.rowMin, rowMax: grid.rowMax }); // スキップあり

  let worst = 0;
  let scale = 0;
  for (let i = 0; i < N * N; i++) {
    worst = Math.max(worst, Math.abs(a.re[i] - b.re[i]), Math.abs(a.im[i] - b.im[i]));
    scale = Math.max(scale, Math.abs(a.re[i]), Math.abs(a.im[i]));
  }
  assert.ok(worst / scale < 1e-12, `相対誤差 ${worst / scale}`);
});

test('fftshift が象限を正しく入れ替える', () => {
  const N = 4;
  const src = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) src[i] = i;
  const out = ZPV.fft.fftshift(src, N);
  // DC (index 0) が中央 (N/2, N/2) に来る
  assert.strictEqual(out[(N / 2) * N + N / 2], 0);
});
