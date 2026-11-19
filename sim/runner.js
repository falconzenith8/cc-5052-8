/*
 * 实况运行器：用机器人玩家驱动一次完整运行并录制。
 * 故障事件由"环境"（剧本）在指定 tick 注入，被记录进事件流。
 */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const api = factory(
    isNode ? require('./sim.js') : root.SIM.sim,
    isNode ? require('./recorder.js') : root.SIM.recorder,
    isNode ? require('./bot.js') : root.SIM.bot
  );
  if (isNode) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.runner = api; }
})(typeof self !== 'undefined' ? self : globalThis, function (SIM, REC, BOT) {
  'use strict';

  function runLive(scene, seed, opts) {
    opts = opts || {};
    const maxTicks = opts.maxTicks || 4000;
    const rec = new REC.Recorder(scene, seed, opts.checkpointEvery || 300);
    const state = SIM.initialState(scene, seed);
    rec.begin(state);
    while (!state.finished && state.tick < maxTicks) {
      const t0 = state.tick;
      const input = BOT.botInput(scene, state);
      rec.recordInput(input);
      const evs = [];
      if (opts.faultTick != null && t0 === opts.faultTick) {
        evs.push({ type: 'mech_malfunction', data: { source: 'scenario-script' } });
      }
      const results = SIM.step(scene, state, input, evs);
      if (evs.length) rec.recordEvents(t0, evs, results);
      rec.afterStep(state);
    }
    return rec.finalize(state);
  }

  return { runLive };
});
