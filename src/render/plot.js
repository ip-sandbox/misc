/* 断面プロット（Canvas2D）。SPEC.md FR-12 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  function LinePlot(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /* series: [{ x: number[], y: number[], color, dash, label }] */
  LinePlot.prototype.draw = function (series, opts) {
    opts = opts || {};
    var ctx = this.ctx;
    var w = this.canvas.width;
    var h = this.canvas.height;
    var padL = 46;
    var padR = 8;
    var padT = 8;
    var padB = 22;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#12151b';
    ctx.fillRect(0, 0, w, h);
    if (!series.length) return;

    var logY = !!opts.logY;
    var xmin = opts.xmin, xmax = opts.xmax, ymin = opts.ymin, ymax = opts.ymax;
    var s, i;
    if (xmin === undefined || xmax === undefined || ymin === undefined || ymax === undefined) {
      xmin = Infinity; xmax = -Infinity; ymin = Infinity; ymax = -Infinity;
      for (s = 0; s < series.length; s++) {
        for (i = 0; i < series[s].x.length; i++) {
          var xv = series[s].x[i], yv = series[s].y[i];
          if (xv < xmin) xmin = xv;
          if (xv > xmax) xmax = xv;
          if (yv < ymin) ymin = yv;
          if (yv > ymax) ymax = yv;
        }
      }
    }
    if (logY) {
      ymin = opts.ymin !== undefined ? opts.ymin : Math.max(ymax * 1e-6, 1e-12);
      ymax = Math.max(ymax, ymin * 10);
    }
    if (ymax === ymin) ymax = ymin + 1;

    var tY = function (v) {
      var t = logY
        ? (Math.log10(Math.max(v, ymin)) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin))
        : (v - ymin) / (ymax - ymin);
      return h - padB - t * (h - padT - padB);
    };
    var tX = function (v) {
      return padL + ((v - xmin) / (xmax - xmin || 1)) * (w - padL - padR);
    };

    // 目盛り
    ctx.strokeStyle = '#2a2f3a';
    ctx.fillStyle = '#8b93a7';
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    if (logY) {
      // 対数軸はディケードごとに目盛る
      var d0 = Math.ceil(Math.log10(ymin));
      var d1 = Math.floor(Math.log10(ymax));
      var stepD = Math.max(1, Math.ceil((d1 - d0 + 1) / 6));
      for (var d = d0; d <= d1; d += stepD) {
        var yv = Math.pow(10, d);
        var yl = tY(yv);
        ctx.beginPath();
        ctx.moveTo(padL, yl);
        ctx.lineTo(w - padR, yl);
        ctx.stroke();
        ctx.fillText('1e' + d, 2, yl + 3);
      }
    } else {
      var nT = 4;
      for (i = 0; i <= nT; i++) {
        var yy = padT + ((h - padT - padB) * i) / nT;
        ctx.beginPath();
        ctx.moveTo(padL, yy);
        ctx.lineTo(w - padR, yy);
        ctx.stroke();
        ctx.fillText((ymax - ((ymax - ymin) * i) / nT).toPrecision(2), 2, yy + 3);
      }
    }
    for (i = 0; i <= 4; i++) {
      var xv2 = xmin + ((xmax - xmin) * i) / 4;
      var xx = tX(xv2);
      ctx.beginPath();
      ctx.moveTo(xx, padT);
      ctx.lineTo(xx, h - padB);
      ctx.stroke();
      ctx.fillText(xv2.toFixed(1), xx - 8, h - 8);
    }
    if (opts.xlabel) {
      ctx.fillText(opts.xlabel, w - padR - 60, h - 8);
    }

    for (s = 0; s < series.length; s++) {
      var ser = series[s];
      ctx.strokeStyle = ser.color || '#7fd1ff';
      ctx.lineWidth = ser.width || 1.5;
      ctx.setLineDash(ser.dash || []);
      ctx.beginPath();
      var started = false;
      for (i = 0; i < ser.x.length; i++) {
        var px = tX(ser.x[i]);
        var py = tY(ser.y[i]);
        if (!isFinite(py)) continue;
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 凡例
    var lx = padL + 6;
    for (s = 0; s < series.length; s++) {
      if (!series[s].label) continue;
      ctx.strokeStyle = series[s].color || '#7fd1ff';
      ctx.setLineDash(series[s].dash || []);
      ctx.beginPath();
      ctx.moveTo(lx, padT + 8);
      ctx.lineTo(lx + 16, padT + 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#c8cfdd';
      ctx.fillText(series[s].label, lx + 20, padT + 11);
      lx += 22 + ctx.measureText(series[s].label).width + 10;
    }
  };

  ZPV.LinePlot = LinePlot;
})(typeof globalThis !== 'undefined' ? globalThis : this);
