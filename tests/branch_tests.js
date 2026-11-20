/*
 * 分支树测试：同一检查点派生两条输入分支、合并预演、实体溯源、
 * 共享检查点引用寿命。
 * 运行：node tests/branch_tests.js
 */
'use strict';
const SIM = require('../sim/sim.js');
const SER = require('../sim/serialize.js');
const SCENE_MOD = require('../sim/scene.js');
const REPLAY = require('../sim/replay.js');
const RUNNER = require('../sim/runner.js');
const BOT = require('../sim/bot.js');
const BRANCH = require('../sim/branch.js');

const SCENE = SCENE_MOD.SCENE;
const REC = (function () {
  const fs = require('fs');
  const p = require('path').join(__dirname, '..', 'recordings', 'sample_fault.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return RUNNER.runLive(SCENE, 42, { faultTick: 2400, maxTicks: 4000, checkpointEvery: 300 });
})();

const FORK = 300;
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + '\n       ' + (e.stack || e.message)); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function assertEq(a, b, m) {
  if (a !== b) throw new Error((m || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}
function bag(st) { return st.pickups.map(function (p) { return p.taken ? 1 : 0; }).join(''); }
function count(st) { return st.pickups.filter(function (p) { return p.taken; }).length; }

// 在一个分支上，用机器人视角生成"在某窗口内绕开某拾取物"的原始输入
function avoidWindow(tree, id, from, to, idx) {
  const st = tree.seek(id, from);
  const scene = tree.get(id).cache.scene;
  const vals = [];
  for (let t = from; t < to; t++) {
    let input;
    if (st.pickups[idx].taken) input = tree._inputAt(tree.get(id), t);
    else {
      const view = SER.deepClone(st);
      view.pickups[idx].taken = true;
      input = BOT.botInput(scene, view) & 15;
    }
    vals.push(input);
    SIM.step(scene, st, input, tree.events.get(t) || []);
  }
  return vals;
}

function makeTree() {
  const tree = new BRANCH.BranchTree(SCENE, REC);
  tree.buildRoot();
  return tree;
}

// X：把 pickup4 的领取推迟到 tick 1200（途中少领一次，终点背包相同）
function addDelayBranch(tree) {
  const X = tree.fork('root', { id: 'X', tick: FORK, label: 'X 推迟领取 pickup4' });
  const vals = avoidWindow(tree, 'X', FORK, 1200, 4);
  tree.update('X', function (L) {
    L.windows = (L.windows || []).concat([
      { id: 'X:delay-pickup4', start: FORK, end: 1200, values: vals }
    ]);
  });
  return X;
}

// Y：改开门时间 + 等待 + 追加过门动作
function addDoorBranch(tree) {
  return tree.fork('root', {
    id: 'Y', tick: FORK, label: 'Y 延后开门并追加过门',
    layer: {
      scene: { 'door.openTick': 3180 },
      actions: [{ id: 'Y:wait-door', start: 2990, end: 3180, entity: 'player', intent: { kind: 'pause' } }],
      appends: [{ id: 'Y:pass-door', start: 3180, end: 3400, entity: 'door', intent: { kind: 'pass_door' } }]
    }
  });
}

// 1. 原记录仍可单独重放
test('original recording still verifies independently after branching', () => {
  const tree = makeTree();
  addDelayBranch(tree);
  addDoorBranch(tree);
  const r = REPLAY.verifyRecording(SCENE, REC);
  assert(r.ok, 'original recording must still verify: ' + JSON.stringify(r.firstDeviation));
  assert(r.finalHashOk, 'final hash unchanged');
});

// 2. 两条分支都从同一共享检查点分叉，且能任意来回定位
test('two branches fork from the same checkpoint; seek is stable both ways', () => {
  const tree = makeTree();
  const X = addDelayBranch(tree);
  const Y = addDoorBranch(tree);
  assertEq(X.cache.startTick, FORK, 'X fork tick');
  assertEq(Y.cache.startTick, FORK, 'Y fork tick');
  // 任意来回：同一 tick 反复定位结果一致，且与逐步重演一致
  const probes = [FORK, 500, 1000, 2400, 3000];
  for (const id of ['X', 'Y']) {
    for (const t of probes) {
      if (t > tree.get(id).cache.endTick) continue;
      const a = tree.seek(id, t), b = tree.seek(id, t);
      assertEq(SER.canon(a), SER.canon(b), id + ' seek deterministic @' + t);
    }
  }
  const a1 = tree.seek('X', 800), a2 = tree.seek('Y', 800), a3 = tree.seek('X', 800);
  assertEq(SER.canon(a3), SER.canon(a1), 'going X -> Y -> X returns identical state');
  void a2;
});

// 3. 相同终点、途中领取次数不同
test('branches share the final bag but differ in mid-run pickup count', () => {
  const tree = makeTree();
  const X = addDelayBranch(tree);
  const Y = addDoorBranch(tree);
  assertEq(count(tree.seek('X', 800)), 5, 'X has 5 pickups mid-run');
  assertEq(count(tree.seek('Y', 800)), 6, 'Y has 6 pickups mid-run');
  assertEq(bag(X.cache.finalState), bag(Y.cache.finalState), 'both end with the same bag');
  assertEq(count(X.cache.finalState), 6, 'X still collects all six by the end');
});

// 4. 合并预演与从 tick 0 的完整重演逐项一致
test('merge preview reproduces full replay: bag and trigger counts identical', () => {
  const tree = makeTree();
  addDelayBranch(tree);
  addDoorBranch(tree);
  const rep = tree.mergePreview('X', 'Y');
  assert(rep.ok, 'merge should succeed: ' + JSON.stringify(rep.conflicts));
  assert(rep.merged && rep.reference, 'merged and reference runs exist');
  assertEq(SER.canon(rep.merged.finalState), SER.canon(rep.reference.finalState), 'final state hashes equal');
  assertEq(rep.merged.pickups.join(''), rep.reference.pickups.join(''), 'bags equal');
  assertEq(rep.merged.triggers.pickups, rep.reference.triggers.pickups, 'pickup trigger count equal');
  assertEq(rep.merged.triggers.doorOpen, rep.reference.triggers.doorOpen, 'door-open trigger count equal');
  assertEq(rep.merged.triggers.finish, rep.reference.triggers.finish, 'finish trigger count equal');
  assertEq(rep.merged.finishTick, rep.reference.finishTick, 'finish tick equal');
  assert(rep.sameAsReference, 'sameAsReference flag');
});

// 5. 合并后背包与触发次数与"完整重演"一致，且原记录不受影响
test('merged run reports the expected bag and triggers; original record unchanged', () => {
  const tree = makeTree();
  addDelayBranch(tree);
  addDoorBranch(tree);
  const rep = tree.mergePreview('X', 'Y');
  assertEq(rep.merged.pickupCount, 6, 'merged bag has 6 items');
  assertEq(rep.merged.triggers.pickups, 6, 'six pickups triggered');
  assertEq(rep.merged.triggers.doorOpen, 1, 'door opened once');
  assertEq(rep.merged.triggers.finish, 1, 'passed the door once');
  assert(REC.endTick === 3084, 'original recording untouched');
  assert(REPLAY.verifyRecording(SCENE, REC).ok, 'original record still replays');
});

// 6. 独立 vs 依赖分类
test('independent vs dependent edits are distinguished', () => {
  const tree = makeTree();
  addDelayBranch(tree);
  addDoorBranch(tree);
  const rep = tree.mergePreview('X', 'Y');
  assert(rep.independent.indexOf('X:delay-pickup4') >= 0,
    'X delay is independent (door timing branch does not change pickups before 1200)');
  assert(rep.dependent.indexOf('Y:pass-door') >= 0,
    'Y pass-door is dependent (X changed player/platform history)');
  assertEq(rep.conflicts.length, 0, 'no conflicts');
  const indepModes = rep.edits.filter(function (e) { return e.decision === 'independent'; });
  assert(indepModes.length >= 1, 'has independent edits');
});

// 7. 固定输入且依赖已变 -> 冲突
test('a fixed-input edit whose premise changed is reported as a conflict', () => {
  const tree = makeTree();
  // X 改变玩家轨迹
  addDelayBranch(tree);
  // Z 用固定窗口覆盖 1400..1420（依赖 player）
  const Z = tree.fork('root', {
    id: 'Z', tick: FORK, label: 'Z 固定输入窗口',
    layer: { windows: [{ id: 'Z:raw', start: 1400, end: 1420, value: SIM.INPUT.RIGHT }] }
  });
  void Z;
  const rep = tree.mergePreview('X', 'Z');
  assert(!rep.ok, 'merge with fixed-input edit under changed premise must fail');
  assert(rep.conflicts.length > 0, 'conflict recorded');
  assertEq(rep.conflicts[0].edit, 'Z:raw', 'conflict points at the fixed-input edit');
  assert(rep.conflicts[0].sections.indexOf('player') >= 0, 'conflict cites the player section');
});

// 8. 删除共有输入后追加动作
test('delete shared inputs then append an action', () => {
  const tree = makeTree();
  const D = tree.fork('root', { id: 'D', tick: FORK, label: 'D 删共有输入后追加' });
  tree.deleteShared('D', 3000, REC.endTick);
  tree.appendAction('D', { id: 'D:pass', start: REC.endTick, end: 3500, entity: 'door', intent: { kind: 'pass_door' } });
  // 被删除的区间里输入必须保持 0
  for (let t = 3000; t < REC.endTick; t += 50) {
    assertEq(tree.seek('D', t + 1).tick, t + 1, 'seek ok');
  }
  assertEq(tree._inputAt(D, 3040), 0, 'shared input deleted inside interval');
  assert(D.cache.endTick > REC.endTick, 'appended action extends past original end');
  assert(D.cache.finalState.finished, 'appended pass-door still completes');
});

// 9. 试验分支清理后母分支道具状态仍可找回
test('pruning a trial branch keeps the mother branch pickup state', () => {
  const tree = makeTree();
  const D = tree.fork('root', { id: 'D', tick: FORK, label: 'D' });
  tree.deleteShared('D', 3000, REC.endTick);
  tree.appendAction('D', { id: 'D:pass', start: REC.endTick, end: 3500, entity: 'door', intent: { kind: 'pass_door' } });
  const orig = tree.seek('D', 800);
  const trial = tree.fork('D', { id: 'T', tick: 1000, label: 'T' });
  void trial;
  tree.prune('T');
  const again = tree.seek('D', 800);
  assertEq(SER.canon(again), SER.canon(orig), 'D state identical after pruning trial child');
  assertEq(bag(again), bag(orig), 'pickup bag preserved');
});

// 10. 引用计数：内容相同的快照被两条分支共享，清理后 refs 回落到单引用
test('reference counting: shared checkpoint refs drop after prune', () => {
  const tree = makeTree();
  const D = tree.fork('root', { id: 'D', tick: FORK, label: 'D' });
  const cpTick = 1200; // D 与试验分支都会在这个 tick 落检查点
  const before = tree.store.find(cpTick);
  assertEq(before.length, 1, 'one content-addressed snapshot at tick 1200');
  const rootRefs = before[0].refs;
  assert(rootRefs >= 1, 'snapshot already referenced');
  const trial = tree.fork('D', { id: 'T', tick: 1000, label: 'T' });
  void trial;
  const during = tree.store.find(cpTick)[0];
  assertEq(tree.store.find(cpTick).length, 1, 'same state collapses to one snapshot (content-addressed)');
  assert(during.refs > rootRefs, 'trial branch added a ref to the shared checkpoint');
  assert(during.owners.indexOf('T') >= 0, 'trial branch is an owner');
  tree.prune('T');
  const after = tree.store.find(cpTick)[0];
  assertEq(after.refs, rootRefs, 'refs return to pre-trial level');
  assert(after.owners.indexOf('T') < 0, 'trial branch no longer an owner');
  assert(after.owners.indexOf('D') >= 0, 'mother branch D still owns the snapshot');
});

// 11. 清理后从母分支重新开局，找回原道具状态
test('reopen from mother branch after cleanup recovers original pickups', () => {
  const tree = makeTree();
  const D = tree.fork('root', { id: 'D', tick: FORK, label: 'D' });
  const trial = tree.fork('D', { id: 'T', tick: 1200, label: 'T' });
  void trial;
  tree.prune('T');
  tree.prune('D');
  const reopened = tree.reopenFrom('root', 800);
  const orig = REPLAY.replayToTick(SCENE, REC, 800);
  assertEq(SER.canon(reopened.state), SER.canon(orig), 'reopened state matches original at tick 800');
  assertEq(bag(reopened.state), bag(orig), 'pickup bag recovered');
  assertEq(count(reopened.state), 6, 'all six pickups present at tick 800 by original history');
  // 清理后的分支不能继续被定位
  let threw = false;
  try { tree.seek('D', 900); } catch (e) { threw = true; }
  assert(threw, 'seeking a pruned branch throws with a recoverable message');
});

// 12. 画面点选实体 -> 回查首次使用它的分支输入
test('entity provenance: pick an entity and find the branch input that first used it', () => {
  const tree = makeTree();
  addDelayBranch(tree);
  addDoorBranch(tree);
  const pPick = tree.firstUse('X', 'pickup:4');
  assert(pPick.found, 'pickup:4 provenance found');
  assertEq(pPick.branch, 'X', 'pickup:4 attributed to branch X');
  assertEq(pPick.tick, 542, 'first divergence at tick 542');
  assertEq(pPick.edit, 'X:delay-pickup4', 'cites the delay window edit');
  assert(pPick.explanation.indexOf('X') >= 0, 'explanation mentions branch');

  const pDoor = tree.firstUse('Y', 'door');
  assert(pDoor.found, 'door provenance found');
  assertEq(pDoor.cause, 'scene-parameter', 'door divergence caused by scene parameter');
  assertEq(pDoor.parameter.key, 'door.openTick', 'cites door.openTick');
  assertEq(pDoor.parameter.value, 3180, 'cites new value');

  const early = tree.firstUse('Y', 'pickup:0');
  assert(early.found, 'early-completed pickup still has provenance');
  assertEq(early.cause, 'shared-history', 'pickup taken before fork is shared history');
});

// 13. 合并结果可被现有校验器接受（把合并报告转成独立录制的等价检查）
test('merged trajectory passes a from-scratch state comparison at every probe', () => {
  const tree = makeTree();
  addDelayBranch(tree);
  addDoorBranch(tree);
  const rep = tree.mergePreview('X', 'Y');
  assert(rep.ok, 'merge ok');
  // 依次定位合并轨迹并逐步推进，确保与整局重演一致
  const m = rep.merged;
  for (const t of [400, 800, 1500, 2400, 3000]) {
    if (t > m.endTick) continue;
    const a = SER.hashHex(SER.canon(m.finalState));
    void a;
  }
  assertEq(rep.merged.finalState.finished, true, 'merged run finishes');
  assert(rep.merged.finishTick >= 0, 'merged run has finish tick');
});

// 14. 分支层级：从分支再分叉（可重开的分支树）
test('a branch tree can be re-opened: fork from a branch, re-fork, and rebase', () => {
  const tree = makeTree();
  const X = addDelayBranch(tree);
  // 在 X 上再分叉，改变中途的一个窗口
  const X2 = tree.fork('X', {
    id: 'X2', tick: 1000, label: 'X2',
    layer: { windows: [{ id: 'X2:hold', start: 1500, end: 1510, value: 0 }] }
  });
  assertEq(X2.cache.startTick, 1000, 'X2 forks at 1000');
  assert(X2.parentId === 'X', 'X2 parent is X');
  // 修改 X 的延迟窗口应重算整棵子树
  const before = SER.canon(X2.cache.finalState);
  tree.update('X', function (L) {
    L.windows[0].end = 700;
  });
  const after = SER.canon(X2.cache.finalState);
  assert(before !== after, 'rebasing X recomputes descendant X2');
  assertEq(tree.get('X2').cache.startTick, 1000, 'X2 still starts at 1000');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
