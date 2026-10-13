// vocab-study / ui / pages.mjs
// 进度页 / 生词本 / 设置页 / 周报。全部只吃 props，不认识 app 内部结构。

import { el, mount, clear } from './dom.mjs';
import { getCore, setCore } from './core-ref.mjs';
// 摊平用的替换是「单行 import」正则，所以这里必须一行一个，别折行。
import * as M_ from '../core/memory.mjs';
import * as MK_ from '../core/mistake.mjs';
import * as G_ from '../core/game.mjs';
import * as Q_ from '../core/queue.mjs';
import * as L_ from '../core/library.mjs';
import * as B_ from '../core/beckon.mjs';

// core 命名空间统一走 ui/core-ref.mjs 的注册表（那里解释了为什么需要它）。
// ESM 形态下本文件自己填一次；摊平形态下由构建脚本填，读法完全一样。
// 必须写成单行 —— 摊平用整行剥离来去掉它，折行会漏掉。
setCore({ memory: M_, mistake: MK_, game: G_, queue: Q_, library: L_, beckon: B_ });

/** 兼容旧调用点：转发到注册表。 */
export function injectCore(core) {
  return setCore(core);
}

/**
 * 词库 id → 显示名（"cet6" → "六级"）。
 *
 * 为什么专门抽一个：用户报「我主页今日这里并没有显示我用的是哪个词库，
 * 这样我就不知道我到底用的是哪个」。换词库之后尤其需要 —— 界面不说是哪本，
 * 用户就无从判断刚才那次换库到底成没成。
 *
 * 名字取不到就退回 id 本身：宁可能看到一个 "cet6"，也不要空着。
 */
export function collectionLabel(state) {
  const { library: L } = getCore();
  const id = (state && state.settings && state.settings.collections && state.settings.collections[0]) || '';
  if (!id) return '';
  const meta = (L.COLLECTIONS || {})[id];
  return (meta && meta.name) || id;
}

/** 记忆保持曲线：一条线证明「按排期走」比「不管它」强（§7.5 证据②）。 */
function curveSvg(curve) {
  const W = 300;
  const H = 86;
  const pad = { l: 2, r: 2, t: 6, b: 12 };
  const xs = curve.scheduled.map((p) => p.day);
  const x = (d) => pad.l + (d / (xs[xs.length - 1] || 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v) * (H - pad.t - pad.b);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.recall).toFixed(1)}`).join(' ');
  const last = curve.scheduled[curve.scheduled.length - 1];
  const lastP = curve.passive[curve.passive.length - 1];
  const svg = `
<svg class="vs-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
  <line class="axis" x1="0" y1="${y(0.5)}" x2="${W}" y2="${y(0.5)}"/>
  <line class="axis" x1="0" y1="${y(1)}" x2="${W}" y2="${y(1)}"/>
  <line class="axis" x1="0" y1="${y(0)}" x2="${W}" y2="${y(0)}"/>
  <path class="passive" d="${path(curve.passive)}"/>
  <path class="sched" d="${path(curve.scheduled)}"/>
</svg>`;
  return {
    svg,
    text: `30 天后：按排期 ${Math.round(last.recall * 20)}/20 还记得 · 不管它 ${Math.round(lastP.recall * 20)}/20`,
  };
}

export function renderProgress(root, st, app) {
  const { memory: M, queue: Q, game: G } = getCore();
  clear(root);
  const stats = st.stats;
  const curve = app.retention();
  const c = curveSvg(curve);

  mount(
    root,
    el('div', { class: 'vs-h2', text: '我变强了没有' }),
    el('div', { class: 'vs-big' }, [
      String(stats.conquered),
      el('small', { text: '词已收服' }),
    ]),
    el('div', {
      class: 'vs-sub',
      text: '收服的判定是硬的：记忆强度 ≥ 0.9，且在辨词里答对过。没在应用场景里考过，不算收服。',
    }),

    el('div', { class: 'vs-h2', text: '接下来 30 天还剩多少' }),
    el('div', { html: c.svg }),
    el('div', { class: 'vs-legend' }, [
      el('span', { class: 's' }, [el('i'), document.createTextNode('按排期走')]),
      el('span', { class: 'p' }, [el('i'), document.createTextNode('不管它')]),
    ]),
    el('div', { class: 'vs-sub', text: c.text }),

    el('div', { class: 'vs-h2', text: '这半个月' }),
    heatmap(stats.heatmap),
    el('div', { class: 'vs-sub', text: '有学就着色；空白的日子什么也不说。' }),

    el('div', { class: 'vs-h2', text: '最顽固的几个' }),
    stats.stubborn.length
      ? el(
          'div',
          { class: 'vs-list' },
          stats.stubborn.slice(0, 6).map((s) =>
            el('div', { class: 'vs-row' }, [
              el('span', { class: 'w', text: s.w.word }),
              el('span', { class: 'm', text: shortMeaning(s.w.meaning) }),
              el('span', { class: 't', text: `错 ${s.e} 次` }),
            ]),
          ),
        )
      : el('div', { class: 'vs-empty', text: '还没有反复错的词' }),

    stats.diagnosis && stats.diagnosis.sentence
      ? el('div', {}, [el('div', { class: 'vs-h2', text: '今天的诊断' }), el('div', { class: 'vs-report', text: stats.diagnosis.sentence })])
      : null,

    stats.confusionsNeedingDrill.length
      ? el('div', {}, [
          el('div', { class: 'vs-h2', text: '需要对着练的混淆对' }),
          el(
            'div',
            { class: 'vs-list' },
            stats.confusionsNeedingDrill.map((p) =>
              el('div', { class: 'vs-row' }, [
                el('span', { class: 'w', text: `${p.a.split(':')[1]} / ${p.b.split(':')[1]}` }),
                el('span', { class: 't', text: `混淆 ${p.count} 次` }),
              ]),
            ),
          ),
        ])
      : null,

    el('div', { class: 'vs-sub', style: { marginTop: '14px' } , text: `词力值 ${stats.level.exp} · ${stats.level.level} 级 ${stats.level.name}` }),
  );
}

export function heatmap(days) {
  const cols = [];
  for (let w = 0; w < Math.ceil(days.length / 7); w++) {
    const col = el('div', { class: 'col' });
    for (let d = 0; d < 7; d++) {
      const cell = days[w * 7 + d];
      if (!cell) {
        col.appendChild(el('div', { class: 'cell', style: { visibility: 'hidden' } }));
        continue;
      }
      col.appendChild(el('div', { class: 'cell', dataset: { l: String(cell.level) }, title: `${cell.key} · ${cell.n} 词` }));
    }
    cols.push(col);
  }
  return el('div', { class: 'vs-heat' }, cols);
}

function shortMeaning(m = '') {
  const t = String(m).split(/[；;]/)[0];
  return t.length > 16 ? `${t.slice(0, 16)}…` : t;
}

export function renderVocab(root, st, app) {
  const { library: L, mistake: MK } = getCore();
  clear(root);
  mount(
    root,
    el('div', { class: 'vs-h2', text: '我的生词本' }),
    el('div', {
      class: 'vs-sub',
      text: '在对话里选中一个纯英文单词 → 悬浮条「加入生词本」。收藏时会顺手抓下它在对话里的那句话当例句。',
    }),
    st.personal && st.personal.length
      ? el(
          'div',
          { class: 'vs-list', style: { marginTop: '8px' } },
          st.personal.map((p) =>
            el('div', { class: 'vs-row' }, [
              el('span', { class: 'w', text: p.word }),
              el('span', { class: 'm', text: p.meaning || '（还没释义）' }),
              el(
                'button',
                {
                  class: 'vs-btn muted',
                  onclick: () => {
                    app.removePersonal(p.id);
                  },
                },
                '删',
              ),
            ]),
          ),
        )
      : el('div', { class: 'vs-empty', text: '生词本还是空的' }),

    el('div', { class: 'vs-h2', text: '批量导入' }),
    el('div', { class: 'vs-sub', text: '粘贴一段英文，自动切词收录。' }),
    el('div', { style: { marginTop: '6px' } }, [
      el('textarea', {
        class: 'vs-input',
        rows: '3',
        style: { width: '100%', maxWidth: 'none', height: '58px', textAlign: 'left', fontFamily: 'inherit' },
        placeholder: 'Paste English text here...',
        id: 'vs-import',
      }),
      el(
        'div',
        { style: { marginTop: '6px' } },
        el(
          'button',
          {
            class: 'vs-btn',
            onclick: () => {
              const ta = root.querySelector('#vs-import');
              const ws = L.extractWordsFromText(ta.value || '');
              let added = 0;
              for (const w of ws.slice(0, 50)) {
                if (app.raw.personal.some((p) => p.word.toLowerCase() === w.toLowerCase())) continue;
                app.addPersonal({ word: w, meaning: '' }, { source: '批量导入' });
                added++;
              }
              ta.value = '';
              renderVocab(root, app.state, app);
              return added;
            },
          },
          '收录',
        ),
      ),
    ]),
  );
}

export function renderSettings(root, st, app) {
  const { library: L, queue: Q } = getCore();
  clear(root);
  const s = st.settings;
  const bal = s.balance;
  const preview = previewBalance(st, app, bal);

  const setNum = (key) => (ev) => app.updateSettings({ [key]: Number(ev.target.value) });

  // 整页重建时把「上次选中的词库」挂到 root 上：换库的失败回落要知道原来选的是哪本。
  root.dataset.collection = String(s.collections[0] || '');

  mount(
    root,
    el('div', { class: 'vs-h2', text: '每天几个词' }),
    el('div', { class: 'vs-field' }, [
      el('label', {}, ['今日容器', el('span', { class: 'note', text: '词数是铁律，时间只作参考显示' })]),
      el('input', { class: 'vs-input', type: 'number', min: '3', max: '200', value: String(s.dailyGoal), onchange: setNum('dailyGoal') }),
    ]),

    el('div', { class: 'vs-h2', text: '新词出场顺序' }),
    el('div', { class: 'vs-field' }, [
      el('label', {}, [
        '出场顺序',
        el('span', {
          class: 'note',
          text:
            s.order === 'seq'
              ? '按词库顺序（也就是字母序，会一直在 a/b 里打转）'
              : '随机 · 每天换一个排法；同一天内不变，所以「接着背」不会换词',
        }),
      ]),
      select(
        [['shuffle', '随机（推荐）'], ['seq', '按词库顺序']],
        s.order,
        (v) => app.updateSettings({ order: v }),
        'vs-order',
      ),
      // 拨这个开关不会重建当前这一轮 —— 否则用户背到一半的进度就没了。
      // 所以要说清楚它什么时候生效，免得以为没反应。
      el('span', { class: 'note', text: '改了下一轮生效，正在背的这轮不动' }),
    ]),

    el('div', { class: 'vs-h2', text: '攻守天平' }),
    el('div', { class: 'vs-scale' }, [
      el('div', { class: 'ends' }, [el('span', { text: '先保住会的' }), el('span', { text: '多背点新的' })]),
      el('input', {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.1',
        value: String(bal),
        id: 'vs-balance',
        oninput: (ev) => {
          const v = Number(ev.target.value);
          const p = previewBalance(st, app, v);
          const node = root.querySelector('#vs-bal-preview');
          if (node) node.textContent = p;
        },
        onchange: (ev) => app.updateSettings({ balance: Number(ev.target.value) }),
      }),
      el('div', { class: 'preview', id: 'vs-bal-preview', text: preview }),
    ]),

    el('div', { class: 'vs-h2', text: '一轮几个词' }),
    el('div', { class: 'vs-field' }, [
      el('label', {}, ['碎片冲刺', el('span', { class: 'note', text: '答完即结算，不设倒计时' })]),
      select([3, 5, 10], s.roundSize, (v) => app.updateSettings({ roundSize: v })),
    ]),

    el('div', { class: 'vs-h2', text: '词库' }),
    el('div', { class: 'vs-field' }, [
      el('label', {}, ['当前词库', el('span', { class: 'note', text: '换库要联网；拉不到就用内置词表顶' })]),
      // ⚠️ 换词库**必须真的把词换掉**，不能只当一个设置项保存。
      //
      // 这里原来写的是 `app.updateSettings({ collections: [v] })`，而
      // updateSettings 只在 dailyGoal / balance 变化时重建容器 ——
      // 于是换库只改了一个字段：st.words 还是老词库的、今日队列还是老的
      // （多半已背完），主页就一直停在「今天没有需要复习的词」。
      // 用户原话：「我明明显示了更换成功但是主页并没有反应」。
      //
      // 现在调 app.changeCollection()：重载词表 → 重种记忆 → 重建今日队列。
      // 它是异步的（可能要走网络），所以下面单独给它一个状态行，
      // 成功/失败都写出来 —— 别让用户再对着一个没反应的界面猜。
      el('select', {
        class: 'vs-select',
        id: 'vs-collection',
        'data-prev': String(s.collections[0] || ''),
        onchange: (ev) => switchCollection(ev.target, app, ev.target.value),
      }, Object.values(L.COLLECTIONS || {}).map((c) => el('option', {
        value: String(c.id),
        selected: String(c.id) === String(s.collections[0]) ? true : null,
        text: c.name,
      }))),
    ]),
    // 换库结果从**快照**里读（st.lastLibraryChange）：
    // 成功换库会 emit() → 整页重绘，只写 DOM 的提示会被冲掉。
    collectionStatusLine(st.lastLibraryChange),
    el('div', { class: 'vs-sub', text: st.librarySource === 'seed' ? '现在用的是内置词表（离线）' : '词表已缓存到本地，之后永久离线可用' }),

    el('div', { class: 'vs-h2', text: 'AI 增强' }),
    el('div', { class: 'vs-field' }, [
      el('label', {}, ['模式', el('span', { class: 'note', text: '每词一生只生成一次，结果写回本地永久复用' })]),
      select(
        [
          ['off', '关'],
          ['ondemand', '按需'],
          ['all', '全部预生成'],
        ],
        s.aiMode,
        (v) => app.updateSettings({ aiMode: v }),
      ),
    ]),
    el('div', { class: 'vs-field' }, [
      el('label', {}, ['记忆钩子提示词', el('span', { class: 'note', text: '你能看到它凭什么这么说，也能自己改' })]),
      el('button', { class: 'vs-btn', onclick: () => togglePrompt(root, app, 'hook') }, '编辑'),
    ]),

    el('div', { class: 'vs-h2', text: '休假' }),
    el('div', { class: 'vs-field' }, [
      el('label', {}, ['暂停到', el('span', { class: 'note', text: '暂停期内胶囊消失、不产生到期词' })]),
      el('input', {
        class: 'vs-input',
        type: 'date',
        style: { width: '128px', textAlign: 'left' },
        value: s.vacationUntil ? new Date(s.vacationUntil).toISOString().slice(0, 10) : '',
        onchange: (ev) => {
          const v = ev.target.value;
          app.setVacation(v ? new Date(`${v}T23:59:59`).getTime() : null);
        },
      }),
    ]),

    el('div', { class: 'vs-h2', text: '数据' }),
    el('div', { class: 'vs-field' }, [
      el('label', {}, ['导出 / 导入', el('span', { class: 'note', text: '换机、备份、重置都留后门；无任何网络上报' })]),
      el('button', { class: 'vs-btn', onclick: () => exportJson(app) }, '导出'),
    ]),
    el('div', { class: 'vs-sub', text: '数据存在用户级目录，跨工作区共享 —— 换工作区不会「进度消失」。' }),
  );
}

function previewBalance(state, app, bal) {
  const { queue: Q } = getCore();
  const c = Q.buildDailyContainer(
    state.words || [],
    app.raw.mem,
    {
      N: app.raw.settings.dailyGoal,
      gapDays: 0,
      balance: bal,
      now: Date.now(),
      collections: app.raw.settings.collections,
    },
  );
  const s = c.stats || {};
  return `预计今日 ${s.containerSize || c.items.length} 词（复习 ${s.reviewCount || 0} · 收藏 ${s.personalCount || 0} · 新词 ${s.newCount || 0}）`;
}

/**
 * 换库结果行。从快照的 `lastLibraryChange` 渲染 —— 不写 DOM。
 *
 * 三种结果都要说出来（P7 数据诚实）：
 *   · 换成了：新词库几个词、是不是离线词表、今日已重排
 *   · 没换（选的就是当前这本）
 *   · 没换成：**原因**（网络？没有词？），并且下拉框会回落到原词库
 */
function collectionStatusLine(chg) {
  const box = el('div', { class: 'vs-collection-status', id: 'vs-collection-status' });
  if (!chg) return box;
  if (chg.ok && chg.unchanged) {
    box.dataset.kind = 'info';
    box.textContent = '这本就是当前词库，没有改动。';
    return box;
  }
  if (chg.ok) {
    box.dataset.kind = 'ok';
    box.textContent = `已换成新词库，共 ${chg.count} 个词 —— 今日已按新词表重新排好`;
    return box;
  }
  box.dataset.kind = 'error';
  box.textContent = `上次换库没成功：${chg.error || '未知原因'}（仍是原来的词库）`;
  return box;
}

function select(options, value, onchange, id) {
  return el(
    'select',
    { class: 'vs-select', id: id || null, onchange: (ev) => onchange(ev.target.value) },
    options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, String(o)];
      return el('option', { value: String(v), selected: String(v) === String(value) ? true : null, text: label });
    }),
  );
}

/**
 * 换词库：真的重载词表并重建今日队列。
 *
 * 为什么单独写一个而不是塞进通用 select：
 * 它是这里**唯一会做异步 I/O** 的设置项（可能走网络拉词表）。
 * 塞进同步 onchange 里，用户只会看到下拉框变了、别的没反应 —— 那正是原来
 * 那个 bug 的表象（用户原话：「显示更换成功但主页并没有反应」）。
 *
 * ⚠️ 结果**不写 DOM**，而是存进 core 的 lastLibraryChange：
 * 成功换库会 emit() 触发整页重绘，临时写进 DOM 的提示会被冲掉，
 * 于是用户只看到"闪一下"或者干脆看不到。重绘后由 renderSettings 从
 * 快照里读出来渲染，才不会丢。
 */
async function switchCollection(sel, app, id) {
  if (!sel || !id) return;
  const prev = sel.dataset.prev || '';
  sel.disabled = true;
  const line = sel.closest('.vs-panel')?.querySelector('#vs-collection-status');
  if (line) {
    line.textContent = '正在换词库…（要联网拉词表）';
    line.dataset.kind = 'loading';
  }
  try {
    const res = typeof app.changeCollection === 'function'
      ? await app.changeCollection(id)
      : { ok: false, error: '内核没有 changeCollection（版本太旧？）' };
    if (!res || !res.ok) {
      // 失败要**回落**到原来那本 —— 不能让下拉框显示一个其实没生效的选择，
      // 那正是这次用户被误导的地方。
      if (prev) sel.value = prev;
      sel.disabled = false;
      if (line) {
        line.textContent = `换库失败：${(res && res.error) || '未知原因'}（已保持原词库）`;
        line.dataset.kind = 'error';
      }
      return;
    }
    // 成功：changeCollection 已经 emit() 过了，面板会重绘，
    // 状态行由 renderSettings 从快照里重新画出来。这里不用管。
  } catch (e) {
    if (prev) sel.value = prev;
    sel.disabled = false;
    if (line) {
      line.textContent = `换库出错：${(e && e.message) || e}（已保持原词库）`;
      line.dataset.kind = 'error';
    }
  }
}

function togglePrompt(root, app, key) {
  const existing = root.querySelector('#vs-prompt-edit');
  if (existing) {
    existing.remove();
    return;
  }
  const box = el('div', { id: 'vs-prompt-edit', style: { padding: '8px 0 4px' } }, [
    el('textarea', {
      class: 'vs-input',
      style: { width: '100%', maxWidth: 'none', height: '140px', textAlign: 'left', fontFamily: 'inherit', fontSize: '11.5px' },
      value: app.raw.settings.prompts?.[key] || '',
      onchange: (ev) => app.updateSettings({ prompts: { ...app.raw.settings.prompts, [key]: ev.target.value } }),
    }),
  ]);
  root.appendChild(box);
}

function exportJson(app) {
  const { queue: Q } = getCore();
  try {
    const data = {
      schemaVersion: 1,
      exportedTs: Date.now(),
      records: app.raw.records,
      mem: app.raw.mem,
      confusions: app.raw.confusions,
      personal: app.raw.personal,
      streak: app.raw.streak,
      exp: app.raw.exp,
      settings: app.raw.settings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vocab-study-${Q.dayKey(Date.now())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  } catch {
    /* 导出失败不阻塞任何东西 */
  }
}

/** 周度对账单：一页，含一句诊断与下周建议（§7.5 证据③）。 */
export function renderWeeklyReport(root, report) {
  clear(root);
  mount(
    root,
    el('div', { class: 'vs-h2', text: '本周对账单' }),
    el('div', { class: 'vs-report' }, [
      el('div', {}, [
        document.createTextNode('本周：学 '),
        el('span', { class: 'k', text: String(report.words) }),
        document.createTextNode(' 词 · 收服 '),
        el('span', { class: 'k', text: String(report.conqueredThisWeek) }),
        document.createTextNode(' 词 · 最长连续 '),
        el('span', { class: 'k', text: String(report.longestStreak) }),
        document.createTextNode(' 天'),
      ]),
      report.stubborn ? el('div', { style: { marginTop: '5px' } }, [
        document.createTextNode('最顽固：'),
        el('span', { class: 'k', text: report.stubborn.word }),
        document.createTextNode(`（错了 ${report.stubborn.e} 次）`),
      ]) : null,
      report.diagnosis ? el('div', { style: { marginTop: '5px' }, text: `诊断：${report.diagnosis}` }) : null,
      report.suggestion ? el('div', { style: { marginTop: '5px' }, text: `下周建议：${report.suggestion}` }) : null,
    ]),
  );
}

export { MK, M, G, Q, L, B };
