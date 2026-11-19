/*
 * 确定性随机数发生器 (mulberry32)。
 * 状态是单个 uint32，可完整序列化进模拟状态 / 检查点，
 * 因此随机序列本身也是可回放、可校验的状态。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.rng = api; }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function create(seed) { return { s: seed >>> 0 }; }

  function nextU32(r) {
    r.s = (r.s + 0x6D2B79F5) >>> 0;
    let t = r.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  function nextFloat(r) { return nextU32(r) / 4294967296; }

  function nextInt(r, n) { return nextU32(r) % n; }

  return { create, nextU32, nextFloat, nextInt };
});
