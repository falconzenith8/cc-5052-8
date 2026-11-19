/*
 * 录制器：记录初始状态、逐 tick 输入、规则事件、定期完整检查点，
 * 并维护逐 tick 的哈希链（chain = H(chainPrev | stateHash)）与分节哈希轨迹。
 * 任何状态偏离都会在链上立刻显现，且可定位到具体 tick 与状态分节。
 */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const api = factory(
    isNode ? require('./sim.js') : root.SIM.sim,
    isNode ? require('./serialize.js') : root.SIM.serialize
  );
  if (isNode) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.recorder = api; }
})(typeof self !== 'undefined' ? self : globalThis, function (SIM, SER) {
  'use strict';

  class Recorder {
    constructor(scene, seed, checkpointEvery) {
      this.scene = scene;
      this.seed = seed >>> 0;
      this.checkpointEvery = checkpointEvery || 300;
      this.inputs = [];
      this.events = [];
      this.trail = [];
      this.checkpoints = [];
      this.chain = '0';
      this.endTick = 0;
      this.initialState = null;
    }

    begin(state) {
      this.initialState = SER.deepClone(state);
      this._trail(state);
      this._checkpoint(state);
    }

    recordInput(input) { this.inputs.push(input & 15); }

    recordEvents(tick, evs, results) {
      for (let i = 0; i < evs.length; i++) {
        this.events.push({ tick: tick, type: evs[i].type, data: evs[i].data || null, result: results[i] });
      }
    }

    afterStep(state) {
      this._trail(state);
      this._checkpoint(state);
      this.endTick = state.tick;
    }

    _trail(state) {
      const sh = SIM.stateHash(state);
      this.chain = SER.hashHex(this.chain + '|' + sh);
      const sec = SIM.sectionHashes(state);
      this.trail.push([this.chain].concat(SIM.SECTIONS.map(function (s) { return sec[s]; })));
    }

    _checkpoint(state) {
      if (state.tick % this.checkpointEvery === 0) {
        this.checkpoints.push({ tick: state.tick, state: SER.deepClone(state) });
      }
    }

    finalize(finalState) {
      return {
        format: 'simreplay/1',
        simVersion: SIM.SIM_VERSION,
        sceneId: this.scene.id,
        sceneHash: SER.hashHex(SER.canon(this.scene)),
        seed: this.seed,
        checkpointEvery: this.checkpointEvery,
        finished: finalState.finished,
        finishTick: finalState.finishTick,
        initialState: this.initialState,
        inputs: this.inputs,
        events: this.events,
        checkpoints: this.checkpoints,
        trail: this.trail,
        endTick: this.endTick,
        finalHash: this.chain,
        externalInputs: 'keyboard: recorded per-tick in inputs[]; fault events: recorded in events[] with rng-drawn results; wall-clock: excluded (fixed-tick sim, render rate independent)'
      };
    }
  }

  return { Recorder };
});
