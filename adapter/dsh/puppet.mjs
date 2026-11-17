// vocab-study / adapter / dsh / puppet.mjs
//
// 「木偶」：把插件状态变成两个**不依赖 React、不碰全局**的 DOM 契约。
//
//   createCapsulePuppet({ storage, ports })  → { root, render(), destroy() }
//   createPanelPuppet({ storage, ports })     → { root, render(), destroy(), focus() }
//
// 为什么要拆成这样：DSH 的客户端插件跑在 `__ModuleLoader__` 的工厂里，只能
// require('react') 和 ctx 服务；而 demo/预览形态是一个自包含 HTML。两种形态
// 用的是**同一份** core 与 ui 源码，差异只集中在这一层和 React 外壳里。
// 这样既不用为插件重写一份界面，也不会让界面逻辑渗进框架细节。

import { createApp } from '../../core/app.mjs';
import { createPanel, hostScheme, watchHostTheme } from '../../ui/panel.mjs';
import { createCapsule } from '../../ui/capsule.mjs';
import { speak, speechAvailable, stopSpeaking } from '../../core/speech.mjs';
import { createStorage, createMemoryStorage } from '../../store/client-store.mjs';

/**
 * 读 DSH 主题。
 *
 * 0.3.6 修过一次：原来这里读的是 `documentElement.dataset.theme` / `.light`，
 * 但 DSH 的主题运行时**不写**这两个东西 —— 它写 `style.colorScheme` +
 * `body[data-ds-dark-theme]`。所以那个判断永远返回 'dark'，真宿主里
 * 「跟随主题」形同虚设、主题插件完全跟不上。
 * 现在统一走 ui/panel.mjs 的 hostScheme()（信号强弱 + 底色亮度兜底），
 * 这里只留一个「宿主给不出任何信号时」的兜底。
 */
function readTheme(root) {
  try {
    const doc = root && root.ownerDocument ? root.ownerDocument : null;
    // hostScheme() 读的是全局 document；挂载点属于哪个文档就临时用它
    if (doc && typeof doc !== 'undefined' && doc !== globalThis.document) {
      if (doc.body && doc.body.hasAttribute && doc.body.hasAttribute('data-ds-dark-theme')) return 'dark';
      const scheme = (doc.documentElement && doc.documentElement.style && doc.documentElement.style.colorScheme) || '';
      if (scheme === 'light' || scheme === 'dark') return scheme;
      return 'dark';
    }
    return hostScheme();
  } catch {
    return 'dark';
  }
}

/**
 * 统一的「应用内核」：app + storage + 订阅。胶囊和面板共享同一个实例，
 * 这样点胶囊开始背词时，面板里立刻就是同一张卡。
 *
 * @param {object} opts
 * @param {object} opts.storage            storage port（缺省用 localStorage 版）
 * @param {() => boolean} opts.isStreaming 模型是否正在输出（规格 §3.1 交接态）
 */
export function createVocabCore({ storage, isStreaming = () => false, fetcher = null, now } = {}) {
  const store = storage || createStorage({});
  const app = createApp({
    storage: store,
    fetcher,
    isStreaming,
    ...(now ? { now } : {}),
  });
  return { app, store, isStreaming };
}

/**
 * 胶囊木偶。只负责画自己；点它做什么由外面决定（打开标签页 or 弹面板）。
 *
 * @param {object} opts
 * @param {() => void}  opts.onOpen   点击后要发生的事
 * @param {object}      opts.core     createVocabCore 的返回值
 * @param {HTMLElement} opts.mountTo  挂到哪个容器里（给了就 append 进去）
 */
export function createCapsulePuppet({ core, onOpen, mountTo } = {}) {
  const capsule = createCapsule({
    onToggle: () => {
      if (typeof onOpen === 'function') onOpen();
    },
  });

  // 和面板一样：容器不在 DOM 里就画不出来，而且不报错。
  // 两种形态都支持 —— 给了 mountTo 就 append；没给就把 root 交回调用方。
  if (mountTo && typeof mountTo.appendChild === 'function') mountTo.appendChild(capsule.root);

  let unsub = null;
  let bound = false;

  function sync() {
    try {
      capsule.render(core.app.beckon());
    } catch {
      // 胶囊画不出来绝不能影响对话区（P8 不劫持）
    }
  }

  // 只在有订阅能力时订阅；没有就靠外部 render() 推
  try {
    if (core.app && typeof core.app.subscribe === 'function') {
      unsub = core.app.subscribe(sync);
      bound = true;
    }
  } catch {
    bound = false;
  }
  sync();

  return {
    ...capsule,
    render: sync,
    /** 外部状态变了（比如主题切换）时推一把 */
    refresh: sync,
    destroy() {
      try {
        if (bound && typeof unsub === 'function') unsub();
      } catch {
        /* 忽略 */
      }
      capsule.destroy();
      // 自己挂上去的，就自己摘掉 —— 否则容器重建时会叠出第二个胶囊
      try {
        if (capsule.root && capsule.root.parentNode) {
          capsule.root.parentNode.removeChild(capsule.root);
        }
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 面板木偶。负责把一个完整的「今日背单词」面板挂进给定容器。
 *
 * @param {object} opts
 * @param {object} opts.core
 * @param {HTMLElement} opts.mountTo  挂到哪里（DSH 给标签页正文容器）
 * @param {object} opts.host          { toast, onEscape, getDocked, isWide, onToggleDock }
 */
export function createPanelPuppet({ core, mountTo, host = {} } = {}) {
  const app = core.app;
  let theme = readTheme(mountTo);

  const panel = createPanel(app, {
    theme,
    // 每次渲染现问宿主是什么主题（而不是创建时定一次）
    getScheme: () => readTheme(mountTo),
    getDocked: host.getDocked || (() => true),
    isWide: host.isWide || (() => true),
    toast: host.toast || (() => {}),
    onEscape: host.onEscape || (() => {}),
    onToggleDock: host.onToggleDock || (() => {}),
    // ⚠️ 这一项原来漏了，于是「单词右边的播放键」是个死键：
    // 用户实测点下去 speechSynthesis.speak() 调用数 0→0，界面上毫无反应。
    // 界面层点单词会调 ctx.onSpeak(word)，而它一直没人传。
    // 默认值直接用本文件已经导入的 speak()，返回 boolean 供界面层给反馈。
    onSpeak: host.onSpeak || ((word) => speak(word)),
  });

  if (mountTo && typeof mountTo.appendChild === 'function') mountTo.appendChild(panel.root);

  // 真宿主里切主题（设置页切浅色/深色、切「跟随系统」、主题插件热更）要即时反映到面板。
  // 只挂在 demo 外壳里是不够的 —— 用户用的是这条路径。
  const stopThemeWatch = watchHostTheme(() => panel);

  /** init 可能已经在别处跑过（胶囊先开了面板）；这里幂等。 */
  async function ensureReady() {
    if (!app.raw || app.raw.ready) return;
    try {
      await app.init();
    } catch {
      // 初始化失败不该白屏：面板会用自己的空态/降级文案顶上（P7 数据诚实）
    }
    panel.render();
  }

  void ensureReady();

  return {
    ...panel,
    root: panel.root,
    /** 宿主主题变了就同步过去 */
    setTheme(t) {
      theme = t === 'light' ? 'light' : 'dark';
      panel.setTheme(theme);
    },
    /** DSH 的读书页焦点可能被框架改掉，这里显式要回焦点（§14.1） */
    focus() {
      panel.focus();
    },
    destroy() {
      try {
        if (typeof stopThemeWatch === 'function') stopThemeWatch();
      } catch {
        /* 忽略 */
      }
      try {
        stopSpeaking();
      } catch {
        /* 忽略 */
      }
      panel.destroy();
      if (panel.root && panel.root.parentNode) panel.root.parentNode.removeChild(panel.root);
    },
  };
}

/** 供适配层用的能力探测：朗读有没有得用，决定卡上要不要画喇叭。 */
export function speech() {
  return { available: speechAvailable(), speak, stop: stopSpeaking };
}

export { createStorage, createMemoryStorage };
