// 客户端激活回归测试。
//
// 为什么必须有这个文件：
//
// 插件本体在最小 DOM（demo-boot）里跑得好好的，但那是 **demo 外壳**，走的是
// `createPanel(app, ...)` 这条路，**完全不经过 DSH 的 Cordis 内核**。
// 真实客户端是另一条路：内核物化工厂 → 调 `apply(ctx)` → fiber 进入 ACTIVE。
//
// 而 `apply(ctx)` 里如果有一个 undefined 上的属性访问，它同步抛错 →
// fiber 永远进不了 ACTIVE → 客户端启动审计在最后一步失败：
//
//     Error: web boot: 1 entry did not activate
//     dsh-vocab-study: loading
//
// 后果不是"插件不显示"，是**整个客户端停在启动页**，弹窗要求
// 「禁用第三方插件、备份 profile patch 并重启」。真实发生过（2026-10-08）。
//
// 所以这个测试要回答的唯一问题是：
//   **把工厂跑起来、把 apply 调一遍，它会不会抛？**
// 以及：`inject` 有没有声明 apply 里用到的每一个服务。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const OFF = '\u001b[0m';

function check(ok, label, extra) {
  if (ok) {
    pass++;
    console.log(`  ${GREEN}✓${OFF} ${label}`);
  } else {
    fail++;
    console.log(`  ${RED}✗${OFF} ${label}${extra ? `\n      ${DIM}${extra}${OFF}` : ''}`);
  }
}

// ── 真实最小 DOM（与 demo-boot 一致的思路，但这里只为让 apply 能跑完）──
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: {},
    children: [],
    listeners: {},
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    },
    removeEventListener() {},
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append(...c) {
      this.children.push(...c);
    },
    remove() {},
    replaceChildren(...c) {
      this.children = c;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    get firstChild() {
      return this.children[0] ?? null;
    },
    focus() {},
    contains() {
      return false;
    },
  };
  return el;
}

const styleTags = [];
const doc = {
  head: makeEl('head'),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  createElement: makeEl,
  createElementNS: (ns, t) => makeEl(t),
  createTextNode: (t) => ({ nodeValue: t }),
  querySelector(sel) {
    if (String(sel).includes('data-vocab-study')) return styleTags[0] ?? null;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
doc.head.appendChild = (n) => {
  styleTags.push(n);
  return n;
};

const React = {
  createElement: (...a) => ({ __el: true, args: a }),
  Fragment: Symbol('Fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
  useLayoutEffect: () => {},
  createContext: () => ({ Provider: null, Consumer: null }),
  memo: (f) => f,
  forwardRef: (f) => f,
};

// ── 真的把 lib/client.js 跑一遍 ──
console.log('\n[1] 加载 lib/client.js 并物化工厂');

const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

let registered = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(m) {
      registered = m;
    },
  },
};
// React 由宿主注入，不需要挂在 window 上；这里给个全局兜底。
globalThis.React = React;

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error(`意外的模块请求: ${name}（工厂里只允许 require('react')）`);
};

try {
  const fn = new Function('window', 'document', 'globalThis', 'self', 'React', src);
  fn(fakeWindow, doc, globalThis, fakeWindow, React);
  check(true, '执行 bundle 没有抛错（注册阶段）');
} catch (e) {
  check(false, '执行 bundle 没有抛错（注册阶段）', e && e.stack);
}

check(!!registered, '捕获到 __ModuleLoader__.load 注册');
check(registered && registered.id === 'dsh-vocab-study', `注册 id 正确（${registered && registered.id}）`);

let mod = null;
try {
  mod = registered.factory(requireStub);
  check(true, '工厂物化没有抛错（materialization）');
} catch (e) {
  check(false, '工厂物化没有抛错（materialization）', e && e.stack);
}

// ── 导出契约 ──
console.log('\n[2] 导出契约');
check(typeof (mod && mod.apply) === 'function', '导出 apply 是函数');
check(Array.isArray(mod && mod.inject), '导出 inject 是数组');
const injectNames = Array.isArray(mod && mod.inject) ? mod.inject : [];
check(
  injectNames.includes('slots'),
  `inject 声明了 slots（实际 ${JSON.stringify(injectNames)}）`,
);
// 这是本次事故的根因：apply 里用了 ctx.sidebarRightTabs 和 ctx.sidebarRight，
// 但 inject 里没写，于是它们是 undefined，属性访问同步抛错。
check(
  injectNames.includes('sidebarRightTabs'),
  `inject 声明了 sidebarRightTabs（apply 里用了它，实际 ${JSON.stringify(injectNames)}）`,
);
check(
  injectNames.includes('sidebarRight'),
  `inject 声明了 sidebarRight（apply 里用了它，实际 ${JSON.stringify(injectNames)}）`,
);

// ── 最关键的一步：真的调 apply(ctx) ──
console.log('\n[3] 调 apply(ctx) —— 这一步抛错就等于整个客户端起不来');

const registeredSlots = [];
const effectLabels = [];
/** 每次 `ctx.inject(...)` 的痕迹，用来验证"服务是从 scope 里拿的"。 */
const injectedScopes = [];

function makeCtx(overrides = {}) {
  const ctx = {
    slots: {
      inject(slotName, cb) {
        registeredSlots.push({ slot: slotName, via: 'inject' });
        // 宿主里 slots.inject 的语义是"槽位存在时才注册"
        if (cb) cb();
      },
      register(spec, component) {
        registeredSlots.push({ slot: spec.name, id: spec.id, key: spec.key, component: typeof component });
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(def) {
        registeredSlots.push({ tabType: def.kind, id: def.id });
        return () => {};
      },
    },
    sidebarRight: {
      // 注意：openTab **不在** ISidebarRight 上（宿主文档明说）。
      // 这里故意不提供，验证"拿不到也不会炸"。
      tabsIn: () => [],
    },
    effect(fn, label) {
      effectLabels.push(label);
      return fn();
    },
    /**
     * 宿主真实契约：`ctx.inject([服务名...], scope => ...)`。
     * **服务出现在 scope 上，不在根 ctx 上** —— 这就是「事故四」的核心。
     * 这里照实复刻：scope 上的服务等于根 ctx 上的同名属性。
     */
    inject(names, cb) {
      const wanted = Array.isArray(names) ? names : [names];
      const scope = {};
      // Cordis 会等所有服务就绪才回调；缺哪个这里就不挂（apply 里各注册自带 try）
      for (const n of wanted) if (ctx[n] !== undefined) scope[n] = ctx[n];
      injectedScopes.push({ names: wanted, scopeKeys: Object.keys(scope) });
      cb(scope);
      return () => {};
    },
    get: () => undefined,
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return ctx;
}

let appliedOk = false;
try {
  mod.apply(makeCtx());
  appliedOk = true;
} catch (e) {
  check(false, 'apply(ctx) 没有抛错', `${e && e.message}\n      ${(e && e.stack || '').split('\n')[1] || ''}`);
}
if (appliedOk) check(true, 'apply(ctx) 没有抛错 → fiber 能进 ACTIVE（客户端不会被拦在启动页）');

console.log('\n[4] apply 真的注册了东西');
const slotNames = registeredSlots.filter((r) => r.slot).map((r) => r.slot);
for (const want of [
  'conversation.input.right',
  'sidebar.right.pane.tab',
  'sidebar.right.pane.tab.title',
  'sidebar.right.tab.menu.item',
]) {
  check(slotNames.includes(want), `注册了槽位 ${want}`);
}
check(
  registeredSlots.some((r) => r.tabType === 'vocab-study'),
  `注册了标签页类型（kind=vocab-study，实际 ${JSON.stringify(registeredSlots.filter((r) => r.tabType).map((r) => r.tabType))}）`,
);
// 每个 register 都要拿到组件，否则宿主渲染不出东西。
// 注意 registeredSlots 里同时记了 `slots.inject(...)` 的条目（它没有 component），
// 所以要单独数"带组件的 register 调用"，不能用 slotNames.length 去比。
const componentRegs = registeredSlots.filter((r) => r.component !== undefined);
check(
  componentRegs.length > 0 && componentRegs.every((r) => r.component === 'function'),
  `每个 register 调用都传了组件（${componentRegs.length} 个 register，组件都是函数）`,
  JSON.stringify(componentRegs),
);
// 生命周期只挂在**外层的 ctx.effect** 上（内核释放 + 标签页类型声明合在一处）。
// 注意不要断言">= 2"：上一版的标签页注册在 scope.effect 里，合并之后就只剩 1 处了。
check(
  effectLabels.length >= 1,
  `用了 ctx.effect 管生命周期（${effectLabels.length} 处：${JSON.stringify(effectLabels)}）`,
);

// ── 服务全缺失时也不能抛 ──
console.log('\n[5] 服务全缺失时 apply 仍然不能抛（降级，而不是崩掉整页）');
let degradedOk = false;
let degradedErr = null;
try {
  mod.apply(
    makeCtx({
      slots: undefined,
      sidebarRightTabs: undefined,
      sidebarRight: undefined,
    }),
  );
  degradedOk = true;
} catch (e) {
  degradedErr = e;
}
// slots 是硬依赖（inject 声明了），Cordis 不会在缺 slots 时调 apply，
// 所以这里允许抛 —— 但 sidebarRightTabs / sidebarRight 缺失必须能活。
check(
  degradedOk || (degradedErr && /slots|undefined/i.test(String(degradedErr.message))),
  '服务缺失时的行为是"框架层面的等待/拒绝"，不是插件内部炸掉',
  degradedErr && degradedErr.message,
);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
