/*
 * 确定性机器人玩家：仅根据 (scene, state) 计算输入，用于生成样例回放。
 * 它是"玩家"，不是模拟规则的一部分。
 */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const api = factory(isNode ? require('./sim.js') : root.SIM.sim);
  if (isNode) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.bot = api; }
})(typeof self !== 'undefined' ? self : globalThis, function (SIM) {
  'use strict';

  const INPUT = SIM.INPUT;

  function botInput(scene, state) {
    const P = state.player;
    let input = 0;

    let tx = null, ty = null, isPickup = false, best = Infinity;
    for (let i = 0; i < scene.pickups.length; i++) {
      if (state.pickups[i].taken) continue;
      const p = scene.pickups[i];
      const d = Math.abs(p.x - P.x);
      if (d < best) { best = d; tx = p.x + 8; ty = p.y + 8; isPickup = true; }
    }
    if (tx === null) {
      if (state.door.openTicks >= SIM.DOOR_OPEN_TICKS) { tx = scene.door.x + 30; ty = 480; }
      else { tx = scene.door.x - 26; ty = 480; }
    }

    const cx = P.x + 12;
    const dx = tx - cx;
    if (dx > 6) input |= INPUT.RIGHT;
    else if (dx < -6) input |= INPUT.LEFT;

    const trying = (input & (INPUT.LEFT | INPUT.RIGHT)) !== 0;
    if (P.grounded && trying && Math.abs(P.vx) < 0.6) input |= INPUT.JUMP;
    if (P.grounded && isPickup && (P.y + 18) - ty > 24 && Math.abs(dx) < 50) input |= INPUT.JUMP;

    // 防御：附近飞镖 -> 面向并攻击
    for (const d of state.darts) {
      if (Math.abs(d.y - (P.y + 18)) < 40 && Math.abs(d.x - cx) < 90) {
        input |= (d.x > cx ? INPUT.RIGHT : INPUT.LEFT);
        input |= INPUT.ATTACK;
        break;
      }
    }
    return input;
  }

  return { botInput };
});
