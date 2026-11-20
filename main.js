#!/usr/bin/env node
/*
 * CLI：
 *   node main.js record --seed 42 --fault 2400 --out recordings/sample_fault.json
 *   node main.js verify <file>                 从开头 + 每个检查点校验
 *   node main.js demo <file> <from> <to> [n]   ASCII 渲染每 n tick 一帧
 *   node main.js state <file> <tick>           打印某 tick 的完整状态（经检查点定位）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SIM = require('./sim/sim.js');
const SER = require('./sim/serialize.js');
const SCENE_MOD = require('./sim/scene.js');
const REPLAY = require('./sim/replay.js');
const RUNNER = require('./sim/runner.js');
const BRANCH = require('./sim/branch.js');

const SCENE = SCENE_MOD.SCENE;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else args._.push(argv[i]);
  }
  return args;
}

function asciiFrame(scene, state) {
  const W = 96, H = 27;
  const sx = scene.width / W, sy = scene.height / H;
  const grid = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill(' '));
  function put(x, y, w, h, ch) {
    const x0 = Math.max(0, Math.floor(x / sx)), x1 = Math.min(W - 1, Math.floor((x + w - 1) / sx));
    const y0 = Math.max(0, Math.floor(y / sy)), y1 = Math.min(H - 1, Math.floor((y + h - 1) / sy));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) grid[yy][xx] = ch;
  }
  for (const s of scene.solids) put(s.x, s.y, s.w, s.h, '#');
  for (const w of scene.oneWays) put(w.x, w.y, w.w, w.h, '-');
  for (let i = 0; i < scene.platforms.length; i++) {
    const pl = state.platforms[i], def = scene.platforms[i];
    put(pl.x, pl.y, def.w, def.h, pl.jamLeft > 0 ? 'J' : '=');
  }
  for (let i = 0; i < scene.crushers.length; i++) {
    const c = state.crushers[i], def = scene.crushers[i];
    put(def.x, c.y, def.w, def.h, c.jamLeft > 0 ? 'J' : 'V');
  }
  for (let i = 0; i < scene.dartTraps.length; i++) {
    const def = scene.dartTraps[i];
    put(def.x - 4, def.y - 4, 8, 8, state.traps[i].haywire ? 'H' : 'T');
  }
  for (const d of state.darts) put(d.x - 4, d.y - 2, 8, 4, '*');
  for (let i = 0; i < scene.pickups.length; i++) {
    if (!state.pickups[i].taken) put(scene.pickups[i].x, scene.pickups[i].y, 16, 16, 'o');
  }
  const openFrac = state.door.openTicks / SIM.DOOR_OPEN_TICKS;
  if (openFrac < 1) put(scene.door.x, scene.door.y, scene.door.w, scene.door.h, 'D');
  else put(scene.door.x, scene.door.y, scene.door.w, 8, 'd');
  const P = state.player;
  put(P.x, P.y, SIM.PLAYER_W, SIM.PLAYER_H, P.invuln > 0 ? 'p' : 'P');
  return grid.map(function (r) { return r.join(''); }).join('\n');
}

function cmdRecord(args) {
  const seed = parseInt(args.seed || '42', 10) >>> 0;
  const fault = args.fault != null ? parseInt(args.fault, 10) : null;
  const maxTicks = args.maxticks ? parseInt(args.maxticks, 10) : 4000;
  const cpEvery = args['checkpoint-every'] ? parseInt(args['checkpoint-every'], 10) : 300;
  const rec = RUNNER.runLive(SCENE, seed, { faultTick: fault, maxTicks: maxTicks, checkpointEvery: cpEvery });
  const out = args.out;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(rec));
  }
  const ev = rec.events.map(function (e) { return e.type + '@' + e.tick + ' -> ' + JSON.stringify(e.result); });
  console.log('recorded: seed=' + seed + ' endTick=' + rec.endTick +
    ' finished=' + rec.finished + ' finishTick=' + rec.finishTick +
    ' checkpoints=' + rec.checkpoints.length + ' finalHash=' + rec.finalHash);
  console.log('events: ' + (ev.join('; ') || '(none)'));
  if (out) console.log('written: ' + out + ' (' + fs.statSync(out).size + ' bytes)');
  else console.log(JSON.stringify(rec));
}

function cmdVerify(file) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('== binding ==');
  const bindErrs = REPLAY.bindingCheck(SCENE, rec);
  if (bindErrs.length) {
    console.log('BINDING FAILED:');
    for (const e of bindErrs) console.log('  - ' + e);
    process.exitCode = 2;
    return;
  }
  console.log('simVersion=' + rec.simVersion + ' sceneId=' + rec.sceneId + ' sceneHash=' + rec.sceneHash.slice(0, 12) + '... seed=' + rec.seed);
  console.log('endTick=' + rec.endTick + ' checkpoints=' + rec.checkpoints.length + ' events=' + rec.events.length);

  console.log('\n== verify from start ==');
  const t0 = Date.now();
  const full = REPLAY.verifyRecording(SCENE, rec);
  console.log(formatReport(full) + '  (' + (Date.now() - t0) + 'ms)');

  console.log('\n== verify from each checkpoint ==');
  let allOk = true;
  for (const cp of rec.checkpoints) {
    const r = REPLAY.verifyFromCheckpoint(SCENE, rec, cp.tick);
    allOk = allOk && r.ok;
    console.log('  cp@' + String(cp.tick).padStart(5) + ': load=' + okStr(r.loadCheck && r.loadCheck.ok) +
      ' firstStep=' + okStr(r.firstStepCheck ? r.firstStepCheck.ok : null) +
      ' toEnd=' + okStr(r.ok));
  }

  console.log('\n== summary ==');
  const ok = full.ok && allOk;
  console.log(ok ? 'REPLAY VERIFIED: trajectory identical from start and from every checkpoint.'
                 : 'REPLAY DIVERGENCE DETECTED — see above.');
  process.exitCode = ok ? 0 : 1;
}

function okStr(v) { return v === null || v === undefined ? '  - ' : (v ? ' ok ' : 'FAIL'); }

function formatReport(r) {
  if (r.ok) return 'OK: ' + r.endTick + ' ticks, finalHash match, checkpoints authentic, event results match';
  const lines = ['FAILED:'];
  if (r.bindingErrors && r.bindingErrors.length) lines.push('  binding: ' + r.bindingErrors.join('; '));
  if (r.firstDeviation) {
    lines.push('  first deviation @ tick ' + r.firstDeviation.tick +
      ' sections=[' + r.firstDeviation.sections.join(',') + ']' +
      ' playerPos=(' + r.firstDeviation.playerPos.x.toFixed(1) + ',' + r.firstDeviation.playerPos.y.toFixed(1) + ')');
  }
  if (r.eventErrors && r.eventErrors.length) lines.push('  event errors: ' + JSON.stringify(r.eventErrors[0]));
  if (r.checkpointErrors && r.checkpointErrors.length) lines.push('  checkpoint errors: ' + JSON.stringify(r.checkpointErrors[0]));
  if (!r.finalHashOk && !r.firstDeviation) lines.push('  final hash mismatch');
  return lines.join('\n');
}

function cmdDemo(file, from, to, n) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let t = from; t <= to; t += n) {
    const st = REPLAY.replayToTick(SCENE, rec, t);
    console.log('--- tick ' + t + '  score=' + st.score + ' hp=' + st.player.hp +
      '  crushers=' + st.crushers.map(function (c) { return c.y.toFixed(0) + (c.jamLeft > 0 ? 'JAM' : ''); }).join(',') +
      '  traps=' + st.traps.map(function (x) { return x.haywire ? 'HAYWIRE' : x.cooldown; }).join(',') +
      '  platformJam=' + st.platforms[0].jamLeft + ' ---');
    console.log(asciiFrame(SCENE, st));
  }
}

function cmdState(file, tick) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const st = REPLAY.replayToTick(SCENE, rec, tick);
  console.log(JSON.stringify(st, null, 2));
}

function loadRec(file) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errs = REPLAY.bindingCheck(SCENE, rec);
  if (errs.length) throw new Error('binding failed: ' + errs.join('; '));
  return rec;
}

function fmtBag(st) {
  return st.pickups.map(function (p, i) { return p.taken ? i : null; }).filter(function (x) { return x != null; }).join(',') || '(空)';
}

function countAt(tree, id, tick) {
  const st = tree.seek(id, tick);
  return st.pickups.filter(function (p) { return p.taken; }).length;
}

/*
 * branch <file> <forkTick>
 *   在同一检查点上派生两条输入分支并做合并预演：
 *   X 把 pickup4 的领取推迟到 tick 1200（途中少领一次）；
 *   Y 把开门时间改到 tick 3180 并追加过门动作。
 *   合并结果与从 tick 0 的完整重演逐项对照；原记录仍单独校验。
 */
function cmdBranch(file, forkTick) {
  const rec = loadRec(file);
  if (forkTick == null) forkTick = 300;
  const tree = new BRANCH.BranchTree(SCENE, rec);
  const root = tree.buildRoot();

  console.log('== 原记录 ==');
  const rootOk = REPLAY.verifyRecording(SCENE, rec);
  console.log('  独立重放: ' + (rootOk.ok ? 'OK' : 'FAIL') +
    '  endTick=' + rec.endTick + '  finishTick=' + rec.finishTick +
    '  最终背包={' + fmtBag(tree.seek('root', rec.endTick)) + '}');

  console.log('\n== 共享检查点 ==');
  console.log('  检查点每 ' + tree.every + ' tick；存储 ' + tree.store.size() +
    ' 个内容寻址快照，' + tree.store.totals().shared + ' 个被多分支共享');

  // X：推迟领取 pickup4
  const X = tree.fork('root', { id: 'X', tick: forkTick, label: 'X 推迟领取 pickup4' });
  const vals = [];
  {
    const st = tree.seek('X', forkTick);
    const scene = X.cache.scene;
    for (let t = forkTick; t < 1200; t++) {
      let input;
      if (st.pickups[4].taken) input = tree._inputAt(X, t);
      else {
        const view = SER.deepClone(st);
        view.pickups[4].taken = true;
        input = require('./sim/bot.js').botInput(scene, view) & 15;
      }
      vals.push(input);
      SIM.step(scene, st, input, tree.events.get(t) || []);
    }
  }
  tree.update('X', function (L) {
    L.windows = (L.windows || []).concat([{ id: 'X:delay-pickup4', start: forkTick, end: 1200, values: vals }]);
  });

  // Y：改变开门时间 + 追加动作
  const Y = tree.fork('root', {
    id: 'Y', tick: forkTick, label: 'Y 延后开门并追加过门',
    layer: {
      scene: { 'door.openTick': 3180 },
      actions: [{ id: 'Y:wait-door', start: 2990, end: 3180, entity: 'player', intent: { kind: 'pause' } }],
      appends: [{ id: 'Y:pass-door', start: 3180, end: 3400, entity: 'door', intent: { kind: 'pass_door' } }]
    }
  });

  const probes = [600, 800, 1200];
  console.log('\n== 两条分支 ==');
  for (const b of [X, Y]) {
    console.log('  ' + b.id + ' [' + b.label + ']  分叉@' + b.forkTick +
      '  结束@' + b.cache.endTick + '  过门@' + b.cache.finalState.finishTick);
    console.log('    途中已领: ' + probes.map(function (t) {
      return 't' + t + '=' + countAt(tree, b.id, t);
    }).join(' ') + '   最终背包={' + fmtBag(b.cache.finalState) + '}');
  }
  console.log('  原记录途中已领: ' + probes.map(function (t) {
    return 't' + t + '=' + countAt(tree, 'root', t);
  }).join(' ') + '（对照：X 在途中少领一次，终点背包相同）');

  console.log('\n== 实体溯源（画面点选）==');
  for (const id of ['pickup:4', 'door']) {
    const p = tree.firstUse('X', id);
    console.log('  X 点选 ' + id + ' -> ' + p.explanation);
  }

  console.log('\n== 合并预演 ==');
  const rep = tree.mergePreview('X', 'Y');
  for (const e of rep.edits) {
    console.log('  [' + e.decision + '] ' + e.id + '  ' + e.reason);
  }
  if (rep.conflicts.length) {
    for (const c of rep.conflicts) console.log('  冲突: ' + c.reason);
  }
  if (rep.merged) {
    console.log('  合并结果: endTick=' + rep.merged.endTick + '  finishTick=' + rep.merged.finishTick +
      '  背包={' + rep.merged.pickups.map(function (v, i) { return v ? i : null; }).filter(function (x) { return x != null; }).join(',') + '}' +
      '  拾取触发=' + rep.merged.triggers.pickups +
      '  开门=' + rep.merged.triggers.doorOpen + '  过门=' + rep.merged.triggers.finish);
    console.log('  完整重演: endTick=' + rep.reference.endTick + '  finishTick=' + rep.reference.finishTick +
      '  背包={' + rep.reference.pickups.map(function (v, i) { return v ? i : null; }).filter(function (x) { return x != null; }).join(',') + '}' +
      '  拾取触发=' + rep.reference.triggers.pickups +
      '  开门=' + rep.reference.triggers.doorOpen + '  过门=' + rep.reference.triggers.finish);
    console.log('  逐项一致: ' + (rep.sameAsReference ? 'YES' : 'NO'));
  }

  console.log('\n== 删除共有输入后追加动作 ==');
  const D = tree.fork('root', { id: 'D', tick: forkTick, label: 'D 删共有输入再加动作' });
  tree.deleteShared('D', 3000, rec.endTick);
  tree.appendAction('D', { id: 'D:pass-door', start: rec.endTick, end: 3500, entity: 'door', intent: { kind: 'pass_door' } });
  console.log('  D 结束@' + D.cache.endTick + '  过门@' + D.cache.finalState.finishTick +
    '  背包={' + fmtBag(D.cache.finalState) + '}');

  console.log('\n== 检查点引用寿命 ==');
  const before = tree.store.totals();
  console.log('  清理前: entries=' + before.entries + ' refs=' + before.refs + ' shared=' + before.shared);
  const trial = tree.fork('D', { id: 'T', tick: 1000, label: '试验分支' });
  const during = tree.store.totals();
  console.log('  派生试验分支 T 后: entries=' + during.entries + ' refs=' + during.refs + ' shared=' + during.shared);
  const pr = tree.prune('T');
  const after = tree.store.totals();
  console.log('  清理 T 后: entries=' + after.entries + ' refs=' + after.refs + ' shared=' + after.shared +
    '（释放 ' + pr.released.length + ' 个引用，母分支 D 与 root 的快照仍在）');
  const reopened = tree.reopenFrom('root', 800);
  const orig = REPLAY.replayToTick(SCENE, rec, 800);
  console.log('  从母分支 root 重新开局@800: 背包={' + fmtBag(reopened.state) + '}  ' +
    '与原记录状态一致: ' + (SER.canon(reopened.state) === SER.canon(orig) ? 'YES' : 'NO'));

  console.log('\n== 说明 ==');
  for (const line of rep.explanations) console.log('  - ' + line);
  const bad = !rep.ok || !rootOk.ok;
  process.exitCode = bad ? 1 : 0;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'record') cmdRecord(args);
else if (cmd === 'verify') cmdVerify(args._[1]);
else if (cmd === 'demo') cmdDemo(args._[1], parseInt(args._[2], 10), parseInt(args._[3], 10), parseInt(args._[4] || '30', 10));
else if (cmd === 'state') cmdState(args._[1], parseInt(args._[2], 10));
else if (cmd === 'branch') cmdBranch(args._[1], args._[2] != null ? parseInt(args._[2], 10) : null);
else {
  console.log('usage:\n  node main.js record --seed N --fault T --out file.json\n  node main.js verify file.json\n  node main.js branch file.json [forkTick]  同一检查点派生两条分支并合并预演\n  node main.js demo file.json from to [n]\n  node main.js state file.json tick');
}
