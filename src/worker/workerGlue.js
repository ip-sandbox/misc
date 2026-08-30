/* Web Worker のグルーコード。ビルド時に src/core/* の後ろに連結される。
 * SPEC.md §4.1: 実行場所の差し替え点はここ 1 か所に閉じ込める。
 */
(function () {
  'use strict';
  var engine = new self.ZPV.Engine();

  function payloadOf(r) {
    // idealProfile はエンジン内でキャッシュしているので転送せずコピーを渡す
    return {
      N: r.N,
      q: r.q,
      pupilDiameterPx: r.pupilDiameterPx,
      maskCount: r.maskCount,
      wavefront: r.wavefront,
      wavefrontMin: r.wavefrontMin,
      wavefrontMax: r.wavefrontMax,
      amplitude: r.amplitude,
      mask: r.mask,
      psf: r.psf,
      psfPeak: r.psfPeak,
      psfPeakRow: r.psfPeakRow,
      psfPeakCol: r.psfPeakCol,
      profile: { radiusLD: r.profile.radiusLD, value: r.profile.value },
      idealProfile: r.idealProfile
        ? {
            radiusLD: Float64Array.from(r.idealProfile.radiusLD),
            value: Float64Array.from(r.idealProfile.value)
          }
        : null,
      metrics: r.metrics,
      timings: r.timings,
      cache: r.cache
    };
  }

  self.onmessage = function (e) {
    var msg = e.data;
    if (!msg) return;
    if (msg.type === 'ping') {
      // 起動確認。file:// では Worker が沈黙するため、応答の有無で判定する
      self.postMessage({ type: 'pong' });
      return;
    }
    if (msg.type !== 'compute') return;
    try {
      var r = engine.compute(msg.state);
      var p = payloadOf(r);
      self.postMessage({ type: 'result', id: msg.id, result: p }, [
        p.wavefront.buffer,
        p.amplitude.buffer,
        p.mask.buffer,
        p.psf.buffer,
        p.profile.radiusLD.buffer,
        p.profile.value.buffer,
        p.idealProfile.radiusLD.buffer,
        p.idealProfile.value.buffer
      ]);
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: msg.id,
        message: String((err && err.message) || err),
        stack: String((err && err.stack) || '')
      });
    }
  };
})();
