// 挂载回归测试：「槽位注册成功了，但屏幕上什么都没有」。
//
// ── 这个文件守的是一个真实事故 ────────────────────────────────
//
// 现象：插件装好了、重启了，`Slots.listSubTree` 查出来我的注册**是 `active: true`**
// （宿主确认它在），浏览器存储里也有插件写的键（证明傀儡真的被创建过），
// **但用户在界面上什么都看不见。**
//
// 根因：`VocabPane` 调 `createPanelPuppet` 时**漏了 `mountTo`**。
// 而 puppet.mjs 里是这么挂的：
//
//     if (mountTo && typeof mountTo.appendChild === 'function') mountTo.appendChild(panel.root);
//
// `mountTo === undefined` → 这行**静默跳过** → 面板 DOM 建好了，却挂在一个
// 游离节点上，永远不进页面。**不报错、不警告、槽位状态还是 active。**
//
// ── 这个测试的写法，以及为什么这么写 ────────────────────────
//
// 一开始我试图用"假 React"把组件挂起来再查 DOM，结果写了两百行假的调和器还是不准。
// 那是**在测试工具上赌运气**，而不是在测产品代码。
//
// 真正该测的是这次事故的那条因果链，它**不依赖 React**：
//
//     容器（宿主给） → 傀儡工厂 → 节点必须真的进了容器的 childNodes
//
// React 只是"把容器放进页面"的那一环。所以这里直接从产物里取出傀儡工厂，
// 拿一个在文档里的容器去建，然后断言 **DOM 树里真的有东西**。
// 这样 bug 一出现就会红：漏传 mountTo 时 childNodes 是空的。
//
// 另外还静态检查了适配层**真的把 mountTo 传下去了** —— 双保险，因为
// "工厂行为正确"和"调用方传对了参数"是两件会分别出错的事。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const OFF = '\u001b[0m';

let pass = 0;
let fail = 0;
function check(ok, label, extra) {
  if (ok) {
    pass++;
    console.log(`  ${GREEN}✓${OFF} ${label}`);
  } else {
    fail++;
    console.log(`  ${RED}✗${OFF} ${label}${extra ? `\n      ${DIM}${extra}${OFF}` : ''}`);
  }
}

// ══════════════════════════════════════════════════════════════
// 一个够真的 DOM（关键是 contains() 和 childNodes 是真的）
//
// ⚠️ 必须让节点**真的** `instanceof Node`：ui/dom.mjs 的 `mount()` 会检查
// `n instanceof Node`，不是节点就抛错。面板每次重画都走 mount()，所以这条
// 不是可选的装饰 —— 构造原型链是让这个测试能测到面板的唯一办法。
// ══════════════════════════════════════════════════════════════
function FakeNode(tag) {
  this.tagName = String(tag).toUpperCase();
  this.nodeType = 1;
  this.childNodes = [];
  this.parentNode = null;
  this.attrs = {};
  this.dataset = {};
  this.style = {};
  this.className = '';
  this.hidden = false;
  /** 事件处理表：addEventListener 真的往这里存（原来被空函数丢了） */
  this._handlers = {};
}
// ui/dom.mjs 的 mount() 用 `instanceof Node` 判真伪，所以挂到全局。
//
// ⚠️ 这里**不能**用 `new Proxy(FakeNode, ...)`：`instanceof` 认的是右侧的
// `Symbol.hasInstance`，proxy 上那层 get 陷阱对它的处理很容易写错（我写错过一次，
// 结果是"实例 instanceof Node === false"，于是 mount() 把真节点全拒了）。
// 正确做法：把 Node 做成一个**可调用**的函数（Text 节点也用它），直接挂
// `Symbol.hasInstance`。
function NodeCtor(tag) {
  if (!(this instanceof NodeCtor)) return { nodeValue: String(tag), nodeType: 3, parentNode: null, childNodes: [] };
  FakeNode.call(this, tag);
}
NodeCtor.prototype = Object.create(FakeNode.prototype);
NodeCtor.prototype.constructor = NodeCtor;
Object.defineProperty(NodeCtor, Symbol.hasInstance, {
  // configurable 必须给：Function.prototype 上本来就有 hasInstance，
  // 默认不可配置会让这次覆盖静默失败（我踩过）
  configurable: true,
  value: (v) => v instanceof FakeNode,
});
// Node 24 自带一个内建的全局 `Node`，直接 `globalThis.Node = X` **赋值会被忽略**
// （诊断过：赋值后 hasInstance 仍是默认实现）。必须用 defineProperty 强改。
Object.defineProperty(globalThis, 'Node', {
  configurable: true,
  writable: true,
  value: NodeCtor,
});
// firstChild 放原型上：它是 getter，不能走上面那个 Object.assign（会提前求值）
Object.defineProperty(FakeNode.prototype, 'firstChild', {
  get() {
    return this.childNodes[0] ?? null;
  },
});

function makeNode(tag) {
  const node = new FakeNode(tag);
  Object.assign(node, {
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    },
    append(...cs) {
      for (const c of cs) this.appendChild(c);
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    replaceChildren(...cs) {
      while (this.childNodes.length) this.removeChild(this.childNodes[0]);
      this.append(...cs);
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    // ⚠️ 这里原来是空函数 —— 而 el() 挂事件全靠它：
    // ui/dom.mjs:13 `else if (k.startsWith('on') && typeof v === 'function')
    //                node.addEventListener(k.slice(2).toLowerCase(), v)`
    // 空实现的后果：所有 onclick 处理函数**被静默丢掉**，于是"点一下"永远
    // 点不出任何东西 —— 想验「播放键点了会不会发音」根本无从下手。
    // 现在真的存起来，配合下面的 click() 派发。
    addEventListener(type, fn) {
      if (typeof fn === 'function') (this._handlers[type] = this._handlers[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this._handlers[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    /** 触发一次点击 —— 让"点播放键"这种检查能真的走到处理函数里 */
    click() {
      for (const fn of this._handlers.click || []) fn({ type: 'click', target: this });
      return true;
    },
    focus() {},
    // ⚠️ 这里原来恒返回 null —— 而面板**全靠它**找元素：
    // panel.mjs 里 `host.querySelector('#vs-badges' / '#vs-ipa' / '#vs-headline'
    // / '#vs-stage' / '#vs-actions' / '#vs-card')` 一共十几处。
    // 恒 null 的后果：卡片还没画出来，setText(null, ...) 就炸
    // "Cannot read properties of null (reading 'firstChild')"，
    // 于是"点播放键"这类行为检查**在一个错误的前提下**失败 —— 看起来像产品坏了，
    // 其实是我的桩不够真实。所以这里实现一个真的查找：
    // 支持 '#id'、'.class'、'tag' 三种最简单形式（够面板用了）。
    querySelector(sel) {
      const hit = this.querySelectorAll(sel);
      return hit.length ? hit[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const s = String(sel || '');
      const match = (n) => {
        if (s.startsWith('#')) return n.attrs && n.attrs.id === s.slice(1);
        if (s.startsWith('.')) return String(n.className || '').split(/\s+/).includes(s.slice(1));
        return String(n.tagName || '').toUpperCase() === s.toUpperCase();
      };
      const walk = (n) => {
        for (const c of n.childNodes || []) {
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    // 注意：这里不能用 getter —— Object.assign 会**求值** getter，
    // 而求值时 this 指向那个字面量而不是节点，会炸。firstChild 由下面刷新。
    contains(other) {
      for (const c of this.childNodes) {
        if (c === other || (c.contains && c.contains(other))) return true;
      }
      return false;
    },
    /** 调试用：所有后代的 class 名 */
    allClasses(out = []) {
      if (this.className) out.push(this.className);
      for (const c of this.childNodes) if (c.allClasses) c.allClasses(out);
      return out;
    },
  });
  return node;
}
const DOC = {};
DOC.createElement = makeNode;
DOC.createElementNS = (ns, t) => makeNode(t);
DOC.createTextNode = (t) => ({ nodeValue: t, nodeType: 3, parentNode: null, childNodes: [] });
DOC.documentElement = makeNode('html');
DOC.head = makeNode('head');
DOC.body = makeNode('body');
DOC.addEventListener = () => {};
DOC.removeEventListener = () => {};
DOC.querySelector = () => null;
DOC.querySelectorAll = () => [];

globalThis.document = DOC;
// 注意：这里**不要**再写 `globalThis.Node = ...`。
// 上面已经用 defineProperty 装好了带 Symbol.hasInstance 的 NodeCtor，
// 这里覆盖一次就会让 `mount()` 的 `instanceof Node` 全部判假（我踩过：面板永远画不出来）。

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.speechSynthesis = undefined;
if (!globalThis.performance) globalThis.performance = { now: () => 0 };

// React 只用来让工厂模块加载起来；这个测试不渲染 React 组件。
const ReactStub = {
  createElement: () => makeNode('div'),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
  useLayoutEffect: () => {},
  createContext: () => ({ Provider: null, Consumer: null }),
  memo: (f) => f,
  forwardRef: (f) => f,
  Fragment: Symbol('Fragment'),
};
globalThis.React = ReactStub;

// ══════════════════════════════════════════════════════════════
// 加载真实产物，把工厂内部拿到的模块导出取出来
// ══════════════════════════════════════════════════════════════
console.log('\n[1] 加载 lib/client.js');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

let registered = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(m) {
      registered = m;
    },
  },
};
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'globalThis', 'self', 'React', src)(
    fakeWindow,
    DOC,
    globalThis,
    fakeWindow,
    ReactStub,
  );
  check(true, 'bundle 执行成功');
} catch (e) {
  check(false, 'bundle 执行成功', e && e.message);
}

let mod = null;
try {
  mod = registered.factory((n) => {
    if (n === 'react') return ReactStub;
    throw new Error(`意外 require: ${n}`);
  });
  check(true, '工厂物化成功');
} catch (e) {
  check(false, '工厂物化成功', e && e.message);
}
check(typeof mod.apply === 'function', '导出 apply');

// ══════════════════════════════════════════════════════════════
// [2] 静态检查：适配层必须把 mountTo 传下去
// ══════════════════════════════════════════════════════════════
console.log('\n[2] 适配层把 mountTo 传给了两个傀儡（这次事故的直接原因）');

const adapter = fs.readFileSync(path.join(ROOT, 'adapter', 'dsh', 'client.js'), 'utf8');
const puppetSrc = fs.readFileSync(path.join(ROOT, 'adapter', 'dsh', 'puppet.mjs'), 'utf8');

check(/createPanelPuppet\(\{[\s\S]{0,400}?mountTo\s*:/.test(adapter), 'VocabPane 给 createPanelPuppet 传了 mountTo');
check(/createCapsulePuppet\(\{[\s\S]{0,400}?mountTo\s*:/.test(adapter), 'CapsuleSeat 给 createCapsulePuppet 传了 mountTo');
check(
  /mountTo\s*&&\s*typeof\s+mountTo\.appendChild\s*===\s*'function'/.test(puppetSrc),
  'puppet.mjs 里是"有 mountTo 才 append"（所以漏传就是静默不画）',
);
// 两个席位都不能再出现"只传 core/host、不传 mountTo"的旧写法
check(
  !/createPanelPuppet\(\{\s*core,\s*host:/.test(adapter),
  '没有残留"createPanelPuppet({ core, host })"这种漏 mountTo 的写法',
);

// ══════════════════════════════════════════════════════════════
// [3] 行为检查：把容器放进文档，建傀儡，节点必须真的进去
// ══════════════════════════════════════════════════════════════
console.log('\n[3] 建傀儡后，DOM 树里必须真的有东西');

// 从 apply 的注册里拿到傀儡工厂（apply 时会把组件注册进来）
const slots = new Map();
const ctx = {
  slots: {
    inject(name, cb) {
      if (typeof cb === 'function') cb();
    },
    register(spec, component) {
      slots.set(spec.name, { spec, component });
      return () => {};
    },
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: {},
  effect: (fn) => fn(),
  /** 宿主真实契约：服务在 scope 上，不在根 ctx 上。 */
  inject(names, cb) {
    const wanted = Array.isArray(names) ? names : [names];
    const scope = {};
    for (const n of wanted) if (ctx[n] !== undefined) scope[n] = ctx[n];
    cb(scope);
    return () => {};
  },
  get: () => undefined,
  on: () => {},
  logger: { info() {}, warn() {}, error() {} },
};
try {
  mod.apply(ctx);
  check(true, 'apply(ctx) 没有抛错');
} catch (e) {
  check(false, 'apply(ctx) 没有抛错', e && e.message);
}

// 用"模拟宿主"的方式：直接测 puppet 工厂（它们是产物里的内部函数，不在导出上）
// 所以这里通过产物源码里那两条 append 语句的可达性来验证行为。
// 更可靠的做法：真的调用 apply 注册进来的组件不行（需要 React 调和），
// 于是我们用一个"最像宿主"的容器去建傀儡 —— 通过 vm 里的工厂？
// 产物只导出 apply/inject，傀儡工厂拿不到。
//
// 因此行为验证改成：断言 puppet.mjs 的两处 append 都在，且两处 mountTo 都来自参数。
const appendsCapsule = [...puppetSrc.matchAll(/mountTo\.appendChild\(/g)].length;
check(
  appendsCapsule === 2,
  `两个傀儡都真的 append 进容器（找到 ${appendsCapsule} 处 mountTo.appendChild）`,
  puppetSrc.includes('mountTo.appendChild') ? undefined : '一处都没有',
);

// 而且 append 必须在"有节点"之后、被 destroy 收拾干净
check(
  /capsule\.root\.parentNode\.removeChild\(capsule\.root\)/.test(puppetSrc),
  '胶囊 destroy 会把自己摘下来（否则容器重建会叠出第二个）',
);

// ══════════════════════════════════════════════════════════════
// [4] 端到端：把产物里的傀儡工厂抠出来，拿真容器建一遍
// ══════════════════════════════════════════════════════════════
console.log('\n[4] 端到端：容器在文档里 → 建傀儡 → 容器里必须有节点');

// 产物不是 ESM（不能 import），里面的工厂函数也不是导出。
// 但它是个普通函数体，所以把工厂体抠出来、原地把几个函数 `return` 出来，
// 就能用受控作用域直接调用 —— 测的是**真产物里的真代码**，不是另抄一份。
function extractFactories(bundleSrc) {
  const marker = '__ModuleLoader__.load(';
  const at = bundleSrc.indexOf(marker);
  if (at < 0) return null;

  // 形态：  __ModuleLoader__.load({ id: '...', factory(require) { <body> } });
  const afterFactory = bundleSrc.indexOf('factory(require)', at);
  if (afterFactory < 0) return null;
  // factory(require) 之后第一个 '{' 就是函数体起点
  const open = bundleSrc.indexOf('{', afterFactory);
  if (open < 0) return null;
  return buildFromBody(bundleSrc, open);
}

/**
 * 取出工厂体。
 *
 * 不用花括号配平 —— 试过，被源码里正则字面量的 `{}` 骗了（配平到 end=-1）。
 * 改用产物**自己写死**的锚点：工厂最后一句是 `return module.exports;`。
 * 取文件里**最后一次**出现（第一次在文件头注释里）。
 */
function buildFromBody(bundleSrc, open) {
  const ANCHOR = 'return module.exports;';
  const anchorAt = bundleSrc.lastIndexOf(ANCHOR);
  if (anchorAt < 0 || anchorAt < open) return null;
  const factoryBody = bundleSrc.slice(open + 1, anchorAt);
  // 工厂头的 module/exports 声明由我们自己的 head 提供，这里去掉产物里的那份
  const cleaned = factoryBody
    .replace(/^\s*var module = \{ exports: \{\} \};\s*$/m, '')
    .replace(/^\s*var exports = module\.exports;\s*$/m, '');

  const names = [
    'createVocabCore',
    'createCapsulePuppet',
    'createPanelPuppet',
    'createPanel',
    'createCapsule',
    'createStorage',
  ];
  const found = names.filter((n) => new RegExp(`function\\s+${n}\\s*\\(`).test(cleaned));
  // ⚠️ `return` 必须追加在**函数体最末尾**，不能插在最前面。
  // 产物里有很多顶层 `const`（比如 ui 那层的 TABS），函数声明会提升但它们不会；
  // 把 return 放前面就会踩 TDZ："Cannot access 'TABS' before initialization"。
  const tail = `\nreturn { ${found.join(', ')} };\n`;
  // 产物工厂头那两行 module/exports 声明已被 cleaning 去掉，这里补回来
  const prelude = `var module = { exports: {} };\nvar exports = module.exports;\n`;
  // 构建期注入的样式变量产物里已经有（`var VOCAB_STUDY_CSS = ...`），不要再补
  // `require` 是工厂自己的参数，得当作形参传进来（产物里有 require('react')）
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'require',
    'window',
    'document',
    'globalThis',
    'self',
    'React',
    prelude + cleaned + tail,
  );
  const requireStub = (n) => {
    if (n === 'react') return ReactStub;
    throw new Error(`意外 require: ${n}`);
  };
  return {
    api: fn(requireStub, fakeWindow, DOC, globalThis, fakeWindow, ReactStub),
    found,
  };
}

const extracted = extractFactories(src);
if (!extracted) {
  // 定位辅助：把失败的那一步直接指出来
  const at = src.indexOf('__ModuleLoader__.load(');
  const af = src.indexOf('factory(require)', at);
  const open = af >= 0 ? src.indexOf('{', af) : -1;
  check(
    false,
    '能从产物里抠出傀儡工厂',
    `marker@${at} factory(require)@${af} bodyOpen@${open}；` +
      `文件里 createPanelPuppet=${/function\s+createPanelPuppet\s*\(/.test(src)}`,
  );
} else {
  check(
    extracted.found.includes('createPanelPuppet') && extracted.found.includes('createCapsulePuppet'),
    `抠到了两个傀儡工厂（${extracted.found.join(', ')}）`,
  );

  const F = extracted.api;
  // 一个"够像 app"的假内核：面板会订阅状态、读 state、可能 await init()
  //
  // ⚠️ state 必须**有卡片**：`raw.ready: true` 时面板第一帧就直接渲染，
  //    而 `card: null` 会让它走"本轮走完"的空状态分支 —— 那样就没有 .vs-word
  //    可点，播放键行为检查会在一个错误的前提下失败（我第一次就踩了这个）。
  function makeFakeApp() {
    return {
      state: {
        card: {
          cardId: 'c-speak-1',
          kind: 'new',
          word: { id: 'w-considerate', word: 'considerate', phonetic: '/kənˈsɪdərət/' },
        },
        lastReveal: null,
        phase: 'idle',
        ready: true,
        // 面板会读这些；给最小可用值，避免一堆 undefined 访问
        session: { sessionId: 's-speak', stats: { answered: 0 } },
        settings: { roundSize: 5, order: 'shuffle' },
        streak: { current: 0 },
        combo: { count: 0 },
        exp: 0,
        roundFinished: false,
        roundSize: 5,
        canRestart: true,
        newGate: { autoBlocked: false, bypassed: false, closed: false },
        stats: { todayAnswered: 0 },
      },
      // 面板会读 app.raw.mem[card.word.id]（panel.mjs:425）——
      // 少了 mem 就 "Cannot read properties of undefined (reading 'w-...')"。
      // raw 是**内部状态**，面板确实会直接读它，所以桩必须给。
      raw: { ready: true, mem: {}, settings: {} },
      subscribe: () => () => {},
      beckon: () => ({ state: 'first', visible: true, label: '🌱 今天第一词', tone: { key: 'fresh' } }),
      init: async () => {},
      render: () => {},
      next: () => {},
      rate: () => {},
      start: () => {},
      updateSettings: () => {},
      settings: {},
      queue: [],
      stats: {},
      streak: {},
    };
  }
  const fakeCore = { app: makeFakeApp() };

  // ── 面板：这次事故的主角 ──
  const host = makeNode('div');
  host.className = 'vs-pane-host';
  DOC.body.appendChild(host);
  check(host.childNodes.length === 0, '容器初始是空的');

  let panel = null;
  try {
    // 诊断：先确认产物里的 el() 用的就是我们的假 document
    if (typeof F.createCapsule === 'function') {
      const probe = F.createCapsule({});
      check(
        probe.root instanceof FakeNode,
        'el() 用的是假 document（节点 instanceof FakeNode）',
        `实际：${Object.prototype.toString.call(probe.root)} / tagName=${probe.root && probe.root.tagName} / ` +
          `有 appendChild=${typeof (probe.root && probe.root.appendChild)}`,
      );
      // 关键：mount() 里那句 `n instanceof Node` 到底认不认我们的节点？
      const n2 = F.createCapsule({}).root;
      console.log(
        `      ${DIM}诊断：ctor=${n2.constructor && n2.constructor.name} ` +
          `globalThis.Node=${globalThis.Node && globalThis.Node.name} ` +
          `hasInstance=${globalThis.Node && globalThis.Node[Symbol.hasInstance] === Function.prototype[Symbol.hasInstance] ? '(默认)' : '(自定义)'} ` +
          `直接调=${globalThis.Node && globalThis.Node[Symbol.hasInstance] && globalThis.Node[Symbol.hasInstance](n2)}${OFF}`,
      );
      check(n2 instanceof globalThis.Node, '假节点能过 mount() 里的 instanceof Node 检查');
      const plain = { tagName: 'X' };
      check(!(plain instanceof globalThis.Node), '普通对象**不**会过 instanceof Node 检查（否则才是真异常）');
    }
    panel = F.createPanelPuppet({ core: fakeCore, mountTo: host, host: {} });
  } catch (e) {
    // 把 mount() 收到的那个值描述出来，别只报 "[object Object]"
    const bad = [];
    if (e && e.badValue) bad.push(`value=${describe(e.badValue)}`);
    check(false, 'createPanelPuppet 能建起来', `${e && e.message}${bad.length ? ' | ' + bad.join(' ') : ''}`);
  }
  if (panel) {
    const cls = host.allClasses().join(' ');
    check(host.childNodes.length > 0, `面板节点真的进了容器（childNodes=${host.childNodes.length}）`);
    check(cls.includes('vs-panel'), `容器里是 .vs-panel（实际第一项："${(cls.split(' ')[0] || '(空)').slice(0, 40)}"）`);
    check(
      cls.includes('vs-head') && cls.includes('vs-tabs') && cls.includes('vs-body') && cls.includes('vs-foot'),
      '面板有 head/tabs/body/foot 四块',
    );
    check(host.contains(panel.root), '容器的 contains() 能查到面板根节点');

    try {
      panel.destroy();
    } catch {
      /* 允许内部噪音 */
    }
    check(host.childNodes.length === 0, `destroy 后容器干净了（childNodes=${host.childNodes.length}）`);
  }

  // ── 反面对照：不传 mountTo 就是空 —— 这正是原来那个 bug 的机制 ──
  const host2 = makeNode('div');
  DOC.body.appendChild(host2);
  try {
    F.createPanelPuppet({ core: fakeCore, host: {} });
  } catch {
    /* 允许 */
  }
  check(host2.childNodes.length === 0, '不传 mountTo 时容器是空的（复现原 bug：静默不画、不报错）');

  // ── 胶囊 ──
  const host3 = makeNode('div');
  DOC.body.appendChild(host3);
  try {
    F.createCapsulePuppet({ core: fakeCore, mountTo: host3, onOpen: () => {} });
  } catch (e) {
    check(false, 'createCapsulePuppet 能建起来', e && e.message);
  }
  const capCls = host3.allClasses().join(' ');
  check(host3.childNodes.length > 0, `胶囊节点真的进了容器（childNodes=${host3.childNodes.length}）`);
  check(capCls.includes('vs-capsule'), `容器里是 .vs-capsule（实际第一项："${(capCls.split(' ')[0] || '(空)').slice(0, 40)}"）`);

  // ── [4d] 播放键行为：真建面板、点一下，onSpeak 必须被调到 ──
  // 必须在这个 `if (F)` 块内：F / makeNode / DOC 都是块内绑定，
  // 写到块外会 "F is not defined"（我第一次就写在了外面，4 条行为断言全红）。
  const host4 = makeNode('div');
  host4.className = 'vs-pane-host';
  DOC.body.appendChild(host4);
  const spoken = [];
  let panel4 = null;
  try {
    panel4 = F.createPanelPuppet({
      core: { app: makeFakeApp() },
      mountTo: host4,
      host: {
        onSpeak: (w) => {
          spoken.push(w);
          return true;
        },
      },
    });
  } catch (e) {
    check(false, '带 onSpeak 时面板能建起来', e && e.message);
  }

  // 递归找 .vs-word（假 DOM 的 querySelector 恒返回 null，只能自己走）
  function findByClass(node, cls) {
    if (!node) return null;
    const own = String(node.className || (node.attrs && node.attrs['class']) || '');
    if (own.split(/\s+/).includes(cls)) return node;
    for (const c of node.childNodes || []) {
      const hit = findByClass(c, cls);
      if (hit) return hit;
    }
    return null;
  }

  const wordBtn = panel4 ? findByClass(panel4.root, 'vs-word') : null;
  check(wordBtn !== null, '面板里找得到 .vs-word 播放键（找不到说明卡片没渲染出来）');
  if (wordBtn) {
    // el() 是 addEventListener('click', fn) 挂的，所以用真的 click() 派发，
    // 而不是找 .onclick 属性（假 DOM 里根本没有那个属性）。
    check((wordBtn._handlers.click || []).length === 1, '.vs-word 上挂了 1 个 click 处理函数');
    try {
      wordBtn.click();
    } catch (e) {
      check(false, '点播放键不抛错', e && e.message);
    }
    check(spoken.length === 1, `点一次播放键，onSpeak 被调到 1 次（实际 ${spoken.length} 次）`);
    check(
      spoken.length > 0 && typeof spoken[0] === 'string' && spoken[0].length > 0,
      `传给 onSpeak 的是一个真单词（收到 ${JSON.stringify(spoken[0])}）`,
    );
  }

  // 反面对照：宿主不给 onSpeak 时**不能**静默 —— 走兜底并给反馈
  const host5 = makeNode('div');
  host5.className = 'vs-pane-host';
  DOC.body.appendChild(host5);
  const toasts = [];
  let panel5 = null;
  try {
    panel5 = F.createPanelPuppet({
      core: { app: makeFakeApp() },
      mountTo: host5,
      host: { toast: (m) => toasts.push(m) },
    });
  } catch (e) {
    check(false, '不带 onSpeak 时面板也能建起来', e && e.message);
  }
  const btn5 = panel5 ? findByClass(panel5.root, 'vs-word') : null;
  if (btn5) {
    try {
      btn5.click();
    } catch (e) {
      check(false, '不带 onSpeak 时点播放键不抛错', e && e.message);
    }
  }
  check(
    toasts.length >= 1,
    `宿主没给 onSpeak 时，点播放键会走兜底（原生 speak）并给出反馈（toast=${toasts.length} 条）`,
  );
}
// ── 到这里 `if (extracted) { ... }` 块结束 ──
// 下面的静态检查不依赖块内的 F / makeNode / DOC，所以放在块外。

// ══════════════════════════════════════════════════════════════
// [5] 播放键不能是死键（2026-10-10 用户报「单词右边的播放键是无效的」）
// ══════════════════════════════════════════════════════════════
//
// 现场：点单词 → `globalThis.__VS_SPEAK__?.(word)`。那是个**从来没有人赋值**
// 的全局钩子，配上 `?.` 于是永远静默；紧接着 `if (ctx.onSpeak) ...`，
// 而 adapter/dsh/puppet.mjs 转发 host 时**漏了 onSpeak**。
// 两条路都是空的，用户点下去毫无反应、控制台连报错都没有。
//
// 真浏览器实测（有 speechSynthesis、包了计数器）：
//   修前 → 点了 speechSynthesis.speak() 调用数 0→0
//   修后 → 0→1，lang=en-US rate=0.9
console.log('\n[5] 播放键必须真的有出路（不能有"读了就没人写"的钩子）');

// 5a 静态：死钩子不许回来
const clientBundle = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
const bundleNoComment = clientBundle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(
  !/__VS_SPEAK__/.test(bundleNoComment),
  '产物里没有 __VS_SPEAK__ 这种"只读不写"的全局钩子（它静默失败，查都无从查起）',
);

// 5b 静态：适配层必须把 onSpeak 转给面板（这次 bug 的直接原因）
check(
  /onSpeak\s*:\s*host\.onSpeak\s*\|\|/.test(puppetSrc),
  'puppet.mjs 的 createPanelPuppet 转发了 onSpeak（原来漏了这一项，于是键是死的）',
);
check(
  /onSpeak[\s\S]{0,80}speak\(word\)/.test(puppetSrc),
  'onSpeak 的默认值是本文件已导入的 speak(word)（不是又一个空函数）',
);

// 5c 静态：界面层得把结果返回出去，否则适配层拿不到 true/false、给不了反馈
const panelSrc = fs.readFileSync(path.join(ROOT, 'ui', 'panel.mjs'), 'utf8');
check(
  /ctx\.onSpeak\s*\?\s*ctx\.onSpeak\(word\)/.test(panelSrc),
  'panel.mjs 点单词时调 ctx.onSpeak(word)',
);
check(
  // 兜底要有一条 toast，且文案不能是"成功"口径 —— 发不出声就得说实话（P7）
  /ctx\.toast\?\.\([\s\S]{0,120}没有系统语音/.test(panelSrc),
  '发不出声时给用户一句诚实的提示（而不是让键看起来像坏的）',
);

// ⚠️ 收尾必须放在**文件最末**：
// 上面 `if (F) { ... }` 块里已经跑完了播放键的行为检查，
// 这里统一汇总。注意别在中间插 process.exit —— 插了后面的检查就静默不跑了
// （我第一次重构时正是把 exit 留在中间、又删掉了末尾这两句，
//   结果整份测试退出码恒为 0，看着全绿其实什么都没验）。
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

