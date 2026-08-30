/* 計算パイプラインのオーケストレーション。SPEC.md §4.2。
 *
 * 状態（グリッド設定 + 係数）を受け取り、表示に必要な一式を返す。
 * DOM を参照しないので Web Worker からも Node のテストからも使える。
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  function Engine(options) {
    options = options || {};
    this.cache = new ZPV.BasisCache(options.basisLimitBytes);
    this.grid = null;
    this.gridKey = null;
    this.scratch = null;
    this.idealPeak = 0;
    this.idealProfile = null;
  }

  Engine.prototype.ensureGrid = function (N, q, pupilOpts) {
    ZPV.pupil.validate(N, q, true); // FFT を使うので 2 のべき乗が必要
    var key = ZPV.pupil.gridKey(N, q, pupilOpts);
    if (this.gridKey === key && this.grid) return this.grid;
    this.grid = ZPV.pupil.buildGrid(N, q, pupilOpts);
    this.gridKey = key;
    this.cache.setGrid(this.grid, key);
    this.scratch = null;

    // 同一瞳マスクの無収差 PSF（Strehl の分母と理想プロファイル）
    var ideal = ZPV.psf.computePsf(this.grid, null, this.scratch);
    this.scratch = ideal.scratch;
    this.idealPeak = ideal.peak;
    this.idealProfile = ZPV.metrics.radialProfile(
      ideal.psf, N, q, ideal.peakRow, ideal.peakCol, Math.min(N / 2, 32 * q)
    );
    return this.grid;
  };

  /* state: { N, q, pupil, coeffs:{nollJ:value[rad]}, excludePistonTilt, eeRadiusLD } */
  Engine.prototype.compute = function (state) {
    var t0 = now();
    var N = state.N;
    var q = state.q;
    var grid = this.ensureGrid(N, q, state.pupil);
    var tGrid = now();

    // 波面を 2 本同時に作る: 表示用（全項）と指標用（ピストン/チルト除外の可否）
    var modes = ZPV.psf.nonZeroModes(state.coeffs || {}, false);
    var wfFull = new Float64Array(grid.count);
    var exclude = state.excludePistonTilt !== false;
    var wfMetric = exclude ? new Float64Array(grid.count) : wfFull;
    for (var k = 0; k < modes.length; k++) {
      var basis = this.cache.get(modes[k].n, modes[k].m);
      var c = modes[k].value;
      var toMetric = exclude && modes[k].j > 3;
      for (var i = 0; i < grid.count; i++) {
        var v = c * basis[i];
        wfFull[i] += v;
        if (toMetric) wfMetric[i] += v;
      }
    }
    var tWave = now();

    var res = ZPV.psf.computePsf(grid, wfFull, this.scratch);
    this.scratch = res.scratch;
    var tFft = now();

    var stats = ZPV.metrics.wavefrontStats(grid, wfMetric);
    var strehlDef = ZPV.metrics.strehlDefinition(grid, wfMetric);
    var strehlPeak = this.idealPeak > 0 ? res.peak / this.idealPeak : 0;
    var profile = ZPV.metrics.radialProfile(
      res.psf, N, q, res.peakRow, res.peakCol, Math.min(N / 2, 32 * q)
    );
    var eeRadius = state.eeRadiusLD || 3;
    var ee = ZPV.metrics.encircledEnergy(res.psf, N, q, res.peakRow, res.peakCol, eeRadius);

    var wfDisplay = ZPV.psf.expandToFull(grid, wfFull, 0);
    var wfMin = Infinity;
    var wfMax = -Infinity;
    for (var t = 0; t < grid.count; t++) {
      var w = wfFull[t];
      if (w < wfMin) wfMin = w;
      if (w > wfMax) wfMax = w;
    }
    if (grid.count === 0) { wfMin = 0; wfMax = 0; }
    var ampDisplay = ZPV.psf.expandToFull(grid, grid.amp, 0);
    var tEnd = now();

    return {
      N: N,
      q: q,
      pupilDiameterPx: grid.pupilDiameterPx,
      maskCount: grid.count,
      wavefront: wfDisplay,
      wavefrontMin: wfMin,
      wavefrontMax: wfMax,
      amplitude: ampDisplay,
      mask: ZPV.psf.maskFull(grid),
      psf: res.psf,
      psfPeak: res.peak,
      psfPeakRow: res.peakRow,
      psfPeakCol: res.peakCol,
      profile: { radiusLD: profile.radiusLD, value: profile.value },
      idealProfile: this.idealProfile
        ? { radiusLD: this.idealProfile.radiusLD, value: this.idealProfile.value }
        : null,
      idealPeak: this.idealPeak,
      metrics: {
        pv: stats.pv,
        rms: stats.rms,
        strehlDefinition: strehlDef,
        strehlPeak: strehlPeak,
        marechal: ZPV.metrics.marechal(stats.rms),
        fwhm: ZPV.metrics.fwhm(profile),
        ee: ee,
        eeRadiusLD: eeRadius,
        modeCount: modes.length,
        excludePistonTilt: exclude
      },
      timings: {
        grid: tGrid - t0,
        wavefront: tWave - tGrid,
        fft: tFft - tWave,
        metrics: tEnd - tFft,
        total: tEnd - t0
      },
      cache: this.cache.stats()
    };
  };

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  ZPV.Engine = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
