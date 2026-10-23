// vocab-study / adapter / dsh / client.js
//
// DSH 客户端插件入口。构建脚本把它包进 `window.__ModuleLoader__.load({...})`
// 工厂里（工厂契约见本文件末尾的注释）。
//
// 本包**只占两个席位**：
//
//   1. conversation.input.right   （list, order 45）
//      一个胶囊 + 一行情绪文案。默认什么都不做，绝不抢焦点、绝不自动开面板（P1/P8）。
//      位置在 `vision-router-mode-toggle`（order 40）右边 —— 输入框右侧那一串小控件里。
//
//   2. sidebar.right.pane.tab     （keyed, key = 'vocab-study'）
//      一个完整的「今日背单词」标签页。同时用 `sidebar.right.tab.title` 给它一个标题，
//      用 `sidebar.right.tab.menu.item` 在标签页菜单里留一个入口。
//
// 不占任何全局：不注册 document 级键盘监听，不修改 window，不碰对话 DOM（§14.1）。

import React from 'react';
import { createVocabCore, createCapsulePuppet, createPanelPuppet } from './puppet.mjs';

// injectVocabStudyCss 由构建脚本在摊平时提供（来源 ui/styles.css）。
// 直接调用它即可 —— 摊平后同处一个作用域。

const CAPSULE_ORDER = 45; // > vision-router-mode-toggle(40)，落在它右边
const TAB_KIND = 'vocab-study';
// 宿主给页面标签记的地址就是 `sidebar://<kind>`（见 ui-sidebar-right 的 pageAddress）。
// `openResource` 走的是地址这条路，和无参的 `openTab` 是两条不同的入口，所以也试一下。
const SIDEBAR_ADDRESS = `sidebar://${TAB_KIND}`;

// ── 诊断用的小工具 ─────────────────────────────────────────
// 探测一个服务对象可能在**探测本身**就抛错（getter 抛、代理拒绝），
// 所以每一个都要包起来。诊断代码绝不能把自己变成新的故障源。
/** 对象自己的可枚举键名；失败返回错误说明。 */
function safeKeys(obj) {
  try {
    return Object.keys(obj);
  } catch (err) {
    return `(取键失败: ${String((err && err.message) || err)})`;
  }
}
/** 原型上的属性名（方法都在这儿）；失败返回错误说明。 */
function safeProtoKeys(obj) {
  try {
    const proto = Object.getPrototypeOf(obj);
    return proto ? Object.getOwnPropertyNames(proto) : null;
  } catch (err) {
    return `(取原型失败: ${String((err && err.message) || err)})`;
  }
}

// ── 一个窗口 = 一个内核（不是"一个对话一个内核"）─────────────────
//
// 【事故十一】这里原来是 `const cores = new Map()`，按 sessionId 每个对话
// 建一个内核。当时的想法是"避免多会话互相串数据"，但用户报回来的现象是：
//
//     「多个对话框之间居然不是共享的」
//
// 实测（两个会话共用同一个 localStorage）坏在三处：
//
//   ① 进度不同步：B 只在**打开面板那一刻**读一次存档，之后 A 背了多少
//      B 一概看不见（实测 A 背 10 个，B 内存里还是 0）。
//   ② 写入被吞：每个内核都去抢 client-store 里那把"一个窗口只许一个写入者"
//      的锁。A 握着锁，B 一 `createStorage` 就被判成**只读**，于是 B 里改的
//      设置全部写进内存、不落盘（实测 B 改成 30，磁盘上还是 20）。
//   ③ 两个内核各自持有一份完整 app 状态，最后写入的覆盖另一份，
//      谁背过哪些词完全对不上。
//
// 根子在于：**背单词的进度属于"这个人"，不属于某个对话**。所以窗口里
// 只该有一个 app 实例，所有对话的所有席位（胶囊、面板）共用它。
// 这样锁也不再自己跟自己抢，②自然消失。
//
// 为什么用 Promise 单例：座席（CapsuleSeat / VocabPane）是 React 同步渲染的，
// 而 `app.init()` 是异步的（要读 localStorage）。直接返回未初始化的实例会让
// 胶囊第一帧拿到空白状态。存 Promise，谁先到谁等它 resolve。
let corePromise = null;

/** 取（或建）本窗口唯一的内核。sessionId 保留在签名里只为日志可读。 */
function coreFor(sessionId) {
  if (!corePromise) {
    corePromise = (async () => {
      const core = createVocabCore({
        // 交接态（§3.1）需要知道模型是否正在输出。当前未接：见 README「已知缺口」。
        isStreaming: () => false,
      });
      try {
        // init() 结尾自己会 emit()，所以先渲染的空壳会被这次 emit 填上真数据 ——
        // 组件不需要额外去 await。
        await core.app.init();
      } catch (err) {
        // init 抛错就让缓存失效：下次有人要内核时重试一次。
        // 不这么做的话，这一次失败会被永久记住，用户只能重启客户端。
        console.error('[vocab-study] 内核 init() 失败（下次取用会重试）：', err);
        corePromise = null;
        throw err;
      }
      return core;
    })();
    // 没人 await 这个 Promise，失败必须自己消费掉，否则会变成
    // "unhandled rejection"，在某些宿主里会弹不该弹的错。
    corePromise.catch(() => {});
  }
  return corePromise;
}


/**
 * 把 DOM 木偶包成 React 组件：框架给容器，木偶负责往里面画。
 *
 * ⚠️ 这里有一个**真实踩过的坑**，改动前务必读完。
 *
 * 木偶的产物是"往容器里 append 一个子节点"（`puppet.mjs` 里那句
 * `mountTo.appendChild(panel.root)`）。所以容器**必须已经在 DOM 里**，
 * 否则画出来的东西挂在一个游离节点上，屏幕上什么都没有 —— 而且**不报任何错**。
 *
 * 所以这里用**回调 ref + state 触发**，而不是 `useRef` + `useEffect`：
 *
 *   - 回调 ref 在 React 提交 DOM 的那一瞬间同步触发，拿到的节点**确定已挂载**；
 *   - 但它触发的时机**早于** `useEffect`，所以同步创建傀儡时宿主节点还不存在；
 *   - 于是 ref 回调里只把节点存进 state，**用一次重渲染**把 `useEffect` 带起来，
 *     这时 `el` 一定有值。
 *
 * 改动前的写法（`useRef` + `useEffect`）看起来更"标准"，实际后果是：
 * 面板标签页正文里那个 div 是**空的** —— 用户看到的现象就是
 * 「插件明明加载了、槽位注册也是 active，但界面上什么都没有」。
 */
function usePuppet(create, deps, core) {
  const puppetRef = React.useRef(null);
  // create 每次渲染都是新函数，但它只依赖 deps；用 ref 固定住，别让它进 effect 依赖
  const createRef = React.useRef(create);
  createRef.current = create;
  // 存 DOM 节点而不是 ref 对象：节点的到来本身要触发一次重渲染
  const [hostEl, setHostEl] = React.useState(null);

  React.useEffect(() => {
    // ⚠️ 内核是异步来的（见 coreFor 的【事故十一】），第一帧 core 还是 null。
    // 而木偶第一行就是 `core.app` —— 不挡住就是「Cannot read properties of null」
    // 把座席 render 打挂。先只画个空壳：core 就绪后 deps 里的 `[core]` 变了，
    // 这个 effect 会重跑，那时才真正建木偶。
    if (core) puppetRef.current = createRef.current(hostEl);
    return () => {
      try {
        puppetRef.current?.destroy();
      } catch {
        /* 卸载时的清理失败不该冒泡 */
      }
      puppetRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostEl, ...deps]);

  // 回调 ref：节点挂上/摘下时同步调用
  const setHost = React.useCallback((node) => {
    setHostEl(node);
  }, []);

  return { hostRef: setHost, puppetRef };
}

/**
 * 「把右侧栏的『今日背单词』标签页拉出来」——最佳努力，永不抛错。
 *
 * ── 这个函数踩过两个坑，都写在注释里，别再走回去 ────────────────
 *
 * 【坑一 · 把整个客户端带崩】
 * 最早这里写的是 `ctx.sidebarRight.openTab(...)`，而同一段代码里还有一处
 * **没包 try** 的 `ctx.sidebarRightTabs.register(...)`。当时 `inject` 里没写
 * `sidebarRightTabs`，那是 undefined 上的属性访问、同步抛错，把整个 `apply` 打挂，
 * fiber 停在 LOADING，客户端启动审计失败 → 弹窗要求「禁用第三方插件」。
 * **教训：界面元素里的可选能力，一律不许有能力把插件本身带崩。**
 *
 * 【坑二 · 点了没反应（界面出来了之后）】
 * 当时以为宿主里没有 `openTab`，于是列了两种猜测形态去试：
 *
 *     ctx.sidebarRight?.tabDomain?.openTab?.(TAB_KIND)   // TabDomain 上根本没这个方法
 *     ctx.sidebarRight?.openTab?.(TAB_KIND)              // 存在，但内部走 require() 守卫
 *
 * 第二种**存在但必抛**。控制器上是这么写的：
 *
 *     openTab(kind, options) {
 *       const { sessionId, actions } = this.require();   // ← 这里
 *       this.placeTab(sessionId, actions, kind, options);
 *     }
 *     require() {
 *       if (this.binding === void 0) throw new Error("sidebarRight: no session surface is mounted");
 *       return this.binding;
 *     }
 *
 * 而 `binding` **只在右侧栏那个 seat 真的挂载时**才会被绑上
 * （`RightbarSeat` 里是 `active ? bindService({...}) : void 0`）。
 * 于是"侧栏没打开 → 点胶囊 → 抛错 → 被 try 吞掉 → 什么都不发生"。
 *
 * 【正确的入口】
 * 控制器上还有一个 `openTabIn(sessionId, kind, options)`，它走的是
 * `actionsFor(sessionId)` 而**不是** `require()`：
 *
 *     openTabIn(sessionId, kind, options = {}) {
 *       const actions = this.actionsFor(sessionId);
 *       if (actions !== void 0) this.placeTab(sessionId, actions, kind, options);
 *     }
 *
 * 所以它**不要求侧栏已经打开**，只需要这个会话的 surface 已经被采纳
 * （在对话里点胶囊时，这个条件天然满足）。而且宿主自己给插件用的那个
 * `ctx.sidebarRight.openTab` 内部**也是转手调 `openTabIn(sessionId, ...)`**：
 *
 *     openTab: (kind, options = {}) => {
 *       navigator.openTabIn(sessionId, kind, { ...place(options), params: options.params });
 *     }
 *
 * 结论：**带上 sessionId 走 `openTabIn`**，不要走无参的 `openTab`。
 *
 * 【坑三 · `ctx` 根本不在组件 props 里 ⚠️ 花了三轮才查出来】
 * 上面两个坑修完，界面出来了、点击还是没反应。日志（我自己加的那条）显示：
 *
 *     sidebarRight.openTabIn(sessionId) → Cannot read properties of undefined (reading 'openTabIn')
 *     ...
 *     sidebarRight = undefined
 *     ctx 自有键   = null          ← ctx 本身就是 undefined
 *
 * 根因：**槽位组件的 props 里没有 `ctx`**。宿主渲染器（ui-renderer）是这么调的：
 *
 *     jsx(Comp, { ...kit, ...injected, ...slotInjected.props, ...contextual, ...ownerProps })
 *
 * `ctx` 不在任何一个展开里。那服务怎么进组件？看 `runInject`：
 *
 *     function runInject(entry, binding, actions) {
 *       const inject = entry.inject;
 *       if (!inject) return EMPTY_INJECTED_PROPS;     // ← 我们没给 inject，所以是空的
 *       return bindInjectSources(inject(...args));
 *     }
 *
 * 也就是说：**注册槽位时可以直接给一个 `inject` 函数，它的返回值会变成组件 props。**
 * 宿主的 ui-chat 就是这么给自己要能力的：
 *
 *     ctx.inject(["sidebarRightTabs"], (scope) => {
 *       const tabs = scope.sidebarRightTabs;        // 服务在 scope 上
 *       scope.slots.inject("settings.general.item", () => scope.slots.register({
 *         name: "settings.general.item", id: "link-opening", order: 14,
 *         inject: () => ({ hooks: { linkOpening, browserAvailable }, setLinkOpening }),
 *       }, LinkOpeningRow));
 *     });
 *
 * 注意 `scope.sidebarRightTabs` —— **服务在 `ctx.inject` 的 `scope` 上，不在根 `ctx` 上**。
 * 这就是为什么 `export const inject = [...]` 声明对了、`apply` 里也不抛错，
 * 但 `ctx.sidebarRight` 恒为 `undefined`。
 *
 * 所以本函数的第一个参数从 `ctx` 改成了**能力对象** `abilities`：
 * 由 `apply` 在 `ctx.inject` 的回调里组装好（把 `scope` 和 `sessionId` 封进去），
 * 组件只管调用，不再自己去找服务。
 *
 * @param {{ openTab?: (sessionId: string) => void, scope?: object }} abilities 打开能力
 * @param {string} sessionId 当前会话 id（`openTabIn` 必需）
 */
function openVocabTab(abilities, sessionId) {
  const scope = abilities?.scope;
  const rr = scope?.sidebarRight;
  const tabs = scope?.sidebarRightTabs;

  // 候选顺序：最可能成功的在前。**每一条都记下"在不在"和"报什么错"**，
  // 这样即使全失败，一次点击也能把全部信息带回来（不用来回猜第二遍）。
  const candidates = [
    ['sidebarRight.openTabIn(sessionId)', () => rr.openTabIn(sessionId, TAB_KIND, { revealIfOpened: true })],
    ['sidebarRight.openTab(kind)', () => rr.openTab(TAB_KIND)],
    ['sidebarRight.openResource(address)', () => rr.openResource(SIDEBAR_ADDRESS)],
    ['sidebarRight.tabDomain.navigate(...)', () => rr.tabDomain?.navigate?.(sessionId, TAB_KIND)],
    ['sidebarRightTabs.open(kind)', () => tabs.open(TAB_KIND)],
    ['sidebarRightTabs.show(kind)', () => tabs.show(TAB_KIND)],
  ];

  const report = [];
  for (const [label, run] of candidates) {
    try {
      run();
      // 不抛错就算这一条走通了（返回值不论）
      return true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      report.push(`    ${label} → ${msg}`);
      // "不是函数"和"抛了守卫错误"是完全不同的两件事，日志里能一眼看出来
      if (!/is not a function/.test(msg)) {
        // 真抛了错：说明方法存在但前提不满足。记住它继续试下一条。
      }
    }
  }

  // 全都没走通 —— 把现场彻底打出来，并且**落一份到 localStorage**。
  //
  // 为什么要落盘：DevTools 会把多行长日志收成一行，只复制到调用栈、复制不到正文，
  // 来回让人翻控制台太折腾。写进 localStorage 之后可以直接从磁盘上的
  // LevelDB 日志把这段读出来，零操作。
  const diag = {
    at: new Date().toISOString(),
    sessionId: sessionId === undefined ? '(undefined)' : String(sessionId),
    failures: report,
    probe: {
      hasAbilities: abilities !== undefined && abilities !== null,
      scopeType: scope === undefined ? 'undefined' : typeof scope,
      scopeKeys: scope ? safeKeys(scope) : null,
      scopeProtoKeys: scope ? safeProtoKeys(scope) : null,
      sidebarRightType: rr === undefined ? 'undefined' : typeof rr,
      sidebarRightOwnKeys: rr ? safeKeys(rr) : null,
      sidebarRightProtoKeys: rr ? safeProtoKeys(rr) : null,
      sidebarRightTabsType: tabs === undefined ? 'undefined' : typeof tabs,
      sidebarRightTabsOwnKeys: tabs ? safeKeys(tabs) : null,
      sidebarRightTabsProtoKeys: tabs ? safeProtoKeys(tabs) : null,
      // 逐个探方法是否存在（不看原型链继承下来的，直接 typeof）
      methodTypes: {
        'sidebarRight.openTabIn': typeof rr?.openTabIn,
        'sidebarRight.openTab': typeof rr?.openTab,
        'sidebarRight.openResource': typeof rr?.openResource,
        'sidebarRight.tabsIn': typeof rr?.tabsIn,
        'sidebarRight.mounted': typeof rr?.mounted,
        'sidebarRight.active': typeof rr?.active,
        'sidebarRight.tabDomain': typeof rr?.tabDomain,
        'sidebarRightTabs.register': typeof tabs?.register,
      },
    },
  };

  try {
    globalThis.localStorage?.setItem('vocab-study.diag', JSON.stringify(diag));
  } catch {
    /* 写不进去就算了，下面还有 console */
  }
  try {
    console.warn(
      '[vocab-study] 没能打开「今日背单词」标签页。逐条结果：\n' +
        report.join('\n') +
        '\n  现场：\n' +
        `    sessionId           = ${JSON.stringify(sessionId)}\n` +
        `    sidebarRight        = ${rr === undefined ? 'undefined' : typeof rr}\n` +
        `    sidebarRight 自有键 = ${JSON.stringify(rr ? safeKeys(rr) : null)}\n` +
        `    sidebarRight 原型键 = ${JSON.stringify(rr ? safeProtoKeys(rr) : null)}\n` +
        `    sidebarRightTabs 键 = ${JSON.stringify(tabs ? safeKeys(tabs) : null)}\n` +
        `    sidebarRightTabs 原型 = ${JSON.stringify(tabs ? safeProtoKeys(tabs) : null)}\n` +
        `    scope 自有键        = ${JSON.stringify(scope ? safeKeys(scope) : null)}\n` +
        `    scope 原型键        = ${JSON.stringify(scope ? safeProtoKeys(scope) : null)}\n` +
        '  （同样内容已写入 localStorage["vocab-study.diag"]）',
    );
  } catch (diagErr) {
    console.warn('[vocab-study] 打开标签页失败，且打印现场时又出错：', diagErr);
  }
  return false;
}

/**
 * 拿到本窗口唯一的内核（异步）。
 *
 * 第一次调用会触发建内核 + init()；之后的调用共享同一个 Promise。
 * 返回 null = 还没就绪，调用方先渲染空壳即可 —— init() 完成时会 emit()，
 * 而面板/胶囊都订阅了，于是会自动重画。
 */
function useCore() {
  const [core, setCore] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    coreFor().then(
      (c) => {
        if (alive) setCore(c);
      },
      () => {
        /* 失败已在 coreFor 里 log 过；这里什么也不做，界面留空 */
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return core;
}

/**
 * 胶囊：输入框右侧那一枚。
 *
 * `openTab` 这个 prop 由 `apply` 里注册时的 `inject` 提供（见 VocabMenuItem 上方注释）——
 * **不要**在这里找 `ctx`，组件 props 里从来没有 `ctx`。
 */
function CapsuleSeat(props) {
  const { openTab } = props;
  // 所有对话共用同一个内核（见 coreFor 上方【事故十一】）
  const core = useCore();

  const { hostRef } = usePuppet(
    (hostEl) =>
      createCapsulePuppet({
        core,
        // 木偶会往这个容器里 append 胶囊按钮；容器由 React 渲染，此时已在 DOM 里
        mountTo: hostEl,
        onOpen: () => {
          openTab?.();
        },
      }),
    [core, openTab],
    core,
  );

  return React.createElement('div', {
    ref: hostRef,
    className: 'vs-capsule-seat',
    'data-slot': 'conversation.input.right',
  });
}

/** 标签页正文：整块面板。 */
function VocabPane(props) {
  const { toast } = props;
  const core = useCore();

  const { hostRef } = usePuppet(
    (hostEl) =>
      createPanelPuppet({
        core,
        // ⚠️ 这一行曾经漏掉：mountTo 是 undefined 时 puppet.mjs 直接跳过 append，
        // 于是面板画在一个游离节点上 —— 标签页里空空如也，且不报错。
        mountTo: hostEl,
        host: {
          toast: typeof toast === 'function' ? toast : () => {},
          isWide: () => true,
          getDocked: () => true,
          onEscape: () => {},
          onToggleDock: () => {},
        },
      }),
    [core],
    core,
  );

  return React.createElement('div', { ref: hostRef, className: 'vs-pane-host' });
}

/** 标签页标题（出现在标签 chip 上）。 */
function VocabTitle() {
  return React.createElement('span', { className: 'vs-tab-title' }, '今日背单词');
}

/**
 * 标签页菜单里的一条入口。
 *
 * `openTab` 由注册时的 `inject` 提供。宿主渲染器的契约（ui-renderer 的 runInject）：
 *
 *     const inject = entry.inject;
 *     if (!inject) return EMPTY_INJECTED_PROPS;
 *     return bindInjectSources(inject(...args));
 *
 * 返回值会被展开进组件 props（`jsx(Comp, { ...kit, ...injected, ... })`）。
 * **这是插件往自己的槽位组件里传能力的唯一正规途径** —— 组件 props 里没有 `ctx`。
 */
function VocabMenuItem(props) {
  const { openTab } = props;
  return React.createElement(
    'button',
    {
      type: 'button',
      className: 'vs-menu-item',
      onClick: () => {
        openTab?.();
      },
    },
    '今日背单词',
  );
}

/**
 * 左侧边栏底部的「眼熟小组件」。
 *
 * 注意：这里**只处理左侧边栏版本**。插件面板中间的版本由 ui/panel.mjs
 * 里的 createPanel 直接渲染，避免把 React 依赖卷进面板那套纯 DOM 逻辑。
 */
function EyeCandySeat() {
  const core = useCore();
  const [tick, setTick] = React.useState(0);
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    if (!core) return;
    const unsub = core.app.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, [core]);

  const words = React.useMemo(() => {
    if (!core) return [];
    return core.app.todayStudiedWords?.() || [];
  }, [core, tick]);

  const cfg = React.useMemo(() => core?.app.state.settings?.eyeCandy, [core, tick]);

  React.useEffect(() => {
    if (!words.length) return;
    setIndex(Math.floor(Math.random() * words.length));
  }, [words.length]);

  React.useEffect(() => {
    if (!words.length) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), 8000);
    return () => clearInterval(id);
  }, [words.length]);

  if (!core) return null;
  if (!cfg?.showInSidebar) return null;
  if (!words.length) return null;

  const w = words[index % words.length];
  return React.createElement(
    'div',
    { className: 'vs-eye-candy vs-eye-candy-compact' },
    [
      React.createElement('div', { key: 'l', className: 'vs-eye-label' }, '今天背过的词'),
      React.createElement('div', { key: 'w', className: 'vs-eye-word' }, w.word || ''),
      React.createElement('div', { key: 'p', className: 'vs-eye-phonetic' }, w.ipa || ''),
      React.createElement('div', { key: 'm', className: 'vs-eye-meaning' }, w.meaning || ''),
    ],
  );
}

/**
 * 插件安装。
 *
 * `inject` 里声明的服务由框架在 apply 之前解析好；少了哪个，
 * `ctx.<那个服务>` 就是 undefined（不是"自然缺失"，是访问即抛错）。
 * 所以 inject 必须写全，见文件末尾的 `inject` 导出。
 *
 * ⚠️ 但**声明了不等于根 ctx 上就有**。`ctx.inject([...], scope => ...)` 给出的
 * `scope` 才是携带服务的那一层。这一条是「事故四」的核心，见 openVocabTab 注释。
 */
export function apply(ctx) {
  // ── 0. 先把样式注入一次 ────────────────────────────────────
  // 插件形态没有 <style> 可用，样式被构建脚本包成字符串常量。
  // 只注入一次；重复加载不会堆出多份（P8：不改不该改的东西）。
  injectVocabStudyCss();

  // ── 1. 收尾 + 标签页类型声明 ───────────────────────────────
  // 这两个都不依赖"往槽位里注册东西"，所以放在最外层用 `ctx.effect`。
  // （`scope` 上有没有 `effect` 我没去赌 —— 能确定可用的入口就用确定的那个。）
  ctx.effect(
    () => {
      const disposers = [];

      // 插件卸载时把内核放掉（放锁 + 清缓存，下次 apply 会重新建）。
      // 注意这里只有**一个**内核（一个窗口一份，见 coreFor 上方【事故十一】），
      // 不再是每个对话一个。
      disposers.push(() => {
        const pending = corePromise;
        corePromise = null;
        if (!pending) return;
        pending
          .then((core) => {
            try {
              core.store?.releaseLock?.();
            } catch {
              /* 忽略 */
            }
          })
          .catch(() => {
            /* 建内核失败过，没东西要放 */
          });
      });

      // 声明标签页类型。没有 patterns：它不是靠地址打开的资源，而是按 kind 打开的「页」。
      //
      // 这圈 try 不是"防御性编程"的摆设：`sidebarRightTabs` 是**宿主发布的服务**，
      // 万一宿主哪天改了服务名或没发布，这里就是 undefined 上的属性访问，
      // 会把整个 apply 打挂、fiber 永远停在 LOADING，最后变成
      // 「web boot: 1 entry did not activate」把整页拦在启动页（真实事故一）。
      // 标签页类型注册不上，顶多是少一个入口，绝不该是"整个客户端用不了"。
      try {
        const disposeTabType = ctx.sidebarRightTabs.register({
          id: TAB_KIND,
          kind: TAB_KIND,
          priority: 'builtin',
          title: () => '今日背单词',
        });
        if (typeof disposeTabType === 'function') disposers.push(disposeTabType);
      } catch (err) {
        console.warn('[vocab-study] 标签页类型注册失败，插件其余部分继续工作：', err);
      }

      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 忽略：清理失败不该影响卸载 */
          }
        }
      };
    },
    'vocab-study: lifecycle',
  );

  // ── 2. 所有需要宿主服务的动作，都在这圈 scope 里做 ─────────
  //
  // 为什么必须包这一圈：**服务在 scope 上，不在根 ctx 上**。
  // 之前写成 `ctx.sidebarRight` 恒为 undefined，`ctx.sidebarRightTabs` 同理，
  // 于是"点胶囊开标签页"这类能力全部静默失效（点下去什么都不发生）。
  //
  // 这圈也不是"防御性编程"的摆设：scope 里某个服务没发布时，`scope.X.register`
  // 是 undefined 上的属性访问、同步抛错，会把整个 apply 打挂、fiber 停在 LOADING，
  // 最后变成「web boot: 1 entry did not activate」把整页拦在启动页（真实事故一）。
  // 所以下面每一处注册都各自包 try —— 少一个入口，绝不该是"整个客户端用不了"。
  ctx.inject(['slots', 'sidebarRightTabs', 'sidebarRight'], (scope) => {
    /**
     * 把"打开标签页"这一能力做成一个闭包，再通过槽位的 `inject` 交给组件。
     *
     * `scope` 和 `sessionId` 都被封在这里面 —— 组件不需要、也拿不到 `ctx`。
     */
    const openTabFor = (sessionId) => () => openVocabTab({ scope }, sessionId);

    // ── 2a. 席位一：输入框右侧的胶囊 ────────────────────────
    scope.slots.inject('conversation.input.right', () =>
      scope.slots.register(
        {
          name: 'conversation.input.right',
          id: 'vocab-study-capsule',
          order: CAPSULE_ORDER,
          // 返回值会变成组件 props（宿主 ui-renderer 的 runInject 契约）。
          // 组件的标准 props 里已经带了 sessionId，这里补上它需要的能力。
          inject: (sessionId) => ({
            openTab: openTabFor(sessionId),
          }),
        },
        CapsuleSeat,
      ),
    );

    // ── 2c. 席位二：标签页正文 + 标题 + 菜单入口 ────────────
    scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_KIND }, VocabPane),
    );
    scope.slots.inject('sidebar.right.pane.tab.title', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_KIND }, VocabTitle),
    );
    scope.slots.inject('sidebar.right.tab.menu.item', () =>
      scope.slots.register(
        {
          name: 'sidebar.right.tab.menu.item',
          id: 'vocab-study-open',
          order: 20,
          label: '今日背单词',
        },
        VocabMenuItem,
      ),
    );

    // 眼熟小组件：默认关闭，用户可在设置里开到左侧边栏底部
    scope.slots.inject('sidebar.footer.action', () =>
      scope.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'vocab-study-eye-candy',
          order: 10,
          label: '今日眼熟',
        },
        EyeCandySeat,
      ),
    );
  });
}

// 框架用的依赖声明。**必须是服务名**（不是包名）—— 服务名由提供方用
// `ctx.reflect.provide("sidebarRightTabs", ...)` 发布，inject 里少写一个，
// `ctx.<服务名>` 就是 undefined（宿主 scheduler 插件的 inject 用的是同一批名字）。
//
// 这三个都是硬需求：少了任何一个，apply 里对应那行就是 undefined 上的属性访问，
// 同步抛错 → fiber 停在 LOADING → 客户端启动审计失败（见 openVocabTab 的注释）。
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']; 

/*
 * ── 工厂契约（构建脚本负责套上）────────────────────────────────
 *
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-vocab-study',
 *     factory(require) {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       // ...本文件与 core/ ui/ store/ 的全部源码（已摊平进同一作用域）...
 *       return module.exports;
 *     },
 *   });
 *
 * 工厂里 `require('react')` 由宿主解析；其它一切都被摊平，没有运行时依赖。
 */
