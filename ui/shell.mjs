// vocab-study / ui / shell.mjs
// demo 外壳：在浏览器里搭出 DSH 的样子，好让胶囊和面板能真的被点、被看。
//
// 这一层只属于 demo / 预览，不属于插件本体。
// 插件形态下，胶囊由 adapter/dsh/client.js 注册进 conversation.input.right，
// 面板注册进 sidebar.right.pane.tab —— 位置与这里的 DOM 顺序一一对应。

import { createApp } from '../core/app.mjs';
import { createPanel } from './panel.mjs';
import { createCapsule } from './capsule.mjs';
import { speak } from '../core/speech.mjs';

/**
 * 启动 demo。单文件形态下由构建产物末尾调用；ESM 形态下也可直接 import 使用。
 */
export async function boot(mountPoint) {
  const mp = mountPoint || (typeof document === 'undefined' ? null : document.getElementById('dsh-root'));
  if (!mp) return null;

  // 出错了要看得见。
  // 之前没有这一段，启动一抛错就是整片黑屏、什么线索都没有，
  // 只能靠猜（为此白绕了好几圈）。现在错误直接铺在页面上。
  try {
    return await bootInner(mp);
  } catch (err) {
    const box = document.createElement('pre');
    box.id = 'vs-boot-error';
    box.style.cssText =
      'position:fixed;inset:0;margin:0;padding:16px;overflow:auto;z-index:99999;' +
      'background:#2A1010;color:#FFD9D4;font:12px/1.6 Consolas,Menlo,monospace;white-space:pre-wrap;';
    box.textContent =
      '启动失败（demo 外壳）\n\n' +
      String(err && err.message) +
      '\n\n' +
      String((err && err.stack) || '') +
      '\n\n提示：这类错在真实插件里表现为「界面不出现」，所以直接显示出来。';
    document.body.appendChild(box);
    return null;
  }
}

async function bootInner(mp) {
  // ── 1. 演示用的持久化（真插件里换成 JSONL + 快照，见 store/client-store.mjs）──
  const storage = demoStorage('vocab-study-demo');

  // ── 2. 让 demo「有历史」：第一次打开时补一段过去的记录，好看到连续天数 ──
  await seedDemoHistory(storage);

  const app = createApp({
    storage,
    fetcher: null, // 演示走内置种子词库：不依赖网络就能开背（P6）
    isStreaming: () => window.__dshStreaming === true,
  });

  await app.init();

  // ── 3. 外壳 DOM：对话区 + 输入框工具栏 + 右侧栏 ──
  const shell = document.createElement('div');
  shell.className = 'dsh-demo';
  shell.innerHTML = [
    '<div class="dsh-top">',
    '  <span class="logo">DeepSeek Harness</span>',
    '  <span class="dim">demo · 今日词汇插件预览</span>',
    '</div>',
    '<div class="dsh-main">',
    '  <div class="dsh-chat">',
    '    <div class="dsh-scroll" id="dsh-scroll">',
    '      <div class="dsh-msg user"><div class="who">你</div><div class="body">帮我把 weather-deck 的 spec 改成 8 页。</div></div>',
    '      <div class="dsh-msg"><div class="who">Harness</div><div class="body">好，我先把 8 页的骨架列出来，再逐页填。</div></div>',
    '    </div>',
    '    <div class="dsh-composer" id="dsh-composer">',
    '      <div class="dsh-hint" id="dsh-hint">提示：点胶囊开始背词。焦点在输入框时按 1 / 2 / 3 不会有任何反应 —— 这是故意的。</div>',
    '      <div class="dsh-input">',
    '        <textarea id="dsh-ta" rows="1" placeholder="交代点什么，或者点右边的胶囊背两个词…"></textarea>',
    '      </div>',
    '      <div class="dsh-toolbar">',
    '        <button class="dsh-seat" id="seat-perm">📜 权限 ▾</button>',
    '        <div class="dsh-seat-group-right" id="dsh-right-group">',
    '          <button class="dsh-send" title="发送">↑</button>',
    '        </div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="dsh-side" id="dsh-side">',
    '    <div class="tabs"><span data-on="1">今日背单词</span><span>文件</span><span>终端</span></div>',
    '    <div class="pane" id="dsh-pane"></div>',
    '  </div>',
    '</div>',
  ].join('\n');
  mp.appendChild(shell);

  // 对话文案可被调用方覆盖（截图/演示用），走 window.__vsChat。
  //
  // 为什么不用 DOM 里的 <script type="application/json"> 槽位：踩过两个坑 ——
  //   ① 把 <script> 塞进 innerHTML 的字符串数组里，HTML 解析器不执行它，
  //      而且会把那段 JS 字符串吃进页面文字，直接 SyntaxError；
  //   ② 用 Page.addScriptToEvaluateOnNewDocument 往里写，那时 document.head
  //      还不存在，appendChild 抛 null。
  // window 上的钩子没有这两个问题：脚本在 documentStart 跑，外壳在 boot 时读。
  try {
    const custom = window.__vsChat;
    if (custom && Array.isArray(custom.messages)) {
      const scroll0 = shell.querySelector('#dsh-scroll');
      if (scroll0) {
        scroll0.innerHTML = custom.messages
          .map((m) =>
            m.who
              ? `<div class="dsh-msg user"><div class="who">${m.who}</div><div class="body">${m.body}</div></div>`
              : `<div class="dsh-msg"><div class="who">Harness</div><div class="body">${m.body}</div></div>`
          )
          .join('');
      }
    }
    if (custom && typeof custom.subtitle === 'string') {
      const dim = shell.querySelector('.dsh-top .dim');
      if (dim) dim.textContent = custom.subtitle;
    }
    if (custom && custom.hideHint) {
      const h = shell.querySelector('#dsh-hint');
      if (h) h.style.display = 'none';
    }
  } catch {
    /* 文案是可选的，坏了就当没塞，不影响背词 */
  }

  const composer = shell.querySelector('#dsh-composer');
  const rightGroup = shell.querySelector('#dsh-right-group');
  const ta = shell.querySelector('#dsh-ta');
  const side = shell.querySelector('#dsh-side');
  const pane = shell.querySelector('#dsh-pane');
  const scroll = shell.querySelector('#dsh-scroll');
  const hintEl = shell.querySelector('#dsh-hint');
  const setHint = (msg) => {
    if (hintEl) hintEl.textContent = msg;
  };

  // ── 4. 胶囊进 conversation.input.right（模型选择器正前方）──
  // 真实槽位顺序：permission → [左组] → [conversation.input.right: 我] → model
  const capsule = createCapsule({ onToggle: () => togglePanel() });
  const modelSeat = document.createElement('button');
  modelSeat.className = 'dsh-seat';
  modelSeat.textContent = '🧠 模型 ▾';
  rightGroup.insertBefore(capsule.root, rightGroup.firstChild);
  rightGroup.insertBefore(modelSeat, capsule.root.nextSibling);
  // 结果：… 权限    [胶囊][模型] ↑

  // ── 5. 面板 ──
  let docked = false;
  let panel = null;
  const isWide = () => shell.clientWidth >= 480; // 整窗过窄 → 浮卡模式，不钉侧栏（§2.4）

  function ensurePanel() {
    if (panel) return panel;
    panel = createPanel(app, {
      theme: document.documentElement.dataset.theme || 'dark',
      getDocked: () => docked,
      isWide,
      onClose: () => closePanel(),
      onToggleDock: () => setDocked(!docked),
      onEscape: () => {
        ta.focus();
        setHint('Esc：焦点已还给输入框。现在按 1 / 2 / 3 不会有任何反应。');
      },
      onSpeak: (word) => {
        const ok = speak(word);
        setHint(ok ? `🔊 ${word}` : '这个环境没有系统语音，发音先跳过（不影响背词）。');
      },
      toast: (msg) => setHint(msg),
    });
    return panel;
  }

  function openPanel() {
    const p = ensurePanel();
    if (docked) {
      side.classList.add('open');
      if (!pane.contains(p.root)) pane.appendChild(p.root);
    } else if (!composer.contains(p.root)) {
      composer.appendChild(p.root);
    }
    p.render();
    p.focus();
  }

  function closePanel() {
    if (panel) panel.root.remove();
  }

  function togglePanel() {
    if (panel && panel.root.isConnected) closePanel();
    else openPanel();
  }

  function setDocked(next) {
    docked = next;
    side.classList.toggle('open', docked);
    const p = ensurePanel();
    p.root.remove();
    if (docked) {
      pane.appendChild(p.root);
      p.render();
    } else {
      composer.appendChild(p.root);
      p.render();
    }
  }

  // 窄窗口降级 + 钉住不静默失效（§2.4）
  function applyWidth() {
    if (!panel) return;
    const w = shell.clientWidth;
    panel.root.classList.toggle('vs-compact', w < 520 && w >= 420);
    panel.root.classList.toggle('vs-tiny', w < 420);
    if (!isWide() && docked) {
      setDocked(false);
      setHint('窗口太窄了，先切回浮卡模式。');
    }
  }
  window.addEventListener('resize', applyWidth);

  // ── 6. 焦点归属演示：输入框吞掉 1/2/3 ──
  // 面板的键盘监听挂在面板元素上，所以这里不需要任何拦截代码。
  ta.addEventListener('focus', () => setHint('焦点在输入框：1 / 2 / 3 归你打字用，卡片一动不动。'));
  ta.addEventListener('input', () => {
    ta.style.height = '26px';
    ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
  });

  // ── 7. 情绪胶囊联动 ──
  function paint() {
    capsule.render(app.beckon());
  }
  app.subscribe(paint);
  paint();

  // ── 8. 自动演示「任务输出中」──
  // 原来这是一个「模拟任务输出」按钮，但按钮会让你分不清哪些是插件功能、
  // 哪些只是 demo 装饰。所以改成自动循环：打字 → 停 → 再打字。
  //
  // 为什么值得留：规格 §3.2 的「注意力交接态」靠 streamActive 驱动 ——
  // 任务在输出时，胶囊要变成「📖 学词中」并退到一边，不抢焦点、不跳转。
  // 没有这个模拟，那段行为在 demo 里就看不见了。
  // 真装进 DSH 后，这个状态由宿主真实的输出状态驱动，不需要模拟。
  const STREAM_LINES = (window.__vsChat && Array.isArray(window.__vsChat.streamLines) && window.__vsChat.streamLines.length)
    ? window.__vsChat.streamLines
    : [
        '正在重写 spec：第 1 页改成封面，第 2 页放趋势图，第 3 页…',
        '把这 8 页的骨架先搭出来，再逐页填内容。',
        '刚才那版第 5 页的图例位置不对，我重排一下。',
      ];
  let streamLine = 0;

  function runStreamCycle() {
    // 只有面板开着才演示，免得你根本没看面板时胶囊一直在那儿变
    if (!panel || !panel.root.isConnected) {
      setTimeout(runStreamCycle, 1200);
      return;
    }
    window.__dshStreaming = true;
    paint();

    const msg = document.createElement('div');
    msg.className = 'dsh-msg';
    msg.innerHTML = '<div class="who">Harness</div><div class="body stream"></div>';
    scroll.appendChild(msg);
    scroll.scrollTop = scroll.scrollHeight;

    const body = msg.querySelector('.body');
    const text = STREAM_LINES[streamLine % STREAM_LINES.length];
    streamLine += 1;
    let i = 0;
    const timer = setInterval(() => {
      body.textContent = text.slice(0, ++i);
      scroll.scrollTop = scroll.scrollHeight;
      if (i >= text.length) {
        clearInterval(timer);
        window.__dshStreaming = false;
        paint();
        // 停一会儿再下一轮，别让对话区无限变长
        setTimeout(() => {
          msg.remove();
          setTimeout(runStreamCycle, 1500);
        }, 2200);
      }
    }, 55);
  }

  applyWidth();
  // 刻意不自动打开面板：面板永不自作主张（P1）
  setTimeout(runStreamCycle, 1500);

  // demo 专用测试口子。
  //
  // 为什么需要：启动回归要验证「设置页拨一下开关，设置真的变了」——
  // 也就是 UI → app.updateSettings 这条路。但 app 是这里的局部变量，
  // 外面（node 测试、浏览器控制台）拿不到；而 VOCAB_CORE.A 只是
  // createApp 这个**工厂**，不是实例（core.A.raw 是 undefined）。
  //
  // 只挂在 demo 外壳里，**插件产物没有这段**：ui/shell.mjs 不在
  // build-plugin.py 的 UI_ORDER 里，所以它进不了 lib/client.js。
  try {
    window.__vsDemo = { app, openPanel, closePanel, capsule };
  } catch {
    /* 没有 window（比如某些测试环境）就算了，不影响界面 */
  }
  return { app, shell, openPanel, closePanel, capsule };
}

// ── demo 用的 localStorage 端口 ────────────────────────────
function demoStorage(key) {
  let mem = {};
  try {
    mem = JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch {
    mem = {};
  }
  const flush = () => {
    try {
      localStorage.setItem(key, JSON.stringify(mem));
    } catch {
      /* 存不下就算了，不影响使用（§14.5：磁盘不可写 → 只读模式，不清空已有数据） */
    }
  };
  return {
    async get(k) {
      return mem[k] ?? null;
    },
    async set(k, v) {
      mem[k] = v;
      flush();
    },
    append(k, row) {
      mem[k] = mem[k] || [];
      mem[k].push(row);
      flush();
    },
    list(k) {
      // 必须返回**副本**，不能把内部数组直接交出去。
      //
      // 踩过的坑（这个 bug 是我自己引进的）：init() 里加了
      //   state.records = storage.list('records')
      // 之后，如果 list 直接返回 mem[k] 这个引用，那么
      //   state.records === mem['records']  →  同一个数组
      // 而 writeRecord() 会
      //   state.records.push(row)        ← 第 1 次
      //   storage.append('records', row) ← mem['records'].push(row)，第 2 次
      // 于是**每答一题记录两条**，连 ts 都一样。
      // 症状：进度环走到 20/20，而「今天已背」显示 40。
      //
      // 真插件没这个问题：createMemoryStorage 是 .slice()、localStorage 版是
      // JSON.parse（都是新数组）。所以是**这个 demo 端口没遵守「list 返回副本」
      // 的约定**，而不是 core 的错。
      return (mem[k] || []).slice();
    },
  };
}

/**
 * 首次打开时补一段「过去 7 天」的记录，好让连续天数与热力图有东西可看。
 *
 * ⚠️ 这些数据必须写进 **`state` 这个 key 里的字段**，不能另开顶层 key。
 * 插件只读 `state` 与 `session`（见 createApp 的 init / persist），
 * 所以曾经写成 `set('records'|'streak'|'exp')` 的那一版等于写进了空气：
 * 97 条记录、7 天连击一个都没显示出来，界面看起来就像刚装好。
 * 字段名与形状照抄 persist() 里写的那份，别自己起名字。
 */
async function seedDemoHistory(storage) {
  if (await storage.get('demoSeeded')) return;
  const now = Date.now();
  const DAY = 86400000;
  const words = ['cet4:abandon', 'cet4:adapt', 'cet4:affect', 'cet4:adopt', 'cet4:effect'];
  const records = [];
  for (let d = 7; d >= 1; d--) {
    const base = now - d * DAY;
    const n = 8 + ((d * 5) % 11);
    for (let i = 0; i < n; i++) {
      const wrong = i % 4 === 0;
      records.push({
        ts: base - i * 60000,
        dayKey: dk(base),
        wordId: words[i % words.length],
        mode: i % 5 === 0 ? 'quiz' : 'recognize',
        selfRating: wrong ? 'forgot' : i % 7 === 0 ? 'fuzzy' : 'known',
        correct: !wrong,
        incorrect: wrong,
        fakeMastery: i % 9 === 0,
        reactionMs: 2000 + i * 60,
        hintUsed: false,
        confusedWith: wrong ? 'cet4:abundant' : null,
        cardId: `seed${d}-${i}`,
        sessionId: `seeds${d}`,
        queueSnapshotId: 'seed',
        tier: i % 3 === 0 ? 3 : 1,
        schemaVersion: 1,
      });
    }
  }

  // 热力图读的是 state.records（heatmap() 按 dayKey 数每天几条）；连击/经验读 state.streak / state.exp。
  // 前 7 天逐日打卡，今天还没开始。
  const days = [];
  for (let back = 7; back >= 1; back--) {
    days.push({ key: dk(now - back * DAY), done: true });
  }

  const saved = (await storage.get('state')) || {};
  await storage.set('state', {
    ...saved,
    streak: { current: 7, longest: 7, lastDay: dk(now - DAY), totalDays: 7 },
    exp: 268,
    // history 只喂「连续 3 天完成 → 自动回到 N」（effectiveBaseN），
    // 热力图不看它。写成 {days:[{key,done}]}，别跟 records 的 {dayKey} 混。
    history: { days },
  });
  // ⚠️ 这份记录必须写成**顶层 records**：heatmap() 靠 storage.append('records')
  // 积累、init() 靠 storage.list('records') 读回。写成 state.records 反而读不到。
  await storage.set('records', records);
  await storage.set('demoSeeded', true);
}

function dk(ts) {
  const d = new Date(ts - 4 * 3600000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
