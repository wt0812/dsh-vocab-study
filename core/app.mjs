// vocab-study / core / app.mjs
// 组合根：把记忆 / 队列 / 会话 / 记录 / 游戏 拼成一个能被 UI 直接驱动的门面。
//
// 这一层仍然不认识 DSH：它只跟一个 Ports 对象打交道（见 §15 adapter 分层）。
//   ports.storage  本地持久化（JSONL + 快照）
//   ports.now      时钟（测试可注入假时钟）
//   ports.fetcher  词库拉取（可注入；离线给 null）
//   ports.ai       AI 增强（可注入；不注入就只有词库自带内容）
//   ports.context  「我上一级输入」的语境（只在用户点了 ✨ 时才读，隐私最小化 —— §9.1）

import * as M from './memory.mjs';
import { DAY_MS } from './memory.mjs';
import * as Q from './queue.mjs';
import * as S from './session.mjs';
import * as G from './game.mjs';
import * as MK from './mistake.mjs';
import * as L from './library.mjs';
import * as B from './beckon.mjs';
import { buildHook, createHookCache } from './hook.mjs';

// DAY_MS 只在 memory.mjs 声明一处：ESM 形态下经 import 拿到，单文件形态下同处一个作用域。
// （曾经三处重复声明，把整个单文件产物炸成 SyntaxError 白屏。）

export function createApp(ports = {}) {
  const storage = ports.storage || memoryStorage();
  const now = () => (ports.now ? ports.now() : Date.now());

  const state = {
    ready: false,
    readOnly: false, // 多窗口：第二个窗口只读（§7.4）
    readOnlyReason: null,
    dayKey: Q.dayKey(now()),
    words: [],
    mem: {},
    confusions: {},
    personal: [],
    records: [],
    settings: null,
    streak: { current: 0, longest: 0, lastDay: null, totalDays: 0 },
    combo: G.newCombo(now()),
    exp: 0,
    pause: null,
    proposal: null, // 自适应提议（只提议，不自动执行 —— P4）
    container: null,
    session: null,
    lastReveal: null,
    offline: false,
    banner: null,
    librarySource: 'seed',
  };

  const listeners = new Set();
  function emit() {
    for (const fn of listeners) {
      try {
        fn(snapshotState());
      } catch {
        /* 一个监听器出错不该拖垮别人 */
      }
    }
  }
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function snapshotState() {
    return {
      ready: state.ready,
      readOnly: state.readOnly,
      readOnlyReason: state.readOnlyReason,
      dayKey: state.dayKey,
      streak: state.streak,
      combo: state.combo,
      exp: state.exp,
      settings: state.settings,
      pause: state.pause,
      proposal: state.proposal,
      container: state.container,
      session: state.session,
      card: state.session ? S.currentCard(state.session) : null,
      lastReveal: state.lastReveal,
      offline: state.offline,
      banner: state.banner,
      librarySource: state.librarySource,
      stats: computeStats(),
      empty: !state.container || state.container.items.length === 0,
    };
  }

  // ── 启动 ────────────────────────────────────────────────
  async function init() {
    const saved = (await storage.get('state')) || {};
    state.settings = normalizeSettings(saved.settings);
    state.mem = saved.mem || {};
    state.confusions = saved.confusions || {};
    state.personal = saved.personal || [];
    state.streak = { current: 0, longest: 0, lastDay: null, totalDays: 0, ...(saved.streak || {}) };
    state.combo = saved.combo || G.newCombo(now());
    state.exp = saved.exp || 0;
    state.pause = saved.pause || null;

    // 0 屏提问（§11）：默认四级，直接开背；首屏不问任何东西
    const coll = state.settings.collections?.[0] || 'cet4';
    const res = await L.loadCollection(coll, { fetcher: ports.fetcher, cache: cachePort() });
    state.words = mergePersonal(res.words, state.personal);
    state.mem = L.seedMemories(state.words, state.mem, now());
    state.offline = res.offline;
    state.banner = res.banner;
    state.librarySource = res.source;

    // 崩溃恢复：存在未结算的 sessionId → 恢复队列顺序与剩余词，已答过的不重考（§7.2）
    const snap = await storage.get('session');
    if (snap && snap.dayKey) {
      const restored = S.restore(snap, {
        words: state.words,
        mem: state.mem,
        confusions: state.confusions,
        quizPool: state.words,
        now: now(),
      });
      if (restored && !S.isFinished(restored) && snap.dayKey === state.dayKey) {
        state.session = S.resumeSession(restored, now());
      }
    }

    if (!state.session) buildContainer();
    state.ready = true;
    emit();
    return snapshotState();
  }

  function cachePort() {
    return {
      get: (k) => storage.get(`cache:${k}`),
      set: (k, v) => storage.set(`cache:${k}`, v),
    };
  }

  function mergePersonal(words, personal) {
    const byId = new Map(words.map((w) => [w.id, w]));
    for (const p of personal) {
      if (!byId.has(p.id)) byId.set(p.id, p);
      else byId.set(p.id, { ...byId.get(p.id), ...p, personal: true });
    }
    return [...byId.values()];
  }

  function normalizeSettings(s = {}) {
    return {
      collections: s.collections || ['cet4'],
      dailyGoal: clampInt(s.dailyGoal ?? 20, 3, 200), // N = 20 铁律的默认值，用户可自己改
      balance: typeof s.balance === 'number' ? s.balance : 0.5, // 攻守天平
      // 新词出场顺序：'shuffle'（默认，随机）| 'seq'（按词库/字母序）
      order: s.order === 'seq' ? 'seq' : 'shuffle',
      aiMode: s.aiMode || 'ondemand', // off | ondemand | all
      masterEnabled: s.masterEnabled !== false, // AI 增强总开关（默认开）
      roundSize: s.roundSize || 5, // 碎片冲刺 3/5/10
      paused: s.paused || null,
      vacationUntil: s.vacationUntil || null,
      dismissedProposals: s.dismissedProposals || {},
      prompts: s.prompts || defaultPrompts(),
      schemaVersion: 1,
    };
  }
  function clampInt(v, lo, hi) {
    const n = Math.round(Number(v) || 0);
    return Math.max(lo, Math.min(hi, n));
  }

  // ── 日容器 ──────────────────────────────────────────────
  function buildContainer() {
    const key = Q.dayKey(now());
    const gap = gapDays();
    state.dayKey = key;
    const auto = Q.containerSize(gap, state.settings.dailyGoal);
    // 恢复：连续 3 天正常完成 → 自动回到 N（不问）
    const recovered = Q.effectiveBaseN(state.settings.dailyGoal, state.streak, state.history?.days);
    const N = recovered || auto;
    state.container = {
      ...Q.buildDailyContainer(personalToWords(), state.mem, {
        N,
        gapDays: gap,
        balance: state.settings.balance,
        now: now(),
        collections: state.settings.collections,
        todayStats: todayStats(),
        // 新词随机顺序的种子 = 今天。同一天内结果稳定，所以中途重开面板
        // 仍然是「从第 N 个词继续」（规格 §7.2 / §540）；换一天换一个排法。
        seed: key,
        order: state.settings.order,
      }),
      dayKey: key,
      gapDays: gap,
      comeback: Q.comebackCopy(gap),
      baseN: state.settings.dailyGoal,
      autoN: auto,
    };
    state.session = S.createSession({ ...state.container, dayKey: key }, sessionOpts());
    persist();
    emit();
    return state.container;
  }

  function personalToWords() {
    const personalIds = new Set(state.personal.map((p) => p.id));
    return state.words.map((w) => (personalIds.has(w.id) ? { ...w, personal: true } : w));
  }
  function sessionOpts() {
    return {
      words: state.words,
      mem: state.mem,
      confusions: state.confusions,
      quizPool: state.words,
      sessionId: `s${now().toString(36)}`,
      now: now(),
    };
  }
  function todayStats() {
    const today = state.records.filter((r) => r.dayKey === state.dayKey);
    const newRecs = today.filter((r) => r.tier === 3);
    const wrong = newRecs.filter((r) => r.incorrect).length;
    return {
      newAnswerCount: newRecs.length,
      newWrongRate: newRecs.length ? wrong / newRecs.length : 0,
    };
  }
  function gapDays() {
    if (!state.streak.lastDay) return 0;
    return Math.max(0, Q.daysBetweenKeys(state.streak.lastDay, Q.dayKey(now())) - 1);
  }

  // ── 作答 ────────────────────────────────────────────────
  function rate(rating, extra = {}) {
    const s = state.session;
    if (!s || state.readOnly) return null;
    const card = S.currentCard(s);
    if (!card) return null;
    const t0 = extra.reactionMs ?? 0;
    const payload = S.submitRating(s, card, rating, { ...extra, now: now(), reactionMs: t0 });
    state.mem = s.mem;
    state.lastReveal = payload.reveal;
    state.lastPlan = payload.plan;
    state.combo = s.combo;
    state.exp = s.exp;
    writeRecord({
      mode: card.mode,
      rating,
      correct: rating !== S.RATING.FORGOT,
      fakeMastery: false,
      card,
      extra,
    });
    persist();
    emit();
    return payload;
  }

  function next() {
    const s = state.session;
    if (!s) return null;
    S.advance(s, now());
    state.lastReveal = null;
    if (S.isFinished(s)) settle();
    persist();
    emit();
    return S.currentCard(s);
  }

  function undo() {
    const res = S.undoLast(state.session, now());
    if (res.ok) {
      state.lastReveal = null;
      persist();
      emit();
    }
    return res;
  }

  /** 揭晓后用户说「其实我搞混了」→ 假掌握 +2，并立刻安排同轮重训。 */
  function reportFakeMastery(confusedWith) {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const res = S.reportFakeMastery(s, card, confusedWith, { now: now() });
    state.mem = s.mem;
    if (confusedWith) state.confusions = MK.noteConfusion(state.confusions, card.word.id, confusedWith, now());
    writeRecord({ mode: card.mode, rating: S.RATING.KNOWN, correct: false, fakeMastery: true, card, extra: { confusedWith } });
    persist();
    emit();
    return res;
  }

  /** 辨词作答。 */
  function answerQuiz(optionId, extra = {}) {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const res = S.submitQuiz(s, card, optionId, { ...extra, now: now(), reactionMs: extra.reactionMs ?? 0 });
    state.mem = s.mem;
    state.combo = s.combo;
    state.exp = s.exp;
    // 供 UI 显示「并排两个词 + 一句人话」（§5.3：不出现红叉）
    state.lastRevealResult = res;
    state.lastReveal = { quiz: true, correct: res.correct };
    state.lastHuman = res.human ? res.human.line : null;
    state.lastPlan = res.plan;
    if (!res.correct && res.chosen) {
      state.confusions = MK.noteConfusion(state.confusions, card.word.id, res.chosen.id, now());
    }
    writeRecord({ mode: 'quiz', rating: res.correct ? S.RATING.KNOWN : S.RATING.FORGOT, correct: res.correct, card, extra: { chosen: res.chosen?.id } });
    persist();
    emit();
    return res;
  }

  /** 安全阀：这道题有问题（本词本轮不计分并标记待复核 —— §5.3）。 */
  function flagQuestion() {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const partner = card.quizOptions?.find((o) => !o.correct)?.id;
    state.confusions = MK.flagConfusion(state.confusions, card.word.id, partner || card.word.id, now());
    // 不计分：跳过这张卡
    card.flagged = true;
    S.advance(s, now());
    persist();
    emit();
    return { ok: true, blacklisted: (state.confusions[MK.pairKey(card.word.id, partner || card.word.id)] || {}).blacklisted };
  }

  function quiz() {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const q = S.buildQuiz(card, s, ports.rand || Math.random);
    card.quizOptions = q.options;
    return q;
  }

  // ── 一轮结束 ────────────────────────────────────────────
  function settle() {
    const s = state.session;
    if (!s) return null;
    const key = Q.dayKey(now());
    const done = s.stats.answered;
    const checked = Q.isCheckedIn(done, s.plannedSize);
    if (checked) {
      state.streak = Q.bumpStreak(state.streak, key);
      (state.history = state.history || { days: [] }).days.push({ key, done: true });
    } else {
      (state.history = state.history || { days: [] }).days.push({ key, done: false });
    }
    // 每周一次：周度对账单（§7.5 证据③，必须是周报不是日报）
    const rep = maybeWeeklyReport();
    if (rep) state.report = rep;
    // 放弃信号检测 + 自适应提议（只提议，不自动改 —— P4）
    state.proposal = detectProposal();
    state.roundJustFinished = true;
    state.container = { ...state.container, done, checkedIn: checked };
    return state.container;
  }

  function writeRecord(rec) {
    const card = rec.card;
    const row = {
      ts: now(),
      dayKey: Q.dayKey(now()),
      wordId: card.word.id,
      mode: rec.mode,
      selfRating: rec.rating,
      correct: !!rec.correct,
      incorrect: !rec.correct,
      fakeMastery: !!rec.fakeMastery,
      reactionMs: rec.extra?.reactionMs ?? 0,
      hintUsed: !!rec.extra?.hintUsed,
      confusedWith: rec.extra?.confusedWith || rec.extra?.chosen || null,
      cardId: card.cardId,
      sessionId: state.session?.sessionId || null,
      queueSnapshotId: state.session?.dayKey || null,
      tier: card.tier,
      schemaVersion: 1,
    };
    state.records.push(row);
    // 追加写，不可变（P5：每答完一张卡即落盘）
    storage.append('records', row);
  }

  // ── 统计 ────────────────────────────────────────────────
  function computeStats() {
    const conquered = G.conqueredCount(state.words, state.mem, (m) => M.isConquered(m, now()));
    const learned = state.words.filter((w) => (state.mem[w.id]?.encodeCount || 0) > 0).length;
    const todayRecs = state.records.filter((r) => r.dayKey === state.dayKey);
    const total = Math.max(1, todayRecs.length);
    const correct = todayRecs.filter((r) => r.correct).length;
    return {
      conquered, // 「已收服 N 词」取代「掌握度 x%」（§7.5 证据①）
      learned,
      totalWords: state.words.length,
      todayAnswered: todayRecs.length,
      todayAccuracy: correct / total,
      level: G.levelFor(state.exp),
      heatmap: heatmap(),
      curve: null, // 按需计算，避免每次 emit 都跑 30 天模拟
      diagnosis: MK.diagnosis(todayRecs, { wordById: wordByIdFn() }),
      stubborn: stubbornWords(10),
      confusionsNeedingDrill: MK.pairsNeedingDrill(state.confusions),
    };
  }
  const wordByIdFn = () => (id) => state.words.find((w) => w.id === id);

  function retention() {
    const ids = new Set(state.container ? state.container.items.map((i) => i.word.id) : []);
    const mems = [...ids].map((id) => state.mem[id]).filter(Boolean);
    return M.retentionCurve(mems, { days: 30, now: now() });
  }

  function heatmap({ weeks = 15 } = {}) {
    const byDay = new Map();
    for (const r of state.records) byDay.set(r.dayKey, (byDay.get(r.dayKey) || 0) + 1);
    const days = [];
    // 口径与记录完全一致：每个格子按 4:00 分界的 dayKey 取
    const offset = 3600000 * (Q.DAY_START_HOUR + 1);
    const todayTs = Q.dayStartTs(now()) + offset;
    for (let i = weeks * 7 - 1; i >= 0; i--) {
      const key = Q.dayKey(todayTs - i * DAY_MS);
      const n = byDay.get(key) || 0;
      // 空白天数没有任何红字警告（§7.1）—— level 0 就是空白，不是惩罚
      days.push({ key, n, level: n === 0 ? 0 : n < 5 ? 1 : n < 12 ? 2 : n < 20 ? 3 : 4 });
    }
    return days;
  }

  function stubbornWords(n) {
    return state.words
      .map((w) => ({ w, e: state.mem[w.id]?.e || 0 }))
      .filter((x) => x.e > 0)
      .sort((a, b) => b.e - a.e)
      .slice(0, n);
  }

  // ── 周报 ────────────────────────────────────────────────
  function maybeWeeklyReport() {
    const key = Q.dayKey(now());
    const today = new Date(now());
    if (today.getDay() !== 1) return null; // 只在周一自动出（§7.8 周一那行）
    const last = state.settings.lastReportDay;
    if (last === key) return state.report || null;
    state.settings.lastReportDay = key;
    const weekAgo = now() - 7 * DAY_MS;
    const recs = state.records.filter((r) => r.ts >= weekAgo);
    const words = new Set(recs.map((r) => r.wordId)).size;
    const conqueredThisWeek = recs.filter((r) => r.correct && r.mode === 'quiz').length;
    const diag = MK.diagnosis(recs, { wordById: wordByIdFn() });
    const stubborn = stubbornWords(1)[0];
    const rec = suggestNextWeek(recs, diag);
    return {
      weekStart: Q.dayKey(weekAgo),
      words,
      conqueredThisWeek,
      longestStreak: state.streak.longest,
      stubborn: stubborn ? { word: stubborn.w.word, e: stubborn.e } : null,
      diagnosis: diag.sentence,
      suggestion: rec,
    };
  }

  function suggestNextWeek(recs, diag) {
    if (!recs.length) return null;
    const acc = recs.filter((r) => r.correct).length / recs.length;
    if (acc < 0.6 && diag?.kind === MK.ERROR_KIND.sound) {
      return '下周把新词减到 15 个，先把读音像的那几组清掉。';
    }
    if (acc < 0.6) return '下周把新词减到 15 个，先把复习做完。';
    if (acc > 0.85) return '手感不错 —— 想加量的话可以在设置里把每天调到 25 个。';
    return '照现在这样走就行。';
  }

  // ── 放弃信号检测（§7.6：系统主动降载，而不是等用户用尽力气）──
  function detectProposal() {
    const days = (state.history?.days || []).slice(-3);
    const dismissed = state.settings.dismissedProposals || {};
    const canPropose = (k) => !dismissed[k] || now() - dismissed[k] > 7 * DAY_MS;
    const todayRecs = state.records.filter((r) => r.dayKey === state.dayKey);
    if (todayRecs.length > 0 && todayRecs.length < 3 && canPropose('lowAnswer')) {
      const shortSessions = (state.history?.shortStreak || 0) + 1;
      state.history = { ...(state.history || {}), shortStreak: shortSessions };
      if (shortSessions >= 3) return { kind: 'reduce', to: 8, text: '要不要把每天降到 8 个？先把习惯养起来。' };
    }
    if (days.length === 3 && days.every((d) => !d.done) && canPropose('lowDone')) {
      return { kind: 'reduceRound', to: 3, text: '要不要把每轮改成 3 个？做完就算完。' };
    }
    return null;
  }

  function acceptProposal() {
    const p = state.proposal;
    if (!p) return;
    if (p.kind === 'reduce') state.settings.dailyGoal = p.to;
    if (p.kind === 'reduceRound') state.settings.roundSize = p.to;
    state.proposal = null;
    persist();
    emit();
  }
  function dismissProposal() {
    const p = state.proposal;
    if (!p) return;
    state.settings.dismissedProposals = { ...state.settings.dismissedProposals, [p.kind]: now() };
    state.proposal = null; // 拒绝后静默 7 天
    persist();
    emit();
  }

  // ── 设置 ────────────────────────────────────────────────
  function updateSettings(patch) {
    state.settings = normalizeSettings({ ...state.settings, ...patch });
    // dailyGoal / balance 变了必须重建，否则预算对不上。
    //
    // 但 **order（新词顺序）故意不在这里重建**：
    // buildContainer() 会 createSession() 出一轮全新的队列，正在背的那一轮
    // 就没了。拨个顺序开关把用户背到一半的 12 个词清掉，代价太大。
    // 所以它立即保存、**下一轮自然生效**（面板上会明说这一点）。
    if (patch.dailyGoal || patch.balance !== undefined) buildContainer();
    persist();
    emit();
  }

  /** 主动休假（§7.7）：有钥匙的退出，比偷偷溜走更容易回来。 */
  function setVacation(untilTs) {
    state.settings.vacationUntil = untilTs;
    persist();
    emit();
  }

  // ── 生词本（§10）──
  function addPersonal(word, { context = null, source = null } = {}) {
    const id = word.id || `personal:${String(word.word).toLowerCase()}`;
    const entry = {
      id,
      word: word.word,
      ipa: word.ipa || '',
      pos: word.pos || '',
      meaning: word.meaning || '',
      example: context || word.example || null,
      collection: 'personal',
      personal: true,
      addedTs: now(),
      source,
      seq: 100000 + state.personal.length,
    };
    state.personal = [...state.personal.filter((p) => p.id !== id), entry];
    state.words = mergePersonal(state.words, [entry]);
    state.mem = L.seedMemories([entry], state.mem, now());
    persist();
    emit();
    return entry;
  }
  function removePersonal(id) {
    state.personal = state.personal.filter((p) => p.id !== id);
    persist();
    emit();
  }

  // ── 情绪胶囊（§3）──
  function beckon() {
    return B.beckonState({
      now: now(),
      hasRecords: state.records.length > 0,
      streak: state.streak,
      gapDays: gapDays(),
      dueCount: state.container ? state.container.stats.dueTotal : 0,
      deferredCount: state.container ? state.container.stats.deferred : 0,
      containerDone: state.container ? state.container.done || 0 : 0,
      containerSize: state.container ? state.container.stats.containerSize : 0,
      session: state.session,
      streamActive: !!ports.isStreaming?.(),
      roundJustFinished: !!state.roundJustFinished,
      paused: state.pause,
      vacationUntil: state.settings?.vacationUntil,
      combo: state.combo,
      longest: state.streak.longest,
    });
  }

  // ── 记忆钩子「✨ 让我记住它」（§9）──
  // 规格：每词一生只付一次，结果写回本地永久复用；失败不阻塞卡片。
  //
  // 这里**总是能成功**：钩子由 hook.mjs 从词库的真实材料（词根/例句/搭配/
  // 易混词）组出来，离线可算、不编造、零等待。所以那句
  // 「✨ 暂时没编出来 · 重试」在这条路径上不会出现 —— 它只该在
  // **接了真 AI 且 AI 真的挂了**时出现（规格 §9 的原意）。
  const hookCache = createHookCache({ storage });

  /**
   * 取某个词的记忆钩子。有缓存直接返回（零等待），没有就生成 + 永久写回。
   * @returns {Promise<{text, source, sourceLabel, word, cached}>}
   */
  async function hookFor(wordOrId) {
    const word =
      typeof wordOrId === 'string'
        ? state.container?.items?.find((c) => c.word && c.word.id === wordOrId)?.word ||
          (state.personal || []).find((w) => w.id === wordOrId) ||
          null
        : wordOrId;
    if (!word) return null;
    const { hook, cached } = await hookCache.ensure(word);
    return { ...hook, cached };
  }

  /** 只读查询，不触发生成（设置页/词本页要看"编过没有"）。 */
  async function hookPeek(wordId) {
    return hookCache.get(wordId);
  }

  function persist() {
    storage.set('state', {
      settings: state.settings,
      mem: state.mem,
      confusions: state.confusions,
      personal: state.personal,
      streak: state.streak,
      combo: state.combo,
      exp: state.exp,
      pause: state.pause,
      history: state.history,
    });
    if (state.session) storage.set('session', S.snapshot(state.session));
  }

  return {
    init,
    subscribe,
    get state() {
      return snapshotState();
    },
    raw: state,
    buildContainer,
    rate,
    next,
    undo,
    quiz,
    answerQuiz,
    flagQuestion,
    reportFakeMastery,
    retention,
    updateSettings,
    setVacation,
    addPersonal,
    removePersonal,
    acceptProposal,
    dismissProposal,
    beckon,
    hookFor,
    hookPeek,
    refresh: () => {
      state.dayKey = Q.dayKey(now());
      state.container = state.container ? { ...state.container } : null;
      emit();
    },
    persist,
  };
}

function defaultPrompts() {
  return {
    hook: [
      '角色：中文母语的英语学习者，正在做单词记忆卡片',
      '任务：为单词生成「一句话记忆钩子」',
      '硬约束：',
      '· 只用一句，不超 40 字',
      '· 词根词源只在有把握时使用，没把握改用场景联想',
      '· 严禁编造词源、编造释义',
      '· 禁止空洞套话（"多读多背就记住了"）',
      '· 中文输出',
      '输出：{ hook, example, collocation }',
    ].join('\n'),
    contrast: [
      '任务：为混淆对 {wordA, wordB} 生成一组辨析',
      '硬约束：',
      '· 必须包含「一句话区分法」，用最短锚点区分二者',
      '· 干扰项必须真难（音近/形近/义近），不许一眼假',
      '· 不许说"这两个词很容易混淆"之类的废话',
      '输出：{ anchor, contrast, quiz[4] }',
    ].join('\n'),
  };
}

/** 没有 storage port 时的内存实现（测试用）。 */
function memoryStorage() {
  const map = new Map();
  const lists = new Map();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    append(k, row) {
      const arr = lists.get(k) || [];
      arr.push(row);
      lists.set(k, arr);
    },
    list(k) {
      return lists.get(k) || [];
    },
  };
}
