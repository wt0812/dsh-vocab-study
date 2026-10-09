// 用 Node 的 vm 把 lib/client.js 当**整个脚本**跑一遍。
//
// 这是比"手工配对括号"硬得多的判据：只要文件被截断、有语法错误，
// 或者工厂体里有引用不到的东西，这里就会抛出带行号的真实错误。
//
// 做法：
//   1. 建隔离上下文，放 window.__ModuleLoader__ 捕获桩
//   2. 把整份产物当脚本执行（= 浏览器 <script> 注入它的那一刻）
//   3. 拿到 factory，用桩 require 调它（= 宿主第一次 import 这个模块）
//   4. 再用桩 ctx 调 apply()（= 宿主激活插件）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.argv[2] || '.');
const DEPLOY =
  'C:\\Users\\21653\\.dsh\\profiles\\desktop\\node_modules\\dsh-vocab-study\\lib\\client.js';

// 模式：直接跑（默认），或把自己再 spawn 一次以便隔离
if (process.argv[3] === '--child') {
  run(process.argv[4], process.argv[5]);
} else {
  for (const [label, file] of [
    ['仓库 lib/client.js', path.join(ROOT, 'lib', 'client.js')],
    ['部署 lib/client.js', DEPLOY],
  ]) {
    if (!fs.existsSync(file)) {
      console.log(`\n═══ ${label}\n  （不存在，跳过）`);
      continue;
    }
    const r = spawnSync(process.execPath, [process.argv[1], ROOT, '--child', label, file], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) process.exitCode = 1;
  }
}

function stubEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: { setProperty() {}, removeProperty() {}, cssText: '' },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    attributes: {},
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore() {},
    cloneNode: () => stubEl(tag),
    focus() {},
    blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    textContent: '',
    innerHTML: '',
    get firstChild() {
      return null;
    },
    get lastChild() {
      return null;
    },
  };
}

function run(label, file) {
  console.log(`\n═══ ${label}`);
  const src = fs.readFileSync(file, 'utf8');
  console.log(`  ${src.length} 字符, ${src.split('\n').length} 行`);

  let captured = null;
  const win = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry;
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

  const sandbox = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
  };
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
    performance: win.performance,
  });
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  try {
    new vm.Script(src, { filename: label }).runInContext(ctx, { timeout: 30000 });
  } catch (err) {
    console.log('  ✗ 脚本执行抛错: ' + err.constructor.name + ': ' + err.message);
    console.log(
      (err.stack || '')
        .split('\n')
        .slice(0, 10)
        .map((l) => '      ' + l)
        .join('\n'),
    );
    process.exit(1);
  }
  if (!captured) {
    console.log('  ✗ 脚本跑完了却没调用 __ModuleLoader__.load');
    process.exit(1);
  }
  console.log(`  ✓ 脚本执行通过，注册 id = ${captured.id}`);

  const fakeReact = {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
    Fragment: Symbol('Fragment'),
    useState: (v) => [v, () => {}],
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
  const requireStub = (id) => {
    if (id === 'react') return fakeReact;
    throw new Error('未预期的 require: ' + id);
  };

  let mod;
  try {
    mod = captured.factory(requireStub);
  } catch (err) {
    console.log('  ✗ factory 求值抛错: ' + err.constructor.name + ': ' + err.message);
    console.log(
      (err.stack || '')
        .split('\n')
        .slice(0, 12)
        .map((l) => '      ' + l)
        .join('\n'),
    );
    process.exit(1);
  }
  console.log('  ✓ factory 求值通过');
  console.log(`    exports.apply  = ${typeof mod.apply}`);
  console.log(`    exports.inject = ${JSON.stringify(mod.inject)}`);

  if (typeof mod.apply !== 'function') return;
  const registered = [];
  const fakeSlots = {
    register(meta) {
      registered.push(meta && (meta.name || meta.key) ? meta.name || meta.key : '?');
      return () => {};
    },
    inject(key, cb) {
      registered.push('inject:' + key);
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
  try {
    mod.apply(fakeCtx);
    console.log('  ✓ apply() 通过');
    console.log(`    注册内容: ${JSON.stringify(registered)}`);
  } catch (err) {
    console.log('  ✗ apply() 抛错: ' + err.constructor.name + ': ' + err.message);
    console.log(
      (err.stack || '')
        .split('\n')
        .slice(0, 12)
        .map((l) => '      ' + l)
        .join('\n'),
    );
    process.exit(1);
  }
}
