/*
 * 场景定义（资源身份）。回放文件绑定 sceneId + sceneHash，
 * 场景内容有任何变化，哈希即变，回放会被拒绝。
 *
 * 场景元素：
 *  - 角色：玩家（平台跳跃物理）
 *  - 机关：2 个液压粉碎机、2 个飞镖陷阱、1 扇定时开启的门
 *  - 运动物体：1 个往返移动平台（可载人）、飞镖投射物
 */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const api = factory(isNode ? require('./serialize.js') : root.SIM.serialize);
  if (isNode) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.scene = api; }
})(typeof self !== 'undefined' ? self : globalThis, function (SER) {
  'use strict';

  const SCENE = {
    id: 'arena-01',
    version: 1,
    width: 960,
    height: 540,
    playerSpawn: { x: 60, y: 464 },
    solids: [
      { x: 0, y: 500, w: 960, h: 40 },
      { x: 0, y: 0, w: 20, h: 540 },
      { x: 940, y: 0, w: 20, h: 540 },
      { x: 0, y: 0, w: 960, h: 20 }
    ],
    oneWays: [
      { x: 280, y: 440, w: 160, h: 12 },
      { x: 620, y: 450, w: 160, h: 12 }
    ],
    platforms: [
      { x1: 180, y1: 470, x2: 330, y2: 470, w: 64, h: 12, period: 150, pause: 40 }
    ],
    crushers: [
      { x: 460, w: 40, h: 20, yTop: 420, yBottom: 480, speed: 1.5, pauseTop: 50, pauseBottom: 10, phase: 0 },
      { x: 560, w: 40, h: 20, yTop: 420, yBottom: 480, speed: 1.5, pauseTop: 50, pauseBottom: 10, phase: 70 }
    ],
    dartTraps: [
      { x: 505, y: 468, dirX: 1, dirY: 0, interval: 160, offset: 0 },
      { x: 855, y: 440, dirX: -1, dirY: 0, interval: 150, offset: 60 }
    ],
    pickups: [
      { x: 150, y: 484 }, { x: 352, y: 424 }, { x: 480, y: 484 },
      { x: 682, y: 434 }, { x: 760, y: 484 }, { x: 840, y: 484 }
    ],
    door: { x: 896, y: 420, w: 16, h: 80, openTick: 3000 }
  };

  const SCENE_HASH = SER.hashHex(SER.canon(SCENE));

  return { SCENE, SCENE_HASH };
});
