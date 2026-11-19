/*
 * 帧率解耦器：把真实帧时间累积成固定 tick 数。
 * 渲染帧率 / 播放速度只改变"每帧推进几个 tick"，不改变 tick 内的规则求值，
 * 因此规则轨迹与渲染帧率无关。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.frameloop = api; }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  class FrameLoop {
    constructor() {
      this.tickLen = 1 / 60;
      this.speed = 1;
      this.acc = 0;
      this.maxTicks = 8;
    }
    advance(dtReal) {
      this.acc += dtReal * this.speed;
      let n = Math.floor(this.acc / this.tickLen + 1e-9);
      if (n > this.maxTicks) { n = this.maxTicks; this.acc = 0; }
      else { this.acc -= n * this.tickLen; }
      return n;
    }
  }

  return { FrameLoop };
});
