// vocab-study / ui / panel.mjs
// 学习面板：今日 / 进度 / 生词本 / 设置。
//
// ── 焦点纪律（规格 §14.1，最高优先级）────────────────────────
// 键盘快捷键只挂在面板自己的元素上（tabindex=0 + keydown），
// 绝不监听 document。于是「焦点在输入框时 1/2/3 绝不改动卡片」是结构性成立的，
// 不是靠一个 if 判断运气好。
//
// 反例（规格原文）：用户对着输入框打字时敲下 1，后台卡片被标成「忘了」
// 并写入 DP 模型 —— 静默污染学习记录。

import { el, mount, clear, setText, focusSelf, prefersReducedMotion } from './dom.mjs';
import { renderProgress, renderVocab, renderSettings, renderWeeklyReport, heatmap, collectionLabel } from './pages.mjs';
import { createEyeCandy } from './eye-candy.mjs';

const TABS = [
  ['today', '今日'],
  ['progress', '进度'],
  ['vocab', '生词本'],
  ['settings', '设置'],
];

export function createPanel(app, ctx = {}) {
  const isDocked = () => ctx.getDocked && !!ctx.getDocked();

  const root = el('div', { class: 'vs vs-panel', tabindex: '0', 'data-theme': ctx.theme || 'dark' });
  const head = el('div', { class: 'vs-head' });
  const banner = el('div', { class: 'vs-banner' });
  const tabs = el('div', { class: 'vs-tabs', role: 'tablist' });
  const body = el('div', { class: 'vs-body' });
  const foot = el('div', { class: 'vs-foot' });
  root.append(head, banner, tabs, body, foot);

  let activeTab = 'today';
  let lastCardKey = null; // 只在「换词」时重建卡片 DOM，其它更新走 setText
  let lastRevealKey = null;
  let undoCardKey = null;
  let undoUntil = 0;
  let disposed = false;
  let eyeCandyTimer = null;

  // ── 行为 ────────────────────────────────────────────────

  function rate(rating) {
    const st = app.state;
    if (!st.card || st.lastReveal) return;
    const t0 = performance.now();
    app.rate(rating, { reactionMs: Math.round(t0 - cardShownAt) });
    undoUntil = Date.now() + 2000; // 2 秒内可撤销（§5.2）
    undoCardKey = st.card.cardId;
    render();
  }

  let cardShownAt = performance.now();

  function next() {
    app.next();
    cardShownAt = performance.now();
    render();
    // 揭晓后把焦点给「下一张」，空格键顺手可用
    const b = body.querySelector('[data-act="next"]');
    if (b) focusSelf(b);
  }

  function undo() {
    app.undo();
    undoUntil = 0;
    render();
  }

  function setTab(t) {
    activeTab = t;
    render();
  }

  function togglePin() {
    const wide = ctx.isWide ? ctx.isWide() : true;
    if (!wide) {
      // 窄窗口下钉住不静默失效，而是明说（§2.4）
      ctx.toast?.('📌 需要更宽的窗口');
      return;
    }
    ctx.onToggleDock?.();
    render();
  }

  // ── 键盘：只在面板持有焦点时生效 ────────────────────────
  root.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLSelectElement) return;
    const st = app.state;
    const revealed = !!st.lastReveal;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      // 焦点还给输入框（§14.1）
      ctx.onEscape?.();
      return;
    }
    if (st.card && !revealed) {
      if (ev.key === '1' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        return rate('forgot');
      }
      if (ev.key === '2') {
        ev.preventDefault();
        return rate('fuzzy');
      }
      if (ev.key === '3' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        return rate('known');
      }
    }
    if (ev.key === ' ' || ev.key === 'Enter') {
      if (revealed) {
        ev.preventDefault();
        next();
      } else if (!st.card) {
        ev.preventDefault();
        setTab('today');
      }
    }
    if (ev.key === 'z' && revealed && Date.now() < undoUntil) {
      ev.preventDefault();
      undo();
    }
  });

  // 一点微妙的暗示：面板拿到焦点时加一圈极淡的内描边，让用户知道「键归我管了」
  root.addEventListener('focusin', () => root.classList.add('vs-focused'));
  root.addEventListener('focusout', () => {
    // 焦点离开面板整体才撤销（内部元素间跳转不算）
    setTimeout(() => {
      if (!root.contains(document.activeElement)) root.classList.remove('vs-focused');
    }, 0);
  });

  // ── 渲染 ────────────────────────────────────────────────

  function render() {
    if (disposed) return;
    // 样式兜底（2026-10-27，真机上"面板突然变成一个巨大黑圆"就是这条引起的）：
    // <style data-vocab-study> 只在 apply 时注入一次，之后没人再看它。
    // 宿主热重载、页签搬移、或本就挂在 ShadowRoot 里时，这份样式可能压根不在当前
    // 那棵树上 —— 一旦丢了，SVG 退回"无尺寸 + 默认黑色填充"，就成了盖满面板的黑圆。
    // 所以每次渲染顺手确认一次（命中已存在就只做一次 querySelector，没有额外开销）。
    if (typeof injectVocabStudyCss === 'function') injectVocabStudyCss(undefined, root);
    const st = app.state;
    root.className = `vs vs-panel ${isDocked() ? 'docked' : 'floating'}`;
    root.dataset.theme = ctx.theme || 'dark';

    // 顶栏
    mount(
      head,
      el('span', { class: 'vs-title', text: '今日背单词' }),
      el('button', { class: 'vs-iconbtn', title: isDocked() ? '取消钉住' : '钉住到右侧栏', 'aria-label': '钉住', onclick: togglePin }, isDocked() ? '📌' : '📍'),
      el('button', { class: 'vs-iconbtn', title: '收起（Esc）', 'aria-label': '收起', onclick: () => ctx.onClose?.() }, '✕'),
    );

    // 一行灰字：词库 / 离线 / 只读 / 另一个窗口正在学 —— 全部不解释（§14.5）
    //
    // ⚠️ 词库名必须放在**第一个**。用户报「我主页今日这里并没有显示我用的是
    // 哪个词库，这样我就不知道我到底用的是哪个」—— 这条灰字原来只说"离线模式"，
    // 用户换完库回到今日页，界面上没有任何东西能告诉他换成了没有。
    // 词库名比"离线模式"重要得多，所以排在最前面（窄侧栏会被省略号截断时，
    // 留下来的也是词库名）。
    const banners = [];
    const libName = collectionLabel(st);
    if (libName) banners.push(`词库 · ${libName}`);
    if (st.readOnly) banners.push('另一个窗口正在学');
    if (st.offline) banners.push('离线模式 · 用内置词表');
    else if (st.banner) banners.push(st.banner);
    setText(banner, banners.join(' · '));
    banner.hidden = banners.length === 0;

    // 页签
    mount(
      tabs,
      TABS.map(([k, label]) =>
        el('button', {
          class: 'vs-tab',
          role: 'tab',
          'aria-selected': activeTab === k ? 'true' : 'false',
          onclick: () => setTab(k),
        }, label),
      ),
    );

    // 主体
    if (activeTab === 'today') renderToday(body, st);
    else if (activeTab === 'progress') renderProgress(body, st, app);
    else if (activeTab === 'vocab') renderVocab(body, st, app);
    else renderSettings(body, st, app);

    // 底部：连击 + 今日进度
    //
    // 分子优先用 st.covered（这一轮覆盖了多少个**不同的词**），理由有两条，
    // 都是实测踩出来的：
    //
    // ① 不能用 session.stats.answered —— 它数的是"卡"，重训会让 20 个词变成 60，
    //    和"词"为单位的分母一除就是「60/20」。详见 core/app.mjs 里 covered 那段注释。
    //
    // ② **不能优先用 container.done。**（2026-10-13 修，用户实测报的）
    //    container.done 只在 settle() 里写，也就是**一轮走完**才更新。
    //    所以用户点「再背一轮」之后，新一轮从 0 开始，而 container.done 还停
    //    在上一轮的成绩上：底部显示「今日 20/20」，而进度环已经很诚实地回到 0/20。
    //    实测复现（一轮 20 词，全「会了」）：
    //        走完第 1 轮    环 20/20   底部 今日 20/20   ✅ 一致
    //        点「再背一轮」  环  0/20   底部 今日 20/20   ❌ 底部卡住
    //        走完第 2 轮    环 20/20   底部 今日 20/20   ❌ 少算一轮
    //    用户看到的就是「一个 0/6 和一个 11」这种自相矛盾的画面 —— 他怀疑数字是假的，
    //    这个怀疑是对的，底部那个确实是错的。
    //
    //    为什么不是把底部改成"今天的总量"：底部展示的是**这一轮走完没**，
    //    和环同口径才说得通；"今天一共背了几个"已经有 KPI `今天已背 N` 在管，
    //    两个数各归各位（和 deckContent 里那条注释同一个道理）。
    //    container.done 只作为最后兜底，形状不全时不至于变 undefined。
    const done = typeof st.covered === 'number'
      ? st.covered
      : (st.session ? st.session.stats.answered : (st.container?.done ?? 0));
    // 分母同理优先跟环走（st.session.plannedSize）。容器那个值对不上"再背一轮"
    // 之后的本轮规模，两处不一致会让「今日 X/Y」的分母显得比环大。
    const size = st.session?.plannedSize ?? st.container?.stats?.containerSize ?? 0;
    const combo = st.combo?.combo || 0;
    mount(
      foot,
      el('span', { class: 'vs-combo', dataset: { hot: combo > 0 ? '1' : '0' }, text: combo > 0 ? `🔥 连击 ×${st.combo.mult}（${combo}）` : '连击 ——' }),
      el('span', { class: 'vs-today', text: `今日 ${Math.min(done, size)}/${size}` }),
      el('span', { class: 'vs-bar' }, el('i', { style: { width: `${size ? Math.min(100, (done / size) * 100) : 0}%` } })),
    );
  }

  // ── 今日页 ──────────────────────────────────────────────

  function attachEyeCandy(st) {
    if (eyeCandyTimer) {
      clearInterval(eyeCandyTimer);
      eyeCandyTimer = null;
    }
    const w = createEyeCandy(app, st);
    if (w) eyeCandyTimer = w.__eyeCandyTimer;
    return w;
  }

  function renderToday(host, st) {
    const card = st.card;
    if (!card) {
      clear(host);
      // 两种"没有卡"要分开，因为它们该给的东西完全不同：
      //   · 本轮走完了 → 用户需要「再背一轮 / 再来几个新词」（本次修复的抱怨②③）
      //   · 今天本来就没有要背的 → 只能换本词库（原来只有这一种，且文案把
      //     "背完一轮"也说成"没有需要复习的词"，等于把用户的成果说成空虚）
      const roundDone = st.roundFinished && (st.roundSize > 0 || (st.stats && st.stats.todayAnswered > 0));
      if (roundDone) {
        const gate = st.newGate || {};
        const todayN = (st.stats && st.stats.todayAnswered) || 0;
        const extra = st.extendedBy || 0;
        mount(
          host,
          el('div', { class: 'vs-empty vs-round-done' }, [
            el('div', { class: 'vs-done-title', text: '这一轮走完了' }),
            el('div', {
              class: 'vs-done-sub',
              // 只陈述事实，不夸奖也不催（§6.3）。数字是用户自己的，不用形容词。
              text: todayN
                ? `今天已背 ${todayN} 词${extra ? `（其中自己加了 ${extra} 次量）` : ''}`
                : '这一轮已经过了一遍',
            }),
          ]),
          // ① 再背一轮：把刚才这一批重来一遍
          st.canRestart
            ? el('div', { style: { textAlign: 'center' } },
                el('button', { class: 'vs-btn primary', onclick: () => app.restartRound() }, '再背一轮'))
            : null,
          // ② 自己往后背：突破当天计划，每次加的数量由**设置页决定**（原来写死 5）。
          //
          // 闸门关着时**不给这个按钮**。实测过：闸门一关，新词池就被挡住，
          // extendRound 会把容器从 20 扩到 25，但新增词数是 0 —— 按钮点下去
          // 什么也没发生。一个"点了没反应"的按钮比没有按钮更坏，所以这里
          // 直接不显示它，只留下真正有效的那条路（「我还是想继续」）。
          !gate.closed
            ? el('div', { style: { textAlign: 'center' } },
                el(
                  'button',
                  { class: 'vs-btn', onclick: () => app.extendRound() },
                  // 按钮上的数字跟着设置走，不然用户改了设置、按钮还写 5，会以为没生效。
                  `再来 ${st.settings?.extendBatch || 5} 个新词`
                ))
            : null,
          // ③ 安全阀关着时，把门交给用户自己开
          gate.closed
            ? el('div', { class: 'vs-gate' }, [
                el('div', { class: 'vs-gate-note', text: '新词先停一下 · 今天错的有点多' }),
                el('button', { class: 'vs-btn', onclick: () => app.allowMoreNew() }, '我还是想继续'),
              ])
            : null,
          el('div', { style: { textAlign: 'center' } },
            el('button', { class: 'vs-btn muted', onclick: () => setTab('settings') }, '换词库')),
          // 眼熟小组件：放在按钮区和数据带之间，用户一完成就能看到今天背过的词。
          attachEyeCandy(st),
          // 数据带也要在走完一轮时留着：用户此刻最想确认的就是"我今天背了多少"，
          // 把数字在他达成的那一刻收走是最不该的。
          el('div', { class: 'vs-deck vs-deck-done' }, deckContent(st)),
          st.report ? weeklyCard(st.report) : null,
        );
        return;
      }
      // 真的没词可背：文案永不指责（§6.3）
      mount(
        host,
        el('div', { class: 'vs-empty', text: '今天没有需要复习的词 · 去换本新的？' }),
        el('div', { style: { textAlign: 'center' } }, el('button', { class: 'vs-btn', onclick: () => setTab('settings') }, '换词库')),
        st.report ? weeklyCard(st.report) : null,
      );
      return;
    }

    const key = `${card.cardId}:${st.session.sessionId}`;
    // 两种情况下必须重建卡片骨架：
    //   1. fresh —— 换了张卡
    //   2. DOM 里根本没有卡片了 —— 页签被切走过（设置/进度/生词本会清掉 body）
    //
    // 第 2 条是修一个真 bug：以前只看 key，于是在「设置」页待过之后切回「今日」时，
    // key 没变 → 跳过重建 → updateCard 去 querySelector('#vs-badges') 拿到 null
    // → mount(null) 抛 "Cannot read properties of null (reading 'firstChild')"，
    // 今日页直接空白。光看代码看不出来，是点出来的。
    const shellMissing = !host.querySelector('#vs-card');
    const fresh = key !== lastCardKey || shellMissing;
    if (fresh) {
      lastCardKey = key;
      lastRevealKey = null;
      cardShownAt = performance.now();
      clear(host);
      host.appendChild(cardShell(st, card));
    }
    // 只更新会变的部分
    updateCard(host, st, card, fresh);
  }

  function cardShell(st, card) {
    const wrap = el('div', { class: 'vs-card', id: 'vs-card' });
    wrap.appendChild(el('div', { class: 'vs-badges', id: 'vs-badges' }));
    wrap.appendChild(el('div', { class: 'vs-headline', id: 'vs-headline' }));
    wrap.appendChild(
      el('button', {
        class: 'vs-word',
        id: 'vs-word',
        title: '点一下听发音',
        onclick: () => {
          // 点单词即 TTS 发音（系统 TTS，零网络零成本 —— §5.2）
          //
          // ⚠️ 这里原来写的是 `globalThis.__VS_SPEAK__?.(word)` —— 一个**从来
          // 没有人赋值**的全局钩子，配上 `?.` 于是永远静默。用户报「单词右边的
          // 播放键是无效的」，实测点下去 speechSynthesis.speak() 调用数 0→0。
          //
          // DSH 适配层确实没传 `onSpeak`（adapter/dsh/puppet.mjs 只转发了
          // toast / onEscape / getDocked / isWide / onToggleDock 五项）。
          // 但那不该由界面层兜着——这里只负责「调能力、给出反馈」，
          // 能力从哪来是适配层的事（那边现在有自带默认值）。
          const word = card.word.word;
          let ok = false;
          try {
            ok = ctx.onSpeak ? ctx.onSpeak(word) === true : false;
          } catch {
            /* 发音失败安静处理，绝不弹错、绝不挡着背词 */
          }
          // 发不出声就说清楚，别让键看着像坏的（P7 数据诚实）。
          if (!ok) ctx.toast?.('这个环境没有系统语音，发音先跳过（不影响背词）。');
        },
      }, [document.createTextNode(card.word.word), el('span', { class: 'vs-audio', text: '🔊' })]),
    );
    wrap.appendChild(el('div', { class: 'vs-ipa', id: 'vs-ipa' }));
    wrap.appendChild(el('div', { id: 'vs-stage' }));
    wrap.appendChild(el('div', { class: 'vs-actions', id: 'vs-actions' }));
    // 真实数据带：停靠面板很高（实测 956px），而一张卡的内容只有约 200px。
    // 与其把卡片硬抻满（试过，视觉检查 4/10，中间被挖出死区），
    // 不如用**本来就存在的数据**把下面这块填成有用的东西。
    // 它不是卡片的一部分，所以换词时不重建，只在 updateCard 里刷新。
    const deck = el('div', { class: 'vs-deck', id: 'vs-deck' });
    wrap.appendChild(deck);
    return wrap;
  }

  // ── 数据带：环形进度 + 真实指标 + 热力图 ──────────────────────
  //
  // 三块都用 app.state 里已有的字段，不新造数字：
  //   · 环：今日已答 / 本批计划数（st.container.done / containerSize）
  //   · 收服词数：stats.conquered
  //   · 最顽固的一个词：stats.stubborn[0]（错 e 次）
  //   · 热力图：stats.heatmap（有学就着色，空白的日子什么也不说）
  // 环形进度：用模板字符串 + innerHTML，跟 pages.mjs 的 curveSvg 同一套做法。
  //
  // 为什么不用 document.createElementNS：测试环境是轻量 DOM 桩，
  // 没有 createElementNS（实测 demo-boot 直接 TypeError 挂掉）。
  // innerHTML 两边都支持，字符串拼装也更短。
  function ringSvg(pct, label) {
    const R = 20;
    const C = 2 * Math.PI * R;
    const off = C * (1 - Math.max(0, Math.min(1, pct)));
    // 宽高和 fill 都写成**属性**而不是只靠 CSS：
    // SVG 没有 width/height 就会撑满父容器，circle 没有 fill="none" 就是默认黑填充 ——
    // 两个一起缺（样式没上时）就得到一个盖住整个面板的黑色实心圆。
    // 属性比 CSS 弱，样式正常时仍由 CSS 决定颜色和 68px/54px 的尺寸，所以留着无害。
    return (
      `<svg class="vs-ring" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">` +
      `<circle class="track" cx="24" cy="24" r="${R}" fill="none"/>` +
      `<circle class="arc" cx="24" cy="24" r="${R}" fill="none" ` +
      `stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>` +
      `<text class="pct" x="24" y="24">${label}</text>` +
      `</svg>`
    );
  }

  /**
   * 数据带的内容（进度环 + 指标 + 热力图）。
   *
   * 抽成独立函数是因为它现在有两个使用场景：
   *   · 有词卡时（cardShell 里的 #vs-deck，由 updateDeck 刷新）
   *   · 一轮走完时（空状态页）
   * 原来只有前者，于是「今天已背 N 词」恰好在用户最想确认成果的那一刻
   * 消失不见 —— 而本轮修复的起点就是"背了却看不到"。
   */
  function deckContent(st) {
    const stats = st.stats || {};
    // 环表示**这一轮**的进度：已答 / 本轮计划。
    //
    // 为什么不用 container.done（原来用的就是它）：那个值是跨轮累加的，
    // 一旦用户点了「再背一轮」，新一轮的 answered 从 0 开始，而 container.done
    // 还停在上一轮的数字，于是环和「今天已背」互相矛盾 —— 实测：重背后答 1 个，
    // 环显示 1，而今日已背显示 6。用户会以为数字坏了。
    // 现在两件事各归各位：环 = 这一轮（session），KPI = 今天（stats）。
    //
    // 分子同样必须用 st.covered（数**词**）而不是 session.stats.answered（数**卡**）：
    // 重训卡会让 20 个词走成 answered = 60，而分母是 20 → 环显示「60/20」。
    // 分子分母不同单位，这个环就永远在撒谎。
    const roundDone = typeof st.covered === 'number'
      ? st.covered
      : (st.session ? st.session.stats.answered : (st.container?.done ?? 0));
    const roundSize = st.session?.plannedSize ?? st.container?.stats?.containerSize ?? 0;
    const pct = roundSize ? Math.min(1, roundDone / roundSize) : 0;

    const kpis = [];
    // 「今天背了几个」放第一个。
    // 用户原话：「我今天背了几个词不显示，只显示多少词被收服，这并不满足我
    // 抽空背诵的理念」——抽空背 3 个就走的场景里，"已收服总量"几乎不动，
    // 看起来像没背过。今日数量才是他当场能确认"我今天确实背了"的东西。
    // 数据来自 stats.todayAnswered（一直算着，只是从前没显示）。
    kpis.push(el('span', { class: 'vs-kpi' }, [
      el('b', { text: String(stats.todayAnswered ?? 0) }),
      el('i', { text: '今天已背' }),
    ]));
    kpis.push(el('span', { class: 'vs-kpi' }, [
      el('b', { text: String(stats.conquered ?? 0) }),
      el('i', { text: '词已收服' }),
    ]));
    const top = stats.stubborn && stats.stubborn[0];
    if (top && top.w) {
      kpis.push(el('span', { class: 'vs-kpi' }, [
        el('b', { text: top.w.word }),
        el('i', { text: `错 ${top.e} 次` }),
      ]));
    } else if (stats.level) {
      kpis.push(el('span', { class: 'vs-kpi' }, [
        el('b', { text: stats.level.name || String(stats.level.level) }),
        el('i', { text: `${stats.level.exp} 词力` }),
      ]));
    }

    const parts = [
      el('div', { class: 'vs-deck-top' }, [
        el('div', { class: 'vs-ringwrap', html: ringSvg(pct, roundSize ? `${Math.min(roundDone, roundSize)}/${roundSize}` : '—') }),
        el('div', { class: 'vs-kpis' }, kpis),
      ]),
    ];
    if (stats.heatmap && stats.heatmap.length) {
      parts.push(el('div', { class: 'vs-deck-heat' }, [
        el('span', { class: 'lbl', text: '最近三个半月' }),
        heatmap(stats.heatmap),
      ]));
    }
    return parts;
  }

  function updateDeck(host, st) {
    const deck = host.querySelector('#vs-deck');
    if (!deck) return;
    mount(deck, deckContent(st));
  }

  function updateCard(host, st, card, fresh) {
    // 角标（§6.4）：只给图标 + 几个字，不给数字展开
    const badges = host.querySelector('#vs-badges');
    const list = [];
    if (card.tier === 3) list.push(['✨ 新词', 'new']);
    if (card.tier === 2) list.push(['📥 收藏', 'personal']);
    const mem = st.card ? app.raw.mem[card.word.id] : null;
    if (mem && mem.e >= 3) list.push([`🔥 错过 ${mem.e} 次`, 'wrong']);
    else if (mem && mem.encodeCount > 0) list.push(['⏳ 明天忘', '']);
    if (card.isRetry) list.push([card.retryReason === 'fuzzy' ? '🤔 模糊 · 再看一次' : '😰 重训', 'wrong']);
    mount(
      badges,
      list.map(([text, kind]) => el('span', { class: 'vs-badge', dataset: { kind }, text })),
    );

    setText(host.querySelector('#vs-ipa'), card.word.ipa || '');

    // 队列顶部一句话（§6.4）
    const hl = host.querySelector('#vs-headline');
    if (card.tier === 3 && host.querySelector('#vs-card')?.dataset.firstHint !== '1') {
      // 首卡一行灰字教学，只出现一次（§11 第 2 步）
      if (!app.raw.records.length) {
        setText(hl, '你可能会忘记的速度，我帮你排期。');
        host.querySelector('#vs-card').dataset.firstHint = '1';
      } else {
        setText(hl, st.container?.explanation?.headline || '');
      }
    } else {
      setText(hl, st.container?.explanation?.headline || '');
    }

    const stage = host.querySelector('#vs-stage');
    const actions = host.querySelector('#vs-actions');
    const revealed = !!st.lastReveal;

    if (!revealed) {
      if (stage.dataset.mode !== 'front' || fresh) {
        stage.dataset.mode = 'front';
        if (card.mode === 'quiz') renderQuizFront(stage, actions, st, card);
        else renderFront(stage, actions);
      }
    } else {
      if (stage.dataset.mode !== 'back') {
        stage.dataset.mode = 'back';
        renderBack(stage, actions, st, card);
      } else {
        renderActions(actions, st, card, true);
      }
    }

    // 数据带跟卡片一起刷新（它用的都是 st.stats 里的真实累计值）
    updateDeck(host, st);
  }

  /** 正面：只给单词 + 音标。词性也藏起来（词性给答案暗示 —— §5.2）。 */
  function renderFront(stage, actions) {
    mount(stage, el('div', { class: 'vs-hint', text: '先凭感觉给自己打个分，再看答案。' }));
    mount(
      actions,
      el('div', { class: 'vs-ratings', style: { width: '100%' } }, [
        el('button', { class: 'vs-rate', dataset: { k: 'forgot' }, onclick: () => rate('forgot') }, ['😰 忘了', el('kbd', { text: '1' })]),
        el('button', { class: 'vs-rate', dataset: { k: 'fuzzy' }, onclick: () => rate('fuzzy') }, ['🤔 模糊', el('kbd', { text: '2' })]),
        el('button', { class: 'vs-rate', dataset: { k: 'known' }, onclick: () => rate('known') }, ['😎 会了', el('kbd', { text: '3' })]),
      ]),
    );
  }

  /** 辨词正面：给释义，四选一。该词错误计数 ≥3 时自动切换（§5.3）。 */
  function renderQuizFront(stage, actions, st, card) {
    const q = app.quiz();
    if (!q) return renderFront(stage, actions);
    card.quizOptions = q.options;
    mount(
      stage,
      el('div', { class: 'vs-hint', text: '下面哪个是它的意思？' }),
      el(
        'div',
        { class: 'vs-quiz-opts' },
        q.options.map((o) =>
          el('button', {
            class: 'vs-quiz-opt',
            dataset: { id: o.id },
            onclick: () => {
              const res = app.answerQuiz(o.id, { reactionMs: Math.round(performance.now() - cardShownAt) });
              st.lastReveal = { quiz: true };
              flashQuiz(stage, o.id, card.word.id);
              render();
              void res;
            },
          }, [o.pos ? el('span', { class: 'pos', text: o.pos }) : null, document.createTextNode(o.meaning || o.word)]),
        ),
      ),
    );
    mount(
      actions,
      el(
        'button',
        {
          class: 'vs-btn muted',
          title: '这题有问题：本词本轮不计分并标记待复核',
          onclick: () => {
            const r = app.flagQuestion();
            if (r?.blacklisted) ctx.toast?.('已拉黑这组干扰项');
            cardShownAt = performance.now();
            render();
          },
        },
        '⚑ 这题有问题',
      ),
    );
  }

  function flashQuiz(stage, chosenId, targetId) {
    for (const btn of stage.querySelectorAll('.vs-quiz-opt')) {
      const id = btn.dataset.id;
      if (id === targetId) btn.dataset.state = 'right';
      else if (id === chosenId) btn.dataset.state = 'wrong';
    }
  }

  /**
   * 背面：三行内读完；例句 0 延迟。
   *
   * 折叠项默认收起 —— **除了「词根词缀」**。
   *
   * 「词根词缀」默认展开是**故意违反规格 §5.2「折叠项永不自动展开」**的：
   * 它的内容只有一行（`前缀 con(共同) · 词根 sider(星) · 后缀 -able(可…的)`），
   * 收起时用户看到的是「▸ 词根词缀」几个字，要点一下才看到那行字 ——
   * 多一次点击、零信息隐藏，纯亏。产品负责人 2026-10 明确要求默认展开。
   *
   * 「词源」（`来自拉丁语 stāmina`）的默认状态**跟着词根词缀走**：
   *   · 这个词有词根词缀那一行 → 词源收起（不抢那一行的位置）
   *   · 没有那一行 → 词源展开（否则这个卡片背面又是一片空白）
   * 词源和词根词缀是两种东西：前者是"来源"，后者是"拆解"，混着显示就是骗人。
   *
   * 「同族词」不一样：最多 5 条、每条还带释义，展开会顶掉例句和评分按钮，
   * 所以它仍然收起（要看再点）。
   *
   * 规格 P1「面板永不自动展开」约束的是**面板/侧栏**不许自己弹出来抢焦点，
   * 不是这张已经翻开的卡片背面里某个折叠块 —— 后者不改变用户正在干什么。
   */
  function renderBack(stage, actions, st, card) {
    const r = st.lastReveal;
    if (r.quiz) {
      renderQuizBack(stage, actions, st, card, r);
      return;
    }
    const w = card.word;
    const folds = [];
    if (w.collocations?.length) {
      folds.push(
        el('details', { class: 'vs-fold' }, [
          el('summary', { text: '常见搭配' }),
          el('div', { class: 'vs-foldbody' }, el('ul', {}, w.collocations.map((c) => el('li', { text: c })))),
        ]),
      );
    }
    if (w.synonyms?.length) {
      folds.push(
        el('details', { class: 'vs-fold' }, [
          el('summary', { text: '近义辨析' }),
          el('div', { class: 'vs-foldbody' }, el('ul', {}, w.synonyms.map((c) => el('li', { text: c })))),
        ]),
      );
    }
    // 词根词缀这一行：**手写词根表优先，维基的构词拆解兜底**。
    // 两个来源都真，但语言上不是一回事：
    //   - 手写表给的是「前缀 con(共同) · 词根 sider(星) · 后缀 -able(可…的)」
    //   - 维基模板给的是「ab- + normal」，只有词素没有含义
    // 所以兜底时前面挂「构词」两个字，别让人以为是词根释义。
    const etym = w.etym;
    let rootLineText = w.roots;
    if (!rootLineText && etym && etym.kind === 'split') {
      rootLineText = `构词：${etym.text}`;
    }
    if (rootLineText) {
      folds.push(
        el('details', { class: 'vs-fold', open: true }, [
          el('summary', { text: '词根词缀' }),
          el('div', { class: 'vs-foldbody', text: rootLineText }),
        ]),
      );
    }
    // 词源：只能追到来源的词（`来自拉丁语 stāmina`）。
    // 有词根词缀那一行时它**默认收起**（不抢那行的位置）；
    // 没有时默认展开 —— 否则这个词背面又是一片空白。
    if (etym && etym.kind === 'origin') {
      folds.push(
        el('details', { class: 'vs-fold', open: !rootLineText }, [
          el('summary', { text: '词源' }),
          el('div', { class: 'vs-foldbody', text: etym.text }),
        ]),
      );
    }
    // 同族词：比「词根含义」更救命的记忆抓手 ——
    // 你认识的 attract / contract / distract 和 abstract 是一家，
    // 这比记住 "tract = 拉" 更容易。数据全部来自我们词库，是真词真释义。
    // 懒查询：只在这一张卡的背面渲染时才算，不给启动加负担。
    // 标题带上共享的词根（`同族词 · tract`），用户才知道凭什么算一家。
    if (w.word) {
      const fam = app.familyFor ? app.familyFor(w.word, 5) : [];
      if (fam.length) {
        // 第一来源（词根家族）带 root；只有第二来源（词形派生）时说明一下来由，
        // 否则标题只剩个「同族词 (3)」，用户不知道凭什么叫一家。
        const shared = fam[0].root || (fam[0].kind === 'derivation' ? '词形派生' : '');
        folds.push(
          el('details', { class: 'vs-fold' }, [
            el('summary', { text: shared ? `同族词 · ${shared}` : `同族词 (${fam.length})` }),
            el(
              'div',
              { class: 'vs-foldbody' },
              el(
                'ul',
                {},
                fam.map((f) =>
                  el('li', { text: f.meaning ? `${f.word} — ${f.meaning}` : f.word }),
                ),
              ),
            ),
          ]),
        );
      }
    }

    mount(
      stage,
      el('div', { class: 'vs-reveal' }, [
        el('div', { class: 'vs-rule' }),
        w.pos ? el('div', { class: 'vs-pos', text: w.pos }) : null,
        el('div', { class: 'vs-meaning', text: w.meaning || '（词库没给释义）' }),
        w.example
          ? el('div', { class: 'vs-ex' }, [
              el('div', { class: 'en', text: w.example }),
              // 只有英文单语例句时**不显示**译文行 —— 语料里没配对，
              // 编一句中文就是假数据（§9 铁律）。
              w.exampleZh ? el('div', { class: 'zh', text: w.exampleZh }) : null,
            ])
          : el('div', { class: 'vs-gray', text: '暂无例句' }),
        // 三项全空时直说，别让用户以为还有东西没展开（§9：没有就说没有）。
        !w.example && !rootLineText && !(etym && etym.text) && !(w.collocations?.length)
          ? el('div', { class: 'vs-gray', text: '这个词暂无例句、词根和词源' })
          : null,
        folds.length ? el('div', { class: 'vs-folds' }, folds) : null,
        el('div', { class: 'vs-ai' }, [
          el(
            'button',
            {
              class: 'vs-ai-btn',
              onclick: () => {
                const out = stage.querySelector('#vs-ai-out');
                out.hidden = false;

                // 已经编过就直接显示 —— 规格 §9「每词一生只付一次，永久复用」。
                // 所以第二次点同一个词是**零等待**的，不该再假装加载。
                if (out.dataset.wordId === w.id && out.dataset.state === 'done') {
                  out.dataset.state = 'done';
                  return;
                }

                out.dataset.wordId = w.id;
                out.dataset.state = 'loading';
                setText(out, '✨ 正在编…');

                Promise.resolve()
                  .then(() => app.hookFor(w))
                  .then((hook) => {
                    if (out.dataset.wordId !== w.id) return; // 用户已经翻到别的词了
                    if (!hook || !hook.text) {
                      // 只有真的取不到料时才说这句（而不是假装调 AI 失败）
                      out.dataset.state = 'failed';
                      setText(out, '✨ 这个词暂时编不出来');
                      return;
                    }
                    out.dataset.state = 'done';
                    // 一行钩子 + 一行来源标注：让用户看得出它凭什么这么说（§9）
                    setText(out, '');
                    mount(
                      out,
                      el('div', { class: 'vs-ai-line', text: hook.text }),
                      hook.sourceLabel
                        ? el('div', { class: 'vs-ai-src', text: '· ' + hook.sourceLabel })
                        : null,
                    );
                  })
                  .catch(() => {
                    if (out.dataset.wordId !== w.id) return;
                    out.dataset.state = 'failed';
                    setText(out, '✨ 暂时没编出来 · 重试');
                  });
              },
            },
            '✨ 让我记住它',
          ),
          el('div', { class: 'vs-ai-out', id: 'vs-ai-out', hidden: true }),
        ]),
      ]),
    );
    renderActions(actions, st, card, false);
  }

  /** 揭晓后的行动区：下一张 / 撤销 / 其实我搞混了。 */
  function renderActions(actions, st, card, isQuiz) {
    const canUndo = Date.now() < undoUntil && undoCardKey === card.cardId;
    const nodes = [];

    if (st.lastReveal && st.lastReveal.quiz) {
      const res = st.lastRevealResult;
      if (res && !res.correct && res.chosen) {
        nodes.push(
          el('div', { class: 'vs-pair' }, [
            el('div', { class: 'side' }, [
              el('div', { class: 'w', text: res.target.word }),
              el('div', { class: 'i', text: card.word.ipa || '' }),
              el('div', { class: 'm', text: res.target.meaning || '' }),
            ]),
            el('div', { class: 'side' }, [
              el('div', { class: 'w', text: res.chosen.word }),
              el('div', { class: 'm', text: res.chosen.meaning || '' }),
            ]),
          ]),
          el('div', { class: 'vs-human', text: app.raw.lastHuman || '' }),
        );
      }
    }

    nodes.push(
      el('button', { class: 'vs-btn primary', 'data-act': 'next', onclick: next }, [document.createTextNode('下一张 '), el('kbd', { text: '␣' })]),
    );
    if (canUndo) {
      nodes.push(el('button', { class: 'vs-btn', onclick: undo, title: '2 秒内可以撤销' }, '↩︎ 撤销'));
    }
    if (!isQuiz) {
      nodes.push(
        el(
          'button',
          {
            class: 'vs-btn muted',
            title: '自评会了但翻车了？告诉我，这个词会加 2 次错误计数并重训',
            onclick: () => {
              app.reportFakeMastery(null);
              const p = app.state.session && app.raw.lastPlan;
              ctx.toast?.(p?.note ? `已安排：${p.note}` : '已记为假掌握');
              render();
            },
          },
          '其实我搞混了',
        ),
      );
    }
    mount(actions, nodes);
  }

  function renderQuizBack(stage, actions, st, card, reveal) {
    const res = st.lastRevealResult || {};
    mount(
      stage,
      el('div', { class: 'vs-reveal' }, [
        el('div', { class: 'vs-rule' }),
        el('div', { class: 'vs-pos', text: card.word.pos || '' }),
        el('div', { class: 'vs-meaning', text: card.word.meaning || '' }),
        card.word.example
          ? el('div', { class: 'vs-ex' }, [
              el('div', { class: 'en', text: card.word.example }),
              card.word.exampleZh ? el('div', { class: 'zh', text: card.word.exampleZh }) : null,
            ])
          : null,
      ]),
    );
    if (st.lastRevealResult) st.lastReveal = { ...reveal, quiz: true };
    renderActions(actions, st, card, true);
    void res;
  }

  function weeklyCard(report) {
    const wrap = el('div', { style: { marginTop: '18px' } });
    renderWeeklyReport(wrap, report);
    return wrap;
  }

  app.subscribe(() => {
    // 连击冻结超时后重新渲染一次底部（保持状态一致）
    render();
  });

  render();
  // 把内核挂一份到面板根节点上：启动回归要验证「拨开关 → 设置真的变了」，
  // 而面板用的 app 必须从**面板自己**这里拿。
  // 之前从 demo 外壳读，读到的是另一个实例，于是断言永远失败 —— 排查了很久。
  try {
    root.__vsApp = app;
  } catch {
    /* 没有就跳过，不影响界面 */
  }
  return {
    root,
    destroy() {
      disposed = true;
      if (eyeCandyTimer) {
        clearInterval(eyeCandyTimer);
        eyeCandyTimer = null;
      }
    },
    render,
    focus: () => focusSelf(root),
    setTheme(t) {
      ctx.theme = t;
      root.dataset.theme = t;
    },
  };
}
