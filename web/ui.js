/* 交互式调试界面：实况录制 + 回放 + 校验 + 时间轴定位。 */
'use strict';
(function () {
  const S = window.SIM;
  const scene = S.scene.SCENE;
  const sim = S.sim, ser = S.serialize, replay = S.replay;
  const Recorder = S.recorder.Recorder;
  const FrameLoop = S.frameloop.FrameLoop;
  const INPUT = sim.INPUT;

  const view = document.getElementById('view');
  const ctx = view.getContext('2d');
  const tl = document.getElementById('timeline');
  const tctx = tl.getContext('2d');
  const panel = document.getElementById('panel');

  let mode = 'live';           // 'live' | 'replay'
  let seed = 42;
  let state = null;
  let recorder = null;
  let recording = null;
  let evMap = null;
  let playing = true;
  let frameLoop = new FrameLoop();
  let keys = {};
  let faultQueued = false;
  let verifyReport = null;
  let cpReports = null;
  let tamperTick = -1;
  let lastSeekCp = null;
  const speeds = [0.25, 1, 2, 4];
  let speedIdx = 1;

  function startLive(newSeed) {
    seed = newSeed >>> 0;
    state = sim.initialState(scene, seed);
    recorder = new Recorder(scene, seed, 300);
    recorder.begin(state);
    recording = null; evMap = null;
    verifyReport = null; cpReports = null;
    tamperTick = -1; lastSeekCp = null;
    mode = 'live';
    playing = true;
  }

  function finalizeLive() {
    recording = recorder.finalize(state);
    evMap = replay.eventsByTick(recording);
    mode = 'replay';
    seek(0);
    playing = true;
  }

  function loadRecording(rec) {
    recording = rec;
    evMap = replay.eventsByTick(recording);
    verifyReport = null; cpReports = null;
    tamperTick = -1;
    mode = 'replay';
    seek(0);
    playing = true;
  }

  function seek(t) {
    t = Math.max(0, Math.min(recording.endTick, t));
    lastSeekCp = null;
    for (const c of recording.checkpoints) {
      if (c.tick <= t && (!lastSeekCp || c.tick > lastSeekCp.tick)) lastSeekCp = c;
    }
    state = replay.replayToTick(scene, recording, t);
  }

  function readInput() {
    let i = 0;
    if (keys.ArrowLeft) i |= INPUT.LEFT;
    if (keys.ArrowRight) i |= INPUT.RIGHT;
    if (keys.Space || keys.ArrowUp) i |= INPUT.JUMP;
    if (keys.KeyZ) i |= INPUT.ATTACK;
    return i;
  }

  function liveTick() {
    const input = readInput();
    recorder.recordInput(input);
    const evs = [];
    if (faultQueued) {
      evs.push({ type: 'mech_malfunction', data: { source: 'debug-key' } });
      faultQueued = false;
    }
    const t0 = state.tick;
    const results = sim.step(scene, state, input, evs);
    if (evs.length) recorder.recordEvents(t0, evs, results);
    recorder.afterStep(state);
    if (state.finished || state.tick >= 7200) finalizeLive();
  }

  function replayTick() {
    if (state.tick >= recording.endTick) { playing = false; return; }
    let input = recording.inputs[state.tick];
    if (tamperTick === state.tick) input ^= INPUT.JUMP;
    const evs = (evMap.get(state.tick) || []).map(e => ({ type: e.type, data: e.data }));
    sim.step(scene, state, input, evs);
  }

  function runVerify() {
    if (!recording) return;
    const override = tamperTick >= 0
      ? t => (t === tamperTick ? (recording.inputs[t] ^ INPUT.JUMP) : null)
      : null;
    verifyReport = replay.verifyRecording(scene, recording, { inputOverride: override });
    cpReports = recording.checkpoints.map(cp => ({
      tick: cp.tick,
      r: replay.verifyFromCheckpoint(scene, recording, cp.tick, { inputOverride: override })
    }));
    if (verifyReport.firstDeviation) seek(verifyReport.firstDeviation.tick);
  }

  // ---------- 渲染 ----------

  function render() {
    ctx.fillStyle = '#101116';
    ctx.fillRect(0, 0, view.width, view.height);

    ctx.fillStyle = '#3a3f4b';
    for (const s of scene.solids) ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = '#565e73';
    for (const w of scene.oneWays) ctx.fillRect(w.x, w.y, w.w, w.h);

    for (let i = 0; i < scene.platforms.length; i++) {
      const def = scene.platforms[i], pl = state.platforms[i];
      ctx.fillStyle = pl.jamLeft > 0 ? '#d9534f' : '#4caf50';
      ctx.fillRect(pl.x, pl.y, def.w, def.h);
      if (pl.speedMul !== 1) label('x' + pl.speedMul, pl.x, pl.y - 14, '#d9534f');
    }
    for (let i = 0; i < scene.crushers.length; i++) {
      const def = scene.crushers[i], c = state.crushers[i];
      ctx.fillStyle = c.jamLeft > 0 ? '#d9534f' : '#f0ad4e';
      ctx.fillRect(def.x, c.y, def.w, def.h);
      ctx.strokeStyle = '#6b5320';
      ctx.strokeRect(def.x + 0.5, def.yTop + 0.5, def.w - 1, def.yBottom - def.yTop + def.h - 1);
      if (c.speedMul !== 1) label('x' + c.speedMul, def.x, c.y - 14, '#d9534f');
    }
    for (let i = 0; i < scene.dartTraps.length; i++) {
      const def = scene.dartTraps[i], tr = state.traps[i];
      ctx.fillStyle = tr.haywire ? '#ff5252' : '#9b59b6';
      ctx.fillRect(def.x - 6, def.y - 6, 12, 12);
      if (tr.haywire) label('HAYWIRE', def.x - 20, def.y - 16, '#ff5252');
    }
    ctx.fillStyle = '#ffd54f';
    for (const d of state.darts) ctx.fillRect(d.x - 4, d.y - 2, 8, 4);
    for (let i = 0; i < scene.pickups.length; i++) {
      if (state.pickups[i].taken) continue;
      const p = scene.pickups[i];
      ctx.fillStyle = '#ffeb3b';
      ctx.beginPath();
      ctx.arc(p.x + 8, p.y + 8, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    const openFrac = state.door.openTicks / sim.DOOR_OPEN_TICKS;
    ctx.fillStyle = openFrac >= 1 ? '#1e5c5c' : '#26c6da';
    ctx.fillRect(scene.door.x, scene.door.y, scene.door.w, scene.door.h * (1 - openFrac));
    ctx.strokeStyle = '#26c6da';
    ctx.strokeRect(scene.door.x + 0.5, scene.door.y + 0.5, scene.door.w - 1, scene.door.h - 1);

    const P = state.player;
    if (P.attackAnim > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      const ax = P.facing > 0 ? P.x + sim.PLAYER_W : P.x - 30;
      ctx.fillRect(ax, P.y + 6, 30, 24);
    }
    ctx.fillStyle = (P.invuln > 0 && (state.tick % 8 < 4)) ? '#ffffff' : '#42a5f5';
    ctx.fillRect(P.x, P.y, sim.PLAYER_W, sim.PLAYER_H);
    ctx.fillStyle = '#111';
    ctx.fillRect(P.facing > 0 ? P.x + 15 : P.x + 5, P.y + 8, 4, 4);
    ctx.fillStyle = '#333';
    ctx.fillRect(P.x, P.y - 8, sim.PLAYER_W, 4);
    ctx.fillStyle = P.hp > 40 ? '#66bb6a' : '#ef5350';
    ctx.fillRect(P.x, P.y - 8, sim.PLAYER_W * Math.max(0, P.hp) / 100, 4);

    if (mode === 'live') label('● REC  seed=' + seed, 8, 16, '#ff5252');
    else label('REPLAY  tick ' + state.tick + '/' + recording.endTick, 8, 16, '#9ccc65');
    if (tamperTick >= 0) label('篡改@' + tamperTick, 8, 34, '#ff6b6b');
  }

  function label(text, x, y, color) {
    ctx.fillStyle = color;
    ctx.font = '12px monospace';
    ctx.fillText(text, x, y);
  }

  function renderTimeline() {
    tctx.fillStyle = '#101116';
    tctx.fillRect(0, 0, tl.width, tl.height);
    if (!recording) {
      tctx.fillStyle = '#7a8194';
      tctx.fillText(mode === 'live' ? '录制中… tick ' + state.tick : '', 8, 20);
      return;
    }
    const end = recording.endTick;
    const x = t => 8 + (tl.width - 16) * (t / end);

    tctx.fillStyle = '#2c5f2e';
    tctx.fillRect(8, 20, tl.width - 16, 10);
    tctx.fillStyle = '#7a8194';
    for (const c of recording.checkpoints) tctx.fillRect(x(c.tick) - 1, 16, 2, 18);
    for (const e of recording.events) {
      tctx.fillStyle = '#ff9800';
      tctx.beginPath();
      tctx.moveTo(x(e.tick), 12); tctx.lineTo(x(e.tick) - 5, 2); tctx.lineTo(x(e.tick) + 5, 2);
      tctx.fill();
    }
    if (verifyReport && verifyReport.firstDeviation) {
      tctx.fillStyle = '#ff1744';
      tctx.fillRect(x(verifyReport.firstDeviation.tick) - 1, 0, 3, 34);
    }
    if (tamperTick >= 0) {
      tctx.fillStyle = '#ff6b6b';
      tctx.fillRect(x(tamperTick) - 1, 36, 2, 10);
    }
    tctx.fillStyle = '#eceff1';
    tctx.fillRect(x(state.tick) - 1, 10, 2, 24);
    tctx.fillStyle = '#7a8194';
    tctx.fillText('0', 8, 46);
    tctx.fillText((end / 60).toFixed(1) + 's', tl.width - 44, 46);
    tctx.fillText('tick ' + state.tick, x(state.tick) + 4 > tl.width - 70 ? tl.width - 70 : x(state.tick) + 4, 12);
  }

  function inputStr(i) {
    return (i & INPUT.LEFT ? '←' : '·') + (i & INPUT.RIGHT ? '→' : '·') +
           (i & INPUT.JUMP ? '跳' : '·') + (i & INPUT.ATTACK ? '打' : '·');
  }

  function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2); }

  function updatePanel() {
    const L = [];
    const P = state.player;
    L.push('模式: ' + (mode === 'live' ? '实况录制' : '回放调试') +
      '  ' + (playing ? '▶播放' : '⏸暂停') + '  速度 ' + speeds[speedIdx] + 'x');
    const end = recording ? recording.endTick : '…';
    L.push('tick: ' + state.tick + ' / ' + end + '  (t=' + (state.tick / 60).toFixed(2) + 's)');
    let chain = '(live) ' + (recorder ? recorder.chain.slice(0, 16) : '');
    if (mode === 'replay' && recording) chain = recording.trail[state.tick][0].slice(0, 16);
    L.push('链哈希: ' + chain + '…');
    if (mode === 'replay' && lastSeekCp) L.push('定位检查点: cp@' + lastSeekCp.tick);
    L.push('');
    const curInput = mode === 'live' ? readInput()
      : (state.tick < recording.endTick ? recording.inputs[state.tick] : 0);
    L.push('输入: [' + inputStr(curInput) + ']' + (tamperTick >= 0 ? '  篡改@' + tamperTick + ' (跳位翻转)' : ''));
    L.push('');
    L.push('玩家: pos(' + fmt(P.x) + ',' + fmt(P.y) + ') vel(' + fmt(P.vx) + ',' + fmt(P.vy) + ')');
    L.push('  hp=' + P.hp + ' invuln=' + P.invuln + ' grounded=' + P.grounded +
      ' facing=' + (P.facing > 0 ? '→' : '←') + ' standingOn=' + P.standingOn);
    L.push('机关:');
    state.platforms.forEach((p, i) => {
      L.push('  平台' + i + ': (' + fmt(p.x) + ',' + fmt(p.y) + ') dir=' + p.dir +
        ' jam=' + p.jamLeft + ' 倍速=' + p.speedMul);
    });
    state.crushers.forEach((c, i) => {
      L.push('  粉碎' + i + ': y=' + fmt(c.y) + ' dir=' + c.dir + ' jam=' + c.jamLeft + ' 倍速=' + c.speedMul);
    });
    state.traps.forEach((t, i) => {
      L.push('  陷阱' + i + ': cooldown=' + t.cooldown + (t.haywire ? ' HAYWIRE' : ''));
    });
    L.push('  门: ' + state.door.openTicks + '/' + sim.DOOR_OPEN_TICKS);
    L.push('世界: 飞镖=' + state.darts.length +
      '  拾取=' + state.pickups.filter(p => p.taken).length + '/' + state.pickups.length +
      '  分数=' + state.score + '  死亡=' + state.deaths);
    L.push('rng: ' + state.rng + '  finished: ' + state.finished);
    L.push('');
    if (verifyReport) {
      L.push('── 校验结果 ──');
      L.push((verifyReport.ok ? '从头重演: OK' : '从头重演: FAIL') +
        '  检查点: ' + cpReports.filter(c => c.r.ok).length + '/' + cpReports.length + ' 通过');
      if (verifyReport.firstDeviation) {
        const d = verifyReport.firstDeviation;
        L.push('首次偏离: tick ' + d.tick + ' (t=' + (d.tick / 60).toFixed(2) + 's)');
        L.push('  玩家位置: (' + fmt(d.playerPos.x) + ',' + fmt(d.playerPos.y) + ')');
        L.push('  偏离分节: ' + d.sections.join(', '));
      }
      if (verifyReport.eventErrors && verifyReport.eventErrors.length) {
        L.push('事件不符: ' + JSON.stringify(verifyReport.eventErrors[0]));
      }
      const badCp = cpReports.find(c => !c.r.ok);
      if (badCp) {
        L.push('检查点' + badCp.tick + ' 失败: load=' + JSON.stringify(badCp.r.loadCheck) +
          (badCp.r.firstDeviation ? ' 偏离@' + badCp.r.firstDeviation.tick : ''));
      }
    } else {
      L.push('(按 V 校验：从头 + 每个检查点重演比对)');
    }
    panel.textContent = L.join('\n');
    panel.classList.toggle('deviating', !!(verifyReport && !verifyReport.ok));
  }

  // ---------- 主循环 ----------

  let lastT = 0;
  function frame(ts) {
    const dt = Math.min(0.25, lastT ? (ts - lastT) / 1000 : 0);
    lastT = ts;
    if (playing) {
      const n = frameLoop.advance(dt);
      for (let i = 0; i < n; i++) {
        if (mode === 'live') liveTick();
        else replayTick();
        if (!playing) break;
      }
    }
    render();
    renderTimeline();
    updatePanel();
    requestAnimationFrame(frame);
  }

  // ---------- 交互 ----------

  const keyDown = e => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space'].includes(e.code)) e.preventDefault();
    keys[e.code] = true;
    if (e.code === 'KeyF' && mode === 'live') faultQueued = true;
    if (e.code === 'KeyT' && mode === 'live') finalizeLive();
    if (e.code === 'KeyK') playing = !playing;
    if (e.code === 'KeyR') startLive(e.shiftKey ? (Math.random() * 4294967296) >>> 0 : seed);
    if (e.code === 'KeyV') runVerify();
    if (e.code === 'KeyX' && mode === 'replay') {
      tamperTick = tamperTick >= 0 ? -1 : state.tick;
    }
    if (e.code === 'Period' && mode === 'replay') {
      if (e.shiftKey) seek(state.tick + 300);
      else if (state.tick < recording.endTick) { replayTick(); }
      playing = false;
    }
    if (e.code === 'Comma' && mode === 'replay') { seek(state.tick - 300); playing = false; }
  };
  const keyUp = e => { keys[e.code] = false; };
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  document.getElementById('bPlay').onclick = () => { playing = !playing; };
  document.getElementById('bStep').onclick = () => {
    if (mode === 'replay' && state.tick < recording.endTick) { replayTick(); playing = false; }
    else if (mode === 'live') { liveTick(); playing = false; }
  };
  document.getElementById('bBack').onclick = () => { if (mode === 'replay') { seek(state.tick - 300); playing = false; } };
  document.getElementById('bFwd').onclick = () => { if (mode === 'replay') { seek(state.tick + 300); playing = false; } };
  document.getElementById('bSpeed').onclick = e => {
    speedIdx = (speedIdx + 1) % speeds.length;
    frameLoop.speed = speeds[speedIdx];
    e.target.textContent = '速度 ' + speeds[speedIdx] + 'x';
  };
  document.getElementById('bFault').onclick = () => { if (mode === 'live') faultQueued = true; };
  document.getElementById('bFin').onclick = () => { if (mode === 'live') finalizeLive(); };
  document.getElementById('bVerify').onclick = runVerify;
  document.getElementById('bTamper').onclick = () => {
    if (mode === 'replay') tamperTick = tamperTick >= 0 ? -1 : state.tick;
  };
  document.getElementById('bRestart').onclick = () => startLive(seed);
  document.getElementById('bSave').onclick = () => {
    if (!recording) return;
    const blob = new Blob([JSON.stringify(recording)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'recording_' + recording.seed + '_' + recording.endTick + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const fileInput = document.getElementById('file');
  document.getElementById('bLoad').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { loadRecording(JSON.parse(rd.result)); }
      catch (err) { alert('回放文件解析失败: ' + err.message); }
    };
    rd.readAsText(f);
  };
  document.getElementById('bSample').onclick = () => {
    fetch('../recordings/sample_fault.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(loadRecording)
      .catch(() => alert('无法直接读取样例（file:// 限制）。请用 "加载回放" 选择 recordings/sample_fault.json，\n或在仓库根目录运行 npx serve / python3 -m http.server 后访问 web/index.html。'));
  };

  tl.addEventListener('click', e => {
    if (mode !== 'replay') return;
    const rect = tl.getBoundingClientRect();
    const frac = (e.clientX - rect.left - 8) / (tl.width - 16);
    seek(Math.round(frac * recording.endTick));
  });

  startLive(seed);
  requestAnimationFrame(frame);
})();
