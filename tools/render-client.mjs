// 真正渲染一遍面板，看渲染路径会不会抛错。
//
// 背景：产物"能装载、能 apply、四个槽位都注册上了"，但页面打开全黑。
// 剩下最像的解释是**渲染时抛错** —— React 会把那棵子树整片卸载，
// 而按钮在外壳的别的子树里，所以按钮还在、内容区全黑。
//
// 这个脚本用 vm 把产物跑起来，拿真 React 的 createElement 语义（简版），
// 然后调用导出的组件函数，看它抛不抛。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(process.argv[2] || '.');

function stubEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: { setProperty() {}, removeProperty() {}, cssText: '' },
    dataset: {},
    children: [],
    attributes: {},
    _text: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    removeChild() {},
    remove() {},
    setAttribute(k, v) {
      el.attributes[k] = v;
    },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore(c) {
      el.children.push(c);
      return c;
    },
    cloneNode: () => stubEl(tag),
    focus() {},
    blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    get firstChild() {
      return el.children[0] || null;
    },
    get lastChild() {
      return el.children[el.children.length - 1] || null;
    },
    get textContent() {
      return el._text;
    },
    set textContent(v) {
      el._text = String(v);
      el.children.length = 0;
    },
    get innerHTML() {
      return '';
    },
    set innerHTML(v) {},
  };
  return el;
}

const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
let captured = null;
const win = {
  __ModuleLoader__: {
    load(e) {
      captured = e;
    },
  },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' },
  navigator: { userAgent: 'node', language: 'zh-CN' },
  performance: { now: () => Date.now() },
};

const sandbox = { setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console };
Object.assign(sandbox, {
  window: win,
  self: win,
  document: {
    createElement: stubEl,
    createElementNS: (ns, tag) => stubEl(tag),
    createTextNode: () => stubEl('text'),
    createDocumentFragment: () => stubEl('fragment'),
    head: stubEl('head'),
    body: stubEl('body'),
    documentElement: stubEl('html'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    readyState: 'complete',
  },
  navigator: win.navigator,
  location: win.location,
  localStorage: win.localStorage,
  matchMedia: win.matchMedia,
  requestAnimationFrame: win.requestAnimationFrame,
  cancelAnimationFrame: win.cancelAnimationFrame,
  performance: win.performance,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
new vm.Script(src, { filename: 'client.js' }).runInContext(ctx, { timeout: 30000 });

// 记录 useState 的初值，这样我们能看出组件内部状态长什么样
const stateLog = [];
const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  Fragment: Symbol('Fragment'),
  useState: (v) => {
    stateLog.push(v);
    return [v, () => {}];
  },
  useEffect() {},
  useLayoutEffect() {},
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
  useCallback: (f) => f,
  memo: (f) => f,
  forwardRef: (f) => f,
  createContext: (v) => ({ Provider: 'P', Consumer: 'C', _v: v }),
  useContext: () => ({}),
  cloneElement: (x) => x,
};

const mod = captured.factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error('未预期的 require: ' + id);
});

console.log(`  exports: ${Object.keys(mod).join(', ')}`);

// 槽位注册时组件被记下来；我们把它们抓出来，直接当函数调用
const comps = [];
const fakeSlots = {
  register(meta, comp) {
    comps.push({ meta: meta || {}, comp });
    return () => {};
  },
  inject(key, cb) {
    cb();
    return () => {};
  },
};
const fakeScope = {
  slots: fakeSlots,
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTab: () => {}, tabDomain: { openTab: () => {} } },
};
const fakeCtx = {
  effect: (fn) => {
    const d = fn();
    return () => (typeof d === 'function' ? d() : undefined);
  },
  inject: (deps, cb) => {
    cb(fakeScope);
    return () => {};
  },
  slots: fakeSlots,
  get sidebarRightTabs() {
    return fakeScope.sidebarRightTabs;
  },
  get sidebarRight() {
    return fakeScope.sidebarRight;
  },
};
mod.apply(fakeCtx);

console.log(`  注册的组件 ${comps.length} 个：`);
for (const c of comps) {
  console.log(`    · ${c.meta.name}  comp=${typeof c.comp}${c.meta.key ? ' key=' + c.meta.key : ''}`);
}

// 逐个真的调用一遍（等价于 React 渲染它）
console.log('\n  ── 逐个渲染 ──');
let failed = 0;
for (const c of comps) {
  const label = `${c.meta.name}${c.meta.key ? '[' + c.meta.key + ']' : ''}`;
  if (typeof c.comp !== 'function') {
    console.log(`    ${label}: 不是函数（${typeof c.comp}），跳过`);
    continue;
  }
  try {
    const before = stateLog.length;
    const out = c.comp({ sessionId: 'sess-test', tabId: 'tab-test' });
    console.log(
      `    ✓ ${label}: 渲染通过（useState 调用 ${stateLog.length - before} 次）`,
    );
    // 看返回的树里有没有明显的空
    const dump = JSON.stringify(out, (k, v) => (typeof v === 'function' ? '[fn]' : v));
    console.log(`        树长度 ${dump.length}`);
  } catch (err) {
    failed++;
    console.log(`    ✗ ${label}: ${err.constructor.name}: ${err.message}`);
    console.log(
      (err.stack || '')
        .split('\n')
        .slice(1, 8)
        .map((l) => '        ' + l.trim())
        .join('\n'),
    );
  }
}
console.log(failed ? `\n  有 ${failed} 个组件渲染抛错` : '\n  全部组件渲染通过');
process.exitCode = failed ? 1 : 0;
