/* UT-09〜UT-13, UT-19: 瞳関数・PSF・指標。SPEC.md §10.1 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers');

const ZPV = loadCore();

/* 水平カット上で最初の極小をサブピクセルで求める（放物線フィット）。 */
function firstMinimumPx(psf, N, row, col) {
  const f = (k) => psf[row * N + col + k];
  let k = 2;
  while (!(f(k) < f(k - 1) && f(k) <= f(k + 1))) {
    k++;
    if (k > N / 2 - 2) throw new Error('極小が見つかりません');
  }
  const denom = f(k - 1) - 2 * f(k) + f(k + 1);
  return k + (0.5 * (f(k - 1) - f(k + 1))) / denom;
}

function peakColSubPixel(psf, N, row, col) {
  const f = (k) => psf[row * N + col + k];
  const denom = f(-1) - 2 * f(0) + f(1);
  return col + (0.5 * (f(-1) - f(1))) / denom;
}

test('UT-09: 無収差 PSF の第 1 暗環が 1.22 λ/D', () => {
  const N = 1024;
  const q = 16; // 像面サンプリングを細かくしないと極小の内挿が偏る（q=8 では約 1.6% ずれる）
  const eng = new ZPV.Engine();
  const r = eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs: {} });

  assert.strictEqual(r.psfPeakRow, N / 2);
  assert.strictEqual(r.psfPeakCol, N / 2);
  assert.ok(Math.abs(r.metrics.strehlDefinition - 1) < 1e-12);
  assert.ok(Math.abs(r.metrics.strehlPeak - 1) < 1e-12);

  const zeroLD = firstMinimumPx(r.psf, N, r.psfPeakRow, r.psfPeakCol) / q;
  assert.ok(Math.abs(zeroLD - 1.22) / 1.22 < 0.01, `第 1 暗環 ${zeroLD} λ/D`);

  // Airy の FWHM は 1.028 λ/D
  assert.ok(Math.abs(r.metrics.fwhm - 1.028) / 1.028 < 0.02, `FWHM ${r.metrics.fwhm} λ/D`);
});

test('UT-10: 無収差 PSF が解析解 [2J1(v)/v]^2 と一致', () => {
  const N = 1024;
  const q = 16;
  const eng = new ZPV.Engine();
  const r = eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs: {} });
  const f = (k) => r.psf[r.psfPeakRow * N + r.psfPeakCol + k] / r.psfPeak;

  // コア部（r <= 1 λ/D）は相対誤差で評価する
  let worstRel = 0;
  for (let k = 0; k <= q; k++) {
    const a = ZPV.metrics.airy(k / q);
    worstRel = Math.max(worstRel, Math.abs(f(k) - a) / a);
  }
  assert.ok(worstRel < 0.02, `コアの最大相対誤差 ${worstRel}`);

  // 3 λ/D までは（零点近傍で相対誤差が発散するため）ピーク基準の絶対誤差で評価する
  let worstAbs = 0;
  for (let k = 0; k <= 3 * q; k++) {
    worstAbs = Math.max(worstAbs, Math.abs(f(k) - ZPV.metrics.airy(k / q)));
  }
  assert.ok(worstAbs < 2e-3, `3 λ/D までの最大絶対誤差 ${worstAbs}`);
});

test('UT-11: チルト (Noll 2, a rad) で PSF が 2a/π λ/D 移動する', () => {
  const N = 1024;
  const q = 8;
  const a = 1.0;
  const eng = new ZPV.Engine();
  const r = eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs: { 2: a } });
  const sub = peakColSubPixel(r.psf, N, r.psfPeakRow, r.psfPeakCol);
  const shiftPx = sub - N / 2;
  const expectPx = ((2 * a) / Math.PI) * q;
  assert.ok(Math.abs(shiftPx - expectPx) < 0.1, `移動量 ${shiftPx} px（期待 ${expectPx} px）`);
  // 行方向（Y）には動かないこと
  assert.strictEqual(r.psfPeakRow, N / 2);
});

test('UT-12: Maréchal 近似との一致（純デフォーカス）', () => {
  const eng = new ZPV.Engine();
  for (const sigma of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
    const r = eng.compute({ N: 512, q: 4, pupil: { shape: 'circular' }, coeffs: { 4: sigma } });
    // 正規化 Zernike なので係数がそのまま RMS[rad]
    assert.ok(Math.abs(r.metrics.rms - sigma) / sigma < 5e-3, `RMS ${r.metrics.rms} != ${sigma}`);
    const marechal = Math.exp(-sigma * sigma);
    const rel = Math.abs(r.metrics.strehlDefinition - marechal) / marechal;
    assert.ok(rel < 0.02, `σ=${sigma} で相対差 ${rel}`);
  }
});

test('UT-13: 中心遮蔽 (ε=0.5) の効果', () => {
  const N = 1024;
  const q = 16;
  const eng = new ZPV.Engine();
  const clear = eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs: {} });
  const obs = eng.compute({ N, q, pupil: { shape: 'circular', obscurationRatio: 0.5 }, coeffs: {} });

  // 第 1 暗環が内側に寄る（ε=0.5 の環状瞳では約 1.0 λ/D）
  const zClear = firstMinimumPx(clear.psf, N, clear.psfPeakRow, clear.psfPeakCol) / q;
  const zObs = firstMinimumPx(obs.psf, N, obs.psfPeakRow, obs.psfPeakCol) / q;
  assert.ok(zObs < zClear, `遮蔽時 ${zObs} が非遮蔽 ${zClear} より内側でないと不正`);
  assert.ok(Math.abs(zObs - 1.0) < 0.03, `遮蔽時の第 1 暗環 ${zObs} λ/D`);

  // 総和正規化した PSF のピーク比は開口面積比 (1-ε^2) = 0.75 になる
  const ratio = obs.psfPeak / clear.psfPeak;
  assert.ok(Math.abs(ratio - 0.75) < 0.01, `ピーク比 ${ratio}`);

  // 総エネルギーは 1（総和正規化）
  let sum = 0;
  for (let i = 0; i < obs.psf.length; i++) sum += obs.psf[i];
  assert.ok(Math.abs(sum - 1) < 1e-5, `総和 ${sum}`);
});

test('UT-19: 基底キャッシュの等価性と上限', () => {
  const grid = ZPV.pupil.buildGrid(64, 4, { shape: 'circular' });
  const key = ZPV.pupil.gridKey(64, 4, { shape: 'circular' });

  const limit = grid.count * 4 * 8; // 8 モード分だけ入る上限にして LRU を強制する
  const cache = new ZPV.BasisCache(limit);
  cache.setGrid(grid, key);
  const first = Float32Array.from(cache.get(4, 0));
  for (let j = 1; j <= 60; j++) {
    const nm = ZPV.noll.nollToNM(j);
    cache.get(nm.n, nm.m);
  }
  assert.ok(cache.bytes <= limit, `上限超過 ${cache.bytes} > ${limit}`);
  assert.ok(cache.map.size < 60, 'LRU で追い出されていること');

  // 追い出されたあとに再取得しても同じ値になること
  const again = cache.get(4, 0);
  assert.strictEqual(again.length, first.length);
  for (let i = 0; i < first.length; i++) assert.strictEqual(again[i], first[i]);

  // グリッドが変わればキャッシュは破棄される
  const grid2 = ZPV.pupil.buildGrid(64, 2, { shape: 'circular' });
  cache.setGrid(grid2, ZPV.pupil.gridKey(64, 2, { shape: 'circular' }));
  assert.strictEqual(cache.map.size, 0);
  assert.strictEqual(cache.bytes, 0);
});

test('ピストン/チルト除外の指標への影響', () => {
  const eng = new ZPV.Engine();
  const coeffs = { 1: 0.5, 2: 0.8, 3: -0.4, 11: 0.3 };
  const on = eng.compute({ N: 256, q: 4, pupil: { shape: 'circular' }, coeffs, excludePistonTilt: true });
  const off = eng.compute({ N: 256, q: 4, pupil: { shape: 'circular' }, coeffs, excludePistonTilt: false });
  // 除外時は球面収差だけの RMS になる
  assert.ok(Math.abs(on.metrics.rms - 0.3) / 0.3 < 5e-3, `除外時 RMS ${on.metrics.rms}`);
  assert.ok(off.metrics.rms > on.metrics.rms, '除外しないほうが RMS は大きい');
  // 表示用 PSF は両者で同一（除外は指標のみに効く）
  assert.strictEqual(on.psfPeak, off.psfPeak);
});

test('矩形瞳とガウシアンアポダイゼーションが動作する', () => {
  const eng = new ZPV.Engine();
  const rect = eng.compute({
    N: 256, q: 4, coeffs: {},
    pupil: { shape: 'rectangular', rect: { halfWidth: 1, halfHeight: 0.5 } }
  });
  assert.ok(rect.maskCount > 0);
  // 縦に狭い開口 -> 像面では縦に広がる
  const N = 256;
  // 開口が狭い y 方向ほど像は広がる。offset は sinc の零点を避けて 2 画素にする。
  const xCut = rect.psf[rect.psfPeakRow * N + rect.psfPeakCol + 2];
  const yCut = rect.psf[(rect.psfPeakRow + 2) * N + rect.psfPeakCol];
  assert.ok(yCut > xCut * 1.5, `短辺方向の PSF がより広がること (x=${xCut}, y=${yCut})`);

  const apod = eng.compute({
    N: 256, q: 4, coeffs: {},
    pupil: { shape: 'circular', apodization: { type: 'gaussian', width: 0.6 } }
  });
  assert.ok(apod.amplitude.some((v) => v > 0 && v < 1), 'アポダイゼーションが振幅に反映されること');
});
