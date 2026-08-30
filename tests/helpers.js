/* テスト用ヘルパー。src/core の各ファイルを globalThis.ZPV に読み込む。 */
'use strict';
const fs = require('fs');
const path = require('path');

const CORE_FILES = [
  'nollIndex.js',
  'zernikePolynomial.js',
  'pupil.js',
  'fft.js',
  'basisCache.js',
  'psf.js',
  'metrics.js',
  'engine.js'
];

function loadCore() {
  if (!globalThis.ZPV) {
    const dir = path.join(__dirname, '..', 'src', 'core');
    for (const f of CORE_FILES) require(path.join(dir, f));
  }
  return globalThis.ZPV;
}

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

/* '# ...' で始まる行を無視して数値行列を読む。 */
function readMatrix(name) {
  const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    rows.push(s.split(',').map(Number));
  }
  return rows;
}

function readTriples(name) {
  const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    out.push(s.split(',').map(Number));
  }
  return out;
}

/* 2 つの行列の最大相対誤差。分母が小さい所は絶対誤差で評価する。 */
function maxRelError(expected, actual, floor) {
  const eps = floor === undefined ? 1e-12 : floor;
  let worst = 0;
  let at = null;
  for (let r = 0; r < expected.length; r++) {
    for (let c = 0; c < expected[r].length; c++) {
      const e = expected[r][c];
      const a = actual[r][c];
      const denom = Math.max(Math.abs(e), eps);
      const err = Math.abs(e - a) / denom;
      if (err > worst) {
        worst = err;
        at = { row: r, col: c, expected: e, actual: a };
      }
    }
  }
  return { error: worst, at };
}

/* 2 つのマップを 2 つの尺度で比較する。
 *   normAbs : 最大絶対誤差をマップのピーク値で正規化したもの（全画素）
 *   relSig  : ピークの 1e-6 を超える画素だけを見た最大相対誤差
 * 零点近傍では相対誤差が発散するため、両方を見るのが正しい。 */
function compareMaps(expected, actualFlat, N) {
  let maxAbs = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) maxAbs = Math.max(maxAbs, Math.abs(expected[r][c]));
  let maxDiff = 0;
  let relSig = 0;
  let at = null;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const e = expected[r][c];
      const a = actualFlat[r * N + c];
      const d = Math.abs(e - a);
      if (d > maxDiff) {
        maxDiff = d;
        at = { row: r, col: c, expected: e, actual: a };
      }
      if (Math.abs(e) > 1e-6 * maxAbs) relSig = Math.max(relSig, d / Math.abs(e));
    }
  }
  return { normAbs: maxAbs > 0 ? maxDiff / maxAbs : maxDiff, relSig, maxAbs, at };
}

/* Float32Array/Float64Array (N*N) を 2 次元配列に変換する。 */
function toMatrix(arr, N) {
  const out = [];
  for (let r = 0; r < N; r++) {
    const row = new Array(N);
    for (let c = 0; c < N; c++) row[c] = arr[r * N + c];
    out.push(row);
  }
  return out;
}

/* 3 点の放物線フィットで極値の位置（サブピクセル）を返す。 */
function parabolicVertex(xm1, x0, xp1) {
  const denom = xm1 - 2 * x0 + xp1;
  if (denom === 0) return 0;
  return (0.5 * (xm1 - xp1)) / denom;
}

module.exports = { loadCore, readMatrix, readTriples, maxRelError, compareMaps, toMatrix, parabolicVertex, FIXTURE_DIR };
