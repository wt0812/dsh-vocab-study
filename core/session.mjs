// vocab-study / core / session.mjs
// 一场学习的完整状态机：出卡 → 自评 → 揭晓 → 同轮重训 → 结算。
//
// 规格里最难也最重要的两条在这里：
//   §5.5 「答错后不得立刻重问同一个词」——必须隔 3–8 张卡
//   §5.2 「同屏最多 1 张卡；连续新词不超过 2 个，第 3 个前必须插入复习词」
//
// 这个文件不认识 DSH，也不认识 DOM；它只输出「下一张卡应该是什么」。

import * as M from './memory.mjs';
import { errorDelta, pickDistractors } from './mistake.mjs';
import { newCombo, stepCombo, freezeCombo, resumeCombo, expFor } from './game.mjs';

/** 同轮重训的插入间距：必须 ≥3 且 ≤8 张卡（§5.5）。取 4 落在安全带正中。 */
export const RETRY_GAP_MIN = 3;
export const RETRY_GAP_MAX = 8;
export const RETRY_GAP_DEFAULT = 4;
/** 「模糊」的再现更靠后一点（第 6 张后）。 */
export const FUZZY_GAP_DEFAULT = 6;
/** 连续新词上限：第 3 个前必须插复习词。 */
export const MAX_CONSECUTIVE_NEW = 2;
/** 撤销窗口：2 秒内可撤销，不留脏数据（§5.2）。 */
export const UNDO_WINDOW_MS = 2000;
/** 一个词错误计数 ≥3 → 自动切辨词模式（§5.3）。 */
export const QUIZ_ERROR_THRESHOLD = 3;

export const MODE = { RECOGNIZE: 'recognize', QUIZ: 'quiz' };
export const RATING = { FORGOT: 'forgot', FUZZY: 'fuzzy', KNOWN: 'known' };

let seqCounter = 0;
function nextSeq() {
  return ++seqCounter;
}

/**
 * 创建一场学习。
 *
 * @param container buildDailyContainer 的产物
 * @param opts      { words, mem, sessionId, now, quizPool, confusions }
 */
export function createSession(container, opts = {}) {
  const now = opts.now ?? Date.now();
  const words = opts.words || [];
  const mem = opts.mem || {};
  const byId = new Map(words.map((w) => [w.id, w]));

  const queue = container.items.map((it, index) => {
    const badges = it.badges || [];
    return {
      queueId: `q${index + 1}`,
      cardId: `c${nextSeq()}`,
      word: it.word,
      tier: it.tier,
      reason: it.reason,
      badges,
      mode: modeForQueueItem(it, mem),
      // 同轮内每个词最多被重训 2 次（§5.5：忘了 → 同轮 ≥2 次）
      retriesDone: 0,
      retriesPlanned: 0,
      answered: false,
      insertedRetry: false,
    };
  });

  const session = {
    v: 1,
    sessionId: opts.sessionId || `s${now.toString(36)}`,
    dayKey: container.dayKey,
    containerSize: container.stats?.containerSize ?? queue.length,
    plannedSize: queue.length,
    queue,
    cursor: 0,
    history: [], // 已完成卡（含被撤销后剔除）
    undoStack: [],
    combo: newCombo(now),
    exp: 0,
    startedTs: now,
    endedTs: null,
    byId,
    mem,
    confusions: opts.confusions || {},
    quizPool: opts.quizPool || words,
    stats: {
      answered: 0,
      correct: 0,
      forgot: 0,
      fuzzy: 0,
      known: 0,
      fakeMastery: 0,
      quizAnswered: 0,
      quizCorrect: 0,
      newAnswerCount: 0,
      newWrongCount: 0,
      get newWrongRate() {
        return this.newAnswerCount ? this.newWrongCount / this.newAnswerCount : 0;
      },
      startedTs: now,
    },
  };
  // 开局就先把「连续新词 ≤ 2」摆平，别等到第 3 张才补救（§5.2）
  ensureNewWordCap(session);
  return session;
}

/** 某条队列项该用哪种卡模式：错频 ≥3 → 辨词；「模糊」词下次必走辨词。 */
function modeForQueueItem(it, mem) {
  const m = mem[it.word.id];
  if (it.reason === 'retry-quiz') return MODE.QUIZ;
  if (m && (m.e || 0) >= QUIZ_ERROR_THRESHOLD) return MODE.QUIZ;
  if (m && m.nextMode === MODE.QUIZ) return MODE.QUIZ;
  if (it.retryReason === 'fuzzy') return MODE.QUIZ;
  return MODE.RECOGNIZE;
}

/** 当前卡。同屏永远只有这一张。 */
export function currentCard(session) {
  return session.queue[session.cursor] || null;
}

/** 是否还有卡。 */
export function isFinished(session) {
  return session.cursor >= session.queue.length;
}

/**
 * 提交自评。这是核心动作：它决定这个词接下来发生什么。
 *
 * @returns 揭晓信息 payload { word, memory, reveal, plan }
 *   plan 里写明「这个词接下来还见不见、什么时候见」—— 这是 §5.5 的落地。
 */
export function submitRating(session, card, rating, extra = {}) {
  const now = extra.now ?? Date.now();
  const wordId = card.word.id;
  const prevMem = session.mem[wordId] || M.newMemory({}, now);

  // 假掌握：自评「会了」但揭晓后发现搞混 → 错误计数 +2（§5.4）
  // 判定方式：调用了 submitReveal 传回 correct=false，或用户点了「其实搞混了」
  const baseDelta = errorDelta({ rating, fakeMastery: false });
  const e = prevMem.e + baseDelta;

  const nextMem = M.encode(
    prevMem,
    { rating, correct: rating === RATING.KNOWN, reactionMs: extra.reactionMs, hintUsed: extra.hintUsed, e, now },
    extra.theta,
  );
  // 「模糊」→ 下次必走辨词模式（§5.5）
  if (rating === RATING.FUZZY) nextMem.nextMode = MODE.QUIZ;
  else if (rating === RATING.KNOWN) nextMem.nextMode = null;

  session.mem[wordId] = nextMem;
  card.answered = true;
  card.rating = rating;

  const s = session.stats;
  s.answered++;
  if (rating === RATING.FORGOT) s.forgot++;
  else if (rating === RATING.FUZZY) s.fuzzy++;
  else s.known++;
  if (card.tier === 3) {
    s.newAnswerCount++;
    if (rating === RATING.FORGOT) s.newWrongCount++;
  }
  session.combo = stepCombo(session.combo, rating === RATING.KNOWN, now);
  session.exp += expFor({ rating, correct: rating === RATING.KNOWN, mult: session.combo.mult, isReview: card.tier === 1 });

  const plan = planRetry(session, card, rating, now);
  session.undoStack.push({
    card,
    prevMem,
    prevCombo: stepComboSnapshot(session, rating),
    at: now,
    plan,
  });
  if (session.undoStack.length > 20) session.undoStack.shift();

  return {
    card,
    word: card.word,
    memory: nextMem,
    plan,
    combo: session.combo,
    exp: session.exp,
    reveal: revealFor(card.word, nextMem, extra),
  };
}

function stepComboSnapshot() {
  return null; // 预览用；撤销时直接按 rating 反推，无需快照
}

/** 揭晓面板内容：词库自带内容 0 延迟，折叠项永不自动展开（§5.2）。 */
export function revealFor(word, mem, extra = {}) {
  return {
    pos: word.pos || '',
    meaning: word.meaning || '',
    example: word.example || null,
    exampleZh: word.exampleZh || null,
    collocations: word.collocations || [],
    roots: word.roots || null,
    synonyms: word.synonyms || [],
    confusables: word.confusables || [],
    // 该词无例句 → 灰字提示（§5.2）
    exampleMissing: !word.example,
    memory: mem,
  };
}

/**
 * 决定这个词在本轮里的重训路径（§5.5 三条路径）。
 *   😰 忘了 → 同轮重训：第 3 张后重现 1 次，第 8 张后再 1 次（同轮内 ≥2 次）
 *   🤔 模糊 → 同轮再现 1 次（第 6 张后），且下次必走辨词模式
 *   😎 会了 → 进正常遗忘曲线，本轮不再打扰
 */
export function planRetry(session, card, rating, now = Date.now()) {
  if (rating === RATING.KNOWN) {
    return { action: 'none', note: '本轮不再出现，明天按遗忘曲线见' };
  }
  if (rating === RATING.FUZZY) {
    if (card.retriesDone >= 1) return { action: 'none', note: '本轮已再现过，下次走辨词' };
    return insertRetry(session, card, { gap: FUZZY_GAP_DEFAULT, reason: 'fuzzy', quiz: true, now });
  }
  // forgot：本轮至少再现 2 次
  const planned = card.retriesDone;
  if (planned >= 2) return { action: 'none', note: '本轮已重训两次，明天降序前置' };
  const gap = planned === 0 ? 3 : 8 - planned; // 第一次第 3 张后，第二次第 8 张后
  return insertRetry(session, card, { gap, reason: 'forgot', quiz: planned >= 1, now });
}

/**
 * 把重训卡插进队列。插入点必须与前一次出现间隔 3–8 张卡。
 * 这就是「绝不立刻重问」的实现方式。
 */
export function insertRetry(session, card, { gap, reason, quiz, now = Date.now() }) {
  let target = session.cursor + gap;
  // 不要插到队尾之后太远；同时保证至少隔 RETRY_GAP_MIN 张
  target = Math.max(session.cursor + RETRY_GAP_MIN, Math.min(target, session.cursor + RETRY_GAP_MAX));
  if (target > session.queue.length) target = session.queue.length;

  const clone = {
    ...card,
    queueId: `${card.queueId}-r${card.retriesDone + 1}`,
    cardId: `c${nextSeq()}`,
    isRetry: true,
    retryReason: reason,
    mode: quiz ? MODE.QUIZ : card.mode,
    retriesDone: card.retriesDone + 1,
    answered: false,
    rating: undefined,
  };
  card.retriesPlanned = (card.retriesPlanned || 0) + 1;

  // 先找满足最小间隔的位置；若那里已经有同一张卡的待答重训，就往后挪
  let insertAt = target;
  while (
    insertAt < session.queue.length &&
    session.queue[insertAt] &&
    session.queue[insertAt].word.id === card.word.id
  ) {
    insertAt++;
  }
  session.queue.splice(insertAt, 0, clone);
  const actualGap = insertAt - session.cursor;
  void now;
  return {
    action: 'retry',
    gap: actualGap,
    at: insertAt,
    reason,
    quiz: !!quiz,
    note:
      reason === 'forgot'
        ? `隔 ${actualGap} 张卡后再见一次（不是立刻重问，那样只是短期记忆）`
        : `隔 ${actualGap} 张卡后再见一次，并且这次用辨词考你`,
  };
}

/**
 * 推进到下一张卡。
 * 这里执行「连续新词 ≤ 2」的硬约束：第 3 个新词前必须插一张复习词。
 */
export function advance(session, now = Date.now()) {
  session.cursor++;
  const guard = ensureNewWordCap(session);
  if (isFinished(session)) session.endedTs = now;
  return { card: currentCard(session), guard };
}

/** 一张卡算不算「新词」：第 3 层且不是同轮重训卡。 */
function isNewCard(card) {
  return !!card && card.tier === 3 && !card.isRetry;
}
// 暴露给测试用：让测试直接测真函数，而不是自己重写一遍判定逻辑
globalThis.__VS_isNewCard = isNewCard;

/**
 * 连续新词上限守卫（§5.2）：连续新词不超过 limit 个，第 limit+1 个前必须插入复习词。
 * 开局与每次推进后都调用一次，逐位检查整条队列。
 *
 * 注意：这是「有素材就拆」的约束，不是「凭空造出复习词」。
 * 队列里如果全是新词（比如刚换新词库、旧词全没到期），没有可插的复习词，
 * 这时应当让守卫报 applied:false，而不是假装满足约束。
 */
/**
 * 连续新词上限守卫（§5.2）：连续新词不超过 limit 个，第 limit+1 个前必须插入复习词。
 * 开局与每次推进后都调用一次。
 *
 * 做法（分块调度）：
 *   1. 把 tail 切成「复习词」与「新词」两堆；
 *   2. 新词按 limit 个一组切块，块数 > 1 时，块与块之间各需要一个复习词当间隔。
 *      所需间隔数 = ceil(新词数 / limit) - 1 —— 这是保证约束成立的最少复习词数；
 *   3. 多余的复习词排在最后（它们本来就是复习卡，早一点晚一点都行）；
 *   4. 复习词不够时就如实少插，绝不去动 head（用户已经看过的那部分）。
 *
 * 关键点：只能用 tail 里的复习词当间隔。早期版本从 cursor+1 往后搜，
 * 会搜到游标身后已经走过的卡，把同一张卡搬出两份 —— 那是个真 bug，
 * 所以现在改成「先分类再拼装」，并在最后做一次去重兜底。
 */
export function ensureNewWordCap(session, limit = MAX_CONSECUTIVE_NEW) {
  const trace = globalThis.__VS_GUARD_TRACE;
  const queue = session.queue;
  const cursor = Math.max(0, Math.min(session.cursor, queue.length));
  // 已走过的部分保持原样，只重塑「当前位置及之后」
  const head = queue.slice(0, cursor);
  const tail = queue.slice(cursor);

  const news = tail.filter((c) => isNewCard(c));
  const rests = tail.filter((c) => !isNewCard(c));

  const groupCount = Math.ceil(news.length / Math.max(1, limit));
  const needed = Math.max(0, groupCount - 1);
  const usable = Math.min(needed, rests.length);

  const body = [];
  let ni = 0;
  let ri = 0;
  for (let g = 0; g < groupCount; g++) {
    for (let k = 0; k < limit && ni < news.length; k++) body.push(news[ni++]);
    if (g < groupCount - 1 && ri < usable) body.push(rests[ri++]);
  }
  // 没用上的复习词放在后面；注意剩余复习词可能为 0
  for (; ri < rests.length; ri++) body.push(rests[ri]);

  const rebuilt = head.concat(body);

  // 去重兜底：万一拼接逻辑出错，也绝不让同一张卡出现两次
  const seen = new Set();
  const deduped = [];
  for (const card of rebuilt) {
    const key = card.cardId ?? card.word?.id ?? card;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(card);
  }
  if (deduped.length !== rebuilt.length && trace) {
    trace.push('去重触发：' + rebuilt.length + ' → ' + deduped.length + '（这是 bug，请检查守卫逻辑）');
  }

  session.queue = deduped;
  if (trace) {
    trace.push('guard：新词 ' + news.length + ' 复习词 ' + rests.length + ' limit=' + limit +
      ' 需间隔 ' + needed + ' 实插 ' + usable + '；' +
      queue.map((c) => (isNewCard(c) ? 'N' : '-')).join('') + ' → ' +
      session.queue.map((c) => (isNewCard(c) ? 'N' : '-')).join(''));
  }
  return { applied: usable > 0, moved: usable, needed, usable };
}

/**
 * 2 秒内撤销（§5.2）：误触自评可撤销，不留脏数据。
 */
export function undoLast(session, now = Date.now()) {
  const top = session.undoStack[session.undoStack.length - 1];
  if (!top) return { ok: false, reason: 'nothing' };
  if (now - top.at > UNDO_WINDOW_MS) return { ok: false, reason: 'expired' };
  // 把插入的重训卡撤掉
  const card = top.card;
  const undoneRating = card.rating; // 先记住，下面要按它回滚计数
  session.queue = session.queue.filter((c) => !(c.isRetry && c.word.id === card.word.id && c.retriesDone > card.retriesDone));
  session.mem[card.word.id] = top.prevMem;
  card.answered = false;
  card.rating = undefined;
  const s = session.stats;
  s.answered--;
  if (undoneRating === RATING.FORGOT) s.forgot--;
  else if (undoneRating === RATING.FUZZY) s.fuzzy--;
  else s.known--;
  if (card.tier === 3) {
    s.newAnswerCount--;
    if (undoneRating === RATING.FORGOT) s.newWrongCount--;
  }
  session.cursor = session.queue.indexOf(card);
  if (session.cursor < 0) session.cursor = Math.max(0, session.cursor);
  session.undoStack.pop();
  card.retriesPlanned = 0;
  return { ok: true, card };
}

// ─────────────────────────────────────────────────────────────
// 辨词模式
// ─────────────────────────────────────────────────────────────

/** 为一张辨词卡生成 4 个选项（含 3 个「真难」的干扰项）。 */
export function buildQuiz(card, session, rand = Math.random) {
  const distractors = pickDistractors(card.word, session.quizPool, {
    confusions: session.confusions,
    count: 3,
    rand,
  });
  const all = [card.word, ...distractors];
  // 洗牌
  const options = all
    .map((w) => ({ id: w.id, word: w.word, meaning: w.meaning, pos: w.pos, correct: w.id === card.word.id }))
    .sort(() => rand() - 0.5);
  return { prompt: card.word, options };
}

/**
 * 提交辨词作答。
 * 答错反馈不出现红叉，只并排显示两个词 + 一句人话（§5.3）。
 */
export function submitQuiz(session, card, optionId, { now = Date.now(), reactionMs, theta } = {}) {
  const correct = optionId === card.word.id;
  const chosen = session.byId.get(optionId) || session.quizPool.find((w) => w.id === optionId);
  const prevMem = session.mem[card.word.id] || M.newMemory({}, now);

  const fake = false;
  const delta = correct ? 0 : errorDelta({ rating: RATING.FORGOT, fakeMastery: fake });
  const e = prevMem.e + delta;
  let nextMem = M.encode(
    prevMem,
    { rating: correct ? RATING.KNOWN : RATING.FORGOT, correct, reactionMs, hintUsed: false, e, now },
    theta,
  );
  // 辨词答对 → 记下「收服」判定的必要条件（§7.5）
  if (correct) nextMem = M.markQuizCorrect(nextMem, now);
  session.mem[card.word.id] = nextMem;

  const s = session.stats;
  s.answered++;
  s.quizAnswered++;
  if (correct) {
    s.quizCorrect++;
    s.correct++;
    s.known++;
  } else {
    s.forgot++;
    if (card.tier === 3) s.newWrongCount++;
  }
  if (card.tier === 3) s.newAnswerCount++;
  session.combo = stepCombo(session.combo, correct, now);
  session.exp += expFor({ rating: correct ? RATING.KNOWN : RATING.FORGOT, correct, mult: session.combo.mult, isReview: card.tier === 1 });
  card.answered = true;
  card.rating = correct ? RATING.KNOWN : RATING.FORGOT;
  card.quizCorrect = correct;

  const plan = correct ? { action: 'none', note: '辨词答对 —— 这个词算真的收下了' } : planRetry(session, card, RATING.FORGOT, now);

  return {
    correct,
    chosen: chosen ? { id: chosen.id, word: chosen.word, meaning: chosen.meaning } : null,
    target: { id: card.word.id, word: card.word.word, meaning: card.word.meaning },
    // 人话反馈：不指责，只告诉你差别在哪
    human: correct ? null : humanizeConfusion(card.word, chosen),
    plan,
    combo: session.combo,
  };
}

/** 答错时的一句人话 + 并排对比。绝不出现红叉、绝不指责。 */
export function humanizeConfusion(target, chosen) {
  if (!chosen) return { line: `这两个意思挨着，我把它们放一起了。`, pair: [target.word, null] };
  const sameHead = target.word[0] === chosen.word[0];
  const lenDiff = Math.abs(target.word.length - chosen.word.length);
  let line;
  if (lenDiff <= 1 && !sameHead) line = `一个 /${target.ipa || '—'}/，一个 /${chosen.ipa || '—'}/ —— 只是读起来像。`;
  else if (sameHead) line = `开头一样，后半截不一样：${target.word} 是「${short(target.meaning)}」，${chosen.word} 是「${short(chosen.meaning)}」。`;
  else line = `意思挨着但用法不同，放一起看一眼就分开了。`;
  return { line, pair: [target.word, chosen.word] };
}
function short(s = '') {
  const t = String(s).split(/[；;，,]/)[0];
  return t.length > 8 ? t.slice(0, 8) : t;
}

/** 一次「其实我搞混了」—— 自评会了但翻车，错误计数 +2（假掌握）。 */
export function reportFakeMastery(session, card, confusedWith, { now = Date.now(), theta } = {}) {
  const prevMem = session.mem[card.word.id] || M.newMemory({}, now);
  const e = prevMem.e + errorDelta({ rating: RATING.KNOWN, fakeMastery: true });
  const nextMem = { ...M.encode(prevMem, { rating: RATING.KNOWN, correct: false, e, now }, theta), nextMode: MODE.QUIZ };
  session.mem[card.word.id] = nextMem;
  session.stats.fakeMastery++;
  session.stats.correct = Math.max(0, session.stats.correct);
  const plan = insertRetry(session, card, { gap: RETRY_GAP_MIN + 1, reason: 'forgot', quiz: true, now });
  return { memory: nextMem, plan, confusedWith };
}

// ─────────────────────────────────────────────────────────────
// 面板收起 / 重开
// ─────────────────────────────────────────────────────────────

/** 收起面板：Combo 冻结而非清零，进度落盘（每答一张就已落盘，P5）。 */
export function pauseSession(session, now = Date.now()) {
  return { ...session, combo: freezeCombo(session.combo, now), pausedTs: now };
}

/** 重开面板：恢复队列顺序与剩余词，已答过的不重考（§7.2 崩溃恢复）。 */
export function resumeSession(session, now = Date.now()) {
  return { ...session, combo: resumeCombo(session.combo, now), pausedTs: null };
}

/** 把会话压成可持久化的快照（崩溃恢复用）。 */
export function snapshot(session) {
  const card = currentCard(session);
  return {
    v: session.v,
    sessionId: session.sessionId,
    dayKey: session.dayKey,
    containerSize: session.containerSize,
    plannedSize: session.plannedSize,
    cursor: session.cursor,
    queue: session.queue.map((c) => ({
      queueId: c.queueId,
      cardId: c.cardId,
      wordId: c.word.id,
      tier: c.tier,
      reason: c.reason,
      mode: c.mode,
      retriesDone: c.retriesDone,
      isRetry: !!c.isRetry,
      retryReason: c.retryReason || null,
      answered: !!c.answered,
      rating: c.rating || null,
    })),
    currentCardId: card ? card.cardId : null,
    combo: session.combo,
    exp: session.exp,
    stats: { ...session.stats, newWrongRate: undefined },
    startedTs: session.startedTs,
    savedTs: Date.now(),
  };
}

/** 从快照恢复：队列顺序与剩余词原样还原，已答过的不重考。 */
export function restore(snap, { words, mem, confusions, quizPool, now = Date.now() } = {}) {
  if (!snap || !Array.isArray(snap.queue)) return null;
  const byId = new Map(words.map((w) => [w.id, w]));
  const queue = [];
  for (const c of snap.queue) {
    const w = byId.get(c.wordId);
    if (!w) continue; // 词库里已经删掉的词，安静跳过
    queue.push({
      queueId: c.queueId,
      cardId: c.cardId,
      word: w,
      tier: c.tier,
      reason: c.reason,
      badges: [],
      mode: c.mode,
      retriesDone: c.retriesDone || 0,
      retriesPlanned: 0,
      isRetry: !!c.isRetry,
      retryReason: c.retryReason,
      answered: !!c.answered,
      rating: c.rating || undefined,
    });
  }
  // 已答过的卡不重考（规格 §7.2 原文要求）
  const cursor = Math.max(0, Math.min(snap.cursor ?? 0, queue.length));
  return {
    v: 1,
    sessionId: snap.sessionId,
    dayKey: snap.dayKey,
    containerSize: snap.containerSize,
    plannedSize: snap.plannedSize || queue.length,
    queue,
    cursor,
    history: [],
    undoStack: [],
    combo: resumeCombo(snap.combo || newCombo(now), now),
    exp: snap.exp || 0,
    startedTs: snap.startedTs || now,
    endedTs: null,
    byId,
    mem,
    confusions: confusions || {},
    quizPool: quizPool || words,
    stats: { answered: 0, correct: 0, forgot: 0, fuzzy: 0, known: 0, fakeMastery: 0, quizAnswered: 0, quizCorrect: 0, newAnswerCount: 0, newWrongCount: 0, newWrongRate: 0, startedTs: now },
  };
}

export { stepCombo };
