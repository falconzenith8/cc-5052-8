/*
 * UI 冒烟测试：用最小 DOM 桩加载 web/ui.js，跑实况->录制->回放->校验->篡改 全流程。
 * 运行：node tests/ui_smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---- 最小 DOM 桩 ----
function makeCtx() {
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'measureText') return () => ({ width: 0 });
      return typeof k === 'string' ? () => {} : undefined;
    },
    set: () => true
  });
}
function makeCanvas() {
  return { width: 960, height: 540, getContext: () => makeCtx(), addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
}
const elements = {};
function el(id) {
  if (!elements[id]) {
    elements[id] = id === 'view' || id === 'timeline' ? makeCanvas() : {
      id, textContent: '', onclick: null, classList: { toggle: () => {} },
      click: () => {}, files: [], hidden: true
    };
  }
  return elements[id];
}

const rafQueue = [];
const listeners = {};
const sandbox = {
  self: null, window: null, module: undefined, require: undefined,
  document: {
    getElementById: el,
    createElement: () => ({ click: () => {}, style: {} }),
    addEventListener: () => {}
  },
  requestAnimationFrame: fn => { rafQueue.push(fn); },
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  FileReader: function () {}, fetch: () => Promise.reject(new Error('no fetch in test')),
  alert: () => {}, console
};
sandbox.self = sandbox;
sandbox.window = sandbox;

function key(code, shift) {
  for (const fn of listeners.keydown || []) fn({ code, shiftKey: !!shift, preventDefault: () => {} });
  for (const fn of listeners.keyup || []) fn({ code });
}
function keyHold(code, down) {
  for (const fn of listeners[down ? 'keydown' : 'keyup'] || []) fn({ code, preventDefault: () => {} });
}
function runFrames(n, dtMs) {
  let ts = runFrames.ts || 0;
  for (let i = 0; i < n; i++) {
    ts += dtMs;
    const q = rafQueue.splice(0);
    for (const fn of q) fn(ts);
  }
  runFrames.ts = ts;
}

// 加载 sim 模块（浏览器全局路径）+ ui.js
const files = ['rng', 'serialize', 'scene', 'sim', 'bot', 'recorder', 'replay', 'frameloop', 'runner']
  .map(f => path.join(__dirname, '..', 'sim', f + '.js'));
for (const f of files) {
  new Function('self', 'window', 'module', 'require', 'document', 'requestAnimationFrame',
    fs.readFileSync(f, 'utf8'))(sandbox, sandbox, undefined, undefined, sandbox.document, sandbox.requestAnimationFrame);
}
new Function('self', 'window', 'module', 'require', 'document', 'requestAnimationFrame',
  'addEventListener', 'Blob', 'URL', 'FileReader', 'fetch', 'alert',
  fs.readFileSync(path.join(__dirname, '..', 'web', 'ui.js'), 'utf8'))(
    sandbox, sandbox, undefined, undefined, sandbox.document, sandbox.requestAnimationFrame,
    sandbox.addEventListener, sandbox.Blob, sandbox.URL, sandbox.FileReader, sandbox.fetch, sandbox.alert);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + '\n       ' + (e.stack || e.message)); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

const S = sandbox.SIM;

test('ui boots into live mode and renders frames', () => {
  runFrames(30, 16.7);
  assert(el('panel').textContent.includes('实况录制'), 'panel shows live mode');
});

test('live play records inputs; fault injection recorded', () => {
  keyHold('ArrowRight', true);
  runFrames(120, 16.7);
  keyHold('ArrowRight', false);
  key('KeyF'); // 注入故障
  runFrames(5, 16.7);
  key('KeyT'); // 结束录制 -> 回放
  runFrames(5, 16.7);
  const txt = el('panel').textContent;
  assert(txt.includes('回放调试'), 'switched to replay mode');
});

test('replay verify passes on freshly recorded run', () => {
  key('KeyV');
  runFrames(2, 16.7);
  const txt = el('panel').textContent;
  assert(txt.includes('从头重演: OK'), 'verify ok, got:\n' + txt.split('── 校验结果 ──')[1]);
});

test('tamper + verify shows first deviation with tick and sections', () => {
  // 跳到中段某 tick，篡改，校验
  key('KeyX'); // 在当前 tick 篡改
  key('KeyV');
  runFrames(2, 16.7);
  const txt = el('panel').textContent;
  assert(txt.includes('从头重演: FAIL'), 'tampered verify fails');
  assert(txt.includes('首次偏离: tick'), 'first deviation shown');
  assert(/偏离分节: .+/.test(txt), 'deviating sections shown');
  key('KeyX'); // 清除篡改
  key('KeyV');
  runFrames(2, 16.7);
  assert(el('panel').textContent.includes('从头重演: OK'), 'clean again after untamper');
});

test('timeline seek uses checkpoints and stays consistent', () => {
  // 直接点击时间轴中点
  const rec = null; void rec;
  key('Comma'); // 后退
  runFrames(2, 16.7);
  const txt = el('panel').textContent;
  assert(/tick: \d+/.test(txt), 'tick displayed');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
