/* UI 本体。SPEC.md §9 / §6
 * 計算は Web Worker（作れない環境では同一スレッドの Engine）に投げ、
 * 表示パラメータの変更は再計算せずシェーダのユニフォーム更新だけで済ませる。
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var noll = ZPV.noll;

  /* ---------------- 状態 ---------------- */
  var state = {
    N: 1024,
    q: 4,
    previewN: 512,
    pupil: {
      shape: 'circular',
      obscurationRatio: 0,
      spider: { count: 0, widthPixels: 2, rotationDeg: 0 },
      apodization: { type: 'none', width: 0.7 },
      rect: { halfWidth: 1, halfHeight: 1 }
    },
    coeffs: {},
    unit: 'rad',
    wavelengthNm: 550,
    nMax: 20,
    sliderRange: 2,
    filter: '',
    nonZeroOnly: false,
    excludePistonTilt: true,
    display: {
      pupilView: 'wavefront',
      pupilColormap: 'coolwarm',
      psfScale: 'log',
      psfLogFloorDb: -50,
      psfGamma: 0.4,
      psfZoomLambdaOverD: 16,
      psfColormap: 'viridis'
    },
    expanded: new Set([0, 1, 2, 3, 4])
  };

  var last = null;          // 直近の計算結果
  var undoStack = [];
  var redoStack = [];
  var busy = false;
  var pendingState = null;  // 未送信の最新リクエスト（中間の入力は捨てる）
  var seq = 0;
  var pupilView, psfView, plot;

  /* ---------------- 計算バックエンド ----------------
   *
   * 通常は Blob URL から作った Web Worker で計算する（file:// でも動作する）。
   * ただし Worker の生成が拒否されたり、生成できても起動しない環境がありうる。
   * その場合 onerror が飛ばず沈黙することがあるため、ping/pong のハンドシェイクに
   * タイムアウトを付けて判定し、応答が無ければメインスレッド実行に切り替える。
   */
  var HANDSHAKE_MS = 800;
  var backend = { kind: 'pending', worker: null, engine: null, reason: '' };

  /* URL に ?backend=main / ?backend=worker を付けると経路を固定できる
   * （テストの決定性確保と、Worker が不調な環境での回避に使う）。 */
  function forcedBackend() {
    var m = /[?&]backend=(main|worker)/.exec(String(location.search || ''));
    return m ? m[1] : null;
  }

  function initBackend() {
    var forced = forcedBackend();
    if (forced === 'main') {
      useMainThread('URL の ?backend=main で指定されました');
      return;
    }
    var srcEl = document.getElementById('zpv-worker-src');
    if (!srcEl || typeof Worker === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      useMainThread('Worker API が使えません');
      return;
    }
    var timer = forced === 'worker' ? null : setTimeout(function () {
      useMainThread('Worker が ' + HANDSHAKE_MS + 'ms 以内に応答しませんでした');
    }, HANDSHAKE_MS);
    try {
      var blob = new Blob([srcEl.textContent], { type: 'text/javascript' });
      var w = new Worker(URL.createObjectURL(blob));
      w.onmessage = function (e) {
        if (e.data && e.data.type === 'pong') {
          if (backend.kind !== 'pending') return; // 既にフォールバック済み
          if (timer) clearTimeout(timer);
          backend = { kind: 'worker', worker: w, engine: null, reason: '' };
          updateBackendLabel();
          pump();
          return;
        }
        onWorkerMessage(e);
      };
      w.onerror = function (e) {
        if (timer) clearTimeout(timer);
        if (backend.kind === 'pending') useMainThread('Worker の起動に失敗: ' + (e.message || ''));
        else showError('Worker でエラーが発生しました: ' + (e.message || ''));
      };
      backend.worker = w;
      w.postMessage({ type: 'ping' });
    } catch (e) {
      if (timer) clearTimeout(timer);
      useMainThread('Worker を作成できません: ' + e.message);
    }
  }

  function useMainThread(reason) {
    if (backend.kind === 'main') return;
    if (backend.worker) { try { backend.worker.terminate(); } catch (e) { /* noop */ } }
    backend = { kind: 'main', worker: null, engine: new ZPV.Engine(), reason: reason || '' };
    updateBackendLabel();
    pump();
  }

  function onWorkerMessage(e) {
    var msg = e.data;
    if (msg.type === 'result') {
      busy = false;
      applyResult(msg.result);
      pump();
    } else if (msg.type === 'error') {
      busy = false;
      showError('計算に失敗しました: ' + msg.message + '\n' + msg.stack);
      pump();
    }
  }

  function snapshotState(preview) {
    var N = preview && state.previewN && state.previewN < state.N ? state.previewN : state.N;
    return {
      N: N,
      q: state.q,
      pupil: JSON.parse(JSON.stringify(state.pupil)),
      coeffs: Object.assign({}, state.coeffs),
      excludePistonTilt: state.excludePistonTilt,
      eeRadiusLD: 3
    };
  }

  function requestCompute(preview) {
    pendingState = snapshotState(preview);
    pump();
  }

  /* 常に最新のリクエストだけを処理し、中間の入力は捨てる（SPEC.md §8.2） */
  function pump() {
    if (backend.kind === 'pending' || busy || !pendingState) return;
    var s = pendingState;
    pendingState = null;
    busy = true;
    seq++;
    if (backend.kind === 'worker') {
      backend.worker.postMessage({ type: 'compute', id: seq, state: s });
      return;
    }
    // メインスレッド実行。描画を先に反映させるため 1 tick 譲る
    setTimeout(function () {
      try {
        var r = backend.engine.compute(s);
        busy = false;
        applyResult(r);
        pump();
      } catch (err) {
        busy = false;
        showError('計算に失敗しました: ' + err.message + '\n' + (err.stack || ''));
        pump();
      }
    }, 0);
  }

  function updateBackendLabel() {
    var el = $('stBackend');
    if (!el) return;
    el.textContent =
      (backend.kind === 'worker' ? 'Worker' : backend.kind === 'main' ? 'メインスレッド' : '準備中') +
      ' / ' + (psfView ? psfView.backend : '-');
    el.title = backend.reason || '';
  }

  /* ---------------- 結果の反映 ---------------- */
  function applyResult(r) {
    last = r;
    var pupilData = state.display.pupilView === 'amplitude' ? r.amplitude : r.wavefront;
    pupilView.setData(pupilData, r.N, r.mask);
    psfView.setData(r.psf, r.N, null);
    updateViewParams();
    updateMetrics(r);
    updatePlot(r);
    updateStatus(r);
  }

  function updateViewParams() {
    if (!last) return;
    var r = last;
    var d = state.display;

    var amp = d.pupilView === 'amplitude';
    var lim = Math.max(Math.abs(r.wavefrontMin), Math.abs(r.wavefrontMax), 1e-9);
    pupilView.setParams({
      mode: 'linear',
      vmin: amp ? 0 : -lim,
      vmax: amp ? 1 : lim,
      colormap: amp ? 'grayscale' : d.pupilColormap,
      useMask: true,
      centerX: 0.5,
      centerY: 0.5,
      halfExtent: Math.min(0.5, (0.56 * r.pupilDiameterPx) / r.N)
    });
    setColorbar('cbPupil', amp ? 'grayscale' : d.pupilColormap,
      amp ? '1.00' : fmt(lim), amp ? '0.00' : fmt(-lim), 'pupHi', 'pupLo');

    var halfPx = d.psfZoomLambdaOverD * r.q;
    psfView.setParams({
      mode: d.psfScale,
      vmin: 0,
      vmax: r.psfPeak,
      floorDb: d.psfLogFloorDb,
      gamma: d.psfGamma,
      colormap: d.psfColormap,
      centerX: 0.5,
      centerY: 0.5,
      halfExtent: Math.min(0.5, halfPx / r.N)
    });
    setColorbar('cbPsf', d.psfColormap,
      d.psfScale === 'log' ? '0 dB' : fmt(r.psfPeak),
      d.psfScale === 'log' ? d.psfLogFloorDb + ' dB' : '0',
      'psfHi', 'psfLo');

    pupilView.render();
    psfView.render();
  }

  function setColorbar(canvasId, cmap, hi, lo, hiId, loId) {
    var cv = $(canvasId);
    var ctx = cv.getContext('2d');
    var lut = ZPV.colormaps.lut(cmap);
    var img = ctx.createImageData(cv.width, cv.height);
    for (var y = 0; y < cv.height; y++) {
      var t = 1 - y / (cv.height - 1);
      var idx = Math.round(t * 255) * 3;
      for (var x = 0; x < cv.width; x++) {
        var o = (y * cv.width + x) * 4;
        img.data[o] = lut[idx];
        img.data[o + 1] = lut[idx + 1];
        img.data[o + 2] = lut[idx + 2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    $(hiId).textContent = hi;
    $(loId).textContent = lo;
  }

  function fmt(v) {
    if (!isFinite(v)) return '–';
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a < 1e-3 || a >= 1e5) return v.toExponential(1);
    return v.toPrecision(3);
  }

  function updateMetrics(r) {
    var m = r.metrics;
    var scale = ZPV.io.radToUnit(state.unit, state.wavelengthNm);
    var u = unitLabel();
    $('mRms').textContent = (m.rms * scale).toPrecision(3) + ' ' + u;
    $('mPv').textContent = (m.pv * scale).toPrecision(3) + ' ' + u;
    $('mStrehl').textContent = m.strehlDefinition.toFixed(4);
    $('mStrehlPk').textContent = m.strehlPeak.toFixed(4);
    $('mMarechal').textContent = m.marechal.toFixed(4);
    $('mFwhm').textContent = isFinite(m.fwhm) ? m.fwhm.toFixed(3) + ' λ/D' : '–';
    $('mEe').textContent = m.ee.toFixed(4);
    $('mModes').textContent = m.modeCount + ' / ' + noll.J_MAX;
    var nonCircular = state.pupil.obscurationRatio > 0 ||
      state.pupil.spider.count > 0 || state.pupil.shape !== 'circular' ||
      state.pupil.apodization.type !== 'none';
    $('mNote').textContent = nonCircular
      ? '※ 非円形瞳のため Zernike の直交性は崩れています（RMS はマップから数値計算）'
      : '';
  }

  function updatePlot(r) {
    var q = r.q;
    var half = Math.min(state.display.psfZoomLambdaOverD, r.N / 2 / q);
    var n = Math.round(half * q);
    var xs = [];
    var ys = [];
    var ideal = [];
    var row = r.N / 2;
    var col = r.N / 2;
    for (var k = -n; k <= n; k++) {
      var c = col + k;
      if (c < 0 || c >= r.N) continue;
      xs.push(k / q);
      ys.push(r.psf[row * r.N + c] / Math.max(r.psfPeak, 1e-30));
      ideal.push(ZPV.metrics.airy(Math.abs(k) / q));
    }
    var logY = state.display.psfScale === 'log';
    plot.draw(
      [
        { x: xs, y: ideal, color: '#8b93a7', dash: [3, 3], label: '理想 Airy' },
        { x: xs, y: ys, color: '#58a6ff', label: '実測' }
      ],
      {
        logY: logY,
        ymin: logY ? Math.pow(10, state.display.psfLogFloorDb / 10) : 0,
        ymax: 1,
        xlabel: 'λ/D'
      }
    );
  }

  function updateStatus(r) {
    $('stGrid').textContent =
      'N=' + r.N + ' q=' + r.q + ' 瞳直径=' + r.pupilDiameterPx.toFixed(2) + 'px' +
      ' (マスク内 ' + r.maskCount.toLocaleString() + ' 画素)';
    $('stTime').textContent =
      '計算 ' + r.timings.total.toFixed(1) + ' ms' +
      ' (波面 ' + r.timings.wavefront.toFixed(1) + ' / FFT ' + r.timings.fft.toFixed(1) + ')';
    updateBackendLabel();
    $('stCache').textContent =
      '基底 ' + r.cache.entries + ' 件 ' + (r.cache.bytes / 1048576).toFixed(1) + ' MB';
    $('outDpix').textContent = r.pupilDiameterPx.toFixed(2) + ' 画素';
  }

  function showError(msg) {
    var box = $('errBox');
    box.style.display = 'block';
    box.textContent = msg;
  }

  /* ---------------- 係数表 ---------------- */
  function unitLabel() {
    return state.unit === 'rad' ? 'rad' : state.unit === 'waves' ? 'λ' : 'nm';
  }

  function toDisplay(rad) { return rad * ZPV.io.radToUnit(state.unit, state.wavelengthNm); }
  function toRad(v) { return v * ZPV.io.unitToRad(state.unit, state.wavelengthNm); }

  function matchesFilter(j, nm) {
    if (!state.filter) return true;
    var f = state.filter.toLowerCase();
    var text = j + ' (' + nm.n + ',' + nm.m + ') ' + noll.modeName(nm.n, nm.m) +
      ' osa' + noll.nmToOsa(nm.n, nm.m) + ' fringe' + noll.nmToFringe(nm.n, nm.m);
    return text.toLowerCase().indexOf(f) >= 0;
  }

  function buildTable() {
    var host = $('coeffTable');
    host.textContent = '';
    var range = toDisplay(state.sliderRange);
    var step = range / 1000;
    var frag = document.createDocumentFragment();

    for (var n = 0; n <= state.nMax; n++) {
      var range2 = noll.nollRangeForOrder(n);
      var rows = [];
      var nz = 0;
      for (var j = range2[0]; j <= range2[1]; j++) {
        var nm = noll.nollToNM(j);
        if (state.coeffs[j]) nz++;
        if (state.nonZeroOnly && !state.coeffs[j]) continue;
        if (!matchesFilter(j, nm)) continue;
        rows.push({ j: j, nm: nm });
      }
      if (!rows.length && (state.nonZeroOnly || state.filter)) continue;

      var open = state.expanded.has(n) || !!state.filter;
      var grp = document.createElement('div');
      grp.className = 'grp' + (nz ? ' has-nz' : '');
      grp.dataset.order = n;
      grp.innerHTML =
        '<span class="caret">' + (open ? '▼' : '▶') + '</span>' +
        '<span>n = ' + n + '</span>' +
        '<span class="cnt">' + (range2[1] - range2[0] + 1) + ' 項' +
        (nz ? ' / 非ゼロ ' + nz : '') + '</span>';
      frag.appendChild(grp);
      if (!open) continue;

      for (var i = 0; i < rows.length; i++) {
        var j2 = rows[i].j;
        var nm2 = rows[i].nm;
        var val = toDisplay(state.coeffs[j2] || 0);
        var el = document.createElement('div');
        el.className = 'crow' + (state.coeffs[j2] ? ' nz' : '');
        el.dataset.j = j2;
        el.innerHTML =
          '<span class="j">' + j2 + '</span>' +
          '<span class="nm">(' + nm2.n + ',' + (nm2.m >= 0 ? '+' : '') + nm2.m + ')</span>' +
          '<span class="nme" title="Noll ' + j2 + ' / OSA ' + noll.nmToOsa(nm2.n, nm2.m) +
          ' / Fringe ' + noll.nmToFringe(nm2.n, nm2.m) + '（名称は表示用ラベル）">' +
          noll.modeName(nm2.n, nm2.m) + '</span>' +
          '<input type="number" class="val" step="' + (step * 10).toPrecision(2) +
          '" value="' + trimNum(val) + '">' +
          '<input type="range" class="sld" min="' + -range + '" max="' + range +
          '" step="' + step + '" value="' + val + '">';
        frag.appendChild(el);
      }
    }
    host.appendChild(frag);
  }

  function trimNum(v) {
    if (!v) return '0';
    return Number(v.toPrecision(6)).toString();
  }

  /* 値だけを更新する（表の再構築を避ける） */
  function refreshRowValues() {
    var rows = $('coeffTable').querySelectorAll('.crow');
    for (var i = 0; i < rows.length; i++) {
      var j = Number(rows[i].dataset.j);
      var v = toDisplay(state.coeffs[j] || 0);
      var num = rows[i].querySelector('.val');
      var sld = rows[i].querySelector('.sld');
      if (document.activeElement !== num) num.value = trimNum(v);
      if (document.activeElement !== sld) sld.value = v;
      rows[i].classList.toggle('nz', !!state.coeffs[j]);
    }
  }

  /* ---------------- Undo / Redo ---------------- */
  function pushUndo() {
    undoStack.push(Object.assign({}, state.coeffs));
    if (undoStack.length > 32) undoStack.shift();
    redoStack.length = 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(Object.assign({}, state.coeffs));
    state.coeffs = undoStack.pop();
    buildTable();
    requestCompute(false);
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(Object.assign({}, state.coeffs));
    state.coeffs = redoStack.pop();
    buildTable();
    requestCompute(false);
  }

  /* ---------------- ファイル入出力 ---------------- */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function pickFile(accept, cb) {
    var inp = $('filePicker');
    inp.accept = accept;
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { cb(String(fr.result), f.name); inp.value = ''; };
      fr.readAsText(f);
    };
    inp.click();
  }

  function exportPng() {
    var src = $('cvPsf');
    var w = src.width;
    var h = src.height;
    var out = document.createElement('canvas');
    out.width = w;
    out.height = h + 26;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    ctx.fillStyle = '#d6dbe6';
    ctx.font = '12px sans-serif';
    var r = last || {};
    ctx.fillText(
      'PSF  N=' + r.N + ' q=' + r.q + '  ±' + state.display.psfZoomLambdaOverD +
      ' λ/D  ' + state.display.psfScale +
      (state.display.psfScale === 'log' ? ' (' + state.display.psfLogFloorDb + ' dB)' : '') +
      '  Strehl=' + (r.metrics ? r.metrics.strehlDefinition.toFixed(4) : '-'),
      6, h + 17
    );
    out.toBlob(function (b) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'psf.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    });
  }

  /* ---------------- キャンバスのサイズ調整 ---------------- */
  function resizeCanvas(cv) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var r = cv.parentElement.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
    return false;
  }

  function resizeAll() {
    resizeCanvas($('cvPupil'));
    resizeCanvas($('cvPsf'));
    var p = $('plot');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    p.width = Math.max(1, Math.round(p.clientWidth * dpr));
    p.height = Math.max(1, Math.round(p.clientHeight * dpr));
    pupilView.render();
    psfView.render();
    if (last) updatePlot(last);
  }

  /* ---------------- イベント ---------------- */
  function onCoeffInput(e) {
    var rowEl = e.target.closest('.crow');
    if (!rowEl) return;
    var j = Number(rowEl.dataset.j);
    var v = Number(e.target.value);
    if (!isFinite(v)) return;
    state.coeffs[j] = toRad(v);
    if (!state.coeffs[j]) delete state.coeffs[j];
    rowEl.classList.toggle('nz', !!state.coeffs[j]);
    var other = e.target.classList.contains('sld') ? rowEl.querySelector('.val') : rowEl.querySelector('.sld');
    other.value = e.target.classList.contains('sld') ? trimNum(v) : v;
    requestCompute(e.type === 'input' && e.target.classList.contains('sld'));
  }

  function bind() {
    var t = $('coeffTable');
    t.addEventListener('input', onCoeffInput);
    t.addEventListener('change', function (e) {
      if (e.target.closest('.crow')) { pushUndo(); requestCompute(false); }
    });
    t.addEventListener('click', function (e) {
      var g = e.target.closest('.grp');
      if (!g) return;
      var n = Number(g.dataset.order);
      if (state.expanded.has(n)) state.expanded.delete(n);
      else state.expanded.add(n);
      buildTable();
    });

    // グリッド・瞳
    $('inN').onchange = function () { state.N = Number(this.value); requestCompute(false); };
    $('inQ').onchange = function () { state.q = Number(this.value) || 4; requestCompute(false); };
    $('inPreview').onchange = function () { state.previewN = Number(this.value); };
    $('inShape').onchange = function () { state.pupil.shape = this.value; requestCompute(false); };
    $('inEps').onchange = function () { state.pupil.obscurationRatio = Number(this.value) || 0; requestCompute(false); };
    $('inSpider').onchange = function () { state.pupil.spider.count = Number(this.value); requestCompute(false); };
    $('inSpiderW').onchange = function () { state.pupil.spider.widthPixels = Number(this.value) || 2; requestCompute(false); };
    $('inApod').onchange = function () { state.pupil.apodization.type = this.value; requestCompute(false); };
    $('inApodW').onchange = function () { state.pupil.apodization.width = Number(this.value) || 0.7; requestCompute(false); };

    // 係数表の見せ方
    $('inUnit').onchange = function () { state.unit = this.value; buildTable(); if (last) updateMetrics(last); };
    $('inLambda').onchange = function () { state.wavelengthNm = Number(this.value) || 550; buildTable(); if (last) updateMetrics(last); };
    $('inNmax').onchange = function () { state.nMax = Number(this.value); buildTable(); };
    $('inRange').onchange = function () { state.sliderRange = Number(this.value) || 2; buildTable(); };
    $('inFilter').oninput = function () { state.filter = this.value.trim(); buildTable(); };
    $('inNonZero').onchange = function () { state.nonZeroOnly = this.checked; buildTable(); };
    $('btnExpandAll').onclick = function () {
      for (var n = 0; n <= state.nMax; n++) state.expanded.add(n);
      buildTable();
    };
    $('btnCollapseAll').onclick = function () { state.expanded.clear(); buildTable(); };

    // 表示
    $('inPupilView').onchange = function () {
      state.display.pupilView = this.value;
      if (last) applyResult(last);
    };
    $('inPupCmap').onchange = function () { state.display.pupilColormap = this.value; updateViewParams(); };
    $('inPsfCmap').onchange = function () { state.display.psfColormap = this.value; updateViewParams(); };
    $('inScale').onchange = function () {
      state.display.psfScale = this.value;
      $('inFloor').style.display = this.value === 'log' ? '' : 'none';
      $('inGamma').style.display = this.value === 'gamma' ? '' : 'none';
      updateViewParams();
      if (last) updatePlot(last);
    };
    $('inFloor').oninput = function () {
      state.display.psfLogFloorDb = Number(this.value) || -50;
      updateViewParams();
      if (last) updatePlot(last);
    };
    $('inGamma').oninput = function () { state.display.psfGamma = Number(this.value) || 0.4; updateViewParams(); };
    $('inZoom').oninput = function () {
      state.display.psfZoomLambdaOverD = Math.max(0.5, Number(this.value) || 16);
      updateViewParams();
      if (last) updatePlot(last);
    };
    $('inExclude').onchange = function () { state.excludePistonTilt = this.checked; requestCompute(false); };

    // ボタン
    $('btnClear').onclick = function () { pushUndo(); state.coeffs = {}; buildTable(); requestCompute(false); };
    $('btnRandom').onclick = function () {
      pushUndo();
      state.coeffs = {};
      var total = 0.8; // RMS 合計 [rad]
      var jmax = noll.nollRangeForOrder(Math.min(state.nMax, 6))[1];
      var vals = [];
      for (var j = 4; j <= jmax; j++) vals.push((Math.random() * 2 - 1) / Math.pow(noll.nollToNM(j).n, 1.2));
      var norm = Math.sqrt(vals.reduce(function (a, b) { return a + b * b; }, 0)) || 1;
      for (var k = 0; k < vals.length; k++) state.coeffs[4 + k] = (vals[k] / norm) * total;
      buildTable();
      requestCompute(false);
    };
    $('btnUndo').onclick = undo;
    $('btnRedo').onclick = redo;
    $('btnHelp').onclick = function () { $('dlgHelp').showModal(); };

    $('btnSave').onclick = function () {
      download('zernike-psf.zpsf.json', JSON.stringify(ZPV.io.toJson(state), null, 2), 'application/json');
    };
    $('btnLoad').onclick = function () {
      pickFile('.json', function (text) {
        try {
          var s = ZPV.io.fromJson(JSON.parse(text));
          pushUndo();
          if (s.coeffs) state.coeffs = s.coeffs;
          if (s.pupil) state.pupil = ZPV.pupil.merge(state.pupil, s.pupil);
          if (s.N) state.N = s.N;
          if (s.q) state.q = s.q;
          if (s.wavelengthNm) state.wavelengthNm = s.wavelengthNm;
          if (s.display) Object.assign(state.display, s.display);
          syncControls();
          buildTable();
          requestCompute(false);
        } catch (err) {
          showError('読込に失敗しました: ' + err.message);
        }
      });
    };
    $('btnCsvIn').onclick = function () {
      pickFile('.csv,.txt', function (text) {
        var startStr = window.prompt(
          '先頭要素に対応する Noll 番号を入力してください。\n' +
          '（torchmfbd のモード列はピストンを含まないため 2 です）', '1');
        if (startStr === null) return;
        try {
          var res = ZPV.io.parseCoefficientCsv(text, {
            scheme: 'Noll',
            nollStart: Number(startStr) || 1,
            unit: state.unit,
            wavelengthNm: state.wavelengthNm
          });
          pushUndo();
          state.coeffs = res.coeffs;
          buildTable();
          requestCompute(false);
          if (res.warnings.length) showError(res.warnings.join('\n'));
          else $('errBox').style.display = 'none';
        } catch (err) {
          showError('CSV の読込に失敗しました: ' + err.message);
        }
      });
    };
    $('btnCsvOut').onclick = function () {
      download('zernike-coefficients.csv',
        ZPV.io.formatCoefficientCsv(state.coeffs, { unit: state.unit, wavelengthNm: state.wavelengthNm }),
        'text/csv;charset=utf-8');
    };
    $('btnPng').onclick = exportPng;

    // カーソル読み取りとホイールズーム
    hookCanvas($('cvPsf'), psfView, function (p, r) {
      var x = (p.col - r.N / 2) / r.q;
      var y = (p.row - r.N / 2) / r.q;
      return 'PSF (' + x.toFixed(2) + ', ' + y.toFixed(2) + ') λ/D  I=' +
        (p.value / Math.max(r.psfPeak, 1e-30)).toExponential(3) + ' (ピーク比)';
    });
    hookCanvas($('cvPupil'), pupilView, function (p, r) {
      var half = r.pupilDiameterPx / 2;
      var x = (p.col - r.N / 2) / half;
      var y = (p.row - r.N / 2) / half;
      var v = pupilView.data[p.row * r.N + p.col];
      return '瞳 (' + x.toFixed(3) + ', ' + y.toFixed(3) + ')  ' +
        (state.display.pupilView === 'amplitude' ? 'A=' + v.toFixed(3) : 'W=' + v.toFixed(4) + ' rad');
    });

    $('cvPsf').addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY > 0 ? 1.25 : 0.8;
      state.display.psfZoomLambdaOverD = Math.max(0.5, Math.min(256, state.display.psfZoomLambdaOverD * f));
      $('inZoom').value = state.display.psfZoomLambdaOverD.toFixed(1);
      updateViewParams();
      if (last) updatePlot(last);
    }, { passive: false });

    window.addEventListener('resize', resizeAll);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
  }

  function hookCanvas(cv, view, formatter) {
    cv.addEventListener('mousemove', function (e) {
      if (!last) return;
      var b = cv.getBoundingClientRect();
      var p = view.pickIndex((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height);
      $('stCursor').textContent = p ? formatter(p, last) : '–';
    });
    cv.addEventListener('mouseleave', function () { $('stCursor').textContent = '–'; });
  }

  var compareSaved = null;

  function onKeyUp(e) {
    if (e.key === ' ' && compareSaved !== null) {
      state.coeffs = compareSaved;
      compareSaved = null;
      requestCompute(false);
    }
  }

  function onKey(e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' && e.target.type !== 'range';
    if (e.ctrlKey || e.metaKey) {
      var k = e.key.toLowerCase();
      if (k === 'f') { e.preventDefault(); $('inFilter').focus(); $('inFilter').select(); }
      else if (k === 'n') { e.preventDefault(); $('btnClear').click(); }
      else if (k === 's') { e.preventDefault(); $('btnSave').click(); }
      else if (k === 'o') { e.preventDefault(); $('btnLoad').click(); }
      else if (k === 'e') { e.preventDefault(); $('btnPng').click(); }
      else if (k === 'z') { e.preventDefault(); undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      return;
    }
    if (e.key === 'F1') { e.preventDefault(); $('dlgHelp').showModal(); return; }
    if (e.key === ' ' && !typing && compareSaved === null) {
      // 押している間だけ無収差状態を表示する
      e.preventDefault();
      compareSaved = state.coeffs;
      state.coeffs = {};
      requestCompute(false);
      return;
    }
    if (typing) {
      var row = e.target.closest && e.target.closest('.crow');
      if (row && (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
                  e.key === 'PageUp' || e.key === 'PageDown')) {
        e.preventDefault();
        var stepRad = e.key === 'PageUp' || e.key === 'PageDown' ? 0.5 : (e.shiftKey ? 0.005 : 0.05);
        var sign = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : -1;
        var j = Number(row.dataset.j);
        state.coeffs[j] = (state.coeffs[j] || 0) + sign * stepRad;
        if (!state.coeffs[j]) delete state.coeffs[j];
        e.target.value = trimNum(toDisplay(state.coeffs[j] || 0));
        row.querySelector('.sld').value = toDisplay(state.coeffs[j] || 0);
        row.classList.toggle('nz', !!state.coeffs[j]);
        requestCompute(false);
      }
      return;
    }
    if (e.key === 'l' || e.key === 'L') {
      var sel = $('inScale');
      sel.value = sel.value === 'log' ? 'linear' : 'log';
      sel.onchange();
    } else if (e.key === 'r' || e.key === 'R') {
      if (last) updateViewParams();
    }
  }

  function syncControls() {
    $('inN').value = String(state.N);
    $('inQ').value = state.q;
    $('inPreview').value = String(state.previewN);
    $('inShape').value = state.pupil.shape;
    $('inEps').value = state.pupil.obscurationRatio;
    $('inSpider').value = String(state.pupil.spider.count);
    $('inSpiderW').value = state.pupil.spider.widthPixels;
    $('inApod').value = state.pupil.apodization.type;
    $('inApodW').value = state.pupil.apodization.width;
    $('inUnit').value = state.unit;
    $('inLambda').value = state.wavelengthNm;
    $('inNmax').value = String(state.nMax);
    $('inRange').value = state.sliderRange;
    $('inNonZero').checked = state.nonZeroOnly;
    $('inExclude').checked = state.excludePistonTilt;
    $('inPupilView').value = state.display.pupilView;
    $('inPupCmap').value = state.display.pupilColormap;
    $('inPsfCmap').value = state.display.psfColormap;
    $('inScale').value = state.display.psfScale;
    $('inFloor').value = state.display.psfLogFloorDb;
    $('inGamma').value = state.display.psfGamma;
    $('inZoom').value = state.display.psfZoomLambdaOverD;
    $('inFloor').style.display = state.display.psfScale === 'log' ? '' : 'none';
    $('inGamma').style.display = state.display.psfScale === 'gamma' ? '' : 'none';
  }

  function fillColormapSelects() {
    ['inPupCmap', 'inPsfCmap'].forEach(function (id) {
      var sel = $(id);
      ZPV.colormaps.names.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n;
        o.textContent = ZPV.colormaps.labels[n] || n;
        sel.appendChild(o);
      });
    });
  }

  /* ---------------- 起動 ---------------- */
  function start() {
    window.addEventListener('error', function (e) {
      showError('未捕捉のエラー: ' + (e.message || '') + '\n' + ((e.error && e.error.stack) || ''));
    });
    window.addEventListener('unhandledrejection', function (e) {
      showError('未処理の Promise 拒否: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
    });
    pupilView = new ZPV.ImageView($('cvPupil'));
    psfView = new ZPV.ImageView($('cvPsf'));
    plot = new ZPV.LinePlot($('plot'));
    if (psfView.glError) {
      showError('WebGL2 が使えないため Canvas2D で描画します: ' + psfView.glError);
    }
    fillColormapSelects();
    syncControls();
    initBackend();
    bind();
    buildTable();
    // 初期状態はデフォーカスと球面収差を少し入れておく
    state.coeffs = { 4: 0.3, 11: 0.5 };
    buildTable();
    // rAF はフレームを描かない状況（バックグラウンドタブ、ヘッドレスの DOM ダンプ）では
    // 発火しないため、初回計算は rAF に依存させない。
    resizeAll();
    requestCompute(false);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(resizeAll); // レイアウト確定後にもう一度サイズを合わせる
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
