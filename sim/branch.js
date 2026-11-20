/*
 * 分支树：在同一共享检查点上派生多条输入分支，支持任意来回、
 * 合并预演、实体溯源，以及共享快照的引用计数生命周期。
 *
 * 设计要点：
 *  - 分支不是"另存一份录制"，而是 (父路径 + 编辑层) 的可重算视图。
 *    编辑层只描述相对父路径的输入 / 动作 / 场景参数变更。
 *  - 检查点放在 CheckpointStore 里，按内容寻址 + 引用计数共享。
 *    分支从父路径分叉时 acquire（refs++），清理分支时 release；
 *    快照不可变，所以清掉试验分支不会破坏母分支的道具状态。
 *  - 任意 tick 的定位 = 最近的共享检查点 + 逐 tick 重演（不是拷贝整段状态）。
 *  - 合并预演逐编辑判定：
 *      independent  另一分支在编辑窗口内没有改动它依赖的分节 → 直接采用原输入；
 *      dependent    依赖分节已变、但编辑带有 intent → 在合并后的世界重新求值；
 *      conflict     依赖分节已变、编辑只有固定输入 → 拒绝合并。
 *    删除共有输入被视为结构性独立操作（保留其删除语义）。
 */
(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const api = factory(
    isNode ? require('./sim.js') : root.SIM.sim,
    isNode ? require('./serialize.js') : root.SIM.serialize,
    isNode ? require('./bot.js') : root.SIM.bot
  );
  if (isNode) module.exports = api;
  else { root.SIM = root.SIM || {}; root.SIM.branch = api; }
})(typeof self !== 'undefined' ? self : globalThis, function (SIM, SER, BOT) {
  'use strict';

  const clone = SER.deepClone;
  const INPUT = SIM.INPUT;
  const hashes = SIM.sectionHashes;

  const ENTITY_SECTION = {
    player: 'player', door: 'door', pickup: 'pickups', platform: 'platforms',
    crusher: 'crushers', trap: 'traps', darts: 'darts'
  };

  const EDIT_RANK = { scene: 0, param: 0, delete: 1, window: 2, action: 3, append: 4 };

  function entityKind(id) { return String(id || '').split(':')[0]; }

  function depsFor(entityId) {
    const k = entityKind(entityId);
    if (k === 'player') return ['player', 'platforms', 'door', 'crushers'];
    return ENTITY_SECTION[k] ? [ENTITY_SECTION[k]] : [];
  }

  function sectionOfSceneKey(key) {
    if (key.indexOf('door.') === 0) return 'door';
    if (key.indexOf('pickups.') === 0) return 'pickups';
    if (key.indexOf('darts') === 0) return 'darts';
    if (key.indexOf('crushers.') === 0) return 'crushers';
    if (key.indexOf('dartTraps.') === 0) return 'traps';
    if (key.indexOf('platforms.') === 0) return 'platforms';
    return 'meta';
  }

  function entitySnap(state) {
    const o = {
      player: state.player.x + ',' + state.player.y,
      door: state.door.openTicks + '/' + (state.finished ? 1 : 0)
    };
    for (let i = 0; i < state.pickups.length; i++) o['pickup:' + i] = state.pickups[i].taken ? 1 : 0;
    for (let i = 0; i < state.platforms.length; i++) o['platform:' + i] = state.platforms[i].x + ',' + state.platforms[i].y;
    for (let i = 0; i < state.crushers.length; i++) o['crusher:' + i] = state.crushers[i].y;
    for (let i = 0; i < state.traps.length; i++) o['trap:' + i] = state.traps[i].haywire ? 1 : 0;
    o.darts = state.darts.length;
    return o;
  }

  function findEntityAt(scene, state, x, y) {
    const P = state.player;
    if (x >= P.x && x <= P.x + SIM.PLAYER_W && y >= P.y && y <= P.y + SIM.PLAYER_H) return 'player';
    const d = scene.door;
    if (x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h) return 'door';
    for (let i = 0; i < scene.pickups.length; i++) {
      const p = scene.pickups[i];
      if (x >= p.x && x <= p.x + SIM.PICKUP_SIZE && y >= p.y && y <= p.y + SIM.PICKUP_SIZE) return 'pickup:' + i;
    }
    for (let i = 0; i < scene.platforms.length; i++) {
      const def = scene.platforms[i], pl = state.platforms[i];
      if (x >= pl.x && x <= pl.x + def.w && y >= pl.y && y <= pl.y + def.h) return 'platform:' + i;
    }
    for (let i = 0; i < scene.crushers.length; i++) {
      const def = scene.crushers[i], c = state.crushers[i];
      if (x >= def.x && x <= def.x + def.w && y >= c.y && y <= c.y + def.h) return 'crusher:' + i;
    }
    for (let i = 0; i < scene.dartTraps.length; i++) {
      const def = scene.dartTraps[i];
      if (Math.abs(x - def.x) <= 10 && Math.abs(y - def.y) <= 10) return 'trap:' + i;
    }
    return null;
  }

  function inputStr(i) {
    return (i & INPUT.LEFT ? 'L' : '-') + (i & INPUT.RIGHT ? 'R' : '-') +
           (i & INPUT.JUMP ? 'J' : '-') + (i & INPUT.ATTACK ? 'A' : '-');
  }

  function inInterval(list, t) {
    for (const iv of list) if (t >= iv[0] && t < iv[1]) return true;
    return false;
  }

  function mergeIntervals(list) {
    const s = list.map(function (x) { return [x[0], x[1]]; }).sort(function (a, b) { return a[0] - b[0]; });
    const out = [];
    for (const iv of s) {
      const last = out[out.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else out.push([iv[0], iv[1]]);
    }
    return out;
  }

  function unique(a) {
    const out = [];
    for (const x of a) if (out.indexOf(x) < 0) out.push(x);
    return out;
  }

  function applySceneOverride(baseScene, over) {
    if (!over || Object.keys(over).length === 0) return { scene: baseScene, changed: [] };
    const scene = clone(baseScene);
    const changed = [];
    for (const k of Object.keys(over)) {
      const parts = k.split('.');
      if (parts[0] === 'door') scene.door[parts[1]] = over[k];
      else if (parts[0] === 'pickups') scene.pickups[parseInt(parts[1], 10)][parts[2]] = over[k];
      else if (parts[0] === 'crushers') scene.crushers[parseInt(parts[1], 10)][parts[2]] = over[k];
      else if (parts[0] === 'dartTraps') scene.dartTraps[parseInt(parts[1], 10)][parts[2]] = over[k];
      else if (parts[0] === 'platforms') scene.platforms[parseInt(parts[1], 10)][parts[2]] = over[k];
      else scene[k] = over[k];
      changed.push(k);
    }
    return { scene: scene, changed: changed };
  }

  /*
   * 动作 intent 描述"想做什么"，不绑定具体按键：
   *  - raw          固定按键（无前提的固定输入）
   *  - pause        原地停住
   *  - pass_door    门开才向右跳过去；门没开则等待
   *  - avoid_pickup 在 deadline 前绕开指定拾取物（机器人策略生成输入）
   * 返回 null 表示本 intent 不接管，回落到下一层。
   */
  function evalIntent(intent, scene, state) {
    if (!intent) return null;
    switch (intent.kind) {
      case 'raw': return (intent.value | 0) & 15;
      case 'pause': return 0;
      case 'pass_door':
        if (!state.finished && state.door.openTicks >= SIM.DOOR_OPEN_TICKS) return INPUT.RIGHT | INPUT.JUMP;
        return 0;
      case 'avoid_pickup': {
        const idx = intent.index | 0;
        if (!state.pickups[idx] || state.pickups[idx].taken) return null;
        if (state.tick >= (intent.deadline | 0)) return null;
        const view = clone(state);
        view.pickups[idx].taken = true;
        return BOT.botInput(scene, view) & 15;
      }
      default: return null;
    }
  }

  // intent 声明它实际读取哪些世界状态，合并时据此判断前提是否失效
  function intentDeps(intent) {
    switch (intent && intent.kind) {
      case 'pass_door': return ['player', 'door', 'platforms'];
      case 'avoid_pickup': return ['player', 'pickups', 'platforms'];
      case 'pause': return ['player'];
      case 'raw': return ['player'];
      default: return ['player'];
    }
  }

  // ------------------------------------------------------------------
  // 检查点存储：内容寻址 + 引用计数
  // ------------------------------------------------------------------
  class CheckpointStore {
    constructor() {
      this.entries = new Map();
      this.gen = 0;
      this.log = [];
    }
    keyOf(tick, state) { return tick + '@' + SER.hashHex(SER.canon(state)); }
    acquire(tick, state, owner) {
      const key = this.keyOf(tick, state);
      let e = this.entries.get(key);
      if (!e) {
        e = {
          key: key, tick: tick, state: clone(state), refs: 0,
          bornGen: ++this.gen, lastReleaseGen: null, releases: 0, owners: []
        };
        this.entries.set(key, e);
        this.log.push({ op: 'create', key: key, tick: tick, gen: e.bornGen });
      }
      e.refs++;
      if (owner && e.owners.indexOf(owner) < 0) e.owners.push(owner);
      this.log.push({ op: 'acquire', key: key, tick: tick, by: owner || '-', refs: e.refs });
      return e;
    }
    release(key, owner) {
      const e = this.entries.get(key);
      if (!e) return null;
      e.refs--;
      e.releases++;
      e.lastReleaseGen = ++this.gen;
      if (owner) { const i = e.owners.indexOf(owner); if (i >= 0) e.owners.splice(i, 1); }
      this.log.push({ op: 'release', key: key, tick: e.tick, by: owner || '-', refs: e.refs });
      if (e.refs <= 0) {
        e.refs = 0;
        this.entries.delete(key);
        this.log.push({ op: 'free', key: key, tick: e.tick, gen: e.lastReleaseGen });
        return Object.assign({}, e, { freed: true });
      }
      return e;
    }
    get(key) { return this.entries.get(key) || null; }
    size() { return this.entries.size; }
    find(tick) {
      return Array.from(this.entries.values()).filter(function (e) { return e.tick === tick; });
    }
    live() {
      return Array.from(this.entries.values())
        .sort(function (a, b) { return a.tick - b.tick || a.bornGen - b.bornGen; })
        .map(function (e) {
          return {
            key: e.key, tick: e.tick, refs: e.refs, bornGen: e.bornGen,
            lastReleaseGen: e.lastReleaseGen, releases: e.releases, owners: e.owners.slice()
          };
        });
    }
    totals() {
      let refs = 0, shared = 0;
      for (const e of this.entries.values()) { refs += e.refs; if (e.refs > 1) shared++; }
      return { entries: this.entries.size, refs: refs, shared: shared, ops: this.log.length };
    }
  }

  // ------------------------------------------------------------------
  // 分支节点
  // ------------------------------------------------------------------
  let SEQ = 0;

  class Branch {
    constructor(tree, spec) {
      this.tree = tree;
      this.id = spec.id || ('b' + (++SEQ));
      this.parentId = spec.parentId || null;
      this.kind = spec.kind || 'fork';
      this.label = spec.label || this.id;
      this.forkTick = spec.tick != null ? spec.tick : (spec.forkTick || 0);
      this.horizon = spec.horizon != null ? spec.horizon : null;
      this.layer = spec.layer || {};
      this.pruned = false;
      this.cache = null;
      this.anchorKey = null;
      this.cpKeys = [];
      this.entityIndex = new Map();
      this.influences = [];
    }
    parent() { return this.parentId ? this.tree.get(this.parentId) : null; }
    lineage() {
      const out = [];
      let n = this;
      while (n) { out.unshift(n); n = n.parent(); }
      return out;
    }
    isAncestorOf(other) {
      for (let n = other; n; n = n.parent()) if (n === this) return true;
      return false;
    }
    compose() {
      const out = { scene: {}, deleted: [], windows: [], actions: [], appends: [], chain: this.lineage() };
      for (const n of out.chain) {
        const L = n.layer || {};
        if (L.scene) Object.assign(out.scene, L.scene);
        if (L.deleted) out.deleted = out.deleted.concat(L.deleted);
        if (L.windows) for (const w of L.windows) out.windows.push(Object.assign({ owner: n.id }, w));
        if (L.actions) for (const a of L.actions) out.actions.push(Object.assign({ owner: n.id }, a));
        if (L.appends) for (const a of L.appends) out.appends.push(Object.assign({ owner: n.id }, a));
      }
      out.deleted = mergeIntervals(out.deleted);
      return out;
    }
  }

  // ------------------------------------------------------------------
  // 分支树
  // ------------------------------------------------------------------
  class BranchTree {
    constructor(scene, rec, opts) {
      this.scene = scene;
      this.rec = rec;
      this.store = new CheckpointStore();
      this.nodes = new Map();
      this.root = null;
      this.counter = 0;
      this.every = (opts && opts.checkpointEvery) || rec.checkpointEvery || 300;
      this._stateMemo = new Map();
      this.events = eventsByTick(rec);
    }

    get(id) { return this.nodes.get(id) || null; }
    active() {
      return Array.from(this.nodes.values()).filter(function (n) { return !n.pruned; });
    }

    buildRoot() {
      const root = new Branch(this, { id: 'root', kind: 'record', label: '原记录', tick: 0, layer: {} });
      root.scene = this.scene;
      const initial = clone(this.rec.initialState);
      const inputs = this.rec.inputs.slice();
      const owners = [], kinds = [], baselines = [];
      const state = clone(initial);
      root.cpKeys = [];
      const e0 = this.store.acquire(0, initial, root.id);
      root.cpKeys.push(e0.key);
      root.entityIndex = new Map();
      let prev = entitySnap(state);
      for (let t = 0; t < this.rec.endTick; t++) {
        const input = inputs[t] | 0;
        owners.push('root'); kinds.push('inherit'); baselines.push(input);
        SIM.step(this.scene, state, input, this.events.get(t) || []);
        this._indexStep(root, state, t + 1, input, { owner: 'root', kind: 'inherit' }, prev);
        prev = entitySnap(state);
        if ((t + 1) % this.every === 0) root.cpKeys.push(this.store.acquire(t + 1, state, root.id).key);
      }
      root.cache = {
        startTick: 0, endTick: state.tick,
        inputs: inputs, owners: owners, kinds: kinds, baselines: baselines,
        scene: this.scene, sceneChanged: [], finalState: state
      };
      this.nodes.set(root.id, root);
      this.root = root;
      return root;
    }

    _indexStep(branch, state, tick, input, r, prevSnap) {
      const snap = entitySnap(state);
      for (const id in snap) {
        if (snap[id] === prevSnap[id]) continue;
        let list = branch.entityIndex.get(id);
        if (!list) { list = []; branch.entityIndex.set(id, list); }
        list.push({
          entity: id, tick: tick, value: snap[id],
          owner: r.owner, edit: r.edit || null, kind: r.kind, input: input
        });
      }
    }

    fork(parentId, spec) {
      spec = spec || {};
      const parent = this._live(parentId);
      const tick = spec.tick != null ? spec.tick : parent.cache.endTick;
      if (tick < 0 || tick > parent.cache.endTick) {
        throw new Error('fork tick ' + tick + ' outside parent range [0,' + parent.cache.endTick + ']');
      }
      const node = new Branch(this, {
        id: spec.id, parentId: parentId, kind: 'fork', tick: tick,
        label: spec.label || ('分支 ' + (++this.counter)),
        layer: clone(spec.layer || {}),
        horizon: spec.horizon
      });
      this.nodes.set(node.id, node);
      this.rebuild(node);
      return node;
    }

    _live(id) {
      const n = this.get(id);
      if (!n) throw new Error('no such branch: ' + id);
      if (n.pruned) throw new Error('分支 ' + id + ' 已清理（引用已释放）；请从母分支重新开局');
      return n;
    }

    // 修改分支编辑层，并重算该分支及其子树
    update(id, mutator) {
      const node = this._live(id);
      if (node.kind === 'record') throw new Error('原记录不可编辑，请先分叉');
      mutator(node.layer);
      const subtree = this.active().filter(function (n) {
        return n === node || node.isAncestorOf(n);
      }).sort(function (a, b) { return a.lineage().length - b.lineage().length; });
      for (const n of subtree) this.rebuild(n);
      return node;
    }

    deleteShared(id, start, end) {
      return this.update(id, function (L) {
        L.deleted = (L.deleted || []).concat([[start, end]]);
      });
    }

    addAction(id, action) {
      return this.update(id, function (L) {
        L.actions = (L.actions || []).concat([action]);
      });
    }

    appendAction(id, action) {
      return this.update(id, function (L) {
        L.appends = (L.appends || []).concat([action]);
      });
    }

    setScene(id, key, value) {
      return this.update(id, function (L) {
        L.scene = L.scene || {};
        L.scene[key] = value;
      });
    }

    // ---------- 物质化（分叉视图） ----------
    rebuild(node) {
      if (node.kind === 'record') return this.buildRoot();
      const parent = this._live(node.parentId);
      const comp = node.compose();
      const so = applySceneOverride(this.scene, comp.scene);
      const scene = so.scene;
      const startTick = node.forkTick;
      const forkState = this._stateBeforeFork(node, scene);
      let horizon = parent.cache.endTick;
      // 动作/追加窗口越过分叉父路径末尾时，视界随之延长；
      // 显式 node.horizon 是硬上限（用于"截到同一终点"的预演）。
      for (const a of comp.actions) if (a.end > horizon) horizon = a.end;
      for (const a of comp.appends) if (a.end > horizon) horizon = a.end;
      if (node.horizon != null) horizon = Math.min(horizon, node.horizon);
      if (horizon < startTick) horizon = startTick;

      this._releaseRefs(node);
      node.scene = scene;
      node.entityIndex = new Map();
      node.cpKeys = [this.store.acquire(startTick, forkState, node.id).key];

      const state = clone(forkState);
      const inputs = [], owners = [], kinds = [], baselines = [];
      let prev = entitySnap(state);
      while (state.tick < horizon) {
        const t = state.tick;
        const r = this._resolve(node, comp, t, state, scene);
        SIM.step(scene, state, r.input, this.events.get(t) || []);
        inputs.push(r.input); owners.push(r.owner); kinds.push(r.kind);
        baselines.push(t < this.rec.endTick ? (this.rec.inputs[t] | 0) : 0);
        this._indexStep(node, state, state.tick, r.input, r, prev);
        prev = entitySnap(state);
        if (state.tick % this.every === 0) node.cpKeys.push(this.store.acquire(state.tick, state, node.id).key);
        if (state.finished) break;
      }
      node.cache = {
        startTick: startTick, endTick: state.tick,
        inputs: inputs, owners: owners, kinds: kinds, baselines: baselines,
        scene: scene, sceneChanged: so.changed, finalState: state,
        comp: comp, forkState: forkState
      };
      this._stateMemo.clear();
      return node.cache;
    }

    _stateBeforeFork(node, scene) {
      // 分叉点的世界由父路径决定；本分支的场景参数只作用于分叉之后，
      // 这样"延后开门"之类的参数不会倒改已经发生的历史。
      return this._seekWorld(node.parent(), node.forkTick, node.parent().cache.scene);
    }

    _resolve(node, comp, t, state, scene) {
      // 1) 显式输入窗口（最后加入者优先）
      for (let i = comp.windows.length - 1; i >= 0; i--) {
        const w = comp.windows[i];
        if (t >= w.start && t < w.end) {
          const v = w.values ? (w.values[t - w.start] | 0) : (w.value | 0);
          return { input: v & 15, owner: w.owner, edit: w.id || null, kind: 'window' };
        }
      }
      // 2) 动作 / 追加动作（intent 对当前世界求值）
      for (let i = comp.actions.length - 1; i >= 0; i--) {
        const a = comp.actions[i];
        if (t >= a.start && t < a.end) {
          const v = evalIntent(a.intent, scene, state);
          if (v != null) return { input: v & 15, owner: a.owner, edit: a.id || null, kind: a.kind || 'action' };
        }
      }
      for (let i = comp.appends.length - 1; i >= 0; i--) {
        const a = comp.appends[i];
        if (t >= a.start && t < a.end) {
          const v = evalIntent(a.intent, scene, state);
          if (v != null) return { input: v & 15, owner: a.owner, edit: a.id || null, kind: 'append' };
        }
      }
      // 3) 删除共有输入（抑制继承）
      if (inInterval(comp.deleted, t)) {
        let owner = node.id, edit = node.id + ':delete';
        for (const n of comp.chain) {
          if (n.layer && n.layer.deleted && inInterval(mergeIntervals(n.layer.deleted), t)) {
            owner = n.id; edit = n.id + ':delete';
          }
        }
        return { input: 0, owner: owner, edit: edit, kind: 'delete' };
      }
      // 4) 继承父路径
      const p = node.parent();
      if (t >= p.cache.startTick && t < p.cache.endTick) {
        return { input: p.cache.inputs[t - p.cache.startTick] & 15, owner: node.id, edit: null, kind: 'inherit' };
      }
      return { input: 0, owner: node.id, edit: null, kind: 'idle' };
    }

    _inputAt(node, t) {
      if (t < node.forkTick) return this._inputAt(node.parent(), t);
      if (t >= node.forkTick && t < node.cache.endTick) return node.cache.inputs[t - node.forkTick] & 15;
      return 0;
    }

    _seekWorld(node, tick, scene) {
      if (node.kind === 'record') return this._seekRoot(tick, scene);
      if (tick < node.forkTick) return this._seekWorld(node.parent(), tick, scene);
      if (tick > node.cache.endTick) tick = node.cache.endTick;
      const best = this._nearestCp(node, tick);
      let state = best ? clone(best.state) : clone(this.rec.initialState);
      const sc = scene || node.scene;
      while (state.tick < tick) {
        SIM.step(sc, state, this._inputAt(node, state.tick), this.events.get(state.tick) || []);
      }
      return state;
    }

    _nearestCp(node, tick) {
      // 候选：本分支自己的检查点（都在 forkTick 之后），
      // 以及祖先/根在 forkTick 及之前的检查点（fork 之后祖先世界与本分支无关）。
      let best = null;
      const consider = (e) => { if (e && e.tick <= tick && (!best || e.tick > best.tick)) best = e; };
      for (const key of node.cpKeys) consider(this.store.get(key));
      let cur = node.parent();
      while (cur) {
        for (const key of cur.cpKeys) {
          const e = this.store.get(key);
          if (e && e.tick <= node.forkTick) consider(e);
        }
        cur = cur.parent();
      }
      return best;
    }

    _seekRoot(tick, scene) {
      const key = 'root:' + tick + ':' + (scene === this.scene ? 'base' : 'alt');
      if (this._stateMemo.has(key)) return clone(this._stateMemo.get(key));
      const best = this._nearestCp(this.root, tick);
      let state = best ? clone(best.state) : clone(this.rec.initialState);
      const sc = scene || this.scene;
      while (state.tick < tick) SIM.step(sc, state, this.rec.inputs[state.tick] | 0, this.events.get(state.tick) || []);
      this._stateMemo.set(key, clone(state));
      return state;
    }

    // 任意分支任意时刻定位（不复制整段状态，走检查点 + 逐 tick 重演）
    seek(id, tick) {
      const node = this._live(id);
      if (tick < 0) tick = 0;
      if (node.kind === 'record') return this._seekRoot(Math.min(tick, this.rec.endTick));
      if (tick > node.cache.endTick) tick = node.cache.endTick;
      if (tick < node.forkTick) return this.seek(node.parentId, tick);
      return this._seekWorld(node, tick);
    }

    stateHash(id, tick) { return hashes(this.seek(id, tick)); }

    divergenceBetween(aId, bId) {
      const a = this._live(aId), b = this._live(bId);
      const start = Math.max(a.cache.startTick, b.cache.startTick);
      const end = Math.min(a.cache.endTick, b.cache.endTick);
      const sa = this.seek(aId, start), sb = this.seek(bId, start);
      for (let t = start; t <= end; t++) {
        if (t > start) {
          SIM.step(a.cache.scene, sa, this._inputAt(a, t - 1), this.events.get(t - 1) || []);
          SIM.step(b.cache.scene, sb, this._inputAt(b, t - 1), this.events.get(t - 1) || []);
        }
        const ha = hashes(sa), hb = hashes(sb);
        const diff = SIM.SECTIONS.filter(function (s) { return ha[s] !== hb[s]; });
        if (diff.length) return { tick: t, sections: diff };
      }
      return null;
    }

    // ---------- 实体溯源 ----------
    history(id, entityId) {
      const node = this._live(id);
      return (node.entityIndex.get(entityId) || []).slice();
    }

    firstUse(id, entityId) {
      const node = this._live(id);
      // 先找"该实体相对母路径的首次分歧"：这才是分支输入真正介入的点。
      // 若实体与母路径始终一致，再退回它自身首次变化，并说明来自原记录。
      const div = this._entityDivergence(node, entityId);
      if (div) {
        const n = div.node;
        const parent = n.parent();
        const inputIdx = div.tick - 1 - n.cache.startTick;
        const owner = n.cache.owners[inputIdx] || n.id;
        const edit = n.cache.kinds[inputIdx] === 'inherit' || n.cache.kinds[inputIdx] === 'idle'
          ? null : this._editIdAt(n, div.tick - 1);
        const input = n.cache.inputs[inputIdx] | 0;
        const baseline = n.cache.baselines[inputIdx] | 0;
        const kind = entityKind(entityId);
        const sec = ENTITY_SECTION[kind];
        let param = null, paramBranch = null;
        for (const m of node.lineage()) {
          const sc = (m.layer && m.layer.scene) || {};
          for (const k in sc) {
            if (sectionOfSceneKey(k) === sec) { param = { key: k, value: sc[k] }; paramBranch = m.id; }
          }
        }
        let branchId = this.get(owner) ? owner : n.id;
        let cause = 'branch-input';
        let what = edit ? '输入 ' + edit : '分支输入';
        if (param && paramBranch) {
          // 若该分节同时被场景参数改动，优先归因于参数（它才是世界状态改变的直接原因）
          cause = 'scene-parameter';
          branchId = paramBranch;
          what = '场景参数 ' + param.key + '=' + param.value;
        }
        const br = this.get(branchId);
        const parts = [];
        parts.push(entityId + ' 相对母路径首次分歧于 tick ' + div.tick +
          '（母=' + JSON.stringify(div.parent) + '，本分支=' + JSON.stringify(div.self) + '）');
        if (cause === 'scene-parameter') parts.push('由分支 ' + branchId + ' 的 ' + what + ' 造成');
        else parts.push('由分支 ' + branchId + ' 的 ' + what + ' [' + inputStr(input) + '] 造成');
        if (input !== baseline) parts.push('该 tick 输入 ' + inputStr(input) + ' 不同于原记录 ' + inputStr(baseline));
        return {
          found: true, entity: entityId, tick: div.tick,
          value: { parent: div.parent, self: div.self },
          branch: branchId, branchLabel: br ? br.label : branchId, edit: edit,
          kind: n.cache.kinds[inputIdx], cause: cause,
          parameter: param ? { branch: paramBranch, key: param.key, value: param.value } : null,
          input: input, inputStr: inputStr(input),
          divergesFromRecord: input !== baseline,
          explanation: parts.join('；')
        };
      }

      const list = node.entityIndex.get(entityId) || [];
      if (!list.length) {
        // 分支之前就已定型的状态属于公共历史，不是任何分支输入造成的
        const pre = this._entityDivergence(node, entityId);
        if (!pre) {
          const rootHist = (this.root.entityIndex.get(entityId) || []);
          const early = rootHist[0];
          if (early && early.tick <= node.cache.startTick) {
            return {
              found: true, entity: entityId, tick: early.tick, value: early.value,
              branch: 'root', branchLabel: '公共历史（分叉前）', edit: null, kind: 'inherit',
              cause: 'shared-history', parameter: null,
              input: early.input | 0, inputStr: inputStr(early.input | 0),
              divergesFromRecord: false,
              explanation: entityId + ' 在 tick ' + early.tick + '（共享检查点 ' +
                node.cache.startTick + ' 之前）已经定型为 ' + early.value +
                '；这属于两条分支的公共历史，并非某条分支输入造成，因此不能归因到任一侧。'
            };
          }
        }
        return { found: false, entity: entityId, reason: '该分支中此实体既未相对母路径分歧，也未发生变化' };
      }
      const f = list[0];
      return {
        found: true, entity: entityId, tick: f.tick, value: f.value,
        branch: 'root', branchLabel: '原记录', edit: null, kind: 'inherit', cause: 'recorded-input',
        parameter: null, input: f.input | 0, inputStr: inputStr(f.input | 0),
        divergesFromRecord: false,
        explanation: entityId + ' 首次变化于 tick ' + f.tick + ' → ' + f.value +
          '；该实体与母路径一致，由原记录输入造成（未使用分支输入）'
      };
    }

    // 沿族谱找出该实体相对各自父路径的最早分歧点
    _entityDivergence(node, entityId) {
      let best = null;
      for (const n of node.lineage()) {
        if (n.kind === 'record') continue;
        const parent = n.parent();
        const from = n.forkTick;
        const to = Math.min(n.cache.endTick, parent.cache.endTick);
        if (to <= from) continue;
        const pa = this._seekWorld(parent, from, parent.cache.scene);
        const na = this._seekWorld(n, from, n.cache.scene);
        for (let t = from; t <= to; t++) {
          const ps = entitySnap(pa)[entityId], ns = entitySnap(na)[entityId];
          if (ps !== ns) {
            if (!best || t < best.tick) best = { tick: t, node: n, parent: ps, self: ns };
            break;
          }
          if (t < to) {
            SIM.step(parent.cache.scene, pa, this._inputAt(parent, t), this.events.get(t) || []);
            SIM.step(n.cache.scene, na, this._inputAt(n, t), this.events.get(t) || []);
          }
        }
      }
      return best;
    }

    _editIdAt(branch, inputTick) {
      const comp = branch.compose();
      for (let i = comp.windows.length - 1; i >= 0; i--) {
        const w = comp.windows[i];
        if (inputTick >= w.start && inputTick < w.end) return w.id || (w.owner + ':window');
      }
      for (let i = comp.actions.length - 1; i >= 0; i--) {
        const a = comp.actions[i];
        if (inputTick >= a.start && inputTick < a.end) return a.id || (a.owner + ':action');
      }
      for (let i = comp.appends.length - 1; i >= 0; i--) {
        const a = comp.appends[i];
        if (inputTick >= a.start && inputTick < a.end) return a.id || (a.owner + ':append');
      }
      if (inInterval(comp.deleted, inputTick)) return branch.id + ':delete';
      return null;
    }

    diffInputs(aId, bId) {
      const a = this._live(aId), b = this._live(bId);
      const start = Math.max(a.cache.startTick, b.cache.startTick);
      const end = Math.min(a.cache.endTick, b.cache.endTick);
      const out = [];
      for (let t = start; t < end; t++) {
        const x = this._inputAt(a, t), y = this._inputAt(b, t);
        if (x !== y) out.push({ tick: t, a: x, b: y });
      }
      return out;
    }

    // ---------- 合并预演 ----------
    _collectEdits(node) {
      const out = [];
      for (const n of node.lineage()) {
        const L = n.layer || {};
        if (L.scene) for (const k in L.scene) out.push(editParam(n, k, L.scene[k]));
        if (L.deleted) for (const iv of L.deleted) out.push(editDelete(n, iv));
        if (L.windows) for (const w of L.windows) out.push(editWindow(n, w));
        if (L.actions) for (const a of L.actions) out.push(editAction(n, a, 'action'));
        if (L.appends) for (const a of L.appends) out.push(editAction(n, a, 'append'));
      }
      return out.sort(function (x, y) { return x.start - y.start; });
    }

    mergePreview(aId, bId, opts) {
      opts = opts || {};
      const a = this._live(aId), b = this._live(bId);
      const ancestor = this._common(a, b);
      const report = {
        ok: true, aId: aId, bId: bId,
        independent: [], dependent: [], conflicts: [],
        edits: [], explanations: [], merged: null, reference: null, sameAsReference: false
      };
      if (a.cache.startTick !== b.cache.startTick) {
        report.conflicts.push({ kind: 'checkpoint', reason: '两条分支不在同一共享检查点分叉：' + a.cache.startTick + ' vs ' + b.cache.startTick });
      }
      const A = this._collectEdits(a), B = this._collectEdits(b);
      const combined = { scene: {}, deleted: [], windows: [], actions: [], appends: [] };

      // 场景参数先合并（同键异值 -> 冲突）
      const params = {};
      for (const e of A.concat(B)) if (e.kind === 'param') {
        if (params[e.key] && params[e.key].value !== e.value) {
          report.conflicts.push({ kind: 'parameter', key: e.key, a: params[e.key].value, b: e.value,
            reason: '同一参数 ' + e.key + ' 被两条分支改成不同值' });
        } else params[e.key] = e;
      }
      for (const k in params) combined.scene[k] = params[k].value;

      // 结构性编辑先合并：删除区间与参数不消耗"前提"，直接采用
      const all = A.concat(B).sort(function (x, y) { return x.start - y.start || rank(x.kind) - rank(y.kind); });
      const actionable = [];
      const sourceOf = {};
      for (const e of A) sourceOf[e.id] = a;
      for (const e of B) sourceOf[e.id] = b;
      for (const e of all) {
        if (e.kind === 'delete') {
          report.independent.push(e.id);
          combined.deleted.push([e.start, e.end]);
          report.edits.push(record(e, 'independent', [], '删除共有输入是无前提的结构操作，直接采用'));
        } else if (e.kind === 'param') {
          report.independent.push(e.id);
          report.edits.push(record(e, 'independent', [], '场景参数独立合并：' + e.key + '=' + e.value));
        } else {
          actionable.push(e);
        }
      }
      if (report.conflicts.length) {
        report.ok = false;
        report.explanations = explain(report, null, null);
        return report;
      }

      // 依赖分节按编辑实际读取的世界状态声明：
      // 暂停只依赖玩家自身；过门还要依赖门；绕拾取物还要依赖拾取物分节。
      // 这样"在远处暂停"不会因为另一分支改了开门时间而误判为依赖。
      const sectionsOf = function (e) {
        if (e.kind === 'param') return [sectionOfSceneKey(e.key)];
        if (e.kind === 'delete') return [];
        if (e.intent) return intentDeps(e.intent);
        return depsFor(e.entity || 'player');
      };
      for (const e of A) e.sections = sectionsOf(e);
      for (const e of B) e.sections = sectionsOf(e);

      // 每条分支相对共享母路径的首个分节偏离 tick
      const devA = this._deviationMap(a, ancestor);
      const devB = this._deviationMap(b, ancestor);
      const decisionOf = {};

      const classify = (e, otherDev) => {
        const changed = (e.sections || []).filter(function (s) {
          return otherDev[s] != null && otherDev[s] < e.end;
        });
        if (!changed.length) {
          report.independent.push(e.id);
          return record(e, 'independent', [],
            '依赖分节 ' + (e.sections.join('/') || '（无）') + ' 在另一分支的整个窗口内未偏离共享状态，原输入可直接采用');
        }
        if (e.intent) {
          report.dependent.push(e.id);
          return record(e, 'dependent', unique(changed),
            '另一分支自 tick ' + Math.min.apply(null, changed.map(function (s) { return otherDev[s]; })) +
            ' 起已改变 ' + unique(changed).join('/') + '，按 ' + e.intent.kind + ' 在合并后的世界重新求值');
        }
        report.conflicts.push({
          kind: 'dependency', edit: e.id, entity: e.entity, tick: e.start, sections: unique(changed),
          reason: '固定输入编辑依赖的 ' + unique(changed).join('/') + ' 已被另一分支改变，且无 intent 可重求值'
        });
        return record(e, 'conflict', unique(changed), '依赖状态已变且无 intent 可重求值');
      };
      for (const e of actionable) {
        const isA = A.indexOf(e) >= 0;
        decisionOf[e.id] = classify(e, isA ? devB : devA);
      }
      report.edits = actionable.map(function (e) { return decisionOf[e.id]; });
      if (report.conflicts.length) {
        report.ok = false;
        report.explanations = explain(report, null, null);
        return report;
      }

      // 用最终决定重组组合层。保留编辑的类型：追加动作仍追加（可延长视界），
      // 窗口内替换仍作为动作处理。
      for (const e of actionable) {
        const d = decisionOf[e.id];
        const src = sourceOf[e.id];
        if (d.decision === 'independent') this._adopt(combined, e, src);
        else {
          const replan = {
            start: e.start, end: e.end, intent: e.intent, entity: e.entity,
            owner: e.branch, id: e.id + ':replan', kind: e.kind === 'append' ? 'append' : 'action'
          };
          if (e.kind === 'append') combined.appends.push(replan);
          else combined.actions.push(replan);
        }
      }

      const horizon = this._horizonOf(combined, a, b);
      const mergedNode = new Branch(this, {
        id: 'merge#' + (++this.counter), parentId: ancestor.id, kind: 'fork',
        tick: a.cache.startTick, label: '合并预演', layer: combined, horizon: horizon
      });
      this.nodes.set(mergedNode.id, mergedNode);
      this.rebuild(mergedNode);
      report.merged = summarize(mergedNode);

      // 完整重演：不复用任何检查点，从 tick 0 一次跑完同一组合层
      report.reference = this._fullReplay(combined, a.cache.startTick, mergedNode.cache.endTick);

      report.sameAsReference =
        SER.hashHex(SER.canon(report.merged.finalState)) === SER.hashHex(SER.canon(report.reference.finalState)) &&
        SER.canon(report.merged.pickups) === SER.canon(report.reference.pickups) &&
        SER.canon(report.merged.triggers) === SER.canon(report.reference.triggers);
      report.ok = report.sameAsReference && report.conflicts.length === 0;

      this.prune(mergedNode.id, true);
      report.explanations = explain(report, a, b);
      return report;
    }

    _horizonOf(combined, a, b) {
      let h = Math.max(a.cache.endTick, b.cache.endTick);
      for (const w of combined.windows) if (w.end > h) h = w.end;
      for (const x of combined.actions) if (x.end > h) h = x.end;
      for (const x of combined.appends) if (x.end > h) h = x.end;
      return h;
    }

    // 首偏离映射：分节 -> 该分支第一次相对共享母路径改变它的 tick
    _deviationMap(branch, ancestor) {
      const from = branch.cache.startTick;
      const to = Math.min(branch.cache.endTick, ancestor.cache.endTick);
      const out = {};
      if (to < from) return out;
      let a = this._seekWorld(ancestor, from, ancestor.cache.scene);
      let b = this._seekWorld(branch, from, branch.cache.scene);
      for (let t = from; t <= to; t++) {
        const ah = hashes(a), bh = hashes(b);
        for (const s of SIM.SECTIONS) {
          if (out[s] == null && ah[s] !== bh[s]) out[s] = t;
        }
        if (t < to) {
          SIM.step(ancestor.cache.scene, a, this._inputAt(ancestor, t), this.events.get(t) || []);
          SIM.step(branch.cache.scene, b, this._inputAt(branch, t), this.events.get(t) || []);
        }
      }
      return out;
    }

    // 从 tick 0 单次完整重演。场景参数按"从共享分叉点起生效"解释：
    // 分叉前的历史由母路径决定，分支不能倒改已发生的历史。
    _fullReplay(combined, forkTick, horizon) {
      const baseScene = this.scene;
      const overScene = applySceneOverride(baseScene, combined.scene).scene;
      const eff = {
        deleted: combined.deleted, windows: combined.windows,
        actions: combined.actions, appends: combined.appends
      };
      const state = clone(this.rec.initialState);
      const trig = { pickups: 0, doorOpen: 0, finish: 0 };
      let prevBag = state.pickups.map(function (p) { return p.taken ? 1 : 0; }).join('');
      let prevDoor = '0/0';
      while (state.tick < horizon) {
        const t = state.tick;
        const scene = t < forkTick ? baseScene : overScene;
        let input;
        if (t < forkTick) input = this.rec.inputs[t] | 0;
        else input = this._resolveLayer(eff, t, state, scene);
        SIM.step(scene, state, input, this.events.get(t) || []);
        const bag = state.pickups.map(function (p) { return p.taken ? 1 : 0; }).join('');
        for (let i = 0; i < bag.length; i++) if (bag[i] !== prevBag[i] && bag[i] === '1') trig.pickups++;
        prevBag = bag;
        const door = state.door.openTicks + '/' + (state.finished ? 1 : 0);
        if (prevDoor.indexOf('0/') === 0 && door.indexOf('0/') !== 0) trig.doorOpen++;
        if (prevDoor.indexOf('/0') > 0 && door.indexOf('/1') > 0) trig.finish++;
        prevDoor = door;
        if (state.finished) break;
      }
      if (state.finished && trig.finish === 0) trig.finish = 1;
      return {
        id: 'full-replay', startTick: 0, endTick: state.tick,
        finished: state.finished, finishTick: state.finishTick, score: state.score,
        doorOpenTicks: state.door.openTicks,
        pickups: state.pickups.map(function (p) { return p.taken ? 1 : 0; }),
        pickupCount: state.pickups.filter(function (p) { return p.taken; }).length,
        triggers: trig, finalState: clone(state), sceneChanged: Object.keys(combined.scene || {})
      };
    }

    _resolveLayer(eff, t, state, scene) {
      for (let i = eff.windows.length - 1; i >= 0; i--) {
        const w = eff.windows[i];
        if (t >= w.start && t < w.end) {
          return w.values ? (w.values[t - w.start] | 0) & 15 : (w.value | 0) & 15;
        }
      }
      for (let i = eff.actions.length - 1; i >= 0; i--) {
        const c = eff.actions[i];
        if (t >= c.start && t < c.end) {
          const v = evalIntent(c.intent, scene, state);
          if (v != null) return v & 15;
        }
      }
      for (let i = eff.appends.length - 1; i >= 0; i--) {
        const c = eff.appends[i];
        if (t >= c.start && t < c.end) {
          const v = evalIntent(c.intent, scene, state);
          if (v != null) return v & 15;
        }
      }
      if (inInterval(eff.deleted, t)) return 0;
      return t < this.rec.endTick ? this.rec.inputs[t] | 0 : 0;
    }
    _adopt(combined, e, source) {
      if (e.kind !== 'window' && e.kind !== 'action' && e.kind !== 'append') return;
      const from = e.start - source.cache.startTick, to = Math.min(e.end, source.cache.endTick) - source.cache.startTick;
      if (from < 0 || to <= from) return;
      combined.windows.push({
        start: e.start, end: e.end,
        values: source.cache.inputs.slice(from, to),
        owner: e.branch, id: e.id + ':adopt', kind: 'window'
      });
    }

    _common(a, b) {
      const set = new Set(b.lineage());
      for (let n = a; n; n = n.parent()) if (set.has(n)) return n;
      return this.root;
    }

    // 清理分支（及子树）：释放其持有的检查点引用。
    // silent=true 用于合并预演的临时节点。
    prune(id, silent) {
      const node = this.get(id);
      if (!node) return null;
      if (node.kind === 'record') throw new Error('不能清理原记录');
      const affected = this.active().filter(function (n) {
        return n === node || node.isAncestorOf(n);
      }).sort(function (x, y) { return x.lineage().length - y.lineage().length; });
      const released = [];
      for (const n of affected) {
        released.push.apply(released, this._releaseRefs(n));
        n.pruned = true;
      }
      this._stateMemo.clear();
      return { pruned: affected.map(function (n) { return n.id; }), released: released, silent: !!silent };
    }

    _releaseRefs(node) {
      const out = [];
      for (const k of node.cpKeys) { this.store.release(k, node.id); out.push(k); }
      node.cpKeys = [];
      return out;
    }

    // 共享检查点生命周期快照
    checkpointReport() {
      return {
        totals: this.store.totals(),
        shared: this.store.live().filter(function (e) { return e.refs > 1; })
          .map(function (e) { return { tick: e.tick, refs: e.refs, owners: e.owners }; }),
        byBranch: this.active().map(function (n) {
          return { id: n.id, pruned: n.pruned, checkpoints: n.cpKeys.length };
        })
      };
    }

    // 从母分支重新开局（清理试验分支后仍能找回原状态）
    reopenFrom(parentId, tick, forkSpec) {
      const state = this.seek(parentId, tick);
      let node = null;
      if (forkSpec) node = this.fork(parentId, Object.assign({ tick: tick }, forkSpec));
      return { state: state, branch: node };
    }

    snapshot() {
      return {
        root: this.root.id,
        branches: this.active().filter(function (n) { return n.kind !== 'record'; }).map(function (n) {
          return {
            id: n.id, label: n.label, parent: n.parentId, forkTick: n.forkTick,
            endTick: n.cache.endTick, scene: n.layer.scene || {},
            edits: countEdits(n.layer), finished: n.cache.finalState.finished,
            finishTick: n.cache.finalState.finishTick
          };
        }),
        checkpoints: this.checkpointReport()
      };
    }
  }

  // ---------------- 编辑描述与辅助 ----------------

  function rank(kind) { return EDIT_RANK[kind] || 0; }

  function idOf(branch, kind, start, end) {
    return branch.id + ':' + kind + ':' + start + '-' + end;
  }

  function editParam(branch, key, value) {
    return {
      id: branch.id + ':param:' + key, branch: branch.id, kind: 'param', key: key, value: value,
      start: branch.forkTick, end: branch.forkTick, entity: key,
      sections: [sectionOfSceneKey(key)], intent: null
    };
  }

  function editDelete(branch, iv) {
    return {
      id: idOf(branch, 'delete', iv[0], iv[1]), branch: branch.id, kind: 'delete',
      start: iv[0], end: iv[1], entity: 'player', sections: [], intent: null
    };
  }

  function editWindow(branch, w) {
    return {
      id: w.id || idOf(branch, 'window', w.start, w.end), branch: branch.id, kind: 'window',
      start: w.start, end: w.end, entity: w.entity || 'player',
      sections: w.sections || depsFor(w.entity || 'player'), intent: w.intent || null,
      value: w.value, values: w.values
    };
  }

  function editAction(branch, a, kind) {
    return {
      id: a.id || idOf(branch, kind, a.start, a.end), branch: branch.id, kind: kind,
      start: a.start, end: a.end, entity: a.entity || 'player',
      sections: a.sections || depsFor(a.entity || 'player'), intent: a.intent
    };
  }

  function countEdits(L) {
    return (L.scene ? Object.keys(L.scene).length : 0) +
      (L.deleted ? L.deleted.length : 0) +
      (L.windows ? L.windows.length : 0) +
      (L.actions ? L.actions.length : 0) +
      (L.appends ? L.appends.length : 0);
  }

  function record(e, decision, sections, reason) {
    return {
      id: e.id, branch: e.branch, kind: e.kind, start: e.start, end: e.end,
      entity: e.entity, intent: e.intent ? e.intent.kind : null,
      sections: e.sections, decision: decision, changedSections: sections, reason: reason
    };
  }

  function summarize(node) {
    const st = node.cache.finalState;
    // 触发次数按整局口径统计：沿族谱累加父路径在分叉点之前的触发，
    // 再加本分支自己的触发，才能和从 tick 0 完整重演公平对照。
    const chain = node.lineage();
    const triggers = { pickups: 0, doorOpen: 0, finish: 0 };
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      const upper = i + 1 < chain.length ? chain[i + 1].forkTick : node.cache.endTick;
      for (const [id, list] of n.entityIndex) {
        if (id.indexOf('pickup:') !== 0) continue;
        for (const c of list) if (c.tick <= upper) triggers.pickups++;
      }
    }
    // 门开启/过门各算一次
    let prevDoor = '0/0';
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      const upper = i + 1 < chain.length ? chain[i + 1].forkTick : node.cache.endTick;
      for (const c of (n.entityIndex.get('door') || [])) {
        if (c.tick > upper) continue;
        if (prevDoor.indexOf('0/') === 0 && c.value.indexOf('0/') !== 0) triggers.doorOpen++;
        if (prevDoor.indexOf('/0') > 0 && c.value.indexOf('/1') > 0) triggers.finish++;
        prevDoor = c.value;
      }
    }
    if (st.door.openTicks > 0 && triggers.doorOpen === 0) triggers.doorOpen = 1;
    if (st.finished && triggers.finish === 0) triggers.finish = 1;
    return {
      id: node.id, startTick: node.cache.startTick, endTick: node.cache.endTick,
      finished: st.finished, finishTick: st.finishTick, score: st.score,
      doorOpenTicks: st.door.openTicks,
      pickups: st.pickups.map(function (p) { return p.taken ? 1 : 0; }),
      pickupCount: st.pickups.filter(function (p) { return p.taken; }).length,
      triggers: triggers,
      finalState: clone(st), sceneChanged: node.cache.sceneChanged
    };
  }

  function explain(report, a, b) {
    const out = [];
    if (report.independent.length) {
      out.push('可直接采用的独立操作：' + report.independent.join('、') +
        ' —— 它们依赖的状态分节在另一分支中未被改动，录制时的输入仍对应同一意图。');
    }
    if (report.dependent.length) {
      out.push('需重新求值的依赖操作：' + report.dependent.join('、') +
        ' —— 另一分支已改变它们依赖的世界状态，固定按键不再成立，改按 intent 在合并后的世界重新求值。');
    }
    for (const c of report.conflicts) out.push('冲突：' + (c.reason || c.kind));
    if (report.sameAsReference && report.merged) {
      out.push('合并结果与从 tick 0 完整重演一致：最终哈希相同，背包 ' +
        report.merged.pickupCount + '/' + report.merged.pickups.length +
        '，触发次数（拾取 ' + report.merged.triggers.pickups +
        ' / 开门 ' + report.merged.triggers.doorOpen +
        ' / 过门 ' + report.merged.triggers.finish + '）逐项相同。');
    }
    if (a && b) {
      out.push('两条分支共享检查点 tick ' + a.cache.startTick +
        '；合并后结束于 tick ' + report.merged.endTick +
        '（原记录结束于 tick ' + a.tree.rec.endTick + '，未受改动，仍可单独重放）。');
    }
    return out;
  }

  function eventsByTick(rec) {
    const m = new Map();
    for (const e of rec.events) {
      if (!m.has(e.tick)) m.set(e.tick, []);
      m.get(e.tick).push({ type: e.type, data: e.data });
    }
    return m;
  }

  return {
    BranchTree, Branch, CheckpointStore,
    entitySnap, findEntityAt, inputStr, inInterval, mergeIntervals,
    applySceneOverride, evalIntent, sectionOfSceneKey, depsFor, eventsByTick
  };
});
