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

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'record') cmdRecord(args);
else if (cmd === 'verify') cmdVerify(args._[1]);
else if (cmd === 'demo') cmdDemo(args._[1], parseInt(args._[2], 10), parseInt(args._[3], 10), parseInt(args._[4] || '30', 10));
else if (cmd === 'state') cmdState(args._[1], parseInt(args._[2], 10));
else {
  console.log('usage:\n  node main.js record --seed N --fault T --out file.json\n  node main.js verify file.json\n  node main.js demo file.json from to [n]\n  node main.js state file.json tick');
}
