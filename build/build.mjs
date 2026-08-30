/* 単一 HTML へのインライン化ビルド。SPEC.md §3.2 (C-6)
 *
 *     node build/build.mjs
 *
 * 外部依存なし。出力は dist/ZernikePsfViewer.html の 1 ファイルで、
 * file:// から直接開いて動作する（ES モジュールを使わない classic script、
 * Worker は Blob URL 経由）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const CORE = [
  'src/core/nollIndex.js',
  'src/core/zernikePolynomial.js',
  'src/core/pupil.js',
  'src/core/fft.js',
  'src/core/basisCache.js',
  'src/core/psf.js',
  'src/core/metrics.js',
  'src/core/engine.js'
];
const FRONT = [
  'src/render/colormaps.js',
  'src/render/imageView.js',
  'src/render/plot.js',
  'src/io/io.js'
];

const coreSrc = CORE.map(read).join('\n');
const workerSrc = coreSrc + '\n' + read('src/worker/workerGlue.js');
const frontSrc = FRONT.map(read).join('\n');
const appSrc = read('src/ui/app.js');
const css = read('src/ui/app.css');
const body = read('src/ui/app.html');

/* <script> 内にそのまま置くテキストが要素を閉じてしまわないようにする */
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zernike PSF Viewer</title>
<style>
${css}</style>
</head>
<body>
${body}
<script type="text/plain" id="zpv-worker-src">
${safe(workerSrc)}
</script>
<script>
${safe(coreSrc)}
</script>
<script>
${safe(frontSrc)}
</script>
<script>
${safe(appSrc)}
</script>
</body>
</html>
`;

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', 'ZernikePsfViewer.html');
writeFileSync(out, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('生成: dist/ZernikePsfViewer.html  ' + kb(Buffer.byteLength(html)));
console.log('  内訳: core ' + kb(Buffer.byteLength(coreSrc)) +
  ' / worker ' + kb(Buffer.byteLength(workerSrc)) +
  ' / front ' + kb(Buffer.byteLength(frontSrc)) +
  ' / app ' + kb(Buffer.byteLength(appSrc)) +
  ' / css ' + kb(Buffer.byteLength(css)) +
  ' / html ' + kb(Buffer.byteLength(body)));
