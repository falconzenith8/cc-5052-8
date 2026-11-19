/*
 * 规范化序列化 + 哈希。
 * canon(): 键排序的确定性 JSON，保证同一状态在任何引擎下序列化结果一致。
 * 哈希用双基底 FNV-1a（64bit 输出），用于状态链与分节哈希。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.serialize = api; }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }

  function fnv1a(str, basis) {
    let h = basis >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function hex8(n) { return ('0000000' + n.toString(16)).slice(-8); }

  function hashHex(str) {
    return hex8(fnv1a(str, 0x811c9dc5)) + hex8(fnv1a(str, 0x811c9dc5 ^ 0x5bd1e995));
  }

  function hashShort(str) { return hex8(fnv1a(str, 0x811c9dc5)); }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function hashState(state) { return hashHex(canon(state)); }

  return { canon, hashHex, hashShort, deepClone, hashState };
});
