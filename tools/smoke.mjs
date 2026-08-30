/* ビルド済み単一 HTML をヘッドレス Chromium で file:// から開き、
 * UI を実際に操作して検証する（SPEC.md IT-02 / IT-06 / IT-07 / IT-08）。
 *
 *     node tools/smoke.mjs [--chrome <path>] [--keep]
 *
 * 外部依存なし。dist の HTML にテストハーネスを追記した一時ファイルを作り、
 * --dump-dom の出力から結果を読む。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const chromeArg = args.indexOf('--chrome');
const CHROME = chromeArg >= 0 ? args[chromeArg + 1] : findChrome();

function findChrome() {
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome'
  ];
  for (const c of candidates) {
    try { readFileSync(c); return c; } catch (e) { /* next */ }
  }
  return null;
}

const HARNESS = `
<div id="smoke-result">RUNNING</div>
<script>
(function () {
  var log = [];
  var failed = 0;
  // ハーネス自身の例外で RUNNING のまま止まらないようにする
  window.addEventListener('error', function (e) {
    log.push('EXCEPTION | ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
    failed++;
    document.getElementById('smoke-result').textContent = 'FAILED(' + failed + ')\\n' + log.join('\\n');
  });
  function check(name, cond, detail) {
    log.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
    if (!cond) failed++;
    // 途中で止まっても、どこまで進んだか分かるよう毎回書き出す
    document.getElementById('smoke-result').textContent =
      'RUNNING(' + log.length + ')\\n' + log.join('\\n');
  }
  function finish() {
    document.getElementById('smoke-result').textContent =
      (failed ? 'FAILED(' + failed + ')' : 'OK') + '\\n' + log.join('\\n');
  }
  function waitFor(pred, ms, cb) {
    var t0 = Date.now();
    (function tick() {
      if (pred()) return cb(true);
      if (Date.now() - t0 > ms) return cb(false);
      setTimeout(tick, 40);
    })();
  }
  var $ = function (id) { return document.getElementById(id); };
  var settled = function () { return $('mRms').textContent !== '\\u2013'; };

  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  waitFor(settled, 12000, function (ok) {
    check('初期計算が完了する', ok,
      'grid=' + $('stGrid').textContent + ' backend=' + $('stBackend').textContent +
      ' err=' + ($('errBox').textContent || 'なし').slice(0, 300) +
      ' search=' + location.search + ' ZPV=' + (typeof window.ZPV));
    if (!ok) return finish();

    check('コアが公開されている', !!(window.ZPV && ZPV.Engine && ZPV.noll));
    check('Noll 231 モードまで扱える', ZPV.noll.J_MAX === 231);
    check('描画バックエンド', /webgl2|canvas2d/.test($('stBackend').textContent),
      $('stBackend').textContent);
    check('?backend=main が効く', /メインスレッド/.test($('stBackend').textContent),
      $('stBackend').textContent);
    check('errBox にエラーが出ていない', $('errBox').style.display !== 'block',
      $('errBox').textContent.slice(0, 200));

    var strehl0 = parseFloat($('mStrehl').textContent);
    check('初期 Strehl が妥当', strehl0 > 0 && strehl0 < 1, String(strehl0));
    check('FWHM が算出されている', /λ\\/D/.test($('mFwhm').textContent), $('mFwhm').textContent);

    // IT-08: 231 行すべて展開
    // 注: --virtual-time-budget 下では Date.now() が仮想時間で進むため、
    //     ここで所要時間を測っても意味がない。性能は tools/bench.js で測る。
    $('btnExpandAll').click();
    var rows = document.querySelectorAll('#coeffTable .crow').length;
    check('全 231 行を展開できる', rows === 231, rows + ' 行');
    check('折りたたみに戻せる', ($('btnCollapseAll').click(),
      document.querySelectorAll('#coeffTable .crow').length === 0));
    $('btnExpandAll').click();

    // 高次モード (Noll 231, n=20) を入力して再計算されること
    var row231 = document.querySelector('#coeffTable .crow[data-j="231"]');
    check('Noll 231 の行が存在する', !!row231);
    if (row231) {
      var inp = row231.querySelector('.val');
      inp.value = '0.8';
      fire(inp, 'input');
      fire(inp, 'change');
    }

    waitFor(function () { return parseFloat($('mStrehl').textContent) !== strehl0; }, 8000, function (ok2) {
      check('n=20 モードの入力で再計算される', ok2,
        'Strehl ' + strehl0 + ' -> ' + $('mStrehl').textContent);
      check('n=20 で RMS が増える', parseFloat($('mRms').textContent) > 0.5, $('mRms').textContent);

      // 中心遮蔽
      var maskBefore = $('stGrid').textContent;
      $('inEps').value = '0.4';
      fire($('inEps'), 'change');
      waitFor(function () { return $('stGrid').textContent !== maskBefore; }, 8000, function (ok3) {
        check('中心遮蔽でマスク画素数が変わる', ok3, $('stGrid').textContent);
        check('非円形瞳の注意書きが出る', $('mNote').textContent.length > 0, $('mNote').textContent);

        // 単位切替 rad -> λ
        var rmsRad = parseFloat($('mRms').textContent);
        $('inUnit').value = 'waves';
        fire($('inUnit'), 'change');
        var rmsWaves = parseFloat($('mRms').textContent);
        check('単位切替で RMS が 1/2π になる',
          Math.abs(rmsWaves - rmsRad / (2 * Math.PI)) < 1e-3,
          rmsRad + ' rad -> ' + rmsWaves + ' λ');
        $('inUnit').value = 'rad';
        fire($('inUnit'), 'change');

        // 表示パラメータのみの変更は再計算を伴わない（計算回数が増えないこと）
        var gridBefore = $('stGrid').textContent;
        var timeBefore = $('stTime').textContent;
        $('inScale').value = 'linear';
        $('inScale').onchange();
        $('inZoom').value = '4';
        $('inZoom').oninput();
        check('表示切替で再計算が走らない',
          $('stGrid').textContent === gridBefore && $('stTime').textContent === timeBefore,
          $('stTime').textContent);

        // JSON 往復
        try {
          var json = ZPV.io.toJson({
            coeffs: { 4: 0.3, 231: 0.8 }, wavelengthNm: 550,
            pupil: { shape: 'circular' }, N: 1024, q: 4, previewN: 512, display: {}
          });
          var back = ZPV.io.fromJson(JSON.parse(JSON.stringify(json)));
          check('JSON 往復で係数が保存される',
            Math.abs(back.coeffs[4] - 0.3) < 1e-12 && Math.abs(back.coeffs[231] - 0.8) < 1e-12,
            JSON.stringify(back.coeffs));
        } catch (e) { check('JSON 往復', false, e.message); }

        // CSV 往復（nollStart=2 = torchmfbd 互換）
        try {
          var csv = '0.10\\n0.20\\n0.30\\n';
          var res = ZPV.io.parseCoefficientCsv(csv, { nollStart: 2, unit: 'rad' });
          check('CSV の nollStart=2 が効く',
            Math.abs(res.coeffs[2] - 0.1) < 1e-12 && Math.abs(res.coeffs[4] - 0.3) < 1e-12,
            JSON.stringify(res.coeffs));
          var out = ZPV.io.formatCoefficientCsv({ 4: 0.3 }, { unit: 'rad' });
          check('CSV 書き出しは (n,m,value) 形式', /2,0,0\\.3/.test(out), out.replace(/\\n/g, ' / '));
        } catch (e) { check('CSV 往復', false, e.message); }

        // 絞り込みと非ゼロのみ
        $('inNonZero').checked = true;
        fire($('inNonZero'), 'change');
        var nzRows = document.querySelectorAll('#coeffTable .crow').length;
        check('非ゼロのみ表示が効く', nzRows > 0 && nzRows < 10, nzRows + ' 行');
        $('inNonZero').checked = false;
        fire($('inNonZero'), 'change');
        $('inFilter').value = '球面';
        $('inFilter').oninput();
        var fRows = document.querySelectorAll('#coeffTable .crow').length;
        check('名称での絞り込みが効く', fRows > 0 && fRows < 231, fRows + ' 行');

        // 断面の切替（FR-12）
        var cutBefore = document.getElementById('plot').toDataURL().length;
        $('inCut').value = 'wf-h';
        $('inCut').onchange();
        check('波面の断面に切り替わる', /瞳半径/.test($('cutNote').textContent),
          $('cutNote').textContent);
        check('断面プロットが再描画される',
          document.getElementById('plot').toDataURL().length !== cutBefore);
        $('inCut').value = 'psf-v';
        $('inCut').onchange();
        check('PSF 垂直カットに切り替わる', /ピーク比/.test($('cutNote').textContent),
          $('cutNote').textContent);

        // マップ CSV の書式（FR-19）
        try {
          var mapCsv = ZPV.io.formatMapCsv(new Float32Array([1, 2, 3, 4]), 2, 'type=test');
          var lines = mapCsv.trim().split('\\n');
          check('マップ CSV の形式', lines.length === 3 && lines[0] === '# type=test' &&
            /^1\\.0+,2\\.0+$/.test(lines[1]), JSON.stringify(lines));
        } catch (e) { check('マップ CSV の形式', false, e.message); }

        // 右クリックのコンテキストメニュー（§9.4）
        $('cvPsf').dispatchEvent(new MouseEvent('contextmenu',
          { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
        var menu = $('ctxmenu');
        check('右クリックでメニューが開く', !menu.hidden && menu.children.length >= 3,
          menu.children.length + ' 項目');
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        check('メニュー外クリックで閉じる', menu.hidden);

        // プリセット（FR-15）
        var modesBefore = $('mModes').textContent;
        $('inPreset').value = 'turbulence';
        $('inPreset').onchange();
        waitFor(function () { return $('mModes').textContent !== modesBefore; }, 8000, function (ok4) {
          check('プリセットが適用され再計算される', ok4,
            modesBefore + ' -> ' + $('mModes').textContent);
          check('プリセットの選択は毎回リセットされる', $('inPreset').value === '');

          $('inPreset').value = 'telescope';
          $('inPreset').onchange();
          check('プリセットが瞳設定も変える', $('inEps').value === '0.3' && $('inSpider').value === '4',
            'ε=' + $('inEps').value + ' spider=' + $('inSpider').value);

          check('最終的に未捕捉エラーが無い', $('errBox').style.display !== 'block',
            $('errBox').textContent.slice(0, 200));
          finish();
        });
        return;
      });
    });
  });
})();
</script>
`;

if (!CHROME) {
  console.error('Chromium が見つかりません。--chrome <path> で指定してください。');
  process.exit(2);
}

const html = readFileSync(join(ROOT, 'dist', 'ZernikePsfViewer.html'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'zpv-smoke-'));
const page = join(dir, 'smoke.html');
writeFileSync(page, html.replace('</body>', HARNESS + '</body>'), 'utf8');

const r = spawnSync(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
  '--disable-component-update', '--disable-background-networking', '--disable-sync',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--user-data-dir=' + join(dir, 'profile'),
  '--window-size=1600,1000', '--virtual-time-budget=30000', '--dump-dom',
  // Worker と仮想時間は併用できない（結果を待つ間に仮想時計が budget を使い切る）ため、
  // ここでは計算経路をメインスレッドに固定して決定的にする。
  'file://' + page + '?backend=main'
], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });

const dom = r.stdout || '';
const m = dom.match(/<div id="smoke-result">([\s\S]*?)<\/div>/);
if (!args.includes('--keep')) rmSync(dir, { recursive: true, force: true });

if (!m) {
  console.error('スモークテストの結果を取得できませんでした。');
  console.error((r.stderr || '').split('\n').slice(-10).join('\n'));
  process.exit(1);
}
const text = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
console.log(text);
process.exit(text.startsWith('OK') ? 0 : 1);
