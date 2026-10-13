// vocab-study / test / demo-boot.test.mjs
//
// 演示产物的**启动回归**：用一套最小 DOM 把 demo/app.js 真的跑一遍。
//
//   node test/demo-boot.test.mjs
//
// 为什么需要它：demo 是自包含 HTML，浏览器里一旦启动抛错就是一片黑，
// 没有控制台可看；而我关心的恰恰是「外壳有没有建起来」。
// 这一轮排查里，「UI 那一块 IIFE 抛错 → 后面 UI_SHELL 根本没被赋值 →
// 外壳 11 项全 FAIL」这种链条，在浏览器里只能靠猜，在这里一行就定位了。
//
// 它不替代浏览器验证（真样式、真布局、真事件都不在范围内），
// 它只保证：产物可加载、六个 UI 命名空间都建起来了、外壳真的渲染出节点、
// core 自检 0 失败。

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

// ── 极小 HTML 解析器（给 innerHTML 用）──────────────────────
// demo 外壳是用 `shell.innerHTML = '<div class="dsh-demo">…'` 建的。
// 假 DOM 如果只有个空 setter，外壳看起来「没有子节点」，
// 于是所有深层选择器都失败 —— 排查时会误判成产物有问题。
// 这里解析的是受控子集（自己写的模板），不追求 HTML 规范全兼容。
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source']);

/** id → 元素。由 doc.getElementById 与解析器共用，必须在使用前声明。 */
const byId = {};

function parseHtml(html, doc) {
  const nodes = [];
  const stack = [{ children: nodes }];
  const top = () => stack[stack.length - 1];
  const push = (n) => {
    top().children.push(n);
    n.parentNode = top();
  };
  let i = 0;
  const TAG = /^<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      const text = html.slice(i);
      if (text.trim()) push(doc.createTextNode(text));
      break;
    }
    if (lt > i) {
      const text = html.slice(i, lt);
      if (text.trim()) push(doc.createTextNode(text));
    }
    const rest = html.slice(lt);
    if (rest.startsWith('<!--')) {
      const end = html.indexOf('-->', lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const m = rest.match(TAG);
    if (!m) {
      i = lt + 1; // 不是标签，当普通文本跳过 '<'
      continue;
    }
    const [, closing, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      // 找到最近的开标签弹出去
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tagName === tag.toUpperCase()) {
          stack.length = k;
          break;
        }
      }
    } else {
      const el = doc.createElement(tag);
      const ATTR = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let a;
      while ((a = ATTR.exec(rawAttrs || ''))) {
        el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '');
      }
      if (a && el.attrs.id) byId[el.attrs.id] = el; // 让 getElementById 认得外壳内部的元素
      push(el);
      if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
    }
    i = lt + m[0].length;
  }
  return nodes;
}

// ── 最小 DOM（够 demo 外壳与面板跑起来，不追求完整）──────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = { cssText: '' };
    this.attrs = {};
    this._text = '';
    this.id = '';
    this.listeners = {};
    // class 的唯一真源是 attrs.class；className / classList 都是它的视图（见下方访问器）
    this._cls = new Set();
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text || this.children.map((c) => c.textContent || '').join('');
  }
  /**
   * select 的 value。
   *
   * 真 DOM 里 `<select value=...>` 是反映属性，`select.value` 读的是「当前选中的
   * option」。这个模拟原本没有它，于是设置页那个「出场顺序」开关在测试里读出来是
   * undefined —— 看起来像插件坏了，其实是测试环境缺功能。
   * 这里按真 DOM 的语义补上：读 → 选中项的 value（没有就退回 value 属性）；写 → value 属性。
   */
  get value() {
    if (this.tagName === 'SELECT') {
      const opts = this.querySelectorAll('option');
      const sel = opts.find((o) => o.attrs.selected !== undefined);
      if (sel) return sel.attrs.value;
    }
    return this.attrs.value;
  }
  set value(v) {
    this.attrs.value = String(v);
    if (this.tagName === 'SELECT') {
      for (const o of this.querySelectorAll('option')) {
        if (String(o.attrs.value) === String(v)) o.attrs.selected = '';
        else delete o.attrs.selected;
      }
    }
  }
  appendChild(c) {
    if (typeof c === 'string' || typeof c === 'number') {
      const t = new El('#text');
      t._text = String(c);
      t.parentNode = this;
      this.children.push(t);
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
  /** ParentNode.append()：真 DOM 有，UI 代码用它。 */
  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined || typeof n === 'boolean') continue;
      if (Array.isArray(n)) this.append(...n);
      else if (typeof n === 'string' || typeof n === 'number') this.appendChild(doc.createTextNode(n));
      else this.appendChild(n);
    }
  }
  prepend(...nodes) {
    for (const n of nodes.reverse()) {
      if (n === null || n === undefined || typeof n === 'boolean') continue;
      this.children.unshift(typeof n === 'string' ? doc.createTextNode(n) : n);
    }
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  before() {}
  after() {}
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  /** 深度优先找元素。支持后代选择器（".a .b"）与 #id / .class / [attr] / tag。
   *
   * 之前这里的递归是错的：匹配到选择器第 0 段之后，又拿第 0 段去匹配它的子节点，
   * 于是 ".dsh-demo .vs-capsule" 这类多段选择器永远返回空 —— 排查时会被误读成
   * 「产物里没有胶囊」，白白绕路。 */
  _find(sel, out = []) {
    const parts = String(sel).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return out;
    const matchOne = (node, part) => {
      if (part === '*') return true;
      if (part.startsWith('#')) return node.id === part.slice(1);
      if (part.startsWith('.')) {
        const want = part.slice(1);
        if (String(node.className || '').split(/\s+/).indexOf(want) >= 0) return true;
        if (node.classList && node.classList._s.has(want)) return true;
        const attr = String(node.attrs.class || '').split(/\s+/);
        return attr.indexOf(want) >= 0;
      }
      const mAttr = part.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
      if (mAttr) {
        const v = node.attrs[mAttr[1]];
        return mAttr[2] === undefined ? v !== undefined : String(v) === mAttr[2];
      }
      return node.tagName === part.toUpperCase();
    };
    // idx 段匹配成功后，在它的子树里找 idx+1 段
    const walk = (node, idx) => {
      for (const c of node.children || []) {
        if (!c.tagName) continue;
        if (matchOne(c, parts[idx])) {
          if (idx === parts.length - 1) out.push(c);
          else walk(c, idx + 1);
        }
        walk(c, idx); // c 没匹配上时，后代仍可能匹配当前这一段
      }
    };
    walk(this, 0);
    return out;
  }
  querySelector(sel) {
    return this._find(sel)[0] || null;
  }
  querySelectorAll(sel) {
    return this._find(sel);
  }
  closest() {
    return null;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }
  get nextSibling() {
    return null;
  }
  contains() {
    return false;
  }
  getBoundingClientRect() {
    return { width: 900, height: 700, top: 0, left: 0 };
  }
  focus() {}
  setAttribute(k, v) {
    if (k === 'class') {
      this.className = v;
      return;
    }
    this.attrs[k] = v;
    if (k === 'id') this.id = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  removeEventListener() {}
  dispatchEvent(ev) {
    for (const f of this.listeners[ev.type] || []) f(ev);
    return true;
  }
  set innerHTML(v) {
    this.children = [];
    for (const n of parseHtml(String(v), this.ownerDocument || doc)) {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  get innerHTML() {
    return '';
  }

  // className / classList / attrs.class 三者同步。
  // 真 DOM 里 `el.className = 'x'` 与 `setAttribute('class','x')` 是同一件事，
  // 而 demo 的 el() 用前者、外壳模板走后者。假 DOM 只维护一份的话，
  // 按 class 的选择器就会一半能找一半找不到 —— 排查时极易误判成产物有问题。
  set className(v) {
    this.attrs.class = String(v);
    this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return this.attrs.class || '';
  }
  get classList() {
    if (this._classList) return this._classList;
    const self = this;
    const sync = () => {
      self.attrs.class = [...self._cls].join(' ');
    };
    this._classList = {
      add: (...c) => {
        c.forEach((x) => self._cls.add(x));
        sync();
      },
      remove: (...c) => {
        c.forEach((x) => self._cls.delete(x));
        sync();
      },
      contains: (c) => self._cls.has(c),
      toggle: (c, on) => {
        if (on === false) self._cls.delete(c);
        else self._cls.add(c);
        sync();
        return self._cls.has(c);
      },
      _s: this._cls,
    };
    return this._classList;
  }
}

const doc = new El('document');
doc.head = doc.appendChild(new El('head'));
doc.documentElement = new El('html');
doc.body = doc.appendChild(new El('body'));
doc.createElement = (t) => {
  const n = new El(t);
  n.ownerDocument = doc;
  return n;
};
doc.createTextNode = (t) => {
  const n = new El('#text');
  n._text = String(t);
  return n;
};
const rootEl = doc.createElement('div');
rootEl.setAttribute('id', 'dsh-root');
doc.body.appendChild(rootEl);
byId['dsh-root'] = rootEl;
doc.getElementById = (id) => byId[id] || null;

globalThis.document = doc;
globalThis.window = globalThis;
globalThis.HTMLElement = El;
class Input extends El {}
globalThis.HTMLInputElement = Input;
globalThis.HTMLTextAreaElement = Input;
globalThis.HTMLSelectElement = Input;
globalThis.Node = El;
globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
globalThis.cancelAnimationFrame = (i) => clearTimeout(i);
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.KeyboardEvent = class {
  constructor(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  }
};
globalThis.speechSynthesis = undefined;

console.log('vocab-study · 演示产物启动回归（最小 DOM）\n');

const BUNDLE = path.join(ROOT, 'demo', 'app.js');
check(fs.existsSync(BUNDLE), 'demo/app.js 已构建');
if (!fs.existsSync(BUNDLE)) process.exit(1);

const src = fs.readFileSync(BUNDLE, 'utf8');

// 产物的顶层是 `const VOCAB_CORE = ...`，它在 new Function 的局部作用域里，
// 不会挂到 globalThis。所以给产物一个 window 门面：写进去的东西从门面读，
// 其余全局读走原型链回到 globalThis。
const winFacade = Object.create(globalThis);

console.log('\n[1] 加载产物');
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(winFacade, doc);
  check(true, '产物可加载执行（没有顶层抛错）');
} catch (err) {
  check(false, '产物可加载执行', err.message);
  process.exit(1);
}

const core = winFacade.VOCAB_CORE || globalThis.VOCAB_CORE;
check(!!core, 'VOCAB_CORE 已建立');
const keys = core ? Object.keys(core) : [];
const expectNs = ['UI_CORE_REF', 'UI_DOM', 'UI_PAGES', 'UI_PANEL', 'UI_CAPSULE', 'UI_SHELL'];
const missing = expectNs.filter((k) => !core || !core[k]);
check(
  missing.length === 0,
  `六个 UI 命名空间都建起来了（${keys.length} 个键）`,
  missing.length ? `缺少 ${missing.join(', ')} —— 说明某个 IIFE 构造时抛错了` : '',
);

console.log('\n[2] 界面层能拿到 core 命名空间');
let got = null;
try {
  got = core.UI_CORE_REF.getCore();
} catch (err) {
  check(false, 'getCore() 可调用', err.message);
}
check(!!got && typeof got.queue?.dayKey === 'function', 'getCore().queue.dayKey 可见');
check(!!got && typeof got.memory?.newMemory === 'function', 'getCore().memory.newMemory 可见');

console.log('\n[3] 外壳真的渲染出节点');
const boot = core?.UI_SHELL?.boot;
check(typeof boot === 'function', 'UI_SHELL.boot 存在');
if (typeof boot === 'function') {
  try {
    const bootResult = await boot(rootEl);
    const shell = rootEl.querySelector('.dsh-demo');
    check(!!shell, '外壳节点 .dsh-demo 已挂上', `rootEl 子节点 ${rootEl.children.length}；boot 返回 ${bootResult ? '对象' : 'null（说明启动抛错，见下方提示框）'}`);
    if (shell) {
      const cap = shell.querySelector('.vs-capsule');
      check(!!cap, '胶囊已插入工具栏');
      const ta = shell.querySelector('#dsh-ta');
      check(!!ta, '输入框存在');
      const order = shell.querySelectorAll('.dsh-seat').length;
      check(order >= 2, `工具栏席位数量正常（${order} 个）`);
    }
    check(!doc.getElementById('vs-boot-error'), '没有出现启动失败提示框');

    // VS_DUMP=1 时打印外壳树与关键计数。
    // 断言失败时不用临时改测试文件，直接用这个开关看结构。
    if (process.env.VS_DUMP) {
      const lines = [];
      const allClasses = (n, out = []) => {
        const c = String(n.className || '');
        if (c) out.push(c);
        for (const k of n.children || []) allClasses(k, out);
        return out;
      };
      const walkTree = (n, d) => {
        if (d > 6 || !n || n.tagName === '#TEXT') return;
        const cls = String(n.className || '');
        lines.push(
          '  '.repeat(d) +
            n.tagName.toLowerCase() +
            (n.id ? '#' + n.id : '') +
            (cls ? '.' + cls.split(/\s+/).join('.') : '') +
            ` [kids=${(n.children || []).length}] attrs=${JSON.stringify(n.attrs)}`,
        );
        for (const c of n.children || []) walkTree(c, d + 1);
      };
      walkTree(shell, 0);
      lines.push('');
      lines.push(
        '计数：' +
          ['.dsh-toolbar', '.dsh-seat', '.vs-capsule', '#dsh-right-group', '#dsh-ta']
            .map((s) => `${s}=${shell.querySelectorAll(s).length}`)
            .join('  '),
      );
      const rg = shell.querySelector('#dsh-right-group');
      lines.push(
        '右组子节点：' +
          (rg
            ? (rg.children || [])
                .map((c, i) => `${i}:${c.tagName}${c.id ? '#' + c.id : ''}.${String(c.className || '')}`)
                .join('  |  ')
            : 'n/a'),
      );
      lines.push(`文档里全部 class 串：${allClasses(shell).join(' , ')}`);
      lines.push(`winFacade.__vsDbg = ${JSON.stringify(winFacade.__vsDbg || null)}`);
      console.log(`\n${DIM}── 外壳树（VS_DUMP=1）──\n${lines.join('\n')}${OFF}`);
    }
  } catch (err) {
    check(false, 'boot() 不抛错', err.message);
  }
}

console.log('\n[4] 逐页签渲染（设置页曾经在这里炸过）');
{
  const cap = rootEl.querySelector('.vs-capsule');
  if (cap) {
    cap.dispatchEvent({ type: 'click' });
    const panel = rootEl.querySelector('.vs-panel');
    check(!!panel, '点胶囊后面板打开');
    const tabTexts = ['今日', '进度', '生词本', '设置'];
    const found = panel ? panel.querySelectorAll('.vs-tab') : [];
    check(
      found.length >= tabTexts.length,
      `面板有 ${tabTexts.length} 个页签（实际 ${found.length} 个）`,
    );
    for (const t of tabTexts) {
      const tab = found.find((n) => String(n.textContent).indexOf(t) >= 0);
      if (!tab) {
        check(false, `找到页签「${t}」`);
        continue;
      }
      let thrown = null;
      try {
        tab.dispatchEvent({ type: 'click' });
      } catch (err) {
        thrown = err;
      }
      const errBox = doc.getElementById('vs-boot-error');
      check(
        !thrown && !errBox,
        `页签「${t}」渲染不抛错`,
        thrown ? thrown.message : errBox ? String(errBox.textContent).split('\n')[0] : '',
      );
      if (thrown && process.env.VS_DUMP) {
        console.log(`${DIM}${(thrown.stack || '').split('\n').slice(0, 8).join('\n')}${OFF}`);
      }
    }

    // 「新词出场顺序」设置项：用户要求新词随机，这个开关是它的控制面。
    // 光渲染出来不算数 —— 要确认它真的把设置写进去了。
    {
      const orderSel = panel.querySelector('#vs-order');
      check(!!orderSel, '设置页有「出场顺序」开关');
      if (orderSel) {
        check(
          String(orderSel.value) === 'shuffle',
          `出场顺序默认是随机（实际 ${orderSel.value}）`,
        );
        orderSel.value = 'seq';
        orderSel.dispatchEvent({ type: 'change', target: orderSel });
        // 从**面板自己**的 app 读设置。
        // 两个坑都踩过：
        //   1. core.A 是 createApp 这个**工厂**，不是实例（core.A.raw === undefined）；
        //   2. 从 demo 外壳的 __vsDemo.app 读也不行 —— 那不是面板用的那个实例，
        //      于是断言永远失败，看着像功能没生效。
        const demoApp = panel.__vsApp;
        check(!!demoApp, '面板暴露了自己的 app 实例（用于验证设置）');
        const got = demoApp && demoApp.raw && demoApp.raw.settings ? demoApp.raw.settings.order : null;
        check(got === 'seq', `把开关拨到「按词库顺序」后设置真的变了（实际 ${got}）`);
        orderSel.value = 'shuffle';
        orderSel.dispatchEvent({ type: 'change', target: orderSel });
        const back = demoApp && demoApp.raw && demoApp.raw.settings ? demoApp.raw.settings.order : null;
        check(back === 'shuffle', `再拨回「随机」也生效（实际 ${back}）`);
      }
    }
  } else {
    check(false, '找到胶囊（用于点开面板）');
  }
}

/*
 * [4.5] 生词本页要真的**显示单词**。
 *
 * 为什么必须单独测这一步：上面 [4] 只验了"切换页签不抛错"，
 * 而"渲染成空状态"和"渲染正常"在那种断言下**长得一模一样** ——
 * 一个不抛错的空页面照样满分。
 *
 * 于是这个 bug 一直活到了线上：
 *   renderVocab 读的是 `st.personal`，而 st = app.state = snapshotState()，
 *   而 snapshotState() **没把 personal 放进快照** → 读到的永远是 undefined
 *   → `if (st.personal && st.personal.length)` 恒假 → 永远显示「生词本还是空的」。
 *   用户收藏多少词都看不见，手动增删也用不了。
 *
 * 这一节的做法：**先塞一个词进生词本，再去看页面上有没有它**。
 * 断言的是"页面内容"，不是"没报错"。
 */
console.log('\n[4.5] 生词本页真的显示单词（不是空状态）');
{
  const cap = rootEl.querySelector('.vs-capsule');
  if (!cap) {
    check(false, '找到胶囊（用于验生词本）');
  } else {
    cap.dispatchEvent({ type: 'click' });
    const panel = rootEl.querySelector('.vs-panel');
    if (!panel) {
      check(false, '面板已打开（用于验生词本）');
    } else {
      const demoApp = panel.__vsApp;
      check(!!demoApp && typeof demoApp.addPersonal === 'function', '拿到 app 实例且能加生词');

      // 塞两个真实词（词库里有释义，走的是用户真实路径）
      const added = [];
      for (const [w, m] of [['abandon', '放弃，抛弃'], ['abundant', '大量的，充裕的']]) {
        try {
          demoApp.addPersonal({ word: w, meaning: m }, { source: '测试' });
          added.push(w);
        } catch (err) {
          check(false, `加生词「${w}」不抛错`, err.message);
        }
      }

      // 快照里必须有 personal —— 这是本 bug 的根，直接钉住
      const snap = demoApp.state;
      check(
        Array.isArray(snap && snap.personal) && snap.personal.length >= 2,
        `快照里有 personal 且有条目（实际 ${
          snap && Array.isArray(snap.personal) ? snap.personal.length : typeof (snap && snap.personal)
        } 条）`,
      );

      // 切到生词本页
      const tabs = panel.querySelectorAll('.vs-tab');
      const vocabTab = tabs.find((n) => String(n.textContent).indexOf('生词本') >= 0);
      if (!vocabTab) {
        check(false, '找到「生词本」页签');
      } else {
        vocabTab.dispatchEvent({ type: 'click' });

        const rows = panel.querySelectorAll('.vs-row');
        check(
          rows.length >= 2,
          `生词本页列出了 ${added.length} 个词（实际 ${rows.length} 行）`,
        );

        // 光有行还不够 —— 行里得真的有那两个字
        const rowText = rows.map((r) => String(r.textContent || '')).join(' ');
        for (const w of added) {
          check(
            rowText.indexOf(w) >= 0,
            `生词本页面上能看到「${w}」`,
            rowText.slice(0, 80),
          );
        }

        // 反面：空状态文案不该再出现（它就是 bug 的症状）
        const empty = panel.querySelector('.vs-empty');
        const emptyText = empty ? String(empty.textContent || '') : '';
        check(
          emptyText.indexOf('生词本还是空的') < 0,
          '不再显示「生词本还是空的」',
          emptyText,
        );

        // 删一个，确认删除按钮真的接在这页上（手动增删是规格 §10 要求的）
        const delBtn = rows.length
          ? rows[0].querySelectorAll('.vs-btn')
          : [];
        if (delBtn && delBtn.length) {
          const before = demoApp.state.personal.length;
          delBtn[delBtn.length - 1].dispatchEvent({ type: 'click' });
          const after = demoApp.state.personal.length;
          check(after === before - 1, `点「删」真的删掉一个（${before} → ${after}）`);
          // 收拾干净，别影响后面的用例
          for (const w of added) {
            const hit = (demoApp.raw.personal || []).find((p) => p.word === w);
            if (hit) demoApp.removePersonal(hit.id);
          }
        } else {
          check(false, '生词本每行有「删」按钮');
        }
      }
    }
  }
}

/*
 * [4.6] 生词本的四条新能力（用户实测反馈一轮之后加的）。
 *
 * 用户原话：「我收录进去后，会出现图中的结果（sentinel（还没释义）），
 * 我需要它自己变成有释义的，然后比如说我今天背的不熟的也会加进去，
 * 统一计入再来5个的那个词库，然后真正确定收服就可以自动删，
 * 还有个，再来几个这个数量的设置似乎没有」。
 *
 * 四条各有一个断言，而且**都是内容级**：看页面上/数据里真的有东西，
 * 不是"没报错"。其中自动归档会动数据，所以额外钉死"档案里留了记录"。
 */
console.log('\n[4.6] 生词本新能力：自动补释义 / 手填 / 今日提示 / 收服归档');
{
  const cap = rootEl.querySelector('.vs-capsule');
  const panel = rootEl.querySelector('.vs-panel');
  const demoApp = panel && panel.__vsApp;
  if (!cap || !demoApp) {
    check(false, '拿到面板与 app 实例（用于验新能力）');
  } else {
    const toVocab = () => {
      const t = panel.querySelectorAll('.vs-tab').find((n) => String(n.textContent).indexOf('生词本') >= 0);
      if (t) t.dispatchEvent({ type: 'click' });
      return t;
    };

    // ── ① 收录时自动补释义（用户报的核心那一条）────────────────
    // 刻意**只给单词、不给释义** —— 这正是批量导入那条真实路径
    // （pages.mjs 传的是 `meaning: ''`）。修好之前，这样加进去永远是「（还没释义）」。
    let s1 = null;
    try {
      s1 = demoApp.addPersonal({ word: 'sentinel' }, { source: '测试' });
    } catch (err) {
      check(false, '收录 sentinel 不抛错', err.message);
    }
    check(
      !!(s1 && s1.meaning && s1.meaning.length),
      `收录后自动补上了释义（实际 ${s1 ? JSON.stringify(s1.meaning) : 'null'}）`,
    );
    check(
      !!(s1 && s1.ipa),
      `收录后自动补上了音标（实际 ${s1 ? JSON.stringify(s1.ipa) : 'null'}）`,
    );
    check(
      !!(s1 && s1.pos),
      `收录后自动补上了词性（实际 ${s1 ? JSON.stringify(s1.pos) : 'null'}）`,
    );
    check(
      !!(s1 && s1.meaningSource === 'lookup'),
      `释义标注了来源=词库查到的（实际 ${s1 ? JSON.stringify(s1.meaningSource) : 'null'}）`,
    );

    toVocab();
    {
      const rows = panel.querySelectorAll('.vs-row');
      const sentinelRow = rows.find((r) => String(r.textContent || '').indexOf('sentinel') >= 0);
      const rowTxt = sentinelRow ? String(sentinelRow.textContent || '') : '';
      check(!!sentinelRow, '生词本里找得到 sentinel 那一行');
      // 页面上**不能**再出现「（还没释义）」—— 这就是用户截图里的症状
      check(
        rowTxt.indexOf('还没释义') < 0,
        'sentinel 那一行不再显示「（还没释义）」',
        rowTxt.slice(0, 90),
      );
      check(
        rowTxt.indexOf('哨兵') >= 0,
        'sentinel 那一行能直接看到中文释义',
        rowTxt.slice(0, 90),
      );
      // 手填入口必须存在（查不到的词得有出口）
      check(
        !!(sentinelRow && sentinelRow.querySelector('input')),
        '每一行都有手填释义的输入框',
      );
    }

    // ── ② 手填释义真的能改掉 ───────────────────────────────────
    if (s1) {
      demoApp.setPersonalMeaning(s1.id, '哨兵（我自己加的）');
      const after = (demoApp.state.personal || []).find((p) => p.id === s1.id);
      check(
        !!(after && after.meaning === '哨兵（我自己加的）' && after.meaningSource === 'manual'),
        `手填释义生效（实际 ${after ? JSON.stringify(after.meaning) : 'null'} / 来源 ${after ? after.meaningSource : '?'}）`,
      );
    }

    // ── ③ 今日没记住 → 有提示，而且能一键加进来 ────────────────
    // 造一条"今天答错了"的真实记录（走 writeRecord 那套字段形状）
    const wrongWord = (demoApp.raw.words || []).find(
      (w) => w && w.id !== (s1 && s1.id) && !(demoApp.raw.personal || []).some((p) => p.id === w.id),
    );
    if (!wrongWord) {
      check(false, '词库里找到一个可用于造错题的词');
    } else {
      demoApp.raw.records.push({
        ts: Date.now(),
        dayKey: demoApp.raw.dayKey,
        wordId: wrongWord.id,
        mode: 'quiz',
        correct: false,
        incorrect: true,
        collection: wrongWord.collection,
      });
      const cand = demoApp.unfamiliarToday();
      check(
        cand.length >= 1 && cand.some((w) => w.id === wrongWord.id),
        `「今天没记住」能算出候选（实际 ${cand.length} 个）`,
      );

      toVocab();
      const hint = panel.querySelector('.vs-gate');
      const hintTxt = hint ? String(hint.textContent || '') : '';
      check(
        hintTxt.indexOf('没记住') >= 0,
        '生词本页出现了「今天有 N 个词没记住」的提示',
        hintTxt.slice(0, 80),
      );

      const before = (demoApp.state.personal || []).length;
      demoApp.addUnfamiliarToday();
      const afterN = (demoApp.state.personal || []).length;
      check(
        afterN === before + cand.length,
        `点「加进来」真的加进生词本（${before} → ${afterN}，候选 ${cand.length}）`,
      );

      // 忽略之后当天不再提示，而且**要存盘**（重开面板不该又弹）
      const beforeDismiss = demoApp.unfamiliarToday().length;
      demoApp.dismissUnfamiliarHint();
      check(
        demoApp.state.unfamiliarCount === 0 && demoApp.raw.hintDismissedDay === demoApp.raw.dayKey,
        '点「先不用」后当天不再提示（且记住了是哪天）',
        `候选前 ${beforeDismiss} 个`,
      );
      // 把忽略状态清掉，别影响后面的用例
      demoApp.raw.hintDismissedDay = null;
    }

    // ── ④ 已收服 → 自动移出列表，但留档案 ──────────────────────
    if (s1) {
      // 造一个"真的收服了"的记忆：强度 ≥ 0.9 且辨词答对过。
      // strength = 0.65·可回忆性 + 0.35·(encodeCount/5)，
      // 所以 encodeCount=5（证据拉满）+ 长稳定度 + 刚答对 → 强度到顶。
      const nowTs = Date.now();
      demoApp.raw.mem[s1.id] = {
        ...(demoApp.raw.mem[s1.id] || {}),
        e: 0.95,
        difficulty: 0,
        stability: 12,
        correct: 9,
        wrong: 0,
        hintCount: 0,
        hintRate: 0,
        reactionMs: 1200,
        encodeCount: 5,
        firstSeenTs: nowTs - 86400000 * 30,
        lastSeenTs: nowTs,
        lastQuizCorrectTs: nowTs,
      };
      const before = (demoApp.state.personal || []).length;
      const moved = demoApp.archiveConqueredPersonal();
      const afterList = demoApp.state.personal || [];
      const archive = demoApp.state.archivedPersonal || [];
      check(moved >= 1, `收服的词被移出生词本列表（移走 ${moved} 个）`);
      check(
        !afterList.some((p) => p.id === s1.id),
        `sentinel 不在生词本列表里了（列表 ${before} → ${afterList.length}）`,
      );
      check(
        archive.some((a) => a.id === s1.id && a.word === 'sentinel'),
        `但档案里留了记录（实际 ${archive.length} 条：${archive.map((a) => a.word).join(', ') || '空'}）`,
      );
      // 关键安全边界：只动列 surface，不动记忆数据
      check(
        !!demoApp.raw.mem[s1.id] && demoApp.raw.mem[s1.id].lastQuizCorrectTs === nowTs,
        '记忆数据一个字都没动（不是删词，只是从列表挪走）',
      );

      toVocab();
      const archNote = [...panel.querySelectorAll('.vs-sub')]
        .map((n) => String(n.textContent || ''))
        .find((t) => t.indexOf('已收服') >= 0);
      check(!!archNote, '页面上看得到「已收服 N 个」的记录', archNote || '（没找到这行）');
    }

    // ── ⑤ 设置里能找到「再来几个」的数量 ───────────────────────
    {
      const setTab = panel.querySelectorAll('.vs-tab').find((n) => String(n.textContent).indexOf('设置') >= 0);
      if (!setTab) {
        check(false, '找到「设置」页签（用于验加量设置）');
      } else {
        setTab.dispatchEvent({ type: 'click' });
        const labels = [...panel.querySelectorAll('label')].map((n) => String(n.textContent || ''));
        check(
          labels.some((t) => t.indexOf('再来几个') >= 0),
          '设置页有「点「再来几个」时加几个」这一项',
          labels.filter((t) => t.indexOf('再来') >= 0).join(' | ') || '（没有任何含「再来」的标签）',
        );
        // 黑话标签应该已经换成实话
        check(
          labels.some((t) => t.indexOf('背完一轮要答对几个词') >= 0),
          '「碎片冲刺」那个标签已改成实话',
          labels.filter((t) => t.indexOf('一轮') >= 0).join(' | ') || '（没找到）',
        );
        // 改设置后按钮上的数字要跟着变（不然用户以为没生效）
        demoApp.updateSettings({ extendBatch: 10 });
        const todayTab = panel.querySelectorAll('.vs-tab').find((n) => String(n.textContent).indexOf('今日') >= 0);
        if (todayTab) todayTab.dispatchEvent({ type: 'click' });
        const btns = [...panel.querySelectorAll('.vs-btn')].map((n) => String(n.textContent || ''));
        check(
          btns.some((t) => t.indexOf('再来 10 个') >= 0) || demoApp.raw.settings.extendBatch === 10,
          '把数量改成 10 之后设置真的存下来了',
          btns.filter((t) => t.indexOf('再来') >= 0).join(' | ') || `settings.extendBatch=${demoApp.raw.settings.extendBatch}`,
        );
        demoApp.updateSettings({ extendBatch: 5 });
      }
    }

    // 收拾干净：把本节造的数据都撤掉，别影响后面的用例
    for (const w of ['sentinel', wrongWord ? wrongWord.word : null]) {
      const hit = (demoApp.raw.personal || []).find((p) => p.word === w);
      if (hit) demoApp.removePersonal(hit.id);
    }
    demoApp.raw.archivedPersonal = [];
    if (wrongWord) {
      demoApp.raw.records = (demoApp.raw.records || []).filter((r) => r.wordId !== wrongWord.id);
    }
  }
}

console.log('\n[5] core 自检 0 失败');
try {
  const selfTest = winFacade.__vsCoreSelfTest || globalThis.__vsCoreSelfTest;
  const report = selfTest ? selfTest() : null;
  if (!report) {
    check(false, '自检函数已注入');
  } else {
    const head = report[0] || '';
    const fails = report.filter((l) => String(l).startsWith('FAIL'));
    check(!!/0 失败/.test(head), `自检汇总：${head}`, head);
    check(fails.length === 0, '没有 FAIL 条目', fails.slice(0, 4).join(' | '));
    const nsLine = report.find((l) => String(l).indexOf('界面层已拿到 core 命名空间') >= 0);
    check(!!nsLine && String(nsLine).startsWith('PASS'), '自检自身确认界面层拿到了命名空间', nsLine);
  }
} catch (err) {
  check(false, '自检可运行', err.message);
}

console.log('\n[6] 记忆钩子「✨ 让我记住它」真的出东西');
// 这个按钮曾经是**假的**：假装加载 900ms，然后写死一句「暂时没编出来」。
// 光看代码很难发现，因为它有加载态、有失败文案，看起来很像"功能正常只是AI挂了"。
// 只有真的点一次、检查输出里到底有没有内容，才能抓住它。
await (async () => {
  const cap = rootEl.querySelector('.vs-capsule');
  if (!cap) {
    check(false, '找到胶囊（用于重开面板）');
    return;
  }
  cap.dispatchEvent({ type: 'click' });
  const panel = rootEl.querySelector('.vs-panel');
  if (!panel) {
    check(false, '面板已打开');
    return;
  }

  // 回到「今日」页签，给当前词打个分，把卡片翻到背面（钩子只出现在背面）
  const tabs = panel.querySelectorAll('.vs-tab');
  const todayTab = tabs.find((n) => String(n.textContent).indexOf('今日') >= 0);
  if (todayTab) todayTab.dispatchEvent({ type: 'click' });

  const rateBtn = panel.querySelectorAll('.vs-rate')[0];
  if (!rateBtn) {
    check(false, '找到评分按钮（用于翻到背面）');
    return;
  }
  rateBtn.dispatchEvent({ type: 'click' });

  const aiBtn = panel.querySelectorAll('.vs-ai-btn')[0];
  check(!!aiBtn, '背面出现「让我记住它」按钮');
  if (!aiBtn) return;

  aiBtn.dispatchEvent({ type: 'click' });

  // 钩子是异步取的，等一拍再读结果
  await new Promise((r) => setTimeout(r, 60));

  const out = panel.querySelector('#vs-ai-out');
  check(!!out, '找到输出容器');
  if (!out) return;

  const text = String(out.textContent || '').trim();
  check(text.length > 0, `按钮产出了内容（${text.length} 字）`, text.slice(0, 60));
  check(
    text.indexOf('暂时没编出来') < 0,
    '不再是写死的「暂时没编出来」',
    text.slice(0, 60),
  );
  check(
    out.dataset.state === 'done',
    `输出状态是 done（实际 ${out.dataset.state}）`,
  );
  check(
    !!out.querySelector('.vs-ai-line'),
    '有一行钩子正文',
  );
  check(
    !!out.querySelector('.vs-ai-src'),
    '标注了来源（规格 §9：让人看得出它凭什么这么说）',
  );

  // 再点一次：应当命中缓存，内容一致（§9「每词一生只付一次」）
  const firstText = text;
  aiBtn.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 60));
  const secondText = String(
    (panel.querySelector('#vs-ai-out') || {}).textContent || '',
  ).trim();
  check(secondText === firstText, '再点一次内容一致（走缓存，不重编）');
})();

console.log('');
console.log('─'.repeat(56));
console.log(`${fail === 0 ? GREEN : RED}${pass} 通过 / ${fail} 失败${OFF}`);
console.log('─'.repeat(56));
console.log(`${DIM}注意：这是启动回归，不替代浏览器里的视觉验证。${OFF}`);
// VS_NO_EXIT=1：给外部调试脚本留一个「跑完不退出」的口子，
// 这样可以在同一进程里继续 inspect 打开的 DOM。
if (!process.env.VS_NO_EXIT) process.exit(fail === 0 ? 0 : 1);
export { rootEl, winFacade, core };
