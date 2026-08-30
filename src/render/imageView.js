/* 2 次元マップの表示。SPEC.md §3.6 / §9.3
 *
 * WebGL2 が使えれば R32F テクスチャに 1 回アップロードし、
 * 対数/γ/レンジ/カラーマップ/ズームをすべてフラグメントシェーダで処理する
 * （表示パラメータの変更に再計算もアップロードも不要）。
 * 使えない場合は Canvas2D にフォールバックする。
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var VS = [
    '#version 300 es',
    'in vec2 aPos;',
    'out vec2 vUv;',
    'void main() {',
    '  vUv = aPos * 0.5 + 0.5;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler2D;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uData;',
    'uniform sampler2D uMask;',
    'uniform sampler2D uCmap;',
    'uniform vec2 uCenter;',   // テクスチャ座標 (0..1) の中心
    'uniform float uHalf;',    // テクスチャ座標での半幅
    'uniform int uMode;',      // 0: linear, 1: log(dB), 2: gamma
    'uniform float uVmin;',
    'uniform float uVmax;',
    'uniform float uFloorDb;',
    'uniform float uGamma;',
    'uniform int uUseMask;',
    'uniform vec3 uMaskColor;',
    'void main() {',
    '  // 行 0 を画面の上に描くためテクスチャの v 軸を反転する（SPEC.md §9.3）',
    '  vec2 t2 = vec2(vUv.x, 1.0 - vUv.y);',
    '  vec2 uv = uCenter + (t2 - 0.5) * (2.0 * uHalf);',
    '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {',
    '    fragColor = vec4(uMaskColor, 1.0); return;',
    '  }',
    '  if (uUseMask == 1 && texture(uMask, uv).r < 0.5) {',
    '    fragColor = vec4(uMaskColor, 1.0); return;',
    '  }',
    '  float v = texture(uData, uv).r;',
    '  float t;',
    '  if (uMode == 1) {',
    '    float peak = max(uVmax, 1e-30);',
    '    float db = 10.0 * log(max(v, 1e-30) / peak) / log(10.0);',
    '    t = clamp((db - uFloorDb) / (0.0 - uFloorDb), 0.0, 1.0);',
    '  } else {',
    '    t = clamp((v - uVmin) / max(uVmax - uVmin, 1e-30), 0.0, 1.0);',
    '    if (uMode == 2) t = pow(t, uGamma);',
    '  }',
    '  fragColor = vec4(texture(uCmap, vec2(t, 0.5)).rgb, 1.0);',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('シェーダのコンパイルに失敗: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function ImageView(canvas) {
    this.canvas = canvas;
    this.N = 0;
    this.data = null;
    this.mask = null;
    this.params = {
      mode: 'linear',
      vmin: 0,
      vmax: 1,
      floorDb: -50,
      gamma: 0.5,
      colormap: 'viridis',
      centerX: 0.5,
      centerY: 0.5,
      halfExtent: 0.5,
      useMask: false
    };
    this.gl = null;
    this.backend = 'canvas2d';
    try {
      this.initGL();
    } catch (e) {
      this.gl = null;
      this.backend = 'canvas2d';
      this.glError = String(e && e.message ? e.message : e);
    }
    if (!this.gl) this.ctx2d = canvas.getContext('2d');
  }

  ImageView.prototype.initGL = function () {
    var gl = this.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 が利用できません');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      // R32F のテクスチャ自体はコア機能なので拡張が無くても続行する
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('シェーダのリンクに失敗: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.gl = gl;
    this.prog = prog;
    this.u = {};
    ['uData', 'uMask', 'uCmap', 'uCenter', 'uHalf', 'uMode', 'uVmin', 'uVmax', 'uFloorDb', 'uGamma', 'uUseMask', 'uMaskColor']
      .forEach(function (n) { this.u[n] = gl.getUniformLocation(prog, n); }, this);

    this.texData = this.makeTexture(gl);
    this.texMask = this.makeTexture(gl);
    this.texCmap = this.makeTexture(gl);
    this.backend = 'webgl2';
    this.cmapUploaded = null;
  };

  ImageView.prototype.makeTexture = function (gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  /* データを差し替える（計算結果が変わったときだけ呼ぶ）。 */
  ImageView.prototype.setData = function (data, N, mask) {
    this.data = data;
    this.N = N;
    this.mask = mask || null;
    if (this.gl) {
      var gl = this.gl;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texData);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, N, N, 0, gl.RED, gl.FLOAT, data);
      if (mask) {
        // R8 は 0..255 を 0..1 に正規化して読まれるので、内側を 255 にして送る
        // （0/1 のまま送ると内側でも 1/255 = 0.004 になり、マスク判定が常に偽になる）
        if (!this.maskScaled || this.maskScaled.length !== mask.length) {
          this.maskScaled = new Uint8Array(mask.length);
        }
        for (var i = 0; i < mask.length; i++) this.maskScaled[i] = mask[i] ? 255 : 0;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texMask);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, this.maskScaled);
      }
    }
  };

  ImageView.prototype.setParams = function (p) {
    for (var k in p) if (p[k] !== undefined) this.params[k] = p[k];
  };

  ImageView.prototype.render = function () {
    if (!this.data || !this.N) return;
    var w = this.canvas.width;
    var h = this.canvas.height;
    if (!w || !h) return;
    if (this.gl) this.renderGL(w, h);
    else this.render2d(w, h);
  };

  ImageView.prototype.renderGL = function (w, h) {
    var gl = this.gl;
    var p = this.params;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);

    if (this.cmapUploaded !== p.colormap) {
      var lut = ZPV.colormaps.lut(p.colormap);
      var rgba = new Uint8Array(256 * 4);
      for (var i = 0; i < 256; i++) {
        rgba[i * 4] = lut[i * 3];
        rgba[i * 4 + 1] = lut[i * 3 + 1];
        rgba[i * 4 + 2] = lut[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.texCmap);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      this.cmapUploaded = p.colormap;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texData);
    gl.uniform1i(this.u.uData, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.uniform1i(this.u.uMask, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texCmap);
    gl.uniform1i(this.u.uCmap, 2);

    gl.uniform2f(this.u.uCenter, p.centerX, p.centerY);
    gl.uniform1f(this.u.uHalf, p.halfExtent);
    gl.uniform1i(this.u.uMode, p.mode === 'log' ? 1 : p.mode === 'gamma' ? 2 : 0);
    gl.uniform1f(this.u.uVmin, p.vmin);
    gl.uniform1f(this.u.uVmax, p.vmax);
    gl.uniform1f(this.u.uFloorDb, p.floorDb);
    gl.uniform1f(this.u.uGamma, p.gamma);
    gl.uniform1i(this.u.uUseMask, p.useMask && this.mask ? 1 : 0);
    gl.uniform3f(this.u.uMaskColor, 0.25, 0.25, 0.25);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  ImageView.prototype.render2d = function (w, h) {
    var p = this.params;
    var N = this.N;
    var lut = ZPV.colormaps.lut(p.colormap);
    var img = this.ctx2d.createImageData(w, h);
    var px = img.data;
    var half = p.halfExtent;
    for (var y = 0; y < h; y++) {
      var v = p.centerY + ((y + 0.5) / h - 0.5) * 2 * half;
      var row = Math.floor(v * N);
      for (var x = 0; x < w; x++) {
        var u = p.centerX + ((x + 0.5) / w - 0.5) * 2 * half;
        var col = Math.floor(u * N);
        var o = (y * w + x) * 4;
        px[o + 3] = 255;
        if (row < 0 || row >= N || col < 0 || col >= N ||
            (p.useMask && this.mask && !this.mask[row * N + col])) {
          px[o] = px[o + 1] = px[o + 2] = 64;
          continue;
        }
        var val = this.data[row * N + col];
        var t;
        if (p.mode === 'log') {
          var db = 10 * Math.log10(Math.max(val, 1e-30) / Math.max(p.vmax, 1e-30));
          t = (db - p.floorDb) / (0 - p.floorDb);
        } else {
          t = (val - p.vmin) / Math.max(p.vmax - p.vmin, 1e-30);
          if (p.mode === 'gamma') t = Math.pow(Math.max(t, 0), p.gamma);
        }
        var idx = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
        px[o] = lut[idx];
        px[o + 1] = lut[idx + 1];
        px[o + 2] = lut[idx + 2];
      }
    }
    this.ctx2d.putImageData(img, 0, 0);
  };

  /* 表示座標 (0..1) から配列インデックスへ */
  ImageView.prototype.pickIndex = function (fx, fy) {
    var p = this.params;
    var u = p.centerX + (fx - 0.5) * 2 * p.halfExtent;
    var v = p.centerY + (fy - 0.5) * 2 * p.halfExtent;
    var col = Math.floor(u * this.N);
    var row = Math.floor(v * this.N);
    if (row < 0 || row >= this.N || col < 0 || col >= this.N) return null;
    return { row: row, col: col, value: this.data[row * this.N + col] };
  };

  ZPV.ImageView = ImageView;
})(typeof globalThis !== 'undefined' ? globalThis : this);
