/*
 * 回放与校验。
 *
 * verifyRecording: 从初始状态完整重演，逐 tick 比对哈希链与分节哈希，
 *   报告首次偏离的 tick、偏离的状态分节、当时玩家位置。
 * verifyFromCheckpoint: 从指定检查点加载——加载时立即校验快照哈希，
 *   第一步重演后立即与原始轨迹比对，然后校验到结尾。
 * replayToTick: 借助最近检查点快速定位到任意中间时刻。
 * diffStates: 当两侧状态都在手边时给出字段级差异。
 */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const api = factory(
    isNode ? require('./sim.js') : root.SIM.sim,
    isNode ? require('./serialize.js') : root.SIM.serialize
  );
  if (isNode) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.replay = api; }
})(typeof self !== 'undefined' ? self : globalThis, function (SIM, SER) {
  'use strict';

  function bindingCheck(scene, rec) {
    const errs = [];
    if (rec.format !== 'simreplay/1') errs.push('format: expected simreplay/1, got ' + rec.format);
    if (rec.simVersion !== SIM.SIM_VERSION) {
      errs.push('simVersion: recording=' + rec.simVersion + ' current=' + SIM.SIM_VERSION);
    }
    const sh = SER.hashHex(SER.canon(scene));
    if (rec.sceneHash !== sh) errs.push('sceneHash: recording=' + rec.sceneHash + ' current=' + sh);
    if (rec.sceneId !== scene.id) errs.push('sceneId: recording=' + rec.sceneId + ' current=' + scene.id);
    if (rec.initialState && (rec.seed >>> 0) !== (rec.initialState.rng >>> 0)) {
      errs.push('seed: ' + rec.seed + ' does not match initialState.rng ' + rec.initialState.rng);
    }
    return errs;
  }

  function eventsByTick(rec) {
    const m = new Map();
    for (const e of rec.events) {
      if (!m.has(e.tick)) m.set(e.tick, []);
      m.get(e.tick).push(e);
    }
    return m;
  }

  // 将当前状态与轨迹中 tickIdx 处记录比对；返回 null（一致）或偏离描述。
  function compareAtTick(state, rec, tickIdx) {
    const entry = rec.trail[tickIdx];
    if (!entry) return { sections: ['<trail-missing>'], chainOk: false };
    const sec = SIM.sectionHashes(state);
    const diffs = [];
    for (let i = 0; i < SIM.SECTIONS.length; i++) {
      if (sec[SIM.SECTIONS[i]] !== entry[1 + i]) diffs.push(SIM.SECTIONS[i]);
    }
    const prevChain = tickIdx === 0 ? '0' : rec.trail[tickIdx - 1][0];
    const expectedChain = SER.hashHex(prevChain + '|' + SIM.stateHash(state));
    const chainOk = expectedChain === entry[0];
    if (diffs.length === 0 && chainOk) return null;
    return { sections: diffs, chainOk: chainOk };
  }

  function stripResults(evs) {
    return evs.map(function (e) { return { type: e.type, data: e.data }; });
  }

  function verifyRecording(scene, rec, opts) {
    opts = opts || {};
    const report = {
      ok: true, bindingErrors: [], eventErrors: [],
      firstDeviation: null, finalHashOk: false,
      checkpointsAuthentic: true, checkpointErrors: [],
      endTick: rec.endTick
    };
    report.bindingErrors = bindingCheck(scene, rec);
    if (report.bindingErrors.length) { report.ok = false; return report; }

    const evMap = eventsByTick(rec);
    const state = SER.deepClone(rec.initialState);

    let dev = compareAtTick(state, rec, 0);
    if (dev) {
      report.ok = false;
      report.firstDeviation = { tick: 0, sections: dev.sections, chainOk: dev.chainOk, playerPos: { x: state.player.x, y: state.player.y } };
      return report;
    }

    let lastChain = rec.trail[0][0];
    for (let t = 0; t < rec.endTick; t++) {
      const recEvs = evMap.get(t) || [];
      let input = rec.inputs[t];
      if (opts.inputOverride) {
        const o = opts.inputOverride(t);
        if (o != null) input = o;
      }
      const results = SIM.step(scene, state, input, stripResults(recEvs));
      for (let i = 0; i < results.length; i++) {
        if (SER.canon(results[i]) !== SER.canon(recEvs[i].result)) {
          report.eventErrors.push({ tick: t, expected: recEvs[i].result, actual: results[i] });
        }
      }
      const d = compareAtTick(state, rec, t + 1);
      lastChain = rec.trail[t + 1][0];
      if (d) {
        report.ok = false;
        report.firstDeviation = {
          tick: t + 1, sections: d.sections, chainOk: d.chainOk,
          playerPos: { x: state.player.x, y: state.player.y }
        };
        return report;
      }
    }

    report.finalHashOk = lastChain === rec.finalHash;

    for (const cp of rec.checkpoints) {
      const d = compareAtTick(cp.state, rec, cp.tick);
      if (d) {
        report.checkpointsAuthentic = false;
        report.checkpointErrors.push({ tick: cp.tick, sections: d.sections });
      }
    }

    report.ok = report.finalHashOk && report.eventErrors.length === 0 && report.checkpointsAuthentic;
    return report;
  }

  function verifyFromCheckpoint(scene, rec, cpTick, opts) {
    opts = opts || {};
    const report = {
      ok: true, cpTick: cpTick, error: null,
      loadCheck: null, firstStepCheck: null,
      eventErrors: [], firstDeviation: null, finalHashOk: false
    };
    report.bindingErrors = bindingCheck(scene, rec);
    if (report.bindingErrors.length) { report.ok = false; return report; }

    const cp = rec.checkpoints.find(function (c) { return c.tick === cpTick; });
    if (!cp) { report.ok = false; report.error = 'no checkpoint at tick ' + cpTick; return report; }

    const state = SER.deepClone(cp.state);

    // 加载即检：快照状态必须与原始轨迹一致
    const loadDev = compareAtTick(state, rec, cpTick);
    report.loadCheck = loadDev
      ? { ok: false, sections: loadDev.sections, chainOk: loadDev.chainOk }
      : { ok: true };
    if (loadDev) { report.ok = false; return report; }

    const evMap = eventsByTick(rec);
    let lastChain = rec.trail[cpTick][0];
    for (let t = cpTick; t < rec.endTick; t++) {
      const recEvs = evMap.get(t) || [];
      let input = rec.inputs[t];
      if (opts.inputOverride) {
        const o = opts.inputOverride(t);
        if (o != null) input = o;
      }
      const results = SIM.step(scene, state, input, stripResults(recEvs));
      for (let i = 0; i < results.length; i++) {
        if (SER.canon(results[i]) !== SER.canon(recEvs[i].result)) {
          report.eventErrors.push({ tick: t, expected: recEvs[i].result, actual: results[i] });
        }
      }
      const d = compareAtTick(state, rec, t + 1);
      lastChain = rec.trail[t + 1][0];
      if (t === cpTick) {
        // 第一步即检：从检查点重演的第一步就必须与原运行一致
        report.firstStepCheck = d ? { ok: false, sections: d.sections } : { ok: true };
      }
      if (d) {
        report.ok = false;
        report.firstDeviation = {
          tick: t + 1, sections: d.sections, chainOk: d.chainOk,
          playerPos: { x: state.player.x, y: state.player.y }
        };
        return report;
      }
    }
    report.finalHashOk = lastChain === rec.finalHash;
    report.ok = report.finalHashOk && report.eventErrors.length === 0;
    return report;
  }

  function replayToTick(scene, rec, target) {
    let cp = null;
    for (const c of rec.checkpoints) {
      if (c.tick <= target && (!cp || c.tick > cp.tick)) cp = c;
    }
    let state, start;
    if (cp) { state = SER.deepClone(cp.state); start = cp.tick; }
    else { state = SER.deepClone(rec.initialState); start = 0; }
    const evMap = eventsByTick(rec);
    for (let t = start; t < target; t++) {
      SIM.step(scene, state, rec.inputs[t], stripResults(evMap.get(t) || []));
    }
    return state;
  }

  function diffStates(a, b, path, out) {
    path = path || '';
    out = out || [];
    if (typeof a !== typeof b || (a === null) !== (b === null)) {
      out.push({ path: path, a: a, b: b });
      return out;
    }
    if (a !== null && typeof a === 'object') {
      const keys = {};
      for (const k of Object.keys(a)) keys[k] = true;
      for (const k of Object.keys(b)) keys[k] = true;
      for (const k of Object.keys(keys)) {
        diffStates(a[k], b[k], path ? path + '.' + k : k, out);
      }
      return out;
    }
    if (a !== b) out.push({ path: path, a: a, b: b });
    return out;
  }

  return { bindingCheck, verifyRecording, verifyFromCheckpoint, replayToTick, diffStates, eventsByTick };
});
