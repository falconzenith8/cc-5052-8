/*
 * 确定性模拟核心。
 *
 * 确定性约束：
 *  - 固定步长：每一步 = 1 个 tick（1/60s 语义），渲染帧率不参与计算。
 *  - 只用 IEEE754 中可正确舍入的运算（+ - * / sqrt floor 等），不用三角函数。
 *  - 全部随机性来自 rng.js，RNG 状态存在 state.rng 中，随状态一起序列化。
 *  - 不使用墙钟时间；外部输入只有玩家输入（逐 tick 记录）和规则事件（记录于事件流）。
 *
 * 状态覆盖后续求值的全部依赖：玩家、机关（粉碎机/陷阱/门/平台）、
 * 投射物、拾取物、RNG、计分。检查点保存完整状态，哈希链覆盖所有分节，
 * 不隐藏任何机关状态。
 */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const api = factory(
    isNode ? require('./rng.js') : root.SIM.rng,
    isNode ? require('./serialize.js') : root.SIM.serialize
  );
  if (isNode) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.sim = api; }
})(typeof self !== 'undefined' ? self : globalThis, function (RNG, SER) {
  'use strict';

  const SIM_VERSION = '1.0.0';
  const INPUT = { LEFT: 1, RIGHT: 2, JUMP: 4, ATTACK: 8 };
  const SECTIONS = ['meta', 'rng', 'player', 'platforms', 'crushers', 'traps', 'darts', 'pickups', 'door'];

  const PLAYER_W = 24, PLAYER_H = 36;
  const PICKUP_SIZE = 16;
  const DART_W = 8, DART_H = 4;
  const MAX_DARTS = 32;
  const GRAVITY = 0.5, MAX_FALL = 9, MOVE_SPEED = 3.2;
  const ACCEL_GROUND = 0.5, ACCEL_AIR = 0.3, FRICTION = 0.4;
  const JUMP_V = -9.5;
  const ATTACK_CD = 20, ATTACK_ANIM = 6;
  const DOOR_OPEN_TICKS = 60;

  function initialState(scene, seed) {
    return {
      tick: 0,
      rng: seed >>> 0,
      score: 0,
      deaths: 0,
      finished: false,
      finishTick: -1,
      player: {
        x: scene.playerSpawn.x, y: scene.playerSpawn.y,
        vx: 0, vy: 0, hp: 100, invuln: 0,
        attackCd: 0, attackAnim: 0,
        prevJump: false, prevAttack: false,
        grounded: false, facing: 1, standingOn: -1
      },
      platforms: scene.platforms.map(function (p) {
        return { x: p.x1, y: p.y1, dir: 1, pauseLeft: 0, jamLeft: 0, speedMul: 1 };
      }),
      crushers: scene.crushers.map(function (c) {
        return { y: c.yTop, dir: 1, pauseLeft: c.phase || 0, jamLeft: 0, speedMul: 1 };
      }),
      traps: scene.dartTraps.map(function (t) {
        return { cooldown: t.offset || 0, haywire: false };
      }),
      darts: [],
      pickups: scene.pickups.map(function () { return { taken: false }; }),
      door: { openTicks: 0 }
    };
  }

  function sectionOf(state, name) {
    if (name === 'meta') {
      return { tick: state.tick, score: state.score, deaths: state.deaths, finished: state.finished, finishTick: state.finishTick };
    }
    if (name === 'rng') return state.rng;
    return state[name];
  }

  function sectionHashes(state) {
    const out = {};
    for (const s of SECTIONS) out[s] = SER.hashShort(SER.canon(sectionOf(state, s)));
    return out;
  }

  function stateHash(state) { return SER.hashHex(SER.canon(state)); }

  function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function damage(scene, state, amount) {
    const P = state.player;
    P.hp -= amount;
    P.invuln = 60;
    if (P.hp <= 0) {
      state.deaths++;
      P.x = scene.playerSpawn.x; P.y = scene.playerSpawn.y;
      P.vx = 0; P.vy = 0; P.hp = 100; P.invuln = 120; P.standingOn = -1;
    }
  }

  /*
   * 规则事件：机关故障。由环境（剧本或调试按键）注入，
   * 选择哪个机关依赖 RNG —— 因此 RNG 状态必须在状态内，回放才能复现抽取结果。
   * 返回结果对象，记录进回放文件，校验时重算比对。
   */
  function applyEvent(scene, state, rng, ev) {
    if (ev.type === 'mech_malfunction') {
      const np = scene.platforms.length, nc = scene.crushers.length;
      const idx = RNG.nextInt(rng, np + nc + scene.dartTraps.length);
      if (idx < np) {
        const p = state.platforms[idx];
        p.jamLeft = 500; p.speedMul = 1.8;
        return { kind: 'platform', index: idx, jamTicks: 500, speedMul: 1.8 };
      }
      if (idx < np + nc) {
        const c = state.crushers[idx - np];
        c.jamLeft = 500; c.speedMul = 2;
        return { kind: 'crusher', index: idx - np, jamTicks: 500, speedMul: 2 };
      }
      const t = state.traps[idx - np - nc];
      t.haywire = true;
      return { kind: 'trap', index: idx - np - nc, haywire: true };
    }
    throw new Error('unknown event type: ' + ev.type);
  }

  /*
   * 推进一个 tick。events 为本 tick 触发的规则事件（{type, data}）。
   * 返回每个事件的重算结果数组（供录制器存储 / 校验器比对）。
   */
  function step(scene, state, input, events) {
    const rng = { s: state.rng >>> 0 };
    const results = [];
    if (events) for (const ev of events) results.push(applyEvent(scene, state, rng, ev));

    const P = state.player;

    if (P.invuln > 0) P.invuln--;
    if (P.attackCd > 0) P.attackCd--;
    if (P.attackAnim > 0) P.attackAnim--;

    const accel = P.grounded ? ACCEL_GROUND : ACCEL_AIR;
    if (input & INPUT.LEFT) { P.vx = Math.max(P.vx - accel, -MOVE_SPEED); P.facing = -1; }
    if (input & INPUT.RIGHT) { P.vx = Math.min(P.vx + accel, MOVE_SPEED); P.facing = 1; }
    if (!(input & (INPUT.LEFT | INPUT.RIGHT)) && P.grounded) {
      P.vx -= Math.sign(P.vx) * Math.min(Math.abs(P.vx), FRICTION);
    }
    const jump = (input & INPUT.JUMP) !== 0;
    if (jump && !P.prevJump && P.grounded) { P.vy = JUMP_V; P.grounded = false; P.standingOn = -1; }
    P.prevJump = jump;
    const attack = (input & INPUT.ATTACK) !== 0;
    if (attack && !P.prevAttack && P.attackCd === 0) { P.attackCd = ATTACK_CD; P.attackAnim = ATTACK_ANIM; }
    P.prevAttack = attack;

    // 移动平台：积分式运动，jam/暂停/倍速全部在状态中
    for (let i = 0; i < scene.platforms.length; i++) {
      const def = scene.platforms[i], pl = state.platforms[i];
      const ox = pl.x, oy = pl.y;
      if (pl.jamLeft > 0) pl.jamLeft--;
      else if (pl.pauseLeft > 0) pl.pauseLeft--;
      else {
        const dx = def.x2 - def.x1, dy = def.y2 - def.y1;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const sp = (dist / def.period) * pl.speedMul;
        let nx = pl.x + (dx / dist) * sp * pl.dir;
        let ny = pl.y + (dy / dist) * sp * pl.dir;
        const t = ((nx - def.x1) * dx + (ny - def.y1) * dy) / (dist * dist);
        if (t >= 1) { nx = def.x2; ny = def.y2; pl.dir = -1; pl.pauseLeft = def.pause; }
        else if (t <= 0) { nx = def.x1; ny = def.y1; pl.dir = 1; pl.pauseLeft = def.pause; }
        pl.x = nx; pl.y = ny;
      }
      if (P.standingOn === i) { P.x += pl.x - ox; P.y += pl.y - oy; }
    }

    // 粉碎机
    for (let i = 0; i < scene.crushers.length; i++) {
      const def = scene.crushers[i], c = state.crushers[i];
      if (c.jamLeft > 0) c.jamLeft--;
      else if (c.pauseLeft > 0) c.pauseLeft--;
      else {
        c.y += def.speed * c.speedMul * c.dir;
        if (c.y >= def.yBottom) { c.y = def.yBottom; c.dir = -1; c.pauseLeft = def.pauseBottom; }
        else if (c.y <= def.yTop) { c.y = def.yTop; c.dir = 1; c.pauseLeft = def.pauseTop; }
      }
    }

    // 飞镖陷阱（故障后间隔缩短且带 RNG 抖动）
    for (let i = 0; i < scene.dartTraps.length; i++) {
      const def = scene.dartTraps[i], tr = state.traps[i];
      if (tr.cooldown > 0) tr.cooldown--;
      if (tr.cooldown === 0) {
        if (state.darts.length < MAX_DARTS) {
          state.darts.push({ x: def.x, y: def.y, vx: def.dirX * 4, vy: def.dirY * 4, life: 300 });
        }
        let interval = def.interval;
        if (tr.haywire) {
          interval = Math.floor(def.interval / 3) + RNG.nextInt(rng, 7) - 3;
          if (interval < 5) interval = 5;
        }
        tr.cooldown = interval;
      }
    }

    // 飞镖：移动、撞墙、被攻击摧毁、命中玩家
    const atk = P.attackAnim > 0
      ? { x: P.facing > 0 ? P.x + PLAYER_W : P.x - 30, y: P.y + 6, w: 30, h: 24 }
      : null;
    const survivors = [];
    for (const d of state.darts) {
      d.x += d.vx; d.y += d.vy; d.life--;
      let dead = d.life <= 0 || d.x < 0 || d.x > scene.width || d.y < 0 || d.y > scene.height;
      if (!dead) {
        for (const s of scene.solids) {
          if (overlap(d.x - DART_W / 2, d.y - DART_H / 2, DART_W, DART_H, s.x, s.y, s.w, s.h)) { dead = true; break; }
        }
      }
      if (!dead && atk && overlap(d.x - DART_W / 2, d.y - DART_H / 2, DART_W, DART_H, atk.x, atk.y, atk.w, atk.h)) {
        dead = true; state.score += 5;
      }
      if (!dead && P.invuln === 0 && overlap(d.x - DART_W / 2, d.y - DART_H / 2, DART_W, DART_H, P.x, P.y, PLAYER_W, PLAYER_H)) {
        dead = true; damage(scene, state, 10);
      }
      if (!dead) survivors.push(d);
    }
    state.darts = survivors;

    // 玩家物理
    P.vy = Math.min(P.vy + GRAVITY, MAX_FALL);
    const doorSolid = state.door.openTicks < DOOR_OPEN_TICKS
      ? { x: scene.door.x, y: scene.door.y, w: scene.door.w, h: scene.door.h }
      : null;
    const solidsX = doorSolid ? scene.solids.concat([doorSolid]) : scene.solids;

    P.x += P.vx;
    for (const s of solidsX) {
      if (overlap(P.x, P.y, PLAYER_W, PLAYER_H, s.x, s.y, s.w, s.h)) {
        if (P.vx > 0) P.x = s.x - PLAYER_W;
        else if (P.vx < 0) P.x = s.x + s.w;
        P.vx = 0;
      }
    }

    const prevFeet = P.y + PLAYER_H;
    P.y += P.vy;
    P.grounded = false;
    P.standingOn = -1;
    for (const s of solidsX) {
      if (overlap(P.x, P.y, PLAYER_W, PLAYER_H, s.x, s.y, s.w, s.h)) {
        if (P.vy > 0) { P.y = s.y - PLAYER_H; P.vy = 0; P.grounded = true; }
        else if (P.vy < 0) { P.y = s.y + s.h; P.vy = 0; }
      }
    }
    for (const w of scene.oneWays) {
      if (P.vy >= 0 && prevFeet <= w.y && P.y + PLAYER_H >= w.y &&
          P.x < w.x + w.w && P.x + PLAYER_W > w.x) {
        P.y = w.y - PLAYER_H; P.vy = 0; P.grounded = true;
      }
    }
    for (let i = 0; i < scene.platforms.length; i++) {
      const def = scene.platforms[i], pl = state.platforms[i];
      if (P.vy >= 0 && prevFeet <= pl.y && P.y + PLAYER_H >= pl.y &&
          P.x < pl.x + def.w && P.x + PLAYER_W > pl.x) {
        P.y = pl.y - PLAYER_H; P.vy = 0; P.grounded = true; P.standingOn = i;
      }
    }

    // 粉碎机伤害
    for (let i = 0; i < scene.crushers.length; i++) {
      const def = scene.crushers[i], c = state.crushers[i];
      if (P.invuln === 0 && overlap(P.x, P.y, PLAYER_W, PLAYER_H, def.x, c.y, def.w, def.h)) {
        damage(scene, state, 30);
        P.vy = -6;
        P.vx = (P.x + PLAYER_W / 2 < def.x + def.w / 2) ? -3 : 3;
      }
    }

    // 拾取物（奖励分含 RNG 抽取，使随机初值进入轨迹）
    for (let i = 0; i < scene.pickups.length; i++) {
      if (state.pickups[i].taken) continue;
      const p = scene.pickups[i];
      if (overlap(P.x, P.y, PLAYER_W, PLAYER_H, p.x, p.y, PICKUP_SIZE, PICKUP_SIZE)) {
        state.pickups[i].taken = true;
        state.score += 100 + RNG.nextInt(rng, 50);
      }
    }

    // 门：集齐拾取物且到达开放时刻后逐渐开启
    const allTaken = state.pickups.every(function (p) { return p.taken; });
    if (allTaken && state.tick >= scene.door.openTick && state.door.openTicks < DOOR_OPEN_TICKS) {
      state.door.openTicks++;
    }
    if (!state.finished && state.door.openTicks >= DOOR_OPEN_TICKS &&
        overlap(P.x, P.y, PLAYER_W, PLAYER_H, scene.door.x, scene.door.y, scene.door.w, scene.door.h)) {
      state.finished = true;
      state.finishTick = state.tick;
    }

    state.rng = rng.s >>> 0;
    state.tick++;
    return results;
  }

  return {
    SIM_VERSION, INPUT, SECTIONS,
    PLAYER_W, PLAYER_H, PICKUP_SIZE, DOOR_OPEN_TICKS,
    initialState, sectionHashes, stateHash, step, applyEvent, damage, overlap
  };
});
