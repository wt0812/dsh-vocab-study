// 客户端插件总审计：把 profile 里**每一个**客户端插件都在隔离环境里跑一遍。
//
// 为什么要做这个：页面内容区全黑，但我的插件自证是好的（能装载、能 apply、
// 组件能渲染、线上槽位 active: true）。那嫌疑就在"别人身上"。
// 与其一个个试，不如把全部插件一次性过一遍，找出那个装载/apply 就抛错的。
//
// 检查项（每项都对应一个会让"整页打不开"的失效模式）：
//   1. package.json 是否有 exports["./client"]、dsh.client.platform === "web"
//   2. client.js 能不能当脚本执行（语法/截断）
//   3. 是否调用了 window.__ModuleLoader__.load({ id, factory })
//   4. factory 能不能求值（顶层抛错）
//   5. exports 里有没有 apply / inject
//   6. 用桩 ctx 调 apply() 会不会同步抛错
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const DEPLOY_ROOT = 'C:\\Users\\21653\\.dsh\\profiles\\desktop\\node_modules';

// 记录"拿不到的真依赖"。声明必须在所有函数之前：ESM 里 const 也是 TDZ，
// 放在文件后面的话，函数先被调用就会炸（这一版我连炸了三次）。
var _missing = new Set();

if (process.argv[2] === '--child') {
  auditOne(process.argv[3], process.argv[4]);
} else {
  const only = process.argv[2];
  const entries = fs.readdirSync(DEPLOY_ROOT, { withFileTypes: true });
  const pkgs = [];
  for (const e of entries) {
    if (e.name.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(DEPLOY_ROOT, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) pkgs.push(path.join(DEPLOY_ROOT, e.name, s.name));
      }
    } else if (e.isDirectory()) {
      pkgs.push(path.join(DEPLOY_ROOT, e.name));
    }
  }

  const clientPkgs = [];
  for (const dir of pkgs) {
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    } catch {
      continue;
    }
    const clientExport = meta.exports && meta.exports['./client'];
    if (!clientExport) continue;
    const clientRel =
      typeof clientExport === 'string'
        ? clientExport
        : clientExport.default || clientExport.import || clientExport.require;
    let clientFile = clientRel ? path.join(dir, clientRel) : path.join(dir, 'lib', 'client.js');
    if (!fs.existsSync(clientFile)) {
      const alt = path.join(dir, 'lib', 'client.js');
      if (fs.existsSync(alt)) clientFile = alt;
      else continue;
    }
    clientPkgs.push({
      name: meta.name,
      version: meta.version,
      platform: meta.dsh && meta.dsh.client && meta.dsh.client.platform,
      file: clientFile,
    });
  }

  console.log(`找到 ${clientPkgs.length} 个客户端插件（有 exports["./client"]）\n`);
  const bad = [];
  for (const p of clientPkgs) {
    if (only && !p.name.includes(only)) continue;
    const r = spawnSync(process.execPath, [process.argv[1], '--child', p.name, p.file], {
      encoding: 'utf8',
      timeout: 60000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0 && !/\u2717/.test(out);
    if (!ok) bad.push({ p, out });
    const mark = ok ? '  OK ' : ' FAIL';
    console.log(
      `${mark} ${String(p.name).padEnd(48)} ${String(p.version || '').padEnd(10)} platform=${p.platform || '-'}`,
    );
  }

  console.log(`\n═══ 有问题的插件 ${bad.length} 个 ═══`);
  for (const b of bad) {
    console.log(`\n── ${b.p.name}`);
    console.log(
      b.out
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 20)
        .map((l) => '   ' + l)
        .join('\n'),
    );
  }
  process.exitCode = bad.length ? 1 : 0;
}

// 按 id 精确解析"真依赖"。
//
// 第一轮审计把 8 个插件全判 FAIL，其实**全是桩的局限**：
// 它们要 react/jsx-runtime、@deepseek-ai/dsh-client-ui-primitives 这些真包，
// 我的假 require 一律抛"未预期的 require"。假 FAIL 比没有审计更坏 ——
// 它会让人以为"找到了元凶"。所以这里老老实实去磁盘上找真包。
//
// 注意用函数返回路径，不要用顶层 const：`makeRequire` 可能被更早调用，
// const 会有 TDZ（第一版就栽在这）。
function builtinDepsDir() {
  return path.join('F:', 'harness', 'resources', 'app.asar', 'dsh', 'node_modules');
}

function makeRequire(pluginName, id) {
  // react 用我们自己的假实现就够了（组件不会真被 React 调用）
  if (id === 'react') return fakeReactForModule();
  if (id === 'react-dom') return { createPortal: (x) => x, render: () => {}, unmountComponentAtNode: () => {} };
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') {
    const h = (type, props, key) => ({ type, props: { ...(props || {}), key }, kids: props && props.children ? [props.children] : [] });
    return { jsx: h, jsxs: h, jsxDEV: h, Fragment: 'Fragment' };
  }

  const bases = [DEPLOY_ROOT, builtinDepsDir(), path.join(DEPLOY_ROOT, pluginName, 'node_modules')];
  for (const base of bases) {
    const dir = path.join(base, id);
    try {
      const pj = path.join(dir, 'package.json');
      if (fs.existsSync(pj)) {
        const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
        const rel =
          (meta.exports && (typeof meta.exports === 'string' ? meta.exports : meta.exports.default)) ||
          meta.module ||
          meta.main ||
          'index.js';
        const entry = path.isAbsolute(rel) ? rel : path.join(dir, rel);
        if (fs.existsSync(entry)) {
          if (!/\.(mjs|js|cjs)$/.test(entry)) return { __id: id };
          const text = fs.readFileSync(entry, 'utf8');
          if (/^\s*(import|export)\s/m.test(text)) return { __id: id };
          const sandbox = { module: { exports: {} }, exports: {}, require: (x) => makeRequire(pluginName, x), console };
          sandbox.exports = sandbox.module.exports;
          vm.createContext(sandbox);
          vm.runInContext(text, sandbox, { filename: id });
          return sandbox.module.exports;
        }
      }
      const f = path.join(base, id + '.js');
      if (fs.existsSync(f)) {
        const text = fs.readFileSync(f, 'utf8');
        if (/^\s*(import|export)\s/m.test(text)) return { __id: id };
        const sandbox = { module: { exports: {} }, exports: {}, require: (x) => makeRequire(pluginName, x), console };
        sandbox.exports = sandbox.module.exports;
        vm.createContext(sandbox);
        vm.runInContext(text, sandbox, { filename: id });
        return sandbox.module.exports;
      }
    } catch {
      /* 换下一个 base */
    }
  }
  // 找不到就返回宽松代理：审计的目的是找"装载/apply 阶段的硬故障"，
  // 不该因为一个拿不到的依赖就误报。缺依赖这件事本身我会单独列出来。
  return missingDep(id);
}

function missingDep(id) {
  _missing.add(id);
  const f = () => missingDep(id);
  return new Proxy(f, {
    get(_, p) {
      if (p === 'then') return undefined;
      if (p === '__esModule') return true;
      return missingDep(id + '.' + String(p));
    },
    apply: () => missingDep(id + '()'),
    construct: () => missingDep(id + '.new'),
  });
}

var _fakeReact = null;
function fakeReactForModule() {
  if (_fakeReact) return _fakeReact;
  _fakeReact = new Proxy(
    {},
    {
      get(_, prop) {
        const p = String(prop);
        if (p === 'createElement') return (type, props, ...kids) => ({ type, props: props || {}, kids });
        if (p === 'Fragment') return Symbol('Fragment');
        if (p === 'useState') return (v) => [typeof v === 'function' ? v() : v, () => {}];
        if (p === 'useRef') return (v) => ({ current: v });
        if (p === 'useMemo' || p === 'useCallback') return (fn) => (typeof fn === 'function' ? fn() : fn);
        if (p === 'createContext') return (v) => ({ Provider: 'P', Consumer: 'C', _v: v });
        if (p === 'useContext') return () => ({});
        if (p === 'forwardRef' || p === 'memo') return (fn) => fn;
        if (p === '__esModule') return true;
        if (p === 'then') return undefined;
        return () => ({});
      },
    },
  );
  return _fakeReact;
}

function stubEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: { setProperty() {}, removeProperty() {}, cssText: '' },
    dataset: {},
    children: [],
    attributes: {},
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
    textContent: '',
    innerHTML: '',
    get firstChild() {
      return el.children[0] || null;
    },
    get lastChild() {
      return el.children[el.children.length - 1] || null;
    },
  };
  return el;
}

function auditOne(name, file) {
  const src = fs.readFileSync(file, 'utf8');
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
  const sandbox = { setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console, URL, URLSearchParams, TextEncoder, TextDecoder };
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
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  sandbox.globalThis = sandbox;
  const vmCtx = vm.createContext(sandbox);

  try {
    new vm.Script(src, { filename: name }).runInContext(vmCtx, { timeout: 30000 });
  } catch (err) {
    console.log(`✗ 脚本执行抛错: ${err.constructor.name}: ${err.message}`);
    console.log((err.stack || '').split('\n').slice(0, 6).map((l) => '  ' + l).join('\n'));
    process.exit(1);
  }
  if (!captured) {
    console.log('✗ 脚本跑完但没有调用 __ModuleLoader__.load —— 包装层不对');
    process.exit(1);
  }
  console.log(`  注册 id = ${captured.id}`);

  const fakeReact = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === 'createElement') return (type, props, ...kids) => ({ type, props: props || {}, kids });
        if (prop === 'Fragment') return Symbol('Fragment');
        if (prop === 'useState') return (v) => [v, () => {}];
        if (prop === 'useRef') return (v) => ({ current: v });
        if (prop === 'useMemo' || prop === 'useCallback') return (f) => (typeof f === 'function' ? f() : f);
        if (prop === 'createContext') return (v) => ({ Provider: 'P', Consumer: 'C', _v: v });
        if (prop === 'useContext') return () => ({});
        if (prop === 'forwardRef' || prop === 'memo') return (f) => f;
        return () => ({});
      },
    },
  );

  let mod;
  try {
    mod = captured.factory((id) => makeRequire(name, id));
  } catch (err) {
    console.log(`✗ factory 求值抛错: ${err.constructor.name}: ${err.message}`);
    console.log((err.stack || '').split('\n').slice(0, 8).map((l) => '  ' + l).join('\n'));
    process.exit(1);
  }
  console.log(`  exports = [${Object.keys(mod).join(', ')}]`);

  if (typeof mod.apply !== 'function') {
    console.log('  （没有 apply，跳过激活检查）');
    return;
  }

  // 桩 ctx：宽一点，避免因为桩太窄造成假阳性
  const noopDisposer = () => {};
  const makeSlots = () => ({
    register: () => noopDisposer,
    registerFactory: () => noopDisposer,
    inject: (k, cb) => {
      if (typeof cb === 'function') cb();
      return noopDisposer;
    },
  });
  const slots = makeSlots();
  const genericService = new Proxy(
    {},
    {
      get: () => {
        const f = () => noopDisposer;
        return new Proxy(f, {
          get: (_, p) => {
            if (p === 'then') return undefined;
            return () => noopDisposer;
          },
          apply: () => noopDisposer,
        });
      },
    },
  );
  const effector = (fn) => {
    const d = typeof fn === 'function' ? fn() : undefined;
    return () => (typeof d === 'function' ? d() : undefined);
  };
  const ctx = {
    effect: effector,
    on: noopDisposer,
    inject: (deps, cb) => {
      if (typeof cb === 'function') cb(makeScope());
      return noopDisposer;
    },
    get: () => genericService,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    reflect: { provide: noopDisposer, get: () => genericService },
  };
  function makeScope() {
    return new Proxy(ctx, {
      get(t, p) {
        if (p === 'slots') return slots;
        if (p in t) return t[p];
        return genericService;
      },
    });
  }
  try {
    mod.apply(ctx);
    console.log('  ✓ apply() 通过');
  } catch (err) {
    console.log(`✗ apply() 抛错: ${err.constructor.name}: ${err.message}`);
    console.log((err.stack || '').split('\n').slice(0, 10).map((l) => '  ' + l).join('\n'));
    process.exit(1);
  }
}
