/* 設定 JSON と係数 CSV の入出力。SPEC.md §7 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var SCHEMA_VERSION = 1;

  /* --- 設定 JSON (§7.1) --------------------------------------------------- */

  function toJson(state) {
    var coefficients = [];
    Object.keys(state.coeffs).forEach(function (k) {
      var v = state.coeffs[k];
      if (!v) return;
      var nm = ZPV.noll.nollToNM(Number(k));
      coefficients.push({ n: nm.n, m: nm.m, value: v });
    });
    coefficients.sort(function (a, b) {
      return ZPV.noll.nmToNoll(a.n, a.m) - ZPV.noll.nmToNoll(b.n, b.m);
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      coefficientUnit: 'rad',
      wavelengthNm: state.wavelengthNm,
      indexScheme: 'Noll',
      coefficients: coefficients,
      pupil: state.pupil,
      grid: { fftSize: state.N, samplingQ: state.q, previewFftSize: state.previewN },
      psf: { normalization: 'sum' },
      display: state.display
    };
  }

  function fromJson(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('JSON の形式が不正です');
    if (obj.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        'schemaVersion ' + obj.schemaVersion + ' は未対応です（対応: ' + SCHEMA_VERSION + '）'
      );
    }
    var coeffs = {};
    (obj.coefficients || []).forEach(function (c) {
      // 係数は必ず (n, m) で持つ（SPEC.md §7.1）
      var j = ZPV.noll.nmToNoll(c.n, c.m);
      coeffs[j] = Number(c.value) || 0;
    });
    var grid = obj.grid || {};
    return {
      coeffs: coeffs,
      wavelengthNm: obj.wavelengthNm,
      pupil: obj.pupil,
      N: grid.fftSize,
      q: grid.samplingQ,
      previewN: grid.previewFftSize,
      display: obj.display
    };
  }

  /* --- 係数 CSV (§7.2) ---------------------------------------------------- */

  /* opts: { scheme:'Noll'|'OSA'|'Fringe', nollStart:number, unit:'rad'|'waves'|'nm', wavelengthNm } */
  function parseCoefficientCsv(text, opts) {
    opts = opts || {};
    var scheme = opts.scheme || 'Noll';
    var start = opts.nollStart === undefined ? 1 : opts.nollStart;
    var lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (!s || s[0] === '#') continue;
      var parts = s.split(/[,\t ]+/).filter(function (p) { return p.length; });
      var nums = parts.map(Number);
      if (nums.some(isNaN)) continue; // ヘッダ行などは読み飛ばす
      rows.push(nums);
    }
    if (!rows.length) throw new Error('数値行が見つかりませんでした');

    var width = rows[0].length;
    var coeffs = {};
    var scale = unitToRad(opts.unit, opts.wavelengthNm);
    var warnings = [];

    if (width >= 3) {
      // 形式 2: n, m, value
      rows.forEach(function (r) {
        try {
          coeffs[ZPV.noll.nmToNoll(r[0], r[1])] = r[2] * scale;
        } catch (e) {
          warnings.push('(n,m)=(' + r[0] + ',' + r[1] + ') は範囲外のため無視しました');
        }
      });
    } else if (width === 2) {
      // 形式 1: index, value
      rows.forEach(function (r) {
        var j = toNoll(scheme, r[0]);
        if (j) coeffs[j] = r[1] * scale;
        else warnings.push('インデックス ' + r[0] + ' は範囲外のため無視しました');
      });
    } else {
      // 値のみ 1 列: nollStart から連番
      rows.forEach(function (r, k) {
        var j = start + k;
        if (j >= 1 && j <= ZPV.noll.J_MAX) coeffs[j] = r[0] * scale;
      });
    }
    return { coeffs: coeffs, warnings: warnings, rowCount: rows.length, width: width };
  }

  function toNoll(scheme, index) {
    if (scheme === 'Noll') {
      return index >= 1 && index <= ZPV.noll.J_MAX ? index : 0;
    }
    for (var j = 1; j <= ZPV.noll.J_MAX; j++) {
      var nm = ZPV.noll.nollToNM(j);
      var v = scheme === 'OSA' ? ZPV.noll.nmToOsa(nm.n, nm.m) : ZPV.noll.nmToFringe(nm.n, nm.m);
      if (v === index) return j;
    }
    return 0;
  }

  function unitToRad(unit, wavelengthNm) {
    if (unit === 'waves') return 2 * Math.PI;
    if (unit === 'nm') return (2 * Math.PI) / (wavelengthNm || 550);
    return 1; // rad
  }

  function radToUnit(unit, wavelengthNm) {
    return 1 / unitToRad(unit, wavelengthNm);
  }

  /* 書き出しは常に形式 2 (n, m, value)。 */
  function formatCoefficientCsv(coeffs, opts) {
    opts = opts || {};
    var scale = radToUnit(opts.unit, opts.wavelengthNm);
    var unitName = opts.unit === 'waves' ? 'waves' : opts.unit === 'nm' ? 'nm' : 'rad';
    var out = ['# n,m,value  unit=' + unitName + '  scheme=(n,m)'];
    Object.keys(coeffs)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .forEach(function (j) {
        if (!coeffs[j]) return;
        var nm = ZPV.noll.nollToNM(j);
        out.push(nm.n + ',' + nm.m + ',' + (coeffs[j] * scale).toPrecision(10));
      });
    return out.join('\n') + '\n';
  }

  /* --- マップ CSV (§7.3) -------------------------------------------------- */

  function formatMapCsv(data, N, header) {
    var lines = ['# ' + header];
    for (var r = 0; r < N; r++) {
      var row = new Array(N);
      for (var c = 0; c < N; c++) row[c] = data[r * N + c].toPrecision(8);
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  ZPV.io = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    toJson: toJson,
    fromJson: fromJson,
    parseCoefficientCsv: parseCoefficientCsv,
    formatCoefficientCsv: formatCoefficientCsv,
    formatMapCsv: formatMapCsv,
    unitToRad: unitToRad,
    radToUnit: radToUnit
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
