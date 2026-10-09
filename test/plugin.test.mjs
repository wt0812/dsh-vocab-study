// vocab-study / test / plugin.test.mjs
//
// 假宿主测试：不装 DSH 也能验证插件半的**契约**。
//
//   node test/plugin.test.mjs
//
// 它做三件事：
//   1. 造一个假的 window.__ModuleLoader__ 和最小 React，把 lib/client.js 加载起来；
//   2. 用假的 ctx.slots / ctx.sidebarRightTabs 调 apply()，检查**席位归属和顺序**；
//   3. 把注册进来的组件真的渲染一下，确认没有 import 错、没有当场抛错。
//
// 真正装进 DSH 的可见效果它证明不了（那要浏览器），但它能证明：
// 产物可加载、入口名对、两个席位都占了、order 落在 vision-router 右边、
// 组件能实例化。这几条出错时在浏览器里表现是「界面不出现」，很难查。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  if (ok) {
    pass++;
    console.log(`${GREEN}  ✓ ${label}${OFF}`);
  } else {
    fail++;
    console.log(`${RED}  ✗ ${label}${OFF}${detail ? `  ${DIM}(${detail})${OFF}` : ''}`);
  }
};

// ── 最小 DOM / React 替身 ─────────────────────────────────────
// 只实现适配层真正会用到的那几个 API。用到别的就会显式抛错，
// 反而能暴露「适配层偷偷依赖了没登记的 API」。

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.textContent = '';
    this.className = '';
    this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
    this.listeners = {};
    this.ownerDocument = null;
  }
  appendChild(c) {
    // 字符串自动变文本节点，和真 DOM 一致
    if (typeof c === 'string' || typeof c === 'number') {
      const t = new FakeNode('#text');
      t.nodeType = 3;
      t.textContent = String(c);
      t.ownerDocument = this.ownerDocument;
      this.children.push(t);
      t.parentNode = this;
      return t;
    }
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore(c) {
    this.children.unshift(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined || n === false || n === true) continue;
      if (Array.isArray(n)) this.append(...n);
      else this.appendChild(n);
    }
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get nextSibling() {
    return null;
  }
  contains() {
    return false;
  }
  getBoundingClientRect() {
    return { width: 600, height: 400, top: 0, left: 0 };
  }
  focus() {}
}

const fakeDocument = new FakeNode('document');
fakeDocument.head = fakeDocument.appendChild(new FakeNode('head'));
fakeDocument.documentElement = new FakeNode('html');
fakeDocument.body = fakeDocument.appendChild(new FakeNode('body'));
fakeDocument.createElement = (tag) => {
  const n = new FakeNode(tag);
  n.ownerDocument = fakeDocument;
  return n;
};
/** 文本节点也要有，否则 el() 造文案时会直接把字符串当元素 append。 */
fakeDocument.createTextNode = (text) => {
  const n = new FakeNode('#text');
  n.nodeType = 3;
  n.textContent = String(text);
  n.ownerDocument = fakeDocument;
  return n;
};
fakeDocument.getElementById = () => null;
/** 真的在树里找，别让「只注入一次」的断言以为自己过了。 */
const findAll = (root, pred, out = []) => {
  for (const c of root.children || []) {
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
};
fakeDocument.querySelector = (sel) => {
  const s = String(sel);
  if (s.includes('data-vocab-study')) {
    return findAll(fakeDocument.head, (n) => n.getAttribute('data-vocab-study') === '1')[0] || null;
  }
  return null;
};
fakeDocument.querySelectorAll = () => [];
fakeDocument.__findAll = findAll;

globalThis.document = fakeDocument;
globalThis.window = globalThis;
globalThis.HTMLElement = FakeNode;
globalThis.HTMLInputElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.Node = FakeNode;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();
globalThis.sessionStorage = globalThis.localStorage;
globalThis.speechSynthesis = undefined; // 没有朗读：应自动降级，不报错
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

/** 最小 React：够渲染我们的组件，不需要 diff。 */
const ReactFake = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') {
      // 函数组件：直接调用，把 props 给它
      return type({ ...(props || {}), children });
    }
    const node = new FakeNode(type === 'div' || type === 'span' || type === 'button' ? type : 'div');
    if (props && props.className) node.className = props.className;
    // ref 现在有两种形态：回调 ref（我们用的）和老式 { current } 对象
    if (props && typeof props.ref === 'function') props.ref(node);
    else if (props && props.ref && typeof props.ref === 'object') props.ref.current = node;
    node.append(...children);
    return node;
  },
  useRef(init) {
    return { current: init ?? null };
  },
  useCallback(fn) {
    // 没有依赖追踪，直接返回原函数：测试里只关心"能不能正常调用"
    return fn;
  },
  useEffect(fn) {
    // 同步执行一次，返回的清理函数丢掉（测试里不需要卸载时序）
    try {
      fn();
    } catch (err) {
      console.log(`${RED}    useEffect 抛错：${err.message}${OFF}`);
    }
  },
  useMemo(fn) {
    return fn();
  },
  useState(init) {
    return [init, () => {}];
  },
};

// ── 装一个假 ModuleLoader ────────────────────────────────────
let loaded = null;
const loaderCalls = [];
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    loaderCalls.push(spec);
    loaded = spec;
  },
};

const BUNDLE = path.join(ROOT, 'lib', 'client.js');

console.log('vocab-study · 插件半契约测试（假宿主）\n');

check(fs.existsSync(BUNDLE), 'lib/client.js 已构建', BUNDLE);
if (!fs.existsSync(BUNDLE)) {
  console.log(`\n${RED}先跑构建：python tools/build-plugin.py${OFF}`);
  process.exit(1);
}

console.log('\n[1] 加载产物');
const src = fs.readFileSync(BUNDLE, 'utf8');
// 产物是给浏览器/Electron 的脚本，直接在全局作用域里 eval
try {
  // eslint-disable-next-line no-new-func
  new Function('window', src)(globalThis.window);
  check(loaderCalls.length === 1, '__ModuleLoader__.load 被调用一次', `实际 ${loaderCalls.length} 次`);
} catch (err) {
  check(false, '产物可被加载执行', err.message);
  process.exit(1);
}

check(loaded && loaded.id === 'dsh-vocab-study', '注册 id 正确', loaded && loaded.id);
check(typeof loaded?.factory === 'function', '带 factory 函数');

console.log('\n[2] 调用 factory，取插件出口');
let plugin = null;
try {
  plugin = loaded.factory((spec) => {
    if (spec === 'react') return ReactFake;
    throw new Error(`未登记的依赖被 require 了：${spec}`);
  });
  check(true, 'factory 只用到了 react');
} catch (err) {
  check(false, 'factory 不应 require 别的模块', err.message);
}

check(plugin && typeof plugin.apply === 'function', '导出 apply(ctx)');
check(Array.isArray(plugin?.inject) && plugin.inject.includes('slots'), '导出 inject 含 slots', JSON.stringify(plugin?.inject));

console.log('\n[3] 用假 ctx 调 apply，检查席位');
const registrations = [];
const tabTypes = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    effects.push(label || '(unnamed)');
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  slots: {
    inject(owner, factory) {
      registrations.push({ owner, via: 'inject' });
      const out = factory();
      if (typeof out === 'function') registrations.push({ owner, dispose: out });
      return out;
    },
    register(spec, Comp) {
      registrations.push({ owner: spec.name, spec, Comp });
      return () => {};
    },
  },
  sidebarRightTabs: {
    register(def) {
      tabTypes.push(def);
      return () => {};
    },
  },
  sidebarRight: {
    openTab(kind) {
      openCalls.push(kind);
    },
    // 真实契约里"带 sessionId 打开"的那个入口。以前这里只放了 openTab，
    // 于是测试通过但线上点不动 —— 因为真实调用走的是 openTabIn。
    openTabIn(sessionId, kind) {
      openCalls.push(`${kind}@${sessionId}`);
    },
  },
  /**
   * 宿主真实契约：`ctx.inject([服务名...], scope => ...)`，**服务在 scope 上**。
   * 这里照实复刻，scope 上的服务直接等于根 ctx 上的同名属性。
   */
  inject(names, cb) {
    const wanted = Array.isArray(names) ? names : [names];
    const scope = {};
    for (const n of wanted) if (ctx[n] !== undefined) scope[n] = ctx[n];
    injectScopes.push({ names: wanted, scopeKeys: Object.keys(scope) });
    cb(scope);
    return () => {};
  },
};
const openCalls = [];
const injectScopes = [];

try {
  plugin.apply(ctx);
  check(true, 'apply(ctx) 不抛错');
} catch (err) {
  check(false, 'apply(ctx) 不抛错', `${err.message}\n${err.stack}`);
  process.exit(1);
}

const seats = registrations.filter((r) => r.spec);
const capsuleSeat = seats.find((r) => r.spec.name === 'conversation.input.right');
const paneSeat = seats.find((r) => r.spec.name === 'sidebar.right.pane.tab');
const titleSeat = seats.find((r) => r.spec.name === 'sidebar.right.pane.tab.title');
const menuSeat = seats.find((r) => r.spec.name === 'sidebar.right.tab.menu.item');

check(!!capsuleSeat, '占了 conversation.input.right（输入框右侧胶囊）');
check(!!paneSeat, '占了 sidebar.right.pane.tab（标签页正文）');
check(!!titleSeat, '占了 sidebar.right.pane.tab.title（标签页标题）');
check(!!menuSeat, '占了 sidebar.right.tab.menu.item（菜单入口）');
check(
  capsuleSeat && capsuleSeat.spec.order > 40,
  `胶囊 order=${capsuleSeat?.spec.order} 落在 vision-router(40) 右边`,
  capsuleSeat ? `order=${capsuleSeat.spec.order}` : 'missing',
);
check(
  capsuleSeat && typeof capsuleSeat.spec.id === 'string' && capsuleSeat.spec.id.length > 0,
  '胶囊用了自己的 id（不是顶替别人的格子）',
  capsuleSeat?.spec.id,
);
check(
  paneSeat && paneSeat.spec.key === titleSeat?.spec.key,
  '正文与标题用同一个 key（否则标签页只有标题没内容）',
  `${paneSeat?.spec.key} vs ${titleSeat?.spec.key}`,
);
check(tabTypes.length === 1 && tabTypes[0].kind === paneSeat?.spec.key, '标签页类型 kind 与正文 key 一致');
check(
  tabTypes[0] && tabTypes[0].id === tabTypes[0].kind,
  '标签页 id 与 kind 一致（文档要求 id 同时用作正文 key）',
  JSON.stringify(tabTypes[0]),
);
check(
  tabTypes[0] && !tabTypes[0].patterns,
  '没给 patterns：它是按 kind 打开的「页」，不是靠地址认领的资源',
);

console.log('\n[4] 真的把注册进来的组件渲染一次');
// ⚠️ 注意：道具里**故意不放 `ctx`**。宿主渲染器（ui-renderer 的 renderEntry）是这么调的：
//     jsx(Comp, { ...kit, ...injected, ...slotInjected.props, ...contextual, ...ownerProps })
// `ctx` 不在任何一项里 —— 组件 props 里从来没有 ctx。
// 上一版测试这里塞了 `ctx`，于是"组件拿不到能力"这个真 bug 被测试自己掩盖了。
const fakeProps = {
  sessionId: 'sess-1',
  toast: () => {},
  useResource: () => null,
  useSessions: () => null,
  inputActions: {},
};
for (const seat of [capsuleSeat, paneSeat, titleSeat, menuSeat]) {
  if (!seat) continue;
  try {
    const out = seat.Comp(fakeProps);
    check(!!out, `${seat.spec.name} 组件能实例化`);
  } catch (err) {
    check(false, `${seat.spec.name} 组件能实例化`, err.message);
    if (process.env.VS_DEBUG) console.log(`\n${DIM}${err.stack}${OFF}\n`);
  }
}

console.log('\n[4b] 真的点一次 —— 必须走到 openTabIn（不是"点了没反应"）');
// 这一段守的是本文件以前守不住的东西：注册成功、组件也不抛错，
// 但点下去什么都没发生。所以必须**照着宿主的方式把 inject 跑一遍**，
// 拿到真正会传给组件的 props，再真的触发一次点击。
check(injectScopes.length >= 1, `apply 用了 ctx.inject 拿服务（${injectScopes.length} 次）`);
check(
  injectScopes.some((s) => s.scopeKeys.includes('sidebarRight')),
  'sidebarRight 真的进了 scope（服务在 scope 上，不在根 ctx 上）',
  JSON.stringify(injectScopes.map((s) => s.scopeKeys)),
);
check(
  injectScopes.some((s) => s.scopeKeys.includes('slots') && s.scopeKeys.includes('sidebarRightTabs')),
  'slots 与 sidebarRightTabs 也进了 scope',
);

if (capsuleSeat && typeof capsuleSeat.spec.inject === 'function') {
  // 宿主 runInject: entry.inject(...args)，会话槽位第一个参数是 sessionId
  const injected = capsuleSeat.spec.inject('sess-42') || {};
  check(
    typeof injected.openTab === 'function',
    '胶囊拿到了 openTab 能力（注册时的 inject 返回值会变成组件 props）',
    JSON.stringify(Object.keys(injected)),
  );

  openCalls.length = 0;
  // 组件照宿主的调法渲染：props = {...kit, ...injected, ...ownerProps}
  const capsuleOut = capsuleSeat.Comp({ ...fakeProps, ...injected });
  check(!!capsuleOut, '带 inject 能力后胶囊组件仍能实例化');

  // 胶囊是傀儡画的，点击回调通过 createCapsulePuppet 传进去；
  // 直接调 inject 给出来的那个 openTab 等价于"用户点了胶囊"。
  let clickErr;
  try {
    injected.openTab();
  } catch (err) {
    clickErr = err;
  }
  check(!clickErr, '点一下胶囊不抛错', clickErr && clickErr.message);
  check(
    openCalls.some((c) => String(c).startsWith('vocab-study@')),
    `点胶囊真的调到了 openTabIn(sessionId, kind)（实际 ${JSON.stringify(openCalls)}）`,
    JSON.stringify(openCalls),
  );
} else {
  check(false, '胶囊槽位上有 inject（否则组件拿不到任何能力）');
}

console.log('\n[5] 样式注入');
check(
  fakeDocument.head.children.some((c) => c.tagName === 'STYLE' && c.getAttribute('data-vocab-study') === '1'),
  '样式被注入一次（<style data-vocab-study>）',
  `head 子节点数 ${fakeDocument.head.children.length}`,
);
try {
  plugin.apply(ctx);
  const styles = fakeDocument.head.children.filter((c) => c.getAttribute('data-vocab-study') === '1');
  check(styles.length === 1, '再次 apply 不会堆出第二份样式', `实际 ${styles.length} 份`);
} catch (err) {
  check(false, '重复 apply 不应抛错', err.message);
}

console.log('\n[6] 全局洁癖');
check(typeof globalThis.__vs_globalHack === 'undefined', '没有往 window 上乱挂东西');
check(
  Object.keys(globalThis).filter((k) => k.startsWith('__vs')).length === 0,
  '没有 __vs* 全局泄漏',
  Object.keys(globalThis).filter((k) => k.startsWith('__vs')).join(', '),
);

console.log('');
console.log('─'.repeat(56));
console.log(`${fail === 0 ? GREEN : RED}${pass} 通过 / ${fail} 失败${OFF}`);
console.log('─'.repeat(56));
process.exit(fail === 0 ? 0 : 1);
