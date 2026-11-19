/*
 * 测试套件：验证确定性录制的各项性质。
 * 运行：node tests/run_tests.js
 */
'use strict';
const SIM = require('../sim/sim.js');
const SER = require('../sim/serialize.js');
const SCENE_MOD = require('../sim/scene.js');
const REPLAY = require('../sim/replay.js');
const RUNNER = require('../sim/runner.js');
const FRAME = require('../sim/frameloop.js');

const SCENE = SCENE_MOD.SCENE;
const SEED = 42;
const FAULT = 2400;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}

function freshRecording() {
  return RUNNER.runLive(SCENE, SEED, { faultTick: FAULT, maxTicks: 4000, checkpointEvery: 300 });
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

const REC = freshRecording();

// 1. 确定性：相同种子 + 相同输入策略 => 完全相同的轨迹哈希
test('determinism: identical runs produce identical final hash', () => {
  const a = freshRecording(), b = freshRecording();
  assertEq(a.finalHash, b.finalHash, 'finalHash');
  assertEq(a.endTick, b.endTick, 'endTick');
});

// 2. 从开头重演：逐 tick 哈希链一致
test('verify from start: ok, final hash matches, checkpoints authentic', () => {
  const r = REPLAY.verifyRecording(SCENE, REC);
  assert(r.ok, 'expected ok, got ' + JSON.stringify(r.firstDeviation || r.eventErrors));
  assert(r.finalHashOk, 'finalHash must match');
  assert(r.checkpointsAuthentic, 'checkpoints must be authentic');
  assertEq(REC.trail.length, REC.endTick + 1, 'trail covers every tick');
});

// 3. 从每个检查点重演：加载即检 + 第一步即检 + 到结尾一致（含故障点附近的检查点）
test('verify from every checkpoint: load check + first step check + to end', () => {
  assert(REC.checkpoints.length >= 8, 'expect periodic checkpoints');
  for (const cp of REC.checkpoints) {
    const r = REPLAY.verifyFromCheckpoint(SCENE, REC, cp.tick);
    assert(r.loadCheck && r.loadCheck.ok, 'load check failed at cp ' + cp.tick);
    if (cp.tick < REC.endTick) assert(r.firstStepCheck && r.firstStepCheck.ok, 'first step check failed at cp ' + cp.tick);
    assert(r.ok, 'verify from cp ' + cp.tick + ' failed: ' + JSON.stringify(r.firstDeviation));
  }
});

// 4. 故障样例：故障发生在运行中后段，结果被记录，机关状态被永久改变且保留在末状态中
test('fault sample: fault in late run, recorded, mechanism state persists', () => {
  assertEq(REC.events.length, 1, 'one fault event');
  const ev = REC.events[0];
  assertEq(ev.tick, FAULT, 'fault tick');
  assert(ev.tick > REC.endTick * 0.6, 'fault must be in latter part of run (tick ' + ev.tick + ' of ' + REC.endTick + ')');
  assert(ev.result && ev.result.kind, 'fault result recorded');
  const finalState = REPLAY.replayToTick(SCENE, REC, REC.endTick);
  const altered =
    finalState.platforms.some(p => p.speedMul !== 1 || p.jamLeft > 0) ||
    finalState.crushers.some(c => c.speedMul !== 1 || c.jamLeft > 0) ||
    finalState.traps.some(t => t.haywire);
  assert(altered, 'fault-altered mechanism state must persist into final state (not hidden/restored)');
});

// 5. 篡改输入：首次偏离被定位到正确 tick 与状态分节
test('tampered input: first deviation localized to tick and section', () => {
  const rec = clone(REC);
  // 找一个玩家确实站在地面的 tick，翻转跳跃位，保证必然产生偏离
  let t = -1;
  for (let k = 500; k < rec.endTick - 2; k++) {
    const st = REPLAY.replayToTick(SCENE, rec, k);
    if (st.player.grounded && !(rec.inputs[k] & SIM.INPUT.JUMP)) { t = k; break; }
  }
  assert(t > 0, 'found a grounded tick to tamper');
  rec.inputs[t] |= SIM.INPUT.JUMP;
  const r = REPLAY.verifyRecording(SCENE, rec);
  assert(!r.ok, 'tampered recording must fail verification');
  assertEq(r.firstDeviation.tick, t + 1, 'deviation tick');
  assert(r.firstDeviation.sections.includes('player'), 'player section must deviate, got ' + r.firstDeviation.sections);
  assert(r.firstDeviation.playerPos && typeof r.firstDeviation.playerPos.x === 'number', 'deviation reports player position');
});

// 6. 篡改检查点的每一个状态分节：加载即检必须全部发现（检查点覆盖全部后续求值依赖，不隐藏机关状态）
test('checkpoint tampering in EVERY section is detected at load', () => {
  const cpTick = REC.checkpoints[Math.floor(REC.checkpoints.length / 2)].tick;
  const cases = [
    ['meta', s => { s.score += 1; }],
    ['rng', s => { s.rng = (s.rng + 1) >>> 0; }],
    ['player', s => { s.player.hp -= 1; }],
    ['platforms', s => { s.platforms[0].x += 0.5; }],
    ['crushers', s => { s.crushers[0].y += 1; }],
    ['traps', s => { s.traps[0].cooldown += 1; }],
    ['darts', s => { s.darts.push({ x: 1, y: 1, vx: 1, vy: 0, life: 10 }); }],
    ['pickups', s => { s.pickups[0].taken = !s.pickups[0].taken; }],
    ['door', s => { s.door.openTicks += 1; }]
  ];
  for (const [section, mutate] of cases) {
    const rec = clone(REC);
    const cp = rec.checkpoints.find(c => c.tick === cpTick);
    mutate(cp.state);
    const r = REPLAY.verifyFromCheckpoint(SCENE, rec, cpTick);
    assert(!r.ok, 'tampered section ' + section + ' must fail');
    assert(r.loadCheck && !r.loadCheck.ok, 'section ' + section + ' must be caught at load time');
    assert(r.loadCheck.sections.includes(section),
      'section ' + section + ' must be identified, got ' + r.loadCheck.sections.join(','));
  }
});

// 7. 删除故障事件：偏离恰好出现在故障后的第一个 tick
test('removed fault event: deviation appears exactly at faultTick+1', () => {
  const rec = clone(REC);
  rec.events = [];
  const r = REPLAY.verifyRecording(SCENE, rec);
  assert(!r.ok, 'must fail');
  assertEq(r.firstDeviation.tick, FAULT + 1, 'deviation tick');
  assert(r.firstDeviation.sections.includes('rng'), 'rng section deviates (fault draws rng)');
});

// 8. 篡改事件结果：事件交叉校验报错
test('tampered event result: event cross-check fails', () => {
  const rec = clone(REC);
  rec.events[0].result = { kind: 'trap', index: 0, haywire: true };
  const r = REPLAY.verifyRecording(SCENE, rec);
  assert(!r.ok, 'must fail');
  assert(r.eventErrors.length > 0, 'event errors reported');
  assertEq(r.eventErrors[0].tick, FAULT, 'event error tick');
});

// 9. 版本 / 资源绑定：不匹配的模拟版本或场景哈希被拒绝
test('binding: sim version and scene identity are enforced', () => {
  const r1 = clone(REC); r1.simVersion = '0.9.0';
  const v1 = REPLAY.verifyRecording(SCENE, r1);
  assert(!v1.ok && v1.bindingErrors.some(e => e.startsWith('simVersion')), 'simVersion mismatch rejected');

  const r2 = clone(REC); r2.sceneHash = 'deadbeefdeadbeef';
  const v2 = REPLAY.verifyRecording(SCENE, r2);
  assert(!v2.ok && v2.bindingErrors.some(e => e.startsWith('sceneHash')), 'sceneHash mismatch rejected');

  const r3 = clone(REC); r3.seed = 12345; // 种子与记录内容不符 -> 初始状态哈希对不上
  const v3 = REPLAY.verifyRecording(SCENE, r3);
  assert(!v3.ok, 'seed/initial-state mismatch detected');
});

// 10. 渲染帧率无关：同一输入序列在不同帧率调度下轨迹完全一致
test('render frame rate does not affect rule trajectory', () => {
  function runWithFrames(dtSequence) {
    const loop = new FRAME.FrameLoop();
    const state = SIM.initialState(SCENE, SEED);
    const hashes = new Map();
    let fi = 0;
    while (state.tick < REC.endTick) {
      const n = loop.advance(dtSequence[fi++ % dtSequence.length]);
      for (let i = 0; i < n && state.tick < REC.endTick; i++) {
        SIM.step(SCENE, state, REC.inputs[state.tick], []);
        if (state.tick % 500 === 0) hashes.set(state.tick, SIM.stateHash(state));
      }
    }
    return hashes;
  }
  const a = runWithFrames([1 / 60]);
  const b = runWithFrames([1 / 23]);
  const c = runWithFrames([1 / 144, 1 / 30, 1 / 97]);
  for (const [tick, h] of a) {
    assertEq(b.get(tick), h, 'hash at tick ' + tick + ' (23fps vs 60fps)');
    assertEq(c.get(tick), h, 'hash at tick ' + tick + ' (mixed fps vs 60fps)');
  }
});

// 11. 检查点定位：replayToTick 在任意时刻的状态与轨迹记录一致（含故障前后）
test('checkpoint-based seek reproduces recorded state at any tick', () => {
  for (const t of [0, 1, 299, 300, 2399, FAULT, FAULT + 1, 2500, 2900, REC.endTick]) {
    const st = REPLAY.replayToTick(SCENE, REC, t);
    const sec = SIM.sectionHashes(st);
    const entry = REC.trail[t];
    SIM.SECTIONS.forEach((s, i) => {
      assertEq(sec[s], entry[1 + i], 'section ' + s + ' at tick ' + t);
    });
  }
});

// 12. 状态级验证而非画面相似：不同随机初值 => 不同轨迹（肉眼相近也不算正确）
test('different random seed produces different trajectory (state-level, not visual)', () => {
  const other = RUNNER.runLive(SCENE, 43, { faultTick: FAULT, maxTicks: 4000, checkpointEvery: 300 });
  assert(other.finalHash !== REC.finalHash, 'different seed must yield different final hash');
  const r = REPLAY.verifyRecording(SCENE, other);
  assert(r.ok, 'other recording is itself verifiable');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
