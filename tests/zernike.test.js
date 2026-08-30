/* UT-01〜UT-05: Zernike 多項式とインデックス変換。SPEC.md §10.1 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadCore, readTriples } = require('./helpers');

const ZPV = loadCore();
const { noll, zernike } = ZPV;

test('UT-01: R_n^m の既知値', () => {
  // R_4^0(rho) = 6rho^4 - 6rho^2 + 1
  assert.ok(Math.abs(zernike.radial(4, 0, 0) - 1) < 1e-12);
  assert.ok(Math.abs(zernike.radial(4, 0, 1) - 1) < 1e-12);
  assert.ok(Math.abs(zernike.radial(4, 0, 0.5) - -0.125) < 1e-12);
  // R_2^0(rho) = 2rho^2 - 1 を全域で
  for (let i = 0; i <= 100; i++) {
    const r = i / 100;
    assert.ok(Math.abs(zernike.radial(2, 0, r) - (2 * r * r - 1)) < 1e-12);
  }
  // R_3^1 = 3rho^3 - 2rho, R_5^5 = rho^5
  for (let i = 0; i <= 50; i++) {
    const r = i / 50;
    assert.ok(Math.abs(zernike.radial(3, 1, r) - (3 * r ** 3 - 2 * r)) < 1e-12);
    assert.ok(Math.abs(zernike.radial(5, 5, r) - r ** 5) < 1e-12);
  }
  // n - |m| が奇数なら恒等的に 0
  assert.strictEqual(zernike.radial(3, 0, 0.7), 0);
});

test('UT-05: BigInt による動径係数が厳密であること', () => {
  // すべての有効な (n, m) で R_n^m(1) = 1（Zernike の基本的な性質）
  // n=20 では係数が 1e5 規模になるため、桁落ちがあればここで露見する。
  let worst = 0;
  for (let n = 0; n <= 20; n++) {
    for (let m = -n; m <= n; m += 2) {
      const v = zernike.radial(n, m, 1);
      worst = Math.max(worst, Math.abs(v - 1));
    }
  }
  assert.ok(worst < 1e-9, `R_n^m(1) の最大誤差 ${worst} が大きすぎます`);

  // 係数がすべて整数であること
  for (let n = 0; n <= 20; n++) {
    for (let m = 0; m <= n; m += 2) {
      const co = zernike.radialCoefficients(n, m);
      if (!co) continue;
      for (const c of co) {
        assert.strictEqual(c, Math.round(c), `n=${n} m=${m} の係数 ${c} が整数ではありません`);
      }
    }
  }

  // R_4^0 = 6rho^4 - 6rho^2 + 1 -> rho^0 の係数から順に [1, -6, 6]
  assert.deepStrictEqual(Array.from(zernike.radialCoefficients(4, 0)), [1, -6, 6]);
  // R_6^0 = 20rho^6 - 30rho^4 + 12rho^2 - 1
  assert.deepStrictEqual(Array.from(zernike.radialCoefficients(6, 0)), [-1, 12, -30, 20]);
  // R_5^1 = 10rho^5 - 12rho^3 + 3rho -> rho^(1+2t) の係数
  assert.deepStrictEqual(Array.from(zernike.radialCoefficients(5, 1)), [3, -12, 10]);
});

test('UT-03: Noll <-> (n,m) の全単射', () => {
  for (let j = 1; j <= noll.J_MAX; j++) {
    const nm = noll.nollToNM(j);
    assert.strictEqual(noll.nmToNoll(nm.n, nm.m), j, `j=${j} で往復しません`);
    assert.ok(nm.n >= 0 && nm.n <= 20);
    assert.ok(Math.abs(nm.m) <= nm.n);
    assert.strictEqual((nm.n - Math.abs(nm.m)) % 2, 0);
  }
});

test('UT-04: Noll 変換が参照実装の出力と全件一致', () => {
  const rows = readTriples('noll_index.csv');
  assert.strictEqual(rows.length, 231);
  for (const [j, n, m] of rows) {
    const got = noll.nollToNM(j);
    assert.strictEqual(got.n, n, `j=${j} の n が不一致`);
    assert.strictEqual(got.m, m, `j=${j} の m が不一致`);
  }
});

test('UT-04b: 付録 A の対応表（OSA / Fringe 併記）', () => {
  const expect = [
    // [noll, n, m, osa, fringe]
    [1, 0, 0, 0, 1], [2, 1, 1, 2, 2], [3, 1, -1, 1, 3], [4, 2, 0, 4, 4],
    [5, 2, -2, 3, 6], [6, 2, 2, 5, 5], [7, 3, -1, 7, 8], [8, 3, 1, 8, 7],
    [9, 3, -3, 6, 11], [10, 3, 3, 9, 10], [11, 4, 0, 12, 9], [12, 4, 2, 13, 12],
    [13, 4, -2, 11, 13], [14, 4, 4, 14, 17], [15, 4, -4, 10, 18], [16, 5, 1, 18, 14],
    [17, 5, -1, 17, 15], [18, 5, 3, 19, 19], [19, 5, -3, 16, 20], [20, 5, 5, 20, 26],
    [21, 5, -5, 15, 27], [22, 6, 0, 24, 16]
  ];
  for (const [j, n, m, osa, fringe] of expect) {
    const got = noll.nollToNM(j);
    assert.deepStrictEqual([got.n, got.m], [n, m], `Noll ${j}`);
    assert.strictEqual(noll.nmToOsa(n, m), osa, `Noll ${j} の OSA 番号`);
    assert.strictEqual(noll.nmToFringe(n, m), fringe, `Noll ${j} の Fringe 番号`);
  }
});

test('名称の割り当て', () => {
  const cases = [
    [1, 'ピストン'], [2, 'チルト (X)'], [3, 'チルト (Y)'], [4, 'デフォーカス'],
    [5, '非点収差 (±45°)'], [6, '非点収差 (0/90°)'], [7, 'コマ収差 (Y)'],
    [9, 'トレフォイル (Y)'], [11, '球面収差'], [12, '二次非点収差 (0/90°)'],
    [14, 'クアドラフォイル (X)'], [16, '二次コマ収差 (X)'], [20, 'ペンタフォイル (X)'],
    [22, '二次球面収差']
  ];
  for (const [j, name] of cases) {
    const nm = noll.nollToNM(j);
    assert.strictEqual(noll.modeName(nm.n, nm.m), name, `Noll ${j}`);
  }
  // n=20 まで名前が付くこと（例外を投げないこと）
  for (let j = 1; j <= noll.J_MAX; j++) {
    const nm = noll.nollToNM(j);
    assert.ok(noll.modeName(nm.n, nm.m).length > 0);
  }
});

test('UT-02: 正規化 Zernike の直交性', () => {
  const N = 513; // q=1 なので瞳直径は (N-1)/q = 512 画素
  const grid = ZPV.pupil.buildGrid(N, 1, { shape: 'circular' });
  const step = 2 / (N - 1);
  const scale = (step * step) / Math.PI;

  const modes = [];
  for (let j = 1; j <= 28; j++) modes.push(noll.nollToNM(j)); // n <= 6
  // n = 20 の全項も対角成分だけ確認する
  for (let j = 211; j <= 231; j++) modes.push(noll.nollToNM(j));

  const maps = modes.map((nm) => ZPV.zernike.zernikeMapPacked(nm.n, nm.m, grid, true));

  // 誤差の主因は円形マスクの画素量子化で、O(1/D_pix) で減衰する。
  // D_pix=512 での実測は n<=6 が 2.6e-3、n=20 が 6.4e-3（N を倍にすると半減する）。
  let worstDiag = 0;
  let worstOff = 0;
  let worstDiag20 = 0;
  for (let a = 0; a < maps.length; a++) {
    for (let b = a; b < maps.length; b++) {
      const isN20 = a >= 28 || b >= 28;
      if (isN20 && a !== b) continue; // n=20 は対角のみ
      let acc = 0;
      const ma = maps[a];
      const mb = maps[b];
      for (let i = 0; i < grid.count; i++) acc += ma[i] * mb[i];
      const v = acc * scale;
      if (a === b) {
        if (isN20) worstDiag20 = Math.max(worstDiag20, Math.abs(v - 1));
        else worstDiag = Math.max(worstDiag, Math.abs(v - 1));
      } else {
        worstOff = Math.max(worstOff, Math.abs(v));
      }
    }
  }
  assert.ok(worstDiag < 5e-3, `n<=6 の対角成分の最大誤差 ${worstDiag}`);
  assert.ok(worstOff < 5e-3, `n<=6 の非対角成分の最大値 ${worstOff}`);
  assert.ok(worstDiag20 < 1e-2, `n=20 の対角成分の最大誤差 ${worstDiag20}`);
});
