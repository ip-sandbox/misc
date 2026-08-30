/* UT-18: 参照実装 (torchmfbd/zern.py) から生成した fixture との突き合わせ。
 * SPEC.md §5.1 / §10.1 / 付録 C。
 *
 * 比較は 2 つの尺度で行う（helpers.compareMaps）。
 *   normAbs : 最大絶対誤差をマップのピーク値で正規化したもの
 *   relSig  : ピークの 1e-6 を超える画素だけを見た最大相対誤差
 * 高次モードは零点近傍で桁落ちするため、局所的な相対誤差だけで判定してはならない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCore, readMatrix, compareMaps } = require('./helpers');

const ZPV = loadCore();
const MODES = [1, 4, 8, 11, 22, 100, 231];

function basisFull(n, m, grid, useFloat64) {
  const packed = ZPV.zernike.zernikeMapPacked(n, m, grid, useFloat64);
  const full = new Float64Array(grid.N * grid.N);
  for (let i = 0; i < grid.count; i++) full[grid.index[i]] = packed[i];
  return full;
}

test('UT-18a: 基底マップが参照実装と一致（倍精度経路）', () => {
  const N = 32;
  const grid = ZPV.pupil.buildGrid(N, 1, { shape: 'circular' });
  for (const j of MODES) {
    const expected = readMatrix(`zmap_noll${String(j).padStart(3, '0')}.csv`);
    assert.strictEqual(expected.length, N);
    const nm = ZPV.noll.nollToNM(j);
    const r = compareMaps(expected, basisFull(nm.n, nm.m, grid, true), N);
    assert.ok(r.normAbs < 1e-12, `Noll ${j} (n=${nm.n}, m=${nm.m}) normAbs=${r.normAbs}`);
    assert.ok(r.relSig < 1e-11, `Noll ${j} (n=${nm.n}, m=${nm.m}) relSig=${r.relSig}`);
  }
});

test('UT-18b: 実行時の Float32 基底経路も参照実装と十分一致', () => {
  const N = 32;
  const grid = ZPV.pupil.buildGrid(N, 1, { shape: 'circular' });
  for (const j of MODES) {
    const expected = readMatrix(`zmap_noll${String(j).padStart(3, '0')}.csv`);
    const nm = ZPV.noll.nollToNM(j);
    const r = compareMaps(expected, basisFull(nm.n, nm.m, grid, false), N);
    // Float32 の相対精度は約 6e-8
    assert.ok(r.normAbs < 1e-6, `Noll ${j} normAbs=${r.normAbs}`);
    assert.ok(r.relSig < 1e-5, `Noll ${j} relSig=${r.relSig}`);
  }
});

test('UT-18c: 合成波面と PSF が参照実装と一致', () => {
  const N = 64;
  const q = 4;
  const coeffs = { 4: 0.3, 11: 0.6, 8: -0.12 }; // fixture と同じ [rad]

  const eng = new ZPV.Engine();
  const res = eng.compute({ N, q, pupil: { shape: 'circular' }, coeffs, excludePistonTilt: true });

  const wf = compareMaps(readMatrix('wavefront.csv'), res.wavefront, N);
  assert.ok(wf.normAbs < 1e-6, `波面 normAbs=${wf.normAbs} @ ${JSON.stringify(wf.at)}`);
  assert.ok(wf.relSig < 1e-5, `波面 relSig=${wf.relSig}`);

  const ps = compareMaps(readMatrix('psf.csv'), res.psf, N);
  assert.ok(ps.normAbs < 1e-6, `PSF normAbs=${ps.normAbs} @ ${JSON.stringify(ps.at)}`);
  assert.ok(ps.relSig < 1e-5, `PSF relSig=${ps.relSig}`);

  // 総和が 1 に正規化されていること（規約 R-6）
  let sum = 0;
  for (let i = 0; i < res.psf.length; i++) sum += res.psf[i];
  assert.ok(Math.abs(sum - 1) < 1e-5, `PSF 総和 ${sum}`);
});

test('グリッド規約 R-4: 端点を含む格子で瞳直径が (N-1)/q になる', () => {
  const grid = ZPV.pupil.buildGrid(1024, 4, { shape: 'circular' });
  assert.strictEqual(grid.pupilDiameterPx, 1023 / 4);
  let maxRho = 0;
  for (let i = 0; i < grid.count; i++) maxRho = Math.max(maxRho, grid.rho[i]);
  assert.ok(maxRho <= 1);
  assert.ok(maxRho > 0.995, `最大 rho ${maxRho}`);
});
