// test/multi-conversation.test.mjs
//
// 【事故十一 的回归锁】用户报：「多个对话框之间居然不是共享的」
//
// 这一节测的**不是**核心逻辑（那些在 round-control / core 里），而是
// **接线**：同一个窗口里两个对话的座席，到底拿到的是不是一个内核实例。
//
// 我原来的写法是 `const cores = new Map()` + `coreFor(sessionId)` —— 每个对话
// 一个内核。三个观测到的后果：
//   ① 每个内核只在打开那一刻读一次存档 → 另一个对话之后的进度看不见
//   ② 每个内核都去抢 client-store 那把写锁 → 第二个对话被判只读、写入静默丢失
//   ③ 两份 app 状态各自覆盖同一份存档 → 数据对不上
//
// 所以这里的断言只有一条主线：**两个对话必须共用同一个 app 实例**。
// 加一条反向的：如果又变回"每个 sessionId 一个实例"，本测试必须变红。
//
// 为什么必须真渲染、不能只 grep 源码：源码里改一个 Mark 写法就能骗过 grep，
// 而"两次挂载拿到同一实例"只有真跑一遍才看得出来。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
function check(ok, label, detail = '') {
  if (ok) {
    pass++;
    console.log(`\u001b[32m  ✓\u001b[0m ${label}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
  } else {
    fail++;
    console.log(`\u001b[31m  ✗\u001b[0m ${label}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
  }
}

// ── 最小 DOM ────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this._text = '';
    this.parentNode = null;
    this._listeners = {};
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._text; }
  set innerHTML(v) { this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') byId[String(v)] = this; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c) { c.parentNode = this; this.children.unshift(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn);
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() {}
  setSelectionRange() {}
}

const byId = {};
const doc = new El('html');
doc.head = doc.appendChild(new El('head'));
doc.body = doc.appendChild(new El('body'));
doc.createElement = (t) => new El(t);
doc.createTextNode = (t) => { const e = new El('#text'); e.textContent = t; return e; };
doc.getElementById = (id) => byId[id] || null;
doc.documentElement = doc.appendChild(new El('html'));
doc.addEventListener = () => {};
doc.removeEventListener = () => {};
doc.readyState = 'complete';

// ── 假 React：同步跑 effect，够验证"两次挂载"这件事 ──────────
//
// 关键点：useState 的值存在组件自己的槽里，effect 在"提交"后同步执行。
// 我们要看的不是渲染结果多漂亮，而是**两个组件实例各自拿到哪个 core**。
const mounts = [];
let hookCursor = 0;
let currentHooks = null;

function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
    useState(init) {
      const i = hookCursor++;
      // ⚠️ 必须把 **hook 槽本身** 抓住，不能用 `currentHooks[i]` ——
      // setter 常常在外部（比如 Promise.then）被调用，那时 hookCursor 早就
      // 跑到别的组件去了，而 `currentHooks` 也已经指向另一个组件的数组。
      // 我第一版就踩了这个：对话 A 的 setCore 把值写进了别的槽 → 看起来像
      // "A 没拿到内核"，其实是脚手架自己丢的。
      const slot = currentHooks;
      if (slot[i] === undefined) slot[i] = typeof init === 'function' ? init() : init;
      return [
        slot[i],
        (v) => {
          slot[i] = typeof v === 'function' ? v(slot[i]) : v;
        },
      ];
    },
    useRef(init) {
      const i = hookCursor++;
      if (currentHooks[i] === undefined) currentHooks[i] = { current: init };
      return currentHooks[i];
    },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) {
      const i = hookCursor++;
      const prev = currentHooks[i];
      const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k]);
      if (changed) {
        prev?.cleanup?.();
        currentHooks[i] = { deps, cleanup: fn() };
      }
    },
  };
}
const React = makeReact();

/** 把一个函数组件"挂载"起来，返回它的 hooks 槽（用来读它拿到的 core）。 */
function renderComponent(Comp, props) {
  hookCursor = 0;
  const mount = { hooks: [], props };
  currentHooks = mount.hooks;
  mount.tree = Comp(props);
  mounts.push(mount);
  return mount;
}

// ── 把 lib/client.js 物化 ────────────────────────────────────
console.log('\n[1] 物化 lib/client.js 并 apply');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

let registered = null;
const fakeWindow = {
  __ModuleLoader__: { load(m) { registered = m; } },
  localStorage: (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      get length() { return m.size; },
      key: (i) => [...m.keys()][i],
    };
  })(),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  speechSynthesis: { speak() {}, cancel() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};
globalThis.window = fakeWindow;
globalThis.document = doc;
globalThis.React = React;

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error(`意外的模块请求: ${name}`);
};

try {
  const fn = new Function('window', 'document', 'globalThis', 'self', 'React', src);
  fn(fakeWindow, doc, globalThis, fakeWindow, React);
  check(true, 'bundle 执行没抛错');
} catch (e) {
  check(false, 'bundle 执行没抛错', e && e.stack);
}

const mod = registered ? registered.factory(requireStub) : null;

// ── 假 ctx：把两个槽位都收下来，好拿到真组件 ─────────────────
const slots = new Map();
const scope = {
  slots: {
    inject: (name, fn) => fn(),
    register: (entry, Comp) => {
      slots.set(entry.id || entry.name, { entry, Comp });
      return () => {};
    },
  },
  sidebarRight: {},
  sidebarRightTabs: { register: () => () => {} },
};
const ctx = {
  effect: (fn) => { fn(); return () => {}; },
  inject: (names, cb) => cb(scope),
  sidebarRightTabs: { register: () => () => {} },
};

let applied = false;
try {
  mod?.apply(ctx);
  applied = true;
  check(true, 'apply() 没抛错');
} catch (e) {
  check(false, 'apply() 没抛错', e && e.stack);
}
if (applied) {
  check(slots.has('vocab-study-capsule'), '拿到了胶囊组件',
    `注册的槽位: ${[...slots.keys()].join(', ')}`);
}

// ── 真渲染两个"对话" ────────────────────────────────────────
console.log('\n[2] 两个对话各挂一次胶囊，看拿到的是不是一个内核');
const CapsuleSeat = slots.get('vocab-study-capsule')?.Comp;

if (typeof CapsuleSeat !== 'function') {
  check(false, '胶囊组件可用', '没有拿到组件，后面的断言没法做');
} else {
  // 对话 A：sessionId = conv-a
  const hostA = new El('div');
  renderComponent(CapsuleSeat, { sessionId: 'conv-a', openTab: () => {} });
  // 对话 B：sessionId = conv-b（不同对话，同一窗口）
  const hostB = new El('div');
  renderComponent(CapsuleSeat, { sessionId: 'conv-b', openTab: () => {} });

  // useCore 的 Promise 是异步的，等一轮微任务
  await new Promise((r) => setTimeout(r, 30));

  // 每个组件的第 0 个 hook 是 useCore 的 useState(null)
  const coreA = mounts[0]?.hooks?.[0];
  const coreB = mounts[1]?.hooks?.[0];

  check(!!coreA, '对话 A 拿到了内核', coreA ? '有' : 'null');
  check(!!coreB, '对话 B 拿到了内核', coreB ? '有' : 'null');
  check(!!coreA && !!coreB && coreA === coreB,
    '两个对话是**同一个内核实例**（这才是"共享"）',
    coreA === coreB ? '同一实例' : '两个不同实例 ← 就是用户报的问题');
  check(!!coreA && coreA.app === coreB?.app,
    '两个对话指向同一个 app（进度/设置天然共享）',
    coreA && coreB ? (coreA.app === coreB.app ? '同一 app' : '不同 app') : '');

  // ── 行为验证：在一个对话里背词，另一个对话必须看得见 ──────────
  //
  // 这一条才真正对应用户的抱怨。只断言"同一实例"是必要的，但不够：
  // 万一今后改成"两个实例但同步"，这条也得过。所以直接看数据。
  //
  // ⚠️ 读数据要读 `app.raw`（内核的内部状态），不是 `app.state`。
  // `app.state` 是**给界面看的精简快照**，init() 里被重新赋过值，
  // 里面只有 ready/streak/combo/settings/container/session 这些，
  // 没有 words/mem/records。我第一版读 `app.state.words` 拿到 undefined，
  // 差点当成"内核是空壳"。
  if (coreA) {
    try {
      await coreA.app.init(); // 已经 init 过就立刻返回
    } catch (e) {
      check(false, '内核 init() 成功', e && e.message);
    }
    const wordsA = coreA.app.raw?.words;
    check(Array.isArray(wordsA) && wordsA.length > 0,
      '共用内核真的把词库读进来了（不是个空壳）',
      `words=${Array.isArray(wordsA) ? wordsA.length : wordsA}`);

    // 如果真是两个内核（旧写法），B 的这份数据绝不会跟着变
    if (coreB) {
      const wordsSeenByB = coreB.app.raw?.words;
      check(wordsSeenByB === wordsA,
        '对话 B 看到的是同一批词（同一个对象，不是各读各的存档）',
        `A=${Array.isArray(wordsA) ? wordsA.length : '?'} B=${Array.isArray(wordsSeenByB) ? wordsSeenByB.length : '?'}`);

      // 直接验"同一个数据对象"：从 B 的 app 改设置，A 必须同时变
      coreB.app.updateSettings({ dailyGoal: 37 });
      check(coreA.app.state.settings.dailyGoal === 37,
        '在对话 B 改设置，对话 A 立刻看到（同一份状态）',
        `A.dailyGoal=${coreA.app.state.settings.dailyGoal}`);
    } else {
      // 两个对话没拿到同一个内核时，上面那两条断言没有意义 ——
      // 但必须显式失败，不能因为"没法测"就静默跳过（不然又是假绿）。
      check(false, '对话 B 有内核可供比对', 'B 没拿到内核，"数据是否共享"这条无法成立');
      check(false, '在对话 B 改设置，对话 A 立刻看到', 'B 没拿到内核');
    }
  }
}

// ── 反向：确认"每个 sessionId 一个实例"这条路真的断了 ────────
//
// 这里**刻意不查源码字面量**。我试过两版 grep，都假红：事故记录和反面教材
// 就写在注释里（`const cores = new Map()`、`coreFor(sessionId)`），
// 按字面量查必然命中注释。而行为断言已经在上面证明了两者是同一实例 ——
// 那才是判据。只留两条不会误报的结构断言（它们查的是"独一份"的事实）。
console.log('\n[3] 反向核对：本窗口唯一内核的落点');
const clientSrc = fs.readFileSync(path.join(ROOT, 'adapter', 'dsh', 'client.js'), 'utf8');
const hasSingleton = /let corePromise = null/.test(clientSrc);
check(hasSingleton, '有本窗口唯一的内核单例（corePromise）');
const seatsUseUseCore = (clientSrc.match(/const core = useCore\(\);/g) || []).length;
check(seatsUseUseCore >= 2, '两个座席都用 useCore（不是 coreFor(sessionId)）',
  `出现 ${seatsUseUseCore} 次`);
// 内核实例只能有一个来源：coreFor。如果两个座席各自能建实例，
// 上面"同一实例"的断言就只是巧合了。
const coreForDefs = (clientSrc.match(/function coreFor\(/g) || []).length;
check(coreForDefs === 1, '只存在一处建内核的入口（coreFor）', `找到 ${coreForDefs} 处`);

// ── 汇总 ────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log(`\u001b[32m${pass} 通过 / ${fail} 失败\u001b[0m  —— 多对话共用一份数据`);
} else {
  console.log(`\u001b[31m${pass} 通过 / ${fail} 失败\u001b[0m`);
}
console.log('─'.repeat(56));
process.exit(fail === 0 ? 0 : 1);
