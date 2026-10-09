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
  // ⚠️ 这里原来是 `useEffect() {}` —— **空的**。
  //
  // 后果非常严重，必须记下来：插件真正的挂载逻辑全在 useEffect 里
  // （adapter/dsh/client.js 的 usePuppet：`React.useEffect(() => {
  // puppetRef.current = createRef.current(hostEl) })`）。effect 不跑，
  // 面板根本不会被创建 —— 于是这个脚本永远报"渲染通过"，
  // 而真机上用户看到的是一片黑。
  //
  // 2026-10-09 我就是拿它当"插件没崩"的证据，一口咬定不是自己的问题，
  // 结果查了一整晚。**用有缺陷的测试台去证明自己清白，结论必然是错的。**
  //
  // 现在真的把 effect 执行掉。副作用是：puppet 会真的去挂 DOM，
  // 而这里的 document 是手写桩 —— 所以它报出的错要区分
  // 「真 bug」和「桩不够用」，不能一律当失败看。
  useEffect: (fn, deps) => {
    effects.push({ fn, deps });
  },
  useLayoutEffect: (fn, deps) => {
    effects.push({ fn, deps });
  },
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
  useCallback: (f) => f,
  memo: (f) => f,
  forwardRef: (f) => f,
  createContext: (v) => ({ Provider: 'P', Consumer: 'C', _v: v }),
  useContext: () => ({}),
  cloneElement: (x) => x,
};
const effects = [];

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
let stubOnly = 0;
/**
 * 区分「真 bug」和「手写 DOM 桩不够用」。
 *
 * 这个区分是被迫学会的：stubEl 没实现 `append`（只有 appendChild），
 * 于是每个 puppet 都会抛 "root.append is not a function" —— 而真浏览器
 * 里这行完全正常（tools/_vs-harness 那套真 DOM 台子实测 errors=0）。
 *
 * 但**不能**因此把 effect 的报错一律忽略：Q.shouldBlockNew 那次就是
 * 在 effect 里炸的，忽略它等于把这个台子重新变成摆设。
 * 所以只把"明显是桩缺方法"的那几种放行，其余照旧算失败。
 */
const STUB_ONLY = [
  /\.append is not a function/,
  /\.prepend is not a function/,
  /\.remove is not a function/,
  /\.closest is not a function/,
  /\.matches is not a function/,
  /getBoundingClientRect is not a function/,
  /matchMedia is not a function/,
  /ResizeObserver is not defined/,
];
const isStubOnly = (err) => STUB_ONLY.some((re) => re.test(err.message || ''));
for (const c of comps) {
  const label = `${c.meta.name}${c.meta.key ? '[' + c.meta.key + ']' : ''}`;
  if (typeof c.comp !== 'function') {
    console.log(`    ${label}: 不是函数（${typeof c.comp}），跳过`);
    continue;
  }
  try {
    const before = stateLog.length;
    effects.length = 0;
    const out = c.comp({ sessionId: 'sess-test', tabId: 'tab-test' });
    console.log(
      `    ✓ ${label}: 渲染通过（useState 调用 ${stateLog.length - before} 次）`,
    );
    // 看返回的树里有没有明显的空
    const dump = JSON.stringify(out, (k, v) => (typeof v === 'function' ? '[fn]' : v));
    console.log(`        树长度 ${dump.length}`);

    // ── 现在真的把 effect 跑掉（这一段是这次修的）──
    // 挂载逻辑全在这里；不跑它，"渲染通过"只是空话。
    for (let i = 0; i < effects.length; i++) {
      try {
        effects[i].fn();
        console.log(`        effect#${i} 执行通过`);
      } catch (err) {
        if (isStubOnly(err)) {
          stubOnly++;
          console.log(`        ○ effect#${i} 撞上手写 DOM 桩的缺口（非产品问题）: ${err.message}`);
          continue;
        }
        failed++;
        console.log(`        ✗ effect#${i} 抛错: ${err.constructor.name}: ${err.message}`);
        console.log(
          (err.stack || '')
            .split('\n')
            .slice(1, 6)
            .map((l) => '            ' + l.trim())
            .join('\n'),
        );
      }
    }
    if (!effects.length) console.log('        （没有 effect —— 挂载逻辑没被执行，这个结论不算数）');
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
console.log(
  failed
    ? `\n  有 ${failed} 处真报错（渲染或 effect）`
    : '\n  渲染 + effect 全部通过',
);
if (stubOnly) {
  console.log(`  （另有 ${stubOnly} 处是手写 DOM 桩缺方法，不是产品问题；真 DOM 验证见 tools/ 的浏览器台子）`);
}
process.exitCode = failed ? 1 : 0;
