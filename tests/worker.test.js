/* Worker のグルーコードを Node 上で直接検証する。
 *
 * ブラウザのヘッドレステスト（tools/smoke.mjs）は --virtual-time-budget を使う都合で
 * Worker 経路を走らせられないため、ここで src/worker/workerGlue.js のロジック
 * （ping/pong、payload の組み立て、転送リストの妥当性、例外時の応答）を検証する。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCore } = require('./helpers');

loadCore(); // globalThis.ZPV を用意しておく（比較用）

const CORE_FILES = [
  'nollIndex.js', 'zernikePolynomial.js', 'pupil.js', 'fft.js',
  'basisCache.js', 'psf.js', 'metrics.js', 'engine.js'
];

/* ブラウザの Worker グローバルを模した sandbox を作り、core + glue を読み込む */
function makeWorker() {
  const posted = [];
  const sandbox = {
    Math, Date, JSON, Object, Array, Number, String, Error, RangeError, TypeError,
    Float32Array, Float64Array, Int32Array, Uint8Array, Map, Set, BigInt, isFinite, NaN, Infinity,
    console
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.postMessage = function (msg, transfer) {
    posted.push({ msg: msg, transfer: transfer || [] });
  };
  vm.createContext(sandbox);

  const dir = path.join(__dirname, '..', 'src');
  for (const f of CORE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(dir, 'core', f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(dir, 'worker', 'workerGlue.js'), 'utf8'), sandbox,
    { filename: 'workerGlue.js' });

  return {
    posted: posted,
    send: function (data) { sandbox.onmessage({ data: data }); }
  };
}

test('ping に pong を返す（起動判定に使う）', () => {
  const w = makeWorker();
  w.send({ type: 'ping' });
  assert.strictEqual(w.posted.length, 1);
  // sandbox 内で作られたオブジェクトなので deepStrictEqual は使えない（realm が違う）
  assert.strictEqual(w.posted[0].msg.type, 'pong');
});

test('compute の結果がメインスレッドの Engine と一致する', () => {
  const stateOf = () => ({
    N: 128, q: 4, pupil: { shape: 'circular' },
    coeffs: { 4: 0.3, 8: -0.12, 11: 0.6 }, excludePistonTilt: true, eeRadiusLD: 3
  });

  const w = makeWorker();
  w.send({ type: 'compute', id: 7, state: stateOf() });
  assert.strictEqual(w.posted.length, 1);
  const out = w.posted[0].msg;
  assert.strictEqual(out.type, 'result');
  assert.strictEqual(out.id, 7);

  const local = new ZPV.Engine().compute(stateOf());
  const r = out.result;
  assert.strictEqual(r.N, local.N);
  assert.strictEqual(r.maskCount, local.maskCount);
  assert.strictEqual(r.psf.length, local.psf.length);
  for (let i = 0; i < r.psf.length; i++) {
    assert.strictEqual(r.psf[i], local.psf[i], `psf[${i}] が一致しません`);
  }
  for (const k of ['pv', 'rms', 'strehlDefinition', 'strehlPeak', 'marechal', 'ee']) {
    assert.ok(Math.abs(r.metrics[k] - local.metrics[k]) < 1e-12, `${k}: ${r.metrics[k]} != ${local.metrics[k]}`);
  }
});

test('転送リストが正しい（重複が無く、payload の配列とだけ対応する）', () => {
  const w = makeWorker();
  w.send({
    type: 'compute', id: 1,
    state: { N: 64, q: 4, pupil: { shape: 'circular' }, coeffs: { 4: 0.2 } }
  });
  const { msg, transfer } = w.posted[0];
  const r = msg.result;

  // 転送リストは ArrayBuffer のみ、かつ重複が無いこと
  assert.ok(transfer.length > 0);
  const seen = new Set();
  for (const b of transfer) {
    assert.ok(b instanceof ArrayBuffer || Object.prototype.toString.call(b) === '[object ArrayBuffer]',
      '転送リストに ArrayBuffer 以外が含まれています');
    assert.ok(!seen.has(b), '転送リストに同じ ArrayBuffer が重複しています');
    seen.add(b);
  }
  // payload に含まれる配列の buffer がすべて転送対象になっていること
  const arrays = [r.wavefront, r.amplitude, r.mask, r.psf,
    r.profile.radiusLD, r.profile.value, r.idealProfile.radiusLD, r.idealProfile.value];
  for (const a of arrays) assert.ok(seen.has(a.buffer), '転送されない配列があります');

  // idealProfile はエンジン内でキャッシュされているため、コピーを渡していること
  const w2 = makeWorker();
  w2.send({ type: 'compute', id: 1, state: { N: 64, q: 4, pupil: { shape: 'circular' }, coeffs: {} } });
  w2.send({ type: 'compute', id: 2, state: { N: 64, q: 4, pupil: { shape: 'circular' }, coeffs: { 4: 0.1 } } });
  assert.strictEqual(w2.posted.length, 2);
  assert.notStrictEqual(
    w2.posted[0].msg.result.idealProfile.value,
    w2.posted[1].msg.result.idealProfile.value,
    '2 回目も同じ配列を転送すると 1 回目で detach 済みになる'
  );
  assert.ok(w2.posted[1].msg.result.idealProfile.value.length > 0);
});

test('計算が失敗したらエラーを返す（沈黙しない）', () => {
  const w = makeWorker();
  w.send({ type: 'compute', id: 3, state: { N: 0, q: 0, pupil: {}, coeffs: {} } });
  assert.strictEqual(w.posted.length, 1);
  assert.strictEqual(w.posted[0].msg.type, 'error');
  assert.strictEqual(w.posted[0].msg.id, 3);
  assert.ok(w.posted[0].msg.message.length > 0);
});

test('未知のメッセージは無視する', () => {
  const w = makeWorker();
  w.send({ type: 'なんだこれ' });
  w.send(null);
  assert.strictEqual(w.posted.length, 0);
});
