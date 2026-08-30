/* SPEC.md §3.5 / §8.2 のマイクロベンチ。
 *     node tools/bench.js
 * Node と Chromium の V8 は同じなので、ブラウザでの実測値の目安になる。
 */
'use strict';
const path = require('path');
['nollIndex', 'zernikePolynomial', 'pupil', 'fft', 'basisCache', 'psf', 'metrics', 'engine'].forEach((f) =>
  require(path.join(__dirname, '..', 'src', 'core', f + '.js'))
);

function bench(label, iterations, fn) {
  fn(); // ウォームアップ（JIT）
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
  console.log(label.padEnd(48), ms.toFixed(2).padStart(8) + ' ms');
  return ms;
}

console.log('=== 2D 複素 FFT（全行） ===');
for (const N of [256, 512, 1024, 2048]) {
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) re[i] = Math.sin(i);
  bench(`fft2  N=${N}`, N >= 1024 ? 3 : 10, () => ZPV.fft.fft2(re, im, N));
}

console.log('\n=== ゼロ行スキップの効果（瞳直径 = N/4） ===');
for (const N of [512, 1024]) {
  const grid = ZPV.pupil.buildGrid(N, 4, { shape: 'circular' });
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  const full = bench(`fft2  N=${N} 全行`, 3, () => ZPV.fft.fft2(re, im, N));
  const skip = bench(`fft2  N=${N} スキップあり`, 3, () =>
    ZPV.fft.fft2(re, im, N, { rowMin: grid.rowMin, rowMax: grid.rowMax })
  );
  console.log(`  -> 削減率 ${(100 * (1 - skip / full)).toFixed(1)}%`);
}

console.log('\n=== 基底マップ 1 モードの生成 ===');
for (const [N, q] of [[512, 4], [1024, 4]]) {
  const grid = ZPV.pupil.buildGrid(N, q, { shape: 'circular' });
  for (const j of [4, 231]) {
    const nm = ZPV.noll.nollToNM(j);
    bench(`基底 Noll ${j} (n=${nm.n}) N=${N} count=${grid.count}`, 5, () =>
      ZPV.zernike.zernikeMapPacked(nm.n, nm.m, grid)
    );
  }
}

console.log('\n=== フルパイプライン（係数 1 個変更 = キャッシュヒット） ===');
for (const [N, q] of [[256, 4], [512, 4], [1024, 4], [2048, 4]]) {
  const eng = new ZPV.Engine();
  const coeffs = { 4: 0.3, 8: -0.12, 11: 0.6 };
  eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs });
  let v = 0.3;
  bench(`compute N=${N} q=${q} 3 モード`, N >= 1024 ? 3 : 10, () => {
    coeffs[4] = v += 0.001;
    eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs });
  });
}

console.log('\n=== 最悪ケース: 231 モードすべて非ゼロ ===');
{
  const N = 1024;
  const q = 4;
  const eng = new ZPV.Engine();
  const coeffs = {};
  for (let j = 1; j <= 231; j++) coeffs[j] = 0.01;
  eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs });
  bench(`compute N=${N} 231 モード（キャッシュ済）`, 3, () => {
    coeffs[4] += 0.001;
    eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs });
  });
  const stats = eng.cache.stats();
  console.log(`  基底キャッシュ: ${stats.entries} エントリ / ${(stats.bytes / 1048576).toFixed(1)} MB`);
}
