/* Noll インデックスと (n, m) の相互変換、および他方式への変換。
 * SPEC.md §5.3 / 規約 R-1。参照実装 torchmfbd/zern.py の zernIndex に準拠する。
 */
(function (root) {
  'use strict';
  var ZPV = (root.ZPV = root.ZPV || {});

  var N_MAX = 20;
  var J_MAX = ((N_MAX + 1) * (N_MAX + 2)) / 2; // 231

  /* zern.py: zernIndex(j) の転記。j は 1 始まり。 */
  function nollToNM(j) {
    var n = Math.floor((-1 + Math.sqrt(8 * (j - 1) + 1)) / 2);
    var p = j - (n * (n + 1)) / 2;
    var k = n % 2;
    var m = Math.floor((p + k) / 2) * 2 - k;
    if (m !== 0) m *= j % 2 === 0 ? 1 : -1;
    return { n: n, m: m };
  }

  /* j -> (n,m) を一度だけ展開し、逆引き表も作る。231 件しかないため十分。 */
  var TABLE = [];
  var REVERSE = new Map();
  for (var j = 1; j <= J_MAX; j++) {
    var nm = nollToNM(j);
    TABLE.push(nm);
    REVERSE.set(nm.n + ':' + nm.m, j);
  }

  function nmToNoll(n, m) {
    var j = REVERSE.get(n + ':' + m);
    if (j === undefined) throw new RangeError('対応する Noll 番号がありません: n=' + n + ', m=' + m);
    return j;
  }

  /* OSA / ANSI: j = (n(n+2) + m) / 2 、0 始まり */
  function nmToOsa(n, m) {
    return (n * (n + 2) + m) / 2;
  }

  /* Fringe: j = (1 + (n+|m|)/2)^2 - 2|m| + floor((1 - sgn m)/2) 、1 始まり */
  function nmToFringe(n, m) {
    var am = Math.abs(m);
    var sgn = m > 0 ? 1 : m < 0 ? -1 : 0;
    return Math.pow(1 + (n + am) / 2, 2) - 2 * am + Math.floor((1 - sgn) / 2);
  }

  var ORDER_PREFIX = ['', '二次', '三次', '四次', '五次', '六次', '七次', '八次', '九次', '十次', '十一次'];
  var FOIL = {
    3: 'トレフォイル',
    4: 'クアドラフォイル',
    5: 'ペンタフォイル',
    6: 'ヘキサフォイル'
  };

  function orderPrefix(k) {
    return k < ORDER_PREFIX.length ? ORDER_PREFIX[k] : k + 1 + '次';
  }

  /* 表示用の日本語名称。(n, m) が正であり、名称は表示用ラベルにすぎない。 */
  function modeName(n, m) {
    var am = Math.abs(m);
    var k = (n - am) / 2; // 同じ |m| の中での次数
    var base;
    if (am === 0) {
      if (n === 0) return 'ピストン';
      if (n === 2) return 'デフォーカス';
      base = orderPrefix(k - 2) + '球面収差';
      return base;
    }
    if (am === 1) {
      base = k === 0 ? 'チルト' : orderPrefix(k - 1) + 'コマ収差';
    } else if (am === 2) {
      base = orderPrefix(k) + '非点収差';
    } else {
      base = orderPrefix(k) + (FOIL[am] || am + '葉収差');
    }
    var suffix;
    if (am === 2) suffix = m > 0 ? ' (0/90°)' : ' (±45°)';
    else suffix = m > 0 ? ' (X)' : ' (Y)';
    return base + suffix;
  }

  /* radial order n に属する Noll 番号の範囲 [first, last] */
  function nollRangeForOrder(n) {
    return [(n * (n + 1)) / 2 + 1, ((n + 1) * (n + 2)) / 2];
  }

  ZPV.noll = {
    N_MAX: N_MAX,
    J_MAX: J_MAX,
    nollToNM: nollToNM,
    nmToNoll: nmToNoll,
    nmToOsa: nmToOsa,
    nmToFringe: nmToFringe,
    modeName: modeName,
    nollRangeForOrder: nollRangeForOrder,
    table: TABLE
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
