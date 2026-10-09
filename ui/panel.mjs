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
import { renderProgress, renderVocab, renderSettings, renderWeeklyReport } from './pages.mjs';

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

    // 一行灰字：离线 / 只读 / 另一个窗口正在学 —— 全部不解释（§14.5）
    const banners = [];
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
    const done = st.container?.done ?? (st.session ? st.session.stats.answered : 0);
    const size = st.container?.stats?.containerSize ?? st.session?.plannedSize ?? 0;
    const combo = st.combo?.combo || 0;
    mount(
      foot,
      el('span', { class: 'vs-combo', dataset: { hot: combo > 0 ? '1' : '0' }, text: combo > 0 ? `🔥 连击 ×${st.combo.mult}（${combo}）` : '连击 ——' }),
      el('span', { class: 'vs-today', text: `今日 ${Math.min(done, size)}/${size}` }),
      el('span', { class: 'vs-bar' }, el('i', { style: { width: `${size ? Math.min(100, (done / size) * 100) : 0}%` } })),
    );
  }

  // ── 今日页 ──────────────────────────────────────────────

  function renderToday(host, st) {
    const card = st.card;
    if (!card) {
      // 空状态：文案永不指责（§6.3）
      clear(host);
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
          try {
            globalThis.__VS_SPEAK__?.(card.word.word);
          } catch {
            /* 发音失败安静处理，绝不弹错 */
          }
          if (ctx.onSpeak) ctx.onSpeak(card.word.word);
        },
      }, [document.createTextNode(card.word.word), el('span', { class: 'vs-audio', text: '🔊' })]),
    );
    wrap.appendChild(el('div', { class: 'vs-ipa', id: 'vs-ipa' }));
    wrap.appendChild(el('div', { id: 'vs-stage' }));
    wrap.appendChild(el('div', { class: 'vs-actions', id: 'vs-actions' }));
    return wrap;
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

  /** 背面：三行内读完；例句 0 延迟；折叠项永不自动展开（§5.2）。 */
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
    if (w.roots) {
      folds.push(
        el('details', { class: 'vs-fold' }, [
          el('summary', { text: '词根词源' }),
          el('div', { class: 'vs-foldbody', text: w.roots }),
        ]),
      );
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
              w.exampleZh ? el('div', { class: 'zh', text: w.exampleZh }) : null,
            ])
          : el('div', { class: 'vs-gray' }, [
              document.createTextNode('暂无例句 · 可 '),
              el(
                'button',
                {
                  onclick: () => {
                    const out = stage.querySelector('#vs-ai-out');
                    out.dataset.state = 'loading';
                    out.hidden = false;
                    setText(out, '✨ 正在编…');
                    setTimeout(() => {
                      // AI 挂了不阻塞：显示一句能重试的话（§9.1）
                      setText(out, '✨ 暂时没编出来 · 重试');
                      out.dataset.state = 'failed';
                    }, 900);
                  },
                },
                '✨ 生成',
              ),
            ]),
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
    },
    render,
    focus: () => focusSelf(root),
    setTheme(t) {
      ctx.theme = t;
      root.dataset.theme = t;
    },
  };
}
