// vocab-study / core / memory.mjs
// 半衰期回归（half-life regression, HLR）记忆模型。
// 纯逻辑：不依赖 DSH、不依赖 DOM、不依赖时钟以外的一切。
//
// 这一层回答的问题是：
//   「这个词，我现在还记得的概率有多大？下次该隔多久再问它？」
//
// 它与「定时表换皮」的区别：间隔不是写死的 1/3/7/15 天，
// 而是由 错误次数 / 历史正确率 / 反应时 / 是否用过提示 四个信号回归出来的。

/** 默认回归参数。a 越大越不容易忘；b/d 是负向特征（错得多、犹豫久 → 半衰期短）。 */
export const DEFAULT_THETA = { a: 3.0, b: 0.42, d: 0.30 };

/** 一天的毫秒数。单文件构建时各模块共享一个作用域，所以只在这里声明一次。 */
export const DAY_MS = 86400000;

/** 稳定度上限：避免长期答对后半衰期无限膨胀，导致这个词永远不再出现。 */
const M_MAX = 32;

/** 没把握时的默认值（词库拉取时种入，区分「真会」与「未校准」）。 */
const NEW_WORD = {
  difficulty: 0.30, // 错频偏高 → 初始半衰期短
  stability: 0, // 已巩固次数
  hintRate: 0, // 提示使用率
  reactionMs: 3500, // 未测得时的默认反应时
  correct: 0,
  wrong: 0,
  encodeCount: 0,
};

/** 建一条新词记忆状态。e 为初始错误计数（词库种子 0，答错后增长）。 */
export function newMemory(seed = {}, now = Date.now()) {
  const e = Number.isFinite(seed.e) ? seed.e : 0;
  return {
    ...NEW_WORD,
    ...seed,
    e,
    s: 0,
    lastSeenTs: seed.lastSeenTs ?? now,
    lastQuizCorrectTs: seed.lastQuizCorrectTs ?? null,
    firstSeenTs: seed.firstSeenTs ?? now,
  };
}

/** 把记忆状态投影成 HLR 的特征向量 x。 */
export function features(m) {
  return {
    wrong: m.e, // 历史错误计数：直接来自用户行为，不猜测
    acc: m.correct + m.wrong === 0 ? 0.5 : m.correct / (m.correct + m.wrong),
    rt: m.reactionMs, // 反应时：只进遗忘模型，不进错误频率（规格 §5.4）
    hint: m.hintRate,
    stability: m.stability,
    difficulty: m.difficulty,
  };
}

/**
 * 半衰期，单位：天。
 *   log2(h) = a + stability - b·错频 + d·(正确率-0.5) - rt 项 - hint 项 - difficulty
 * 结果夹在 [0.4, 32] 天之间。
 */
export function halfLifeDays(mem, theta = DEFAULT_THETA) {
  const f = features(mem);
  const rtTerm = Math.min(0.6, Math.max(0, (f.rt - 1500) / 6000));
  const log2h =
    theta.a +
    f.stability -
    theta.b * f.wrong +
    theta.d * (f.acc - 0.5) -
    rtTerm -
    0.18 * f.hint -
    0.9 * f.difficulty;
  const h = Math.pow(2, log2h);
  return Math.min(M_MAX, Math.max(0.4, h));
}

/** Δt 天后仍能回忆起来的概率：p = 2^(−Δt/h)。刚答对过 → 1.0。 */
export function recallProb(mem, dtDays, theta = DEFAULT_THETA) {
  if (dtDays <= 0) return 1;
  const h = halfLifeDays(mem, theta);
  return Math.pow(2, -dtDays / h);
}

/** 记忆强度 m ∈ [0,1]。规格 §5.4 要求它「不虚报」，所以取近期可回忆性的一半权重 +
 *  模型校准度的一半权重：只被问过一次的词，强度上不去。 */
export function strength(mem, now = Date.now(), theta = DEFAULT_THETA) {
  const dt = (now - mem.lastSeenTs) / DAY_MS;
  const p = recallProb(mem, Math.max(0, dt), theta);
  const evidence = Math.min(1, mem.encodeCount / 5); // 一次分类前最少 5 次作答
  return Math.max(0, Math.min(1, 0.65 * p + 0.35 * evidence));
}

/**
 * 「收服」判定（规格 §7.5 证据①）——必须是硬判定：
 *   强度 ≥ 0.9  且  最近一次辨词（quiz）答对。
 * 没在应用场景里考过，不算收服。
 */
export function isConquered(mem, now = Date.now(), theta = DEFAULT_THETA) {
  if (!mem.lastQuizCorrectTs) return false;
  return strength(mem, now, theta) >= 0.9;
}

/** 下次到期时刻：询问概率跌破 0.6 的那一点。 */
export function dueAt(mem, now = Date.now(), theta = DEFAULT_THETA) {
  const h = halfLifeDays(mem, theta);
  // 2^(-t/h) = 0.6  →  t = h · log2(1/0.6)
  const t = h * (Math.log2(1 / 0.6) || 0.7369);
  return mem.lastSeenTs + Math.max(0.25, t) * DAY_MS;
}

/** 到今天是「已经过期」还是「还没到」。 */
export function isDue(mem, now = Date.now(), theta = DEFAULT_THETA) {
  return dueAt(mem, now, theta) <= now;
}

/** 强度跌破薄弱线的词 → 无论词库标不标「已完成」，立刻拉回复习队列（§5.6）。 */
export const WEAK_THRESHOLD = 0.45;
export function isWeak(mem, now = Date.now(), theta = DEFAULT_THETA) {
  return strength(mem, now, theta) < WEAK_THRESHOLD;
}

/**
 * 一次编码（答完一张卡）后更新记忆状态。
 *   rating: 'forgot' | 'fuzzy' | 'known'   —— 用户自评
 *   correct: 揭晓后是否确实记得（false 即规格里的「假掌握」）
 *
 * 返回新的记忆状态（纯函数，不改原对象）。
 * 注意：错误计数 e 的增减由 mistake.mjs 负责，这里只消费它已经算好的 e。
 */
export function encode(mem, { rating, correct, reactionMs, hintUsed, e, now = Date.now() }, theta = DEFAULT_THETA) {
  const next = { ...mem };
  next.encodeCount = mem.encodeCount + 1;
  next.lastSeenTs = now;
  if (Number.isFinite(e)) next.e = e;
  if (Number.isFinite(reactionMs)) {
    // 反应时取滑动平均，避免单次手滑污染模型
    next.reactionMs = Math.round(mem.reactionMs * 0.7 + reactionMs * 0.3);
  }
  if (hintUsed) {
    next.hintCount = (mem.hintCount || 0) + 1;
  }
  next.hintRate = next.encodeCount ? (next.hintCount || 0) / next.encodeCount : 0;

  const good = rating === 'known' && correct;
  if (good) {
    next.correct = mem.correct + 1;
    next.stability = Math.min(M_MAX, mem.stability + 0.75);
    next.difficulty = Math.max(0, mem.difficulty - 0.08);
  } else if (rating === 'fuzzy') {
    // 提取成功但费力：记对了没固化 → 只微调，不当成失败
    next.correct = mem.correct + 1;
    next.stability = Math.max(0, mem.stability + 0.15);
    next.difficulty = Math.min(1, mem.difficulty + 0.12);
  } else {
    next.wrong = mem.wrong + 1;
    next.stability = Math.max(0, mem.stability - 1.1);
    next.difficulty = Math.min(1, mem.difficulty + 0.28);
  }
  return next;
}

/** 记录一次辨词答对 —— 「收服」判定的必要条件。 */
export function markQuizCorrect(mem, now = Date.now()) {
  return { ...mem, lastQuizCorrectTs: now };
}

/**
 * 保持曲线：未来 days 天，这组词还记得多少。
 * 直接复用已有记忆模型，不需要任何新数据（规格 §7.5 证据②）。
 * 返回 { scheduled, passive } 两条曲线，用来证明「按排期走」比「不管它」强。
 */
export function retentionCurve(mems, { days = 30, now = Date.now(), theta = DEFAULT_THETA } = {}) {
  const scheduled = [];
  const passive = [];
  const n = mems.length || 1;
  for (let d = 0; d <= days; d++) {
    let sSum = 0;
    let pSum = 0;
    for (const m of mems) {
      // 被动：从今天起谁也不碰它
      pSum += recallProb(m, d, theta);
      // 排期：每个到期点复习一次，把 lastSeen 推后
      let cursor = m;
      let t = 0;
      let guard = 0;
      while (t < d && guard < 200) {
        const h = halfLifeDays(cursor, theta);
        const step = Math.max(0.5, h * 0.7369);
        if (t + step > d) break;
        t += step;
        cursor = encode(cursor, { rating: 'known', correct: true, e: cursor.e, now: now + t * DAY_MS }, theta);
        guard++;
      }
      sSum += t === 0 ? recallProb(m, d, theta) : recallProb(cursor, d - t, theta);
    }
    scheduled.push({ day: d, recall: sSum / n });
    passive.push({ day: d, recall: pSum / n });
  }
  return { scheduled, passive };
}

/** 预估今日用时（仅参考显示，不参与约束求解 —— 规格 §6.1.1）。 */
export function estimateMinutes(wordCount, { quizRatio = 0.25 } = {}) {
  const recognizeSec = 20;
  const quizSec = 26;
  const sec = wordCount * (recognizeSec * (1 - quizRatio) + quizSec * quizRatio);
  return Math.max(1, Math.round(sec / 60));
}
