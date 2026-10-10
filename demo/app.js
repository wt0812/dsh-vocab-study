/*
 * vocab-study · 自包含构建产物 —— 请勿直接编辑
 * 源码在 core/ 与 ui/，改动后重跑：python tools/build.py
 * 构建时间：2026-10-10T07:36:48Z
 */
'use strict';

// ╔══════════════════════════════════════════════════════════╗
// ║  core/ —— 纯逻辑，零宿主依赖（跨模块共享一个作用域）        ║
// ╚══════════════════════════════════════════════════════════╝

// ═══════════ core/memory.mjs → M ═══════════
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
const DEFAULT_THETA = { a: 3.0, b: 0.42, d: 0.30 };

/** 一天的毫秒数。单文件构建时各模块共享一个作用域，所以只在这里声明一次。 */
const DAY_MS = 86400000;

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
function newMemory(seed = {}, now = Date.now()) {
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
function features(m) {
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
function halfLifeDays(mem, theta = DEFAULT_THETA) {
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
function recallProb(mem, dtDays, theta = DEFAULT_THETA) {
  if (dtDays <= 0) return 1;
  const h = halfLifeDays(mem, theta);
  return Math.pow(2, -dtDays / h);
}

/** 记忆强度 m ∈ [0,1]。规格 §5.4 要求它「不虚报」，所以取近期可回忆性的一半权重 +
 *  模型校准度的一半权重：只被问过一次的词，强度上不去。 */
function strength(mem, now = Date.now(), theta = DEFAULT_THETA) {
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
function isConquered(mem, now = Date.now(), theta = DEFAULT_THETA) {
  if (!mem.lastQuizCorrectTs) return false;
  return strength(mem, now, theta) >= 0.9;
}

/** 下次到期时刻：询问概率跌破 0.6 的那一点。 */
function dueAt(mem, now = Date.now(), theta = DEFAULT_THETA) {
  const h = halfLifeDays(mem, theta);
  // 2^(-t/h) = 0.6  →  t = h · log2(1/0.6)
  const t = h * (Math.log2(1 / 0.6) || 0.7369);
  return mem.lastSeenTs + Math.max(0.25, t) * DAY_MS;
}

/** 到今天是「已经过期」还是「还没到」。 */
function isDue(mem, now = Date.now(), theta = DEFAULT_THETA) {
  return dueAt(mem, now, theta) <= now;
}

/** 强度跌破薄弱线的词 → 无论词库标不标「已完成」，立刻拉回复习队列（§5.6）。 */
const WEAK_THRESHOLD = 0.45;
function isWeak(mem, now = Date.now(), theta = DEFAULT_THETA) {
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
function encode(mem, { rating, correct, reactionMs, hintUsed, e, now = Date.now() }, theta = DEFAULT_THETA) {
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
function markQuizCorrect(mem, now = Date.now()) {
  return { ...mem, lastQuizCorrectTs: now };
}

/**
 * 保持曲线：未来 days 天，这组词还记得多少。
 * 直接复用已有记忆模型，不需要任何新数据（规格 §7.5 证据②）。
 * 返回 { scheduled, passive } 两条曲线，用来证明「按排期走」比「不管它」强。
 */
function retentionCurve(mems, { days = 30, now = Date.now(), theta = DEFAULT_THETA } = {}) {
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
function estimateMinutes(wordCount, { quizRatio = 0.25 } = {}) {
  const recognizeSec = 20;
  const quizSec = 26;
  const sec = wordCount * (recognizeSec * (1 - quizRatio) + quizSec * quizRatio);
  return Math.max(1, Math.round(sec / 60));
}


// ═══════════ core/mistake.mjs → MK ═══════════
// vocab-study / core / mistake.mjs
// 错误计数、混淆对、错因诊断句。
//
// 这一层是 DP 的输入质量保障：
//   · 忘了        +1
//   · 假掌握      +2（自评「会了」但揭晓后发现搞混 —— 比「忘了」更危险）
//   · 反应时长    不进错频，只作为遗忘模型参数（规格 §5.4）

/** 一次作答对错误计数的增量。 */
function errorDelta({ rating, fakeMastery }) {
  if (fakeMastery) return 2; // 假掌握：错误计数 +2
  if (rating === 'forgot') return 1;
  return 0; // 模糊 / 会了 不涨错频（模糊只影响路径与难度）
}

/** 把增量写回记录（纯函数）。 */
function applyError(rec, delta) {
  return { ...rec, e: Math.max(0, (rec.e || 0) + delta) };
}

/** 两个词的配对键，前后无关：abandon|abundant 与 abundant|abandon 是同一对。 */
function pairKey(a, b) {
  return [a, b].map(String).sort().join('|');
}

/**
 * 记录一次「把 A 和 B 搞混了」。
 * 混淆对永久记录 → 达到 3 次自动生成对抗专项（规格 §5.3）。
 */
function noteConfusion(confusions, a, b, now = Date.now()) {
  const key = pairKey(a, b);
  const prev = confusions[key] || { a, b, count: 0, flags: 0, firstTs: now, lastTs: now, blacklisted: false };
  const next = { ...prev, count: prev.count + 1, lastTs: now };
  return { ...confusions, [key]: next };
}

/** 安全阀：用户在题上点了「⚑ 这题有问题」。同一对被标 ≥2 次 → 干扰项永久拉黑（§5.3）。 */
function flagConfusion(confusions, a, b, now = Date.now()) {
  const key = pairKey(a, b);
  const prev = confusions[key] || { a, b, count: 0, flags: 0, firstTs: now, lastTs: now, blacklisted: false };
  const flags = prev.flags + 1;
  const next = { ...prev, flags, lastTs: now, blacklisted: flags >= 2 };
  return { ...confusions, [key]: next };
}

/** 需要开对抗专项的混淆对（≥3 次，且没被拉黑）。 */
function pairsNeedingDrill(confusions, threshold = 3) {
  return Object.values(confusions)
    .filter((c) => c.count >= threshold && !c.blacklisted)
    .sort((x, y) => y.count - x.count);
}

/** 用于出干扰项的混淆对：真难，且已被拉黑的绝不再出现。 */
function activePairs(confusions) {
  return Object.values(confusions).filter((c) => !c.blacklisted);
}

/** 已被永久拉黑的词对（AI 生成的烂题目不许反复回来骚扰）。 */
function blacklistedPartners(confusions, wordId) {
  const out = new Set();
  for (const c of Object.values(confusions)) {
    if (!c.blacklisted) continue;
    if (c.a === wordId) out.add(c.b);
    if (c.b === wordId) out.add(c.a);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 错因分类：把逐条作答记录归纳成「你到底是怎么错的」
// ─────────────────────────────────────────────────────────────

const VOWELS = /[aeiou]+/g;
/** 粗粒度音形骨架，用来判断两个词是不是「长得像 / 念着像」。 */
function skeleton(word) {
  return String(word)
    .toLowerCase()
    .replace(VOWELS, 'a')
    .replace(/(.)\1+/g, '$1')
    .replace(/[^a-z]/g, '');
}
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 一对词的相似度 0..1（只看形状，词典义项相似度交给 AI 层）。 */
function similarity(a, b) {
  const sa = skeleton(a);
  const sb = skeleton(b);
  const dist = editDistance(sa, sb);
  return 1 - dist / Math.max(sa.length, sb.length, 1);
}
const ERROR_KIND = {
  sound: { label: '发音相近', human: '读起来像' },
  shape: { label: '拼写相近', human: '长得像' },
  meaning: { label: '意思相近', human: '意思挨着' },
  unknown: { label: '没记住', human: '没印象' },
  attention: { label: '看错了', human: '看岔了' },
};

/** 单条错误记录 → 错因。 */
function classifyError(rec, { wordById } = {}) {
  if (rec.fakeMastery) return ERROR_KIND.unknown; // 自评会了却搞混：本质是没真记住
  if (rec.confusedWith && wordById) {
    const a = wordById(rec.wordId);
    const b = wordById(rec.confusedWith);
    if (a && b) {
      const lenDiff = Math.abs(a.word.length - b.word.length);
      if (similarity(a.word, b.word) >= 0.72) {
        // 首字母/元音骨架一致更偏「音近」，否则偏「形近」
        const sameHead = a.word[0] === b.word[0];
        return lenDiff <= 1 && !sameHead ? ERROR_KIND.sound : ERROR_KIND.shape;
      }
      return ERROR_KIND.meaning;
    }
  }
  if (rec.quizWrong && rec.options && rec.chosen && wordById) {
    const target = wordById(rec.wordId);
    const chosen = wordById(rec.chosen);
    if (target && chosen && similarity(target.word, chosen.word) >= 0.72) {
      return target.word[0] === chosen.word[0] ? ERROR_KIND.sound : ERROR_KIND.shape;
    }
    return ERROR_KIND.meaning;
  }
  if (Number.isFinite(rec.reactionMs) && rec.reactionMs < 900) return ERROR_KIND.attention;
  return ERROR_KIND.unknown;
}

/**
 * 诊断句：把错误日志归纳成一句人话（规格 §7.1 诊断层）。
 * 输出 { kind, pct, total, sentence }，sentence 里绝不出现指责性措辞（P3）。
 */
function diagnosis(records, { wordById, minErrors = 3 } = {}) {
  const counts = new Map();
  let total = 0;
  for (const r of records) {
    if (!r.incorrect) continue;
    const kind = classifyError(r, { wordById });
    counts.set(kind, (counts.get(kind) || 0) + 1);
    total++;
  }
  if (total < minErrors) return { kind: null, pct: 0, total, sentence: null };
  const [kind, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const pct = Math.round((n / total) * 100);
  let sentence;
  switch (kind) {
    case ERROR_KIND.sound:
      sentence = `你今天错的 ${total} 个词里 ${n} 个是发音相近的 —— 我用读音帮你把它们分开。`;
      break;
    case ERROR_KIND.shape:
      sentence = `今天的错误集中在拼写相近的词上（${n}/${total}）—— 下次出题我会专挑它们对着考。`;
      break;
    case ERROR_KIND.meaning:
      sentence = `今天的错误里 ${n}/${total} 是意思挨着的词 —— 我把它们放进辨析队列了。`;
      break;
    case ERROR_KIND.attention:
      sentence = `有 ${n} 次是在极短时间内点掉的 —— 我把那几张卡放慢了。`;
      break;
    default:
      sentence = `今天的 ${total} 个错词以「没印象」为主 —— 这几个会早一点再见到。`;
  }
  return { kind, pct, total, sentence };
}

// ─────────────────────────────────────────────────────────────
// 出干扰项：三个干扰项必须「真难」，不许一眼假（规格 §5.3）
// ─────────────────────────────────────────────────────────────

/**
 * 为 target 选 3 个干扰项。
 * 优先级：音近 > 形近 > 近义 > 同词根/同话题。
 * 已被永久拉黑的词对绝不出现。
 */
function pickDistractors(target, pool, { confusions = {}, count = 3, rand = Math.random } = {}) {
  const banned = blacklistedPartners(confusions, target.id);
  const seen = new Set([target.id]);
  const scored = [];
  for (const w of pool) {
    if (seen.has(w.id) || banned.has(w.id)) continue;
    seen.add(w.id);
    const sim = similarity(target.word, w.word);
    let score;
    if (w.soundLike && target.soundLike) score = 100 + (w.soundLike.includes(target.soundLike) ? 40 : 0);
    else if (sim >= 0.78) score = 80 + sim * 10;
    else if (w.pos && target.pos && w.pos === target.pos && w.topic && w.topic === target.topic) score = 45;
    else if (w.topic && target.topic && w.topic === target.topic) score = 35;
    else score = 10 + sim * 10;
    scored.push({ w, score, sim });
  }
  scored.sort((a, b) => b.score - a.score || a.w.word.localeCompare(b.w.word));
  // 在「真难」的前 8 个里随机取 3 个，避免每次同一组
  const head = scored.slice(0, Math.max(count, 8));
  const picked = [];
  const bag = head.slice();
  while (picked.length < count && bag.length) {
    const idx = Math.floor(rand() * bag.length);
    // 优先取相似度不重复的，让三个干扰项各占一个维度
    const cand = bag.splice(idx, 1)[0];
    if (picked.some((p) => Math.abs(p.sim - cand.sim) < 0.02 && Math.abs(p.score - cand.score) < 1) && bag.length) {
      bag.push(cand);
      if (bag.length <= 1) break;
      continue;
    }
    picked.push(cand);
  }
  // 兜底：不够就从剩余里硬补
  for (const s of scored) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.slice(0, count).map((s) => s.w);
}


// ═══════════ core/seed-cet4.mjs → SEED ═══════════
// vocab-study / core / seed-cet4.mjs
// 内置种子词库（离线降级用）。
//
// 规格 §4.2 第 3 条 / §11 第 3 条：断网时用内置词表直接开背，面板顶部一行灰字
// 「离线模式 · 用内置词表」，不做任何解释、不劝退。
//
// 词条按「容易搞混的组」成簇排列，这样辨词模式的干扰项才真的难（§5.3）。
// 字段：id / word / ipa / pos / meaning / example / exampleZh / collocations / confusables / collection / seq

const C = 'cet4';

function w(seq, word, ipa, pos, meaning, extra = {}) {
  return {
    id: `${C}:${word}`,
    word,
    ipa,
    pos,
    meaning,
    collection: C,
    seq,
    example: extra.ex ?? null,
    exampleZh: extra.zh ?? null,
    collocations: extra.col || [],
    roots: extra.root ?? null,
    synonyms: extra.syn || [],
    confusables: extra.conf ?? [],
    topic: extra.topic ?? null,
  };
}
const SEED_CET4_RAW = [
  // ── 组 1：abandon 家族 ────────────────────────────────
  w(1, 'abandon', '/əˈbændən/', 'v.', '放弃，抛弃；遗弃', {
    ex: 'He abandoned his car in the snow.',
    zh: '他把车丢在雪地里不要了。',
    col: ['abandon a plan', 'abandon oneself to', 'with abandon'],
    root: 'a-(去) + band(约束) + -on → 解开束缚，放手不管',
    conf: ['abundant', 'abolish'],
    topic: 'abandon-family',
  }),
  w(2, 'abundant', '/əˈbʌndənt/', 'a.', '大量的，充裕的', {
    ex: 'There is abundant evidence for it.',
    zh: '这方面的证据很多。',
    col: ['abundant in', 'an abundant supply of'],
    root: 'ab-(away) + und(波浪) + -ant → 像水一样涌出来',
    conf: ['abandon', 'adequate'],
    topic: 'abandon-family',
  }),
  w(3, 'abolish', '/əˈbɒlɪʃ/', 'v.', '废除，取消（制度、法律）', {
    ex: 'The law was abolished in 1953.',
    zh: '那条法律 1953 年被废除了。',
    col: ['abolish slavery', 'abolish the death penalty'],
    conf: ['abandon', 'polish'],
    topic: 'abandon-family',
  }),

  // ── 组 2：absolute / absorb / abstract ────────────────
  w(4, 'absolute', '/ˈæbsəluːt/', 'a.', '绝对的，完全的', {
    ex: 'You have my absolute trust.',
    zh: '我完全信任你。',
    root: 'ab-(离开) + solut(松开) → 松开了所有条件的',
    conf: ['abstract', 'absorb'],
    topic: 'ab-family',
  }),
  w(5, 'absorb', '/əbˈzɔːb/', 'v.', '吸收；吸纳；专心于', {
    ex: 'Plants absorb water through their roots.',
    zh: '植物通过根吸收水分。',
    col: ['be absorbed in', 'absorb knowledge'],
    conf: ['absolute', 'abstract'],
    topic: 'ab-family',
  }),
  w(6, 'abstract', '/ˈæbstrækt/', 'a./n.', '抽象的；摘要', {
    ex: 'This is too abstract to be useful.',
    zh: '这东西太抽象，没法直接用。',
    root: 'abs-(离开) + tract(拉) → 从具体里拉出来的',
    conf: ['absolute', 'attract'],
    topic: 'ab-family',
  }),

  // ── 组 3：ac- 前缀 ────────────────────────────────────
  w(7, 'accent', '/ˈæksent/', 'n.', '口音；重音', {
    ex: 'She speaks with a slight French accent.',
    zh: '她说话带一点法国口音。',
    root: 'ac-(加强) + cent(唱) → 唱出来的调子',
    conf: ['accept', 'assent'],
    topic: 'ac-family',
  }),
  w(8, 'accept', '/əkˈsept/', 'v.', '接受；同意', {
    ex: 'Please accept my apology.',
    zh: '请接受我的道歉。',
    root: 'ac-(加强) + cept(拿) → 拿过来',
    conf: ['except', 'accent'],
    topic: 'ac-family',
  }),
  w(9, 'except', '/ɪkˈsept/', 'prep.', '除…之外', {
    ex: 'Everyone came except Tom.',
    zh: '除了汤姆，所有人都来了。',
    root: 'ex-(向外) + cept(拿) → 拿出去的那个',
    conf: ['accept', 'expect'],
    topic: 'ac-family',
  }),
  w(10, 'expect', '/ɪkˈspekt/', 'v.', '期待，预料', {
    ex: 'I expect he will be late.',
    zh: '我估计他会迟到。',
    root: 'ex-(向外) + spect(看) → 向外张望',
    conf: ['except', 'inspect'],
    topic: 'ac-family',
  }),

  // ── 组 4：access / accident / accomplish ──────────────
  w(11, 'access', '/ˈækses/', 'n./v.', '通道；访问权；进入', {
    ex: 'Students have free access to the library.',
    zh: '学生可以免费使用图书馆。',
    col: ['access to', 'gain access'],
    conf: ['excess', 'assess'],
    topic: 'ac-family',
  }),
  w(12, 'excess', '/ɪkˈses/', 'n.', '过量，超额', {
    ex: 'An excess of sugar is bad for you.',
    zh: '糖吃多了没好处。',
    col: ['in excess of', 'an excess of'],
    conf: ['access', 'expect'],
    topic: 'ac-family',
  }),
  w(13, 'accident', '/ˈæksɪdənt/', 'n.', '事故；意外', {
    ex: 'The accident happened at midnight.',
    zh: '事故发生在半夜。',
    col: ['by accident', 'traffic accident'],
    root: 'ac-(to) + cid(落下) + -ent → 落到头上的事',
    conf: ['incident', 'accidentally'],
    topic: 'ac-family',
  }),
  w(14, 'incident', '/ˈɪnsɪdənt/', 'n.', '事件，事变', {
    ex: 'It was a minor incident, nothing more.',
    zh: '这只是个小插曲，没别的。',
    root: 'in-(上) + cid(落下) → 落到身上的事',
    conf: ['accident', 'incidence'],
    topic: 'ac-family',
  }),
  w(15, 'accompany', '/əˈkʌmpəni/', 'v.', '陪伴；伴随', {
    ex: 'She accompanied me to the door.',
    zh: '她陪我走到门口。',
    conf: ['company', 'accomplice'],
    topic: 'ac-family',
  }),
  w(16, 'accomplish', '/əˈkʌmplɪʃ/', 'v.', '完成，达成', {
    ex: 'We accomplished the task in two days.',
    zh: '我们用两天完成了这个任务。',
    col: ['accomplish a goal', 'a sense of accomplishment'],
    conf: ['accompany', 'complete'],
    topic: 'ac-family',
  }),
  w(17, 'accurate', '/ˈækjərət/', 'a.', '准确的，精确的', {
    ex: 'The figures are not entirely accurate.',
    zh: '这些数字并不完全准确。',
    root: 'ac-(加强) + cur(关心) + -ate → 用心做出来的',
    conf: ['adequate', 'curate'],
    topic: 'ac-family',
  }),
  w(18, 'accuse', '/əˈkjuːz/', 'v.', '指控，指责', {
    ex: 'He was accused of stealing.',
    zh: '他被指控偷东西。',
    col: ['accuse sb of sth'],
    conf: ['excuse', 'amuse'],
    topic: 'ac-family',
  }),
  w(19, 'excuse', '/ɪkˈskjuːz/', 'v./n.', '原谅；借口', {
    ex: 'Excuse me for being late.',
    zh: '抱歉我迟到了。',
    root: 'ex-(向外) + cus(原因) → 把原因推出去',
    conf: ['accuse', 'execute'],
    topic: 'ac-family',
  }),
  w(20, 'achieve', '/əˈtʃiːv/', 'v.', '实现，取得', {
    ex: 'She achieved her childhood dream.',
    zh: '她实现了童年的梦想。',
    col: ['achieve success', 'achieve a goal'],
    conf: ['arrive', 'attain'],
    topic: 'ac-family',
  }),
  w(21, 'acknowledge', '/əkˈnɒlɪdʒ/', 'v.', '承认；确认收到', {
    ex: 'He acknowledged his mistake at once.',
    zh: '他马上就承认了错误。',
    conf: ['knowledge', 'admit'],
    topic: 'ac-family',
  }),
  w(22, 'acquire', '/əˈkwaɪə/', 'v.', '获得，取得（习得）', {
    ex: 'Children acquire language quickly.',
    zh: '孩子学语言很快。',
    root: 'ac-(to) + quir(寻求) → 求来的',
    conf: ['require', 'enquire'],
    topic: 'ac-family',
  }),
  w(23, 'require', '/rɪˈkwaɪə/', 'v.', '需要，要求', {
    ex: 'This job requires patience.',
    zh: '这份工作需要耐心。',
    conf: ['acquire', 'request'],
    topic: 'ac-family',
  }),

  // ── 组 5：adapt 家族（四级最高频易混组）──────────────
  w(24, 'adapt', '/əˈdæpt/', 'v.', '适应；改编', {
    ex: 'It took me a month to adapt to the climate.',
    zh: '我花了一个月才适应那边的气候。',
    col: ['adapt to', 'adapt a novel for the screen'],
    root: 'ad-(to) + apt(合适) → 弄到合适',
    conf: ['adopt', 'adept', 'adjust'],
    topic: 'adapt-family',
  }),
  w(25, 'adopt', '/əˈdɒpt/', 'v.', '采纳；收养', {
    ex: 'The company adopted a new policy.',
    zh: '公司采纳了新政策。',
    col: ['adopt a policy', 'adopt a child'],
    root: 'ad-(to) + opt(选择) → 挑过来用',
    conf: ['adapt', 'adept'],
    topic: 'adapt-family',
  }),
  w(26, 'adept', '/əˈdept/', 'a.', '熟练的，擅长的', {
    ex: 'She is adept at handling complaints.',
    zh: '她很会处理投诉。',
    col: ['be adept at'],
    conf: ['adapt', 'adopt'],
    topic: 'adapt-family',
  }),
  w(27, 'adjust', '/əˈdʒʌst/', 'v.', '调整；适应', {
    ex: 'Adjust the mirror before you drive.',
    zh: '开车前先把镜子调好。',
    col: ['adjust to', 'adjust the volume'],
    conf: ['adapt', 'judge'],
    topic: 'adapt-family',
  }),

  // ── 组 6：affect 家族 ─────────────────────────────────
  w(28, 'affect', '/əˈfekt/', 'v.', '影响；感染（动词）', {
    ex: 'The weather affects my mood.',
    zh: '天气会影响我的心情。',
    col: ['be affected by', 'affect health'],
    root: 'af-(to) + fect(做) → 对…起作用',
    conf: ['effect', 'infect'],
    topic: 'affect-family',
  }),
  w(29, 'effect', '/ɪˈfekt/', 'n.', '效果，影响（名词）', {
    ex: 'The medicine had no effect.',
    zh: '这药没有效果。',
    col: ['have an effect on', 'in effect', 'side effect'],
    root: 'ef-(向外) + fect(做) → 做出来的结果',
    conf: ['affect', 'effort'],
    topic: 'affect-family',
  }),
  w(30, 'infect', '/ɪnˈfekt/', 'v.', '传染，感染', {
    ex: 'The wound became infected.',
    zh: '伤口感染了。',
    root: 'in-(进入) + fect(做) → 钻进去起作用',
    conf: ['affect', 'inject'],
    topic: 'affect-family',
  }),

  // ── 组 7：ad- 前缀 ────────────────────────────────────
  w(31, 'adequate', '/ˈædɪkwət/', 'a.', '足够的，适当的', {
    ex: 'The room is small but adequate.',
    zh: '房间不大，但够用。',
    col: ['adequate for', 'adequate supply'],
    conf: ['accurate', 'abundant'],
    topic: 'ad-family',
  }),
  w(32, 'advantage', '/ədˈvɑːntɪdʒ/', 'n.', '优势，好处', {
    ex: 'Speed is our main advantage.',
    zh: '速度是我们的主要优势。',
    col: ['take advantage of', 'competitive advantage'],
    conf: ['adventure', 'disadvantage'],
    topic: 'ad-family',
  }),
  w(33, 'adventure', '/ədˈventʃə/', 'n.', '冒险，奇遇', {
    ex: 'The trip turned into a real adventure.',
    zh: '这趟旅行变成了一场真正的冒险。',
    conf: ['advantage', 'adventurous'],
    topic: 'ad-family',
  }),
  w(34, 'advocate', '/ˈædvəkeɪt/', 'v./n.', '提倡；拥护者', {
    ex: 'She advocates a simpler life.',
    zh: '她提倡过更简单的生活。',
    conf: ['advertise', 'avocate'],
    topic: 'ad-family',
  }),
  w(35, 'advertise', '/ˈædvətaɪz/', 'v.', '做广告；宣传', {
    ex: 'They advertise the product online.',
    zh: '他们在网上给这个产品打广告。',
    col: ['advertise for', 'advertising campaign'],
    conf: ['advocate', 'advice'],
    topic: 'ad-family',
  }),

  // ── 组 8：商业/经济 ───────────────────────────────────
  w(36, 'account', '/əˈkaʊnt/', 'n./v.', '账户；描述；占比', {
    ex: 'Please account for the missing money.',
    zh: '请说明这笔钱的去向。',
    col: ['account for', 'take into account', 'on account of'],
    conf: ['amount', 'count'],
    topic: 'business',
  }),
  w(37, 'amount', '/əˈmaʊnt/', 'n./v.', '数量；总计', {
    ex: 'A large amount of data was lost.',
    zh: '大量数据丢了。',
    col: ['amount to', 'a large amount of'],
    conf: ['account', 'number'],
    topic: 'business',
  }),
  w(38, 'budget', '/ˈbʌdʒɪt/', 'n.', '预算', {
    ex: 'We are over budget this month.',
    zh: '这个月我们超支了。',
    col: ['on a tight budget', 'budget for'],
    conf: ['bulletin', 'bargain'],
    topic: 'business',
  }),
  w(39, 'bargain', '/ˈbɑːɡɪn/', 'n./v.', '便宜货；讨价还价', {
    ex: 'That coat was a real bargain.',
    zh: '那件外套真是捡到便宜了。',
    col: ['bargain with', 'a good bargain'],
    conf: ['budget', 'burden'],
    topic: 'business',
  }),
  w(40, 'benefit', '/ˈbenɪfɪt/', 'n./v.', '好处；受益', {
    ex: 'Everyone benefits from the change.',
    zh: '每个人都从这次改动里受益。',
    col: ['benefit from', 'for the benefit of'],
    root: 'bene(好) + fit(做) → 做好事',
    conf: ['profit', 'beneficial'],
    topic: 'business',
  }),
  w(41, 'profit', '/ˈprɒfɪt/', 'n./v.', '利润；获利', {
    ex: 'The company made a small profit.',
    zh: '公司赚了一点钱。',
    col: ['make a profit', 'profit from'],
    conf: ['benefit', 'prophet'],
    topic: 'business',
  }),
  w(42, 'commission', '/kəˈmɪʃn/', 'n.', '佣金；委员会', {
    ex: 'He earns a 10% commission.',
    zh: '他拿 10% 的佣金。',
    conf: ['mission', 'committee'],
    topic: 'business',
  }),
  w(43, 'commit', '/kəˈmɪt/', 'v.', '承诺；犯（错/罪）', {
    ex: 'He committed himself to the project.',
    zh: '他把全部精力投到这个项目上。',
    col: ['commit to', 'commit a crime'],
    conf: ['commission', 'submit'],
    topic: 'business',
  }),

  // ── 组 9：con- 前缀 ───────────────────────────────────
  w(44, 'confirm', '/kənˈfɜːm/', 'v.', '确认，证实', {
    ex: 'Please confirm your booking.',
    zh: '请确认您的预订。',
    root: 'con-(加强) + firm(坚固) → 弄结实',
    conf: ['conform', 'conform'],
    topic: 'con-family',
  }),
  w(45, 'conform', '/kənˈfɔːm/', 'v.', '遵守，符合', {
    ex: 'The product conforms to safety standards.',
    zh: '这产品符合安全标准。',
    col: ['conform to'],
    root: 'con-(共同) + form(形状) → 跟大家一个形状',
    conf: ['confirm', 'perform'],
    topic: 'con-family',
  }),
  w(46, 'consist', '/kənˈsɪst/', 'v.', '由…组成；在于', {
    ex: 'The team consists of five people.',
    zh: '这个团队由五个人组成。',
    col: ['consist of', 'consist in'],
    conf: ['insist', 'persist'],
    topic: 'con-family',
  }),
  w(47, 'insist', '/ɪnˈsɪst/', 'v.', '坚持，坚决要求', {
    ex: 'She insisted on paying.',
    zh: '她坚持要付钱。',
    col: ['insist on'],
    root: 'in-(上) + sist(站) → 站在上面不动',
    conf: ['consist', 'persist'],
    topic: 'con-family',
  }),
  w(48, 'persist', '/pəˈsɪst/', 'v.', '坚持；持续存在', {
    ex: 'The problem persists.',
    zh: '这个问题一直存在。',
    col: ['persist in'],
    root: 'per-(贯穿) + sist(站) → 一直站着',
    conf: ['insist', 'resist'],
    topic: 'con-family',
  }),
  w(49, 'resist', '/rɪˈzɪst/', 'v.', '抵抗，忍住', {
    ex: 'I could not resist the offer.',
    zh: '我没能拒绝这个报价。',
    col: ['resist temptation', 'cannot resist'],
    root: 're-(反) + sist(站) → 站着对抗',
    conf: ['persist', 'assist'],
    topic: 'con-family',
  }),
  w(50, 'consent', '/kənˈsent/', 'n./v.', '同意，许可', {
    ex: 'She gave her consent.',
    zh: '她同意了。',
    root: 'con-(共同) + sent(感觉) → 感觉一样',
    conf: ['content', 'dissent'],
    topic: 'con-family',
  }),
  w(51, 'content', '/ˈkɒntent/', 'n./a.', '内容；满足的', {
    ex: 'He is content with his life.',
    zh: '他对自己的生活挺满足。',
    conf: ['consent', 'contest'],
    topic: 'con-family',
  }),
  w(52, 'contest', '/ˈkɒntest/', 'n./v.', '比赛；争辩', {
    ex: 'She won the singing contest.',
    zh: '她赢了歌唱比赛。',
    conf: ['content', 'context'],
    topic: 'con-family',
  }),
  w(53, 'context', '/ˈkɒntekst/', 'n.', '上下文，背景', {
    ex: 'Read it in context.',
    zh: '要放到上下文里读。',
    col: ['in the context of'],
    root: 'con-(一起) + text(编织) → 织在一起的东西',
    conf: ['contest', 'contrast'],
    topic: 'con-family',
  }),
  w(54, 'contrast', '/ˈkɒntrɑːst/', 'n./v.', '对比，反差', {
    ex: 'The contrast is striking.',
    zh: '反差非常明显。',
    col: ['in contrast to', 'by contrast'],
    conf: ['context', 'contract'],
    topic: 'con-family',
  }),
  w(55, 'contract', '/ˈkɒntrækt/', 'n./v.', '合同；收缩', {
    ex: 'Sign the contract here.',
    zh: '在这份合同上签字。',
    root: 'con-(一起) + tract(拉) → 拉到一起',
    conf: ['contrast', 'contact'],
    topic: 'con-family',
  }),
  w(56, 'contact', '/ˈkɒntækt/', 'n./v.', '联系，接触', {
    ex: 'Stay in contact with me.',
    zh: '跟我保持联系。',
    col: ['in contact with', 'contact lens'],
    conf: ['contract', 'contagious'],
    topic: 'con-family',
  }),
  w(57, 'contribute', '/kənˈtrɪbjuːt/', 'v.', '贡献；投稿；促成', {
    ex: 'Everyone contributed to the success.',
    zh: '每个人都为这次成功出了力。',
    col: ['contribute to'],
    root: 'con-(一起) + tribut(给予) → 一起给',
    conf: ['distribute', 'attribute'],
    topic: 'con-family',
  }),
  w(58, 'distribute', '/dɪˈstrɪbjuːt/', 'v.', '分发，分配', {
    ex: 'They distributed food to the villagers.',
    zh: '他们给村民分发食物。',
    conf: ['contribute', 'attribute'],
    topic: 'con-family',
  }),
  w(59, 'consider', '/kənˈsɪdə/', 'v.', '考虑，认为', {
    ex: 'I am considering moving abroad.',
    zh: '我在考虑搬到国外。',
    col: ['consider doing', 'consider sb as'],
    conf: ['consist', 'considerate'],
    topic: 'con-family',
  }),
  w(60, 'considerate', '/kənˈsɪdərət/', 'a.', '体贴的，考虑周到的', {
    ex: 'It was very considerate of you.',
    zh: '你想得真周到。',
    conf: ['considerable', 'consider'],
    topic: 'con-family',
  }),
  w(61, 'considerable', '/kənˈsɪdərəbl/', 'a.', '相当大的', {
    ex: 'It took a considerable amount of time.',
    zh: '这花了不少时间。',
    conf: ['considerate', 'consider'],
    topic: 'con-family',
  }),

  // ── 组 10：dis- / ex- ─────────────────────────────────
  w(62, 'disappear', '/ˌdɪsəˈpɪə/', 'v.', '消失，不见', {
    ex: 'The keys disappeared again.',
    zh: '钥匙又不见了。',
    conf: ['appear', 'display'],
    topic: 'dis-family',
  }),
  w(63, 'display', '/dɪˈspleɪ/', 'v./n.', '展示，陈列', {
    ex: 'The results are displayed on screen.',
    zh: '结果显示在屏幕上。',
    conf: ['disappear', 'play'],
    topic: 'dis-family',
  }),
  w(64, 'distinct', '/dɪˈstɪŋkt/', 'a.', '明显的；截然不同的', {
    ex: 'There are two distinct groups.',
    zh: '这里有两类完全不同的人。',
    col: ['distinct from'],
    root: 'dis-(分开) + stinct(刺) → 刺一下分出来',
    conf: ['distinctive', 'distinguish'],
    topic: 'dis-family',
  }),
  w(65, 'distinguish', '/dɪˈstɪŋɡwɪʃ/', 'v.', '区分，辨别', {
    ex: 'Children cannot distinguish the two.',
    zh: '小孩分不清这两个。',
    col: ['distinguish between', 'distinguish A from B'],
    conf: ['distinct', 'extinguish'],
    topic: 'dis-family',
  }),
  w(66, 'distribute', '/dɪˈstrɪbjuːt/', 'v.', '分发；分布', {
    ex: 'The species is widely distributed.',
    zh: '这个物种分布很广。',
    conf: ['attribute', 'tribute'],
    topic: 'dis-family',
  }),
  w(67, 'attribute', '/əˈtrɪbjuːt/', 'v./n.', '把…归因于；属性', {
    ex: 'She attributes her success to luck.',
    zh: '她把成功归功于运气。',
    col: ['attribute A to B'],
    root: 'at-(to) + tribut(给予) → 归给',
    conf: ['contribute', 'distribute'],
    topic: 'dis-family',
  }),
  w(68, 'exhaust', '/ɪɡˈzɔːst/', 'v./n.', '使精疲力尽；废气', {
    ex: 'The long walk exhausted us.',
    zh: '走了这么远，我们都累垮了。',
    conf: ['exhibit', 'exert'],
    topic: 'ex-family',
  }),
  w(69, 'exhibit', '/ɪɡˈzɪbɪt/', 'v./n.', '展出；展品', {
    ex: 'The gallery exhibits modern art.',
    zh: '这家美术馆展出当代艺术。',
    conf: ['exhaust', 'inhabit'],
    topic: 'ex-family',
  }),
  w(70, 'expand', '/ɪkˈspænd/', 'v.', '扩大，扩张', {
    ex: 'The company plans to expand into Asia.',
    zh: '公司计划向亚洲扩张。',
    root: 'ex-(向外) + pand(铺开) → 铺开',
    conf: ['expend', 'extend'],
    topic: 'ex-family',
  }),
  w(71, 'expend', '/ɪkˈspend/', 'v.', '花费，消耗', {
    ex: 'They expended all their energy.',
    zh: '他们耗尽了全部精力。',
    conf: ['expand', 'expense'],
    topic: 'ex-family',
  }),
  w(72, 'extend', '/ɪkˈstend/', 'v.', '延伸；延长', {
    ex: 'They extended the deadline.',
    zh: '他们延长了截止日期。',
    col: ['extend to', 'extend a deadline'],
    root: 'ex-(向外) + tend(伸展) → 往外伸',
    conf: ['expand', 'extent'],
    topic: 'ex-family',
  }),
  w(73, 'extent', '/ɪkˈstent/', 'n.', '程度，范围', {
    ex: 'To some extent, you are right.',
    zh: '某种程度上你是对的。',
    col: ['to some extent', 'to a great extent'],
    conf: ['extend', 'content'],
    topic: 'ex-family',
  }),
  w(74, 'expose', '/ɪkˈspəʊz/', 'v.', '暴露；揭露；使接触', {
    ex: 'Do not expose the film to light.',
    zh: '别让胶片见光。',
    col: ['expose to', 'be exposed to'],
    root: 'ex-(向外) + pos(放) → 放到外面',
    conf: ['impose', 'dispose'],
    topic: 'ex-family',
  }),
  w(75, 'impose', '/ɪmˈpəʊz/', 'v.', '强加；征收', {
    ex: 'Do not impose your views on others.',
    zh: '别把你的看法强加给别人。',
    col: ['impose on'],
    root: 'im-(上) + pos(放) → 压上去',
    conf: ['expose', 'compose'],
    topic: 'ex-family',
  }),

  // ── 组 11：in- / im- 前缀 ─────────────────────────────
  w(76, 'incline', '/ɪnˈklaɪn/', 'v.', '倾向；倾斜', {
    ex: 'I incline to agree with you.',
    zh: '我倾向于同意你。',
    col: ['be inclined to'],
    conf: ['decline', 'include'],
    topic: 'in-family',
  }),
  w(77, 'decline', '/dɪˈklaɪn/', 'v./n.', '下降；婉拒', {
    ex: 'Sales declined by 10%.',
    zh: '销量下降了 10%。',
    conf: ['incline', 'recline'],
    topic: 'in-family',
  }),
  w(78, 'include', '/ɪnˈkluːd/', 'v.', '包括，包含', {
    ex: 'The price includes breakfast.',
    zh: '这个价格含早餐。',
    col: ['include in'],
    root: 'in-(内) + clud(关) → 关在里面',
    conf: ['exclude', 'conclude'],
    topic: 'in-family',
  }),
  w(79, 'exclude', '/ɪkˈskluːd/', 'v.', '排除，不包括', {
    ex: 'We cannot exclude that possibility.',
    zh: '我们不能排除那种可能。',
    root: 'ex-(外) + clud(关) → 关在外面',
    conf: ['include', 'conclude'],
    topic: 'in-family',
  }),
  w(80, 'conclude', '/kənˈkluːd/', 'v.', '得出结论；结束', {
    ex: 'We concluded that he was right.',
    zh: '我们得出结论：他是对的。',
    root: 'con-(一起) + clud(关) → 一起关上门',
    conf: ['include', 'exclude'],
    topic: 'in-family',
  }),
  w(81, 'initial', '/ɪˈnɪʃl/', 'a.', '最初的，开头的', {
    ex: 'My initial reaction was surprise.',
    zh: '我第一反应是惊讶。',
    conf: ['initiative', 'essential'],
    topic: 'in-family',
  }),
  w(82, 'initiative', '/ɪˈnɪʃətɪv/', 'n.', '主动性；倡议', {
    ex: 'She took the initiative.',
    zh: '她主动开了头。',
    col: ['take the initiative', 'on one\'s own initiative'],
    conf: ['initial', 'imitative'],
    topic: 'in-family',
  }),
  w(83, 'intense', '/ɪnˈtens/', 'a.', '强烈的，紧张的', {
    ex: 'The heat was intense.',
    zh: '热得厉害。',
    conf: ['intensive', 'intent'],
    topic: 'in-family',
  }),
  w(84, 'intensive', '/ɪnˈtensɪv/', 'a.', '密集的，加强的', {
    ex: 'He took an intensive course.',
    zh: '他上了一个强化班。',
    conf: ['intense', 'extensive'],
    topic: 'in-family',
  }),
  w(85, 'extensive', '/ɪkˈstensɪv/', 'a.', '广泛的，大量的', {
    ex: 'The damage was extensive.',
    zh: '损失范围很大。',
    conf: ['intensive', 'extend'],
    topic: 'in-family',
  }),
  w(86, 'influence', '/ˈɪnfluəns/', 'n./v.', '影响', {
    ex: 'He had a strong influence on me.',
    zh: '他对我的影响很大。',
    col: ['have an influence on', 'under the influence of'],
    conf: ['affluence', 'affect'],
    topic: 'in-family',
  }),
  w(87, 'investigate', '/ɪnˈvestɪɡeɪt/', 'v.', '调查，研究', {
    ex: 'Police are investigating the case.',
    zh: '警方正在调查这个案子。',
    conf: ['investment', 'navigate'],
    topic: 'in-family',
  }),
  w(88, 'investment', '/ɪnˈvestmənt/', 'n.', '投资，投入', {
    ex: 'Education is a good investment.',
    zh: '教育是笔好投资。',
    col: ['make an investment', 'return on investment'],
    conf: ['investigate', 'inventory'],
    topic: 'in-family',
  }),

  // ── 组 12：高频多义 ───────────────────────────────────
  w(89, 'although', '/ɔːlˈðəʊ/', 'conj.', '虽然，尽管', {
    ex: 'Although it rained, we went out.',
    zh: '虽然下雨，我们还是出去了。',
    conf: ['though', 'through'],
    topic: 'function',
  }),
  w(90, 'through', '/θruː/', 'prep.', '穿过；通过', {
    ex: 'We walked through the park.',
    zh: '我们穿过公园。',
    conf: ['though', 'thought'],
    topic: 'function',
  }),
  w(91, 'thought', '/θɔːt/', 'n.', '想法；思考', {
    ex: 'That is a good thought.',
    zh: '这想法不错。',
    conf: ['through', 'although'],
    topic: 'function',
  }),
  w(92, 'advice', '/ədˈvaɪs/', 'n.', '建议（不可数）', {
    ex: 'Let me give you some advice.',
    zh: '我给你点建议。',
    col: ['a piece of advice', 'give advice'],
    conf: ['advise', 'device'],
    topic: 'function',
  }),
  w(93, 'advise', '/ədˈvaɪz/', 'v.', '建议，劝告', {
    ex: 'I advise you to wait.',
    zh: '我建议你再等等。',
    conf: ['advice', 'devise'],
    topic: 'function',
  }),
  w(94, 'device', '/dɪˈvaɪs/', 'n.', '装置，设备', {
    ex: 'This device saves power.',
    zh: '这个装置省电。',
    conf: ['devise', 'advice'],
    topic: 'function',
  }),
  w(95, 'devise', '/dɪˈvaɪz/', 'v.', '设计，想出', {
    ex: 'They devised a new method.',
    zh: '他们想出了新办法。',
    conf: ['device', 'advise'],
    topic: 'function',
  }),
  w(96, 'principal', '/ˈprɪnsəpl/', 'a./n.', '主要的；校长', {
    ex: 'The principal reason is money.',
    zh: '主要原因是钱。',
    conf: ['principle', 'principal'],
    topic: 'function',
  }),
  w(97, 'principle', '/ˈprɪnsəpl/', 'n.', '原则，原理', {
    ex: 'It is a matter of principle.',
    zh: '这是个原则问题。',
    col: ['in principle', 'on principle'],
    conf: ['principal', 'principled'],
    topic: 'function',
  }),
  w(98, 'personal', '/ˈpɜːsənl/', 'a.', '个人的，私人的', {
    ex: 'This is a personal matter.',
    zh: '这是私事。',
    conf: ['personnel', 'personality'],
    topic: 'function',
  }),
  w(99, 'personnel', '/ˌpɜːsəˈnel/', 'n.', '人员，员工', {
    ex: 'The personnel department handles it.',
    zh: '人事部负责这个。',
    conf: ['personal', 'personality'],
    topic: 'function',
  }),
  w(100, 'affect', '/əˈfekt/', 'v.', '影响（复习词）', {
    ex: 'Smoking affects your health.',
    zh: '抽烟影响健康。',
    conf: ['effect'],
    topic: 'function',
  }),

  // ── 组 13：常用动词 ───────────────────────────────────
  w(101, 'delay', '/dɪˈleɪ/', 'v./n.', '推迟，延误', {
    ex: 'The flight was delayed by two hours.',
    zh: '航班延误了两小时。',
    conf: ['relay', 'deny'],
    topic: 'verb',
  }),
  w(102, 'deny', '/dɪˈnaɪ/', 'v.', '否认；拒绝给予', {
    ex: 'He denied taking the money.',
    zh: '他否认拿了钱。',
    col: ['deny doing', 'deny sb sth'],
    conf: ['delay', 'refuse'],
    topic: 'verb',
  }),
  w(103, 'propose', '/prəˈpəʊz/', 'v.', '提议；求婚', {
    ex: 'I propose we start earlier.',
    zh: '我建议我们早点开始。',
    col: ['propose doing', 'propose to sb'],
    conf: ['purpose', 'suppose'],
    topic: 'verb',
  }),
  w(104, 'suppose', '/səˈpəʊz/', 'v.', '假设；认为', {
    ex: 'I suppose you are right.',
    zh: '我想你是对的。',
    col: ['be supposed to'],
    conf: ['propose', 'purpose'],
    topic: 'verb',
  }),
  w(105, 'purpose', '/ˈpɜːpəs/', 'n.', '目的，意图', {
    ex: 'What is the purpose of this?',
    zh: '这是干什么用的？',
    col: ['on purpose', 'for the purpose of'],
    conf: ['propose', 'suppose'],
    topic: 'verb',
  }),
  w(106, 'obtain', '/əbˈteɪn/', 'v.', '获得，得到', {
    ex: 'You must obtain permission first.',
    zh: '你必须先取得许可。',
    root: 'ob-(朝向) + tain(握) → 握到手里',
    conf: ['maintain', 'contain'],
    topic: 'verb',
  }),
  w(107, 'maintain', '/meɪnˈteɪn/', 'v.', '维持；保养；主张', {
    ex: 'It is hard to maintain this speed.',
    zh: '这个速度很难保持。',
    root: 'main(手) + tain(握) → 用手一直握着',
    conf: ['obtain', 'retain'],
    topic: 'verb',
  }),
  w(108, 'retain', '/rɪˈteɪn/', 'v.', '保留，保持', {
    ex: 'The soil retains water.',
    zh: '这种土能保水。',
    root: 're-(回) + tain(握) → 握回来',
    conf: ['maintain', 'attain'],
    topic: 'verb',
  }),
  w(109, 'attain', '/əˈteɪn/', 'v.', '达到，实现', {
    ex: 'She attained her goal at last.',
    zh: '她终于达成了目标。',
    conf: ['obtain', 'retain'],
    topic: 'verb',
  }),
  w(110, 'reveal', '/rɪˈviːl/', 'v.', '揭示，透露', {
    ex: 'The survey revealed a surprising fact.',
    zh: '调查揭示了一个意外的事实。',
    root: 're-(反) + veal(面纱) → 揭开面纱',
    conf: ['revise', 'review'],
    topic: 'verb',
  }),
  w(111, 'revise', '/rɪˈvaɪz/', 'v.', '修改；复习', {
    ex: 'Revise the draft before sending.',
    zh: '发出前先改一改草稿。',
    root: 're-(再) + vis(看) → 再看一遍',
    conf: ['reveal', 'review'],
    topic: 'verb',
  }),
  w(112, 'review', '/rɪˈvjuː/', 'v./n.', '回顾；评论', {
    ex: 'Let us review the plan.',
    zh: '我们把计划过一遍。',
    conf: ['revise', 'preview'],
    topic: 'verb',
  }),
  w(113, 'reduce', '/rɪˈdjuːs/', 'v.', '减少，降低', {
    ex: 'We must reduce waste.',
    zh: '我们必须减少浪费。',
    col: ['reduce to', 'reduce by'],
    root: 're-(回) + duc(引导) → 引回来',
    conf: ['deduce', 'induce'],
    topic: 'verb',
  }),
  w(114, 'deduce', '/dɪˈdjuːs/', 'v.', '推断，演绎', {
    ex: 'We can deduce the answer from this.',
    zh: '由此可以推出答案。',
    conf: ['reduce', 'induce'],
    topic: 'verb',
  }),
  w(115, 'induce', '/ɪnˈdjuːs/', 'v.', '引起；诱使', {
    ex: 'Nothing could induce him to change.',
    zh: '什么也劝不动他改主意。',
    conf: ['deduce', 'reduce'],
    topic: 'verb',
  }),
  w(116, 'occur', '/əˈkɜː/', 'v.', '发生；被想起', {
    ex: 'It occurred to me that I was wrong.',
    zh: '我忽然想到我错了。',
    col: ['occur to sb', 'occur in'],
    conf: ['recur', 'accrue'],
    topic: 'verb',
  }),
  w(117, 'recur', '/rɪˈkɜː/', 'v.', '再发生，复发', {
    ex: 'The pain recurs every winter.',
    zh: '每到冬天这疼痛就复发。',
    conf: ['occur', 'recover'],
    topic: 'verb',
  }),
  w(118, 'adapt', '/əˈdæpt/', 'v.', '适应（复习词）', {
    ex: 'Adapt or fail.',
    zh: '要么适应，要么被淘汰。',
    conf: ['adopt'],
    topic: 'verb',
  }),
  w(119, 'adopt', '/əˈdɒpt/', 'v.', '采纳（复习词）', {
    ex: 'They adopted the proposal.',
    zh: '他们采纳了这个提案。',
    conf: ['adapt'],
    topic: 'verb',
  }),
  w(120, 'remind', '/rɪˈmaɪnd/', 'v.', '提醒，使想起', {
    ex: 'This reminds me of home.',
    zh: '这让我想起家。',
    col: ['remind sb of', 'remind sb to do'],
    conf: ['remember', 'remain'],
    topic: 'verb',
  }),
];
const SEED_COLLECTIONS = {
  cet4: { id: 'cet4', name: '四级', tag: 'cet4', target: 4500, urls: [] },
  cet6: { id: 'cet6', name: '六级', tag: 'cet6', target: 5400, urls: [] },
  kaoyan: { id: 'kaoyan', name: '考研', tag: 'kaoyan', target: 5500, urls: [] },
  ielts: { id: 'ielts', name: '雅思', tag: 'ielts', target: 4000, urls: [] },
  toefl: { id: 'toefl', name: '托福', tag: 'toefl', target: 4000, urls: [] },
  gre: { id: 'gre', name: 'GRE', tag: 'gre', target: 8000, urls: [] },
};


// ═══════════ core/library.mjs → L ═══════════
// vocab-study / core / library.mjs
// 词库：拉取 → 落缓存 → 永久离线可用；失败则部分降级到内置种子库。
//
// 规格 §4.2 的六条都在这里落地，尤其是第 3 条：
// 「重试 3 次后才降级，且是部分降级：已拉到的批次照常可用，不因后续失败而全量作废」。
const SEED_CET4 = SEED_CET4_RAW;
const COLLECTIONS = SEED_COLLECTIONS;
const FIRST_CHUNK = 20; // 首批 20 词到达即开始学习，不阻塞首卡

/** 词表源：纯词表 + 音标 + 释义 + 例句 + 搭配，无版权风险。 */
const SOURCES = {
  cet4: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/CET4_edited.txt'],
  cet6: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/CET6_edited.txt'],
};

/** 把各种来源的原始文本解析成统一词条。接受 JSON 数组或每行「词 音标 释义」。 */
function parseWordlist(raw, collection = 'cet4', startSeq = 0) {
  if (!raw) return [];
  let rows = null;
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) rows = j;
    else if (j && Array.isArray(j.words)) rows = j.words;
  } catch {
    /* 不是 JSON，按文本行解析 */
  }
  if (!rows) {
    rows = String(raw)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        // 兼容「word /ipa/ pos. meaning」与制表符分隔
        const parts = l.split(/\t|  +/).filter(Boolean);
        if (parts.length >= 2) return { word: parts[0], ipa: parts[1], meaning: parts.slice(2).join(' ') };
        return { word: l };
      });
  }
  const out = [];
  let seq = startSeq;
  for (const r of rows) {
    const word = String(r.word || r.w || '').trim();
    if (!word || !/^[A-Za-z][A-Za-z '-]*$/.test(word)) continue;
    seq++;
    out.push({
      id: `${collection}:${word.toLowerCase()}`,
      word,
      ipa: r.ipa || r.phonetic || '',
      pos: r.pos || guessPos(r.meaning) || '',
      meaning: r.meaning || r.trans || r.zh || '',
      example: r.example || r.ex || null,
      exampleZh: r.exampleZh || null,
      collocations: r.collocations || [],
      roots: r.roots || null,
      synonyms: r.synonyms || [],
      confusables: r.confusables || [],
      topic: r.topic || null,
      collection,
      seq,
    });
  }
  return out;
}

function guessPos(meaning = '') {
  const m = String(meaning).match(/(^|\s)(n|v|a|ad|adj|adv|prep|conj|pron|num|int)\./);
  return m ? `${m[2]}.` : '';
}

/**
 * 加载一个词库。返回 { words, source, offline, partial, failedBatches }。
 *
 * @param fetcher 注入的 fetch（测试时给假实现；离线时给 null）
 * @param cache   { get(key), set(key, value) } —— 由 store 层提供
 */
async function loadCollection(collection, { fetcher = null, cache = null, retries = 3, onChunk, signal } = {}) {
  const meta = SEED_COLLECTIONS[collection] || { id: collection, name: collection, urls: [] };
  const cacheKey = `wordlist:${collection}`;

  // 1) 缓存优先：过了就不再联网（§4.2 第 4 条「面板内只读缓存，绝不实时请求」）
  const cached = cache ? await cache.get(cacheKey) : null;
  if (cached && Array.isArray(cached.words) && cached.words.length) {
    if (onChunk) onChunk({ words: cached.words, done: true, fromCache: true });
    return { words: cached.words, source: 'cache', offline: false, partial: !!cached.partial, failedBatches: [] };
  }

  const seeded = seedFor(collection);
  const urls = meta.urls || SOURCES[collection] || [];
  const batches = [];
  const failedBatches = [];

  if (fetcher && urls.length) {
    for (const url of urls) {
      let ok = false;
      let lastErr = null;
      // 2) 重试 3 次后才降级
      for (let attempt = 0; attempt < retries && !ok; attempt++) {
        try {
          const res = await fetcher(url, { signal });
          const text = typeof res === 'string' ? res : await res.text();
          const parsed = parseWordlist(text, collection, batches.reduce((n, b) => n + b.length, 0));
          if (parsed.length) {
            batches.push(parsed);
            ok = true;
            // 5) 流式：首批 20 词到达即可开始学习
            if (onChunk) onChunk({ words: parsed.slice(0, FIRST_CHUNK), batch: parsed, done: false });
          }
        } catch (err) {
          lastErr = err;
        }
      }
      // 3) 部分降级：这一批失败不影响已经拿到的批次
      if (!ok) failedBatches.push({ url, error: lastErr ? String(lastErr.message || lastErr) : 'failed' });
    }
  }

  const pulled = batches.flat();
  let words;
  let source;
  let partial = false;
  if (pulled.length) {
    // 拉到的 + 种子库补齐（种子库同 id 会被拉取结果覆盖）
    const byId = new Map();
    for (const w of dedupeById(seeded)) byId.set(w.id, w);
    for (const w of pulled) byId.set(w.id, w);
    words = [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    source = failedBatches.length ? 'partial' : 'network';
    partial = failedBatches.length > 0;
  } else {
    words = dedupeById(seeded);
    source = 'seed';
  }

  if (cache) await cache.set(cacheKey, { words, source, partial, savedTs: Date.now(), failedBatches });
  if (onChunk) onChunk({ words: words.slice(0, FIRST_CHUNK), done: true, source });
  return {
    words,
    source,
    offline: source === 'seed',
    partial,
    failedBatches,
    // 4) 面板顶部一行灰字：不解释（§4.2 第 3 条）
    banner: source === 'seed' ? '离线模式 · 用内置词表' : partial ? '部分词表未取到 · 先用已有的' : null,
  };
}

/**
 * 按 id 去重，保留首次出现。
 *
 * 为什么必须有：种子词库手写，天生会有重词（混形族里同一个词被两次想放进来）。
 * 不去重的话，一个重复词会**两次**吃掉当天的 N 个名额——20 词的容器里出现两张
 * 一模一样的卡，是又浪费又伤信任的那种 bug。所以这里是兜底，不是顺便。
 */
function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const w of list) {
    const key = w && w.id;
    if (key === undefined || key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** 种子库（离线降级用）。其他词库暂时复用四级种子，标注为对应词库。 */
function seedFor(collection = 'cet4') {
  if (collection === 'cet4') return dedupeById(SEED_CET4_RAW);
  return dedupeById(SEED_CET4_RAW).map((w) => ({ ...w, id: `${collection}:${w.word}`, collection }));
}

/** 给词库种入初始记忆（e=0.3，区分「真会」与「未校准」—— 规格 §5.4）。 */
function seedMemories(words, existing = {}, now = Date.now()) {
  const mem = { ...existing };
  for (const w of words) {
    if (!mem[w.id]) mem[w.id] = { e: 0.3, difficulty: 0.3, stability: 0, correct: 0, wrong: 0, hintCount: 0, hintRate: 0, reactionMs: 3500, encodeCount: 0, lastSeenTs: now, firstSeenTs: now, lastQuizCorrectTs: null };
  }
  return mem;
}

/** 批量导入：粘贴英文段落自动切词（§10）。 */
function extractWordsFromText(text) {
  const seen = new Set();
  const out = [];
  const tokens = String(text).match(/[A-Za-z][A-Za-z'-]{1,}/g) || [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** 选词收藏只对「纯英文」触发（P8）。 */
function isPureEnglish(sel) {
  const s = String(sel || '').trim();
  if (!s) return false;
  if (s.length > 48) return false;
  return /^[A-Za-z][A-Za-z' -]*$/.test(s);
}

/** 从一段文本中抓取该词所在的句子，作为专属例句（§10）。 */
function contextSentence(text, word) {
  if (!text || !word) return null;
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/);
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return sentences.find((s) => re.test(s))?.trim().slice(0, 220) || null;
}


// ═══════════ core/speech.mjs → SP ═══════════
// vocab-study / core / speech.mjs
// 系统 TTS（点单词即发音，零网络零成本 —— 规格 §5.2）。

let cachedVoice = null;
let voicesReady = false;

/** 找一个英文音色：优先 en-US，其次任意 en-*。 */
function pickVoice(synth) {
  if (cachedVoice) return cachedVoice;
  const voices = (synth && synth.getVoices && synth.getVoices()) || [];
  if (!voices.length) return null;
  const en = voices.filter((v) => /^en(-|_)?/i.test(v.lang || ''));
  cachedVoice =
    en.find((v) => /en[-_]US/i.test(v.lang) && /female|samantha|zira|aria/i.test(v.name)) ||
    en.find((v) => /en[-_]US/i.test(v.lang)) ||
    en[0] ||
    null;
  return cachedVoice;
}
function speechAvailable() {
  return typeof window !== 'undefined' && !!window.speechSynthesis;
}

/** 朗读一个单词。失败安静返回 false —— 绝不弹错、绝不阻塞卡片。 */
function speak(word, { rate = 0.9, lang = 'en-US' } = {}) {
  if (!speechAvailable()) return false;
  try {
    const synth = window.speechSynthesis;
    if (!voicesReady) {
      voicesReady = true;
      // 有些浏览器首次 getVoices() 为空，等一次 voiceschanged 再取
      try {
        synth.addEventListener?.('voiceschanged', () => {
          cachedVoice = null;
          pickVoice(synth);
        });
      } catch {
        /* 忽略 */
      }
      pickVoice(synth);
    }
    synth.cancel(); // 连点单词时不排队，直接打断上一条
    const u = new SpeechSynthesisUtterance(String(word));
    const v = pickVoice(synth);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || lang;
    u.rate = rate;
    u.pitch = 1;
    u.volume = 1;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}
function stopSpeaking() {
  if (!speechAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* 忽略 */
  }
}

/** 朗读练习：自动停下的时长估算，用于面板内「🔊 再听一遍」。 */
function speechSupportedLanguages() {
  if (!speechAvailable()) return [];
  try {
    return (window.speechSynthesis.getVoices() || []).map((v) => v.lang);
  } catch {
    return [];
  }
}


// ═══════════ core/hook.mjs → HK ═══════════
// vocab-study / core / hook.mjs
//
// 「让我记住它」—— 记忆钩子。
//
// ══ 这个模块为什么存在 ══════════════════════════════════════════════════
// 规格 §9 要求：点 `✨ 让我记住它` → 生成一个记忆钩子，**每词一生只付一次**，
// 结果写回本地永久复用；AI 挂了不阻塞，显示「✨ 暂时没编出来 · 重试」。
//
// 但之前的实现里，那个按钮**只有壳**：它假装加载 900ms，然后写死一句
// 「暂时没编出来」——永远不会成功。这违反 P7「数据诚实」。
//
// ══ 现在的做法 ═══════════════════════════════════════════════════════════
// 规格 §9 本身给了两条约束，恰好指向同一个答案：
//   · 「严禁编造词源、编造释义」
//   · 「AI 挂了不阻塞」
// 而内置词库里**本来就有** root（词根拆解）、collocations（搭配）、
// example（例句）、confusables（易混词）这些真实材料。
// 所以这里**先用真实材料组出钩子**——离线可算、绝不编造、零等待。
//
// 将来接上真 AI 时（规格 §9 的 AiPort），只要在 buildHook 之上加一层：
// 有 AI 就用 AI 的，AI 挂了就回落到这里的本地结果。那才是「不阻塞」的正解。
//
// ══ 为什么不是纯 AI ═════════════════════════════════════════════════════
// 这是一个**纯客户端插件**：没有 host 侧 AI 服务，客户端也拿不到模型通道。
// 与其给一个点了必然失败的按钮，不如给一个**真的能用**的钩子。
// 输出的每一句都带着来源标注（词根 / 例句 / 搭配），用户看得出它凭什么这么说
// ——这也是规格 §9 的要求（「提示词本身可编辑，用户能看到它凭什么这么说」）。

/**
 * 钩子种类。用于在界面上标注「这句话凭什么这么说」。
 */
const HOOK_SOURCE = {
  ROOT: 'root',
  EXAMPLE: 'example',
  COLLOCATION: 'collocation',
  CONTRAST: 'contrast',
  SPELLING: 'spelling',
};

const SOURCE_LABEL = {
  [HOOK_SOURCE.ROOT]: '来自词根',
  [HOOK_SOURCE.EXAMPLE]: '来自例句',
  [HOOK_SOURCE.COLLOCATION]: '来自搭配',
  [HOOK_SOURCE.CONTRAST]: '来自易混词',
  [HOOK_SOURCE.SPELLING]: '来自拼写',
};

/** 钩子的一句话长度上限（规格 §9：不超 40 字）。 */
const HOOK_MAX_CHARS = 40;

/**
 * 把词根拆解收拾成一句真正的钩子。
 *
 * 词库里的 root 形如：
 *   'a-(去) + band(约束) + -on → 解开束缚，放手不管'
 *   'ac-(加强) + cept(拿) → 拿过来'
 *
 * 箭头右边是词根给出的画面。但**光有画面不算钩子**——
 * 「拿过来」这三个字单独摆着，读者想不起是 accept 还是 receive。
 * 所以画面太短时把单词拼进去，让钩子自带「哪个词」这个信息：
 *   accept → `accept：拿过来`
 */
function fromRoot(word) {
  const root = word.roots;
  if (!root || typeof root !== 'string') return null;
  const arrow = root.indexOf('→');
  let tail = arrow >= 0 ? root.slice(arrow + 1).trim() : root.trim();
  if (!tail) return null;

  // 画面太短（说不出所以然）就把单词带上，让它成为一个完整的钩子
  const w = String(word.word || '').trim();
  if (w && tail.length < 8 && !tail.toLowerCase().includes(w.toLowerCase())) {
    tail = `${w}：${tail}`;
  }
  return tail;
}

/**
 * 用例句造一句场景联想。
 * 规格 §9 允许「没把握时改用场景联想」——例句是真实材料，不涉及编造。
 */
function fromExample(word) {
  const ex = word.example;
  if (!ex || typeof ex !== 'string') return null;
  const zh = word.exampleZh;
  // 有中文就借中文说事，没有就用英文例句本身
  if (zh && typeof zh === 'string') return zh.trim() || null;
  return ex.trim() || null;
}

/**
 * 用搭配造钩子：搭配是最小可用的固定说法，适合"记不住就用它"。
 */
function fromCollocation(word) {
  const col = word.collocations;
  if (!Array.isArray(col) || !col.length) return null;
  const first = String(col[0] || '').trim();
  return first || null;
}

/**
 * 用易混词造钩子：只提「跟谁容易混」，不编造区分理由
 * （编理由就是编造词源，规格明令禁止）。
 */
function fromContrast(word) {
  const conf = word.confusables;
  if (!Array.isArray(conf) || !conf.length) return null;
  const other = String(conf[0] || '').trim();
  if (!other) return null;
  return `别跟 ${other} 弄混`;
}

/**
 * 拼写兜底：词太长、又没有任何可用材料时，用首尾字母给个抓手。
 * 这是纯形式观察，不涉及任何编造。
 */
function fromSpelling(word) {
  const w = String(word.word || '').trim();
  if (w.length < 6) return null;
  return `${w.slice(0, 3)}…${w.slice(-3)}`;
}

/** 兜底：真的什么都没有时，诚实地说明，而不是编一句。 */
function fallbackLine(word) {
  const m = String(word.meaning || '').trim();
  if (m) return `${m}`;
  return '暂无可用材料';
}

/** 按优先级挑第一个能用的来源。顺序即"材料可靠度"顺序。 */
const BUILDERS = [
  [HOOK_SOURCE.ROOT, fromRoot],
  [HOOK_SOURCE.EXAMPLE, fromExample],
  [HOOK_SOURCE.COLLOCATION, fromCollocation],
  [HOOK_SOURCE.CONTRAST, fromContrast],
  [HOOK_SOURCE.SPELLING, fromSpelling],
];

/** 截断到上限，超了就加省略号（中文按字符算，规格说的是"字"）。 */
function clamp(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= HOOK_MAX_CHARS) return t;
  return t.slice(0, HOOK_MAX_CHARS - 1) + '…';
}

/**
 * 为单词构造记忆钩子。
 *
 * **纯函数**：同样的输入永远得到同样的输出，不读时间、不读随机数、
 * 不碰存储、不发网络请求。所以它可以被单测穷举，也可以安全地缓存。
 *
 * @param {object} word 词条（来自 library / seed-cet4）
 * @returns {{ text: string, source: string, sourceLabel: string, word: string }}
 *          text 是给用户看的那一句；source 标出它凭什么这么说。
 */
function buildHook(word) {
  const w = word || {};
  for (const [source, fn] of BUILDERS) {
    let line = null;
    try {
      line = fn(w);
    } catch {
      line = null; // 任何一条材料坏了都不该让整个按钮失败
    }
    const text = clamp(line);
    if (text) {
      return {
        text,
        source,
        sourceLabel: SOURCE_LABEL[source] || '',
        word: String(w.word || ''),
      };
    }
  }
  // 连一个可用材料都没有：给出释义本身，并诚实标注来源
  return {
    text: clamp(fallbackLine(w)),
    source: 'meaning',
    sourceLabel: '来自释义',
    word: String(w.word || ''),
  };
}

/**
 * 批量构造（「全部预生成」模式，规格 §9 的设置项会用到）。
 */
function buildHooks(words) {
  const out = {};
  for (const w of words || []) {
    if (w && w.id) out[w.id] = buildHook(w);
  }
  return out;
}

/**
 * 缓存的读写封装。
 *
 * 规格 §9：「每词一生只付一次，结果写回本地永久复用」。
 * 所以这里只做一件事：有缓存就用缓存，没有才生成，生成后立刻写回。
 *
 * @param {object} opts
 * @param {object} opts.storage 端口：{ get(k), set(k, v) }（异步）
 * @param {string} [opts.key]   存储键，默认 'hooks'
 * @returns {{ get: Function, ensure: Function, all: Function, forget: Function }}
 */
function createHookCache({ storage, key = 'hooks' } = {}) {
  let table = null;

  async function load() {
    if (table) return table;
    let raw = null;
    try {
      raw = storage ? await storage.get(key) : null;
    } catch {
      raw = null;
    }
    table = raw && typeof raw === 'object' ? raw : {};
    return table;
  }

  return {
    /** 只读：拿已缓存的钩子，没有就返回 null（不触发生成）。 */
    async get(wordId) {
      const t = await load();
      return t[wordId] || null;
    },

    /**
     * 拿到钩子：有缓存直接返回（零等待），没有就生成 + 写回。
     * 返回 { hook, cached }，让界面能区分"刚编的"和"早就编好的"。
     */
    async ensure(word) {
      const t = await load();
      const id = word && word.id;
      if (id && t[id]) return { hook: t[id], cached: true };
      const hook = buildHook(word);
      if (id) {
        t[id] = hook;
        try {
          if (storage) await storage.set(key, t);
        } catch {
          // 存不下也不能失败：规格 §14.5 磁盘不可写 → 只读模式，不清空已有数据
        }
      }
      return { hook, cached: false };
    },

    /** 导出全部（设置页要看"用它凭什么这么说"，也方便用户自己备份）。 */
    async all() {
      return { ...(await load()) };
    },

    /** 忘掉一个词的钩子（重编）。 */
    async forget(wordId) {
      const t = await load();
      if (Object.prototype.hasOwnProperty.call(t, wordId)) {
        delete t[wordId];
        try {
          if (storage) await storage.set(key, t);
        } catch {
          /* 同上 */
        }
      }
    },
  };
}


// ═══════════ core/queue.mjs → Q ═══════════
// vocab-study / core / queue.mjs
// 三层优先级组队 + 日容器切片 + DP 的「预算内最优子集」。
//
// 规格 §6.3 / §6.6 的两条硬约束都落在这个文件里：
//   1. 预算 20 词是铁律（N），没人能挤占；
//   2. 到期词只切片、不汇总 —— 「欠你 200 个」这句话永远不会被构造出来。

// DAY_MS 由 memory.mjs 提供：ESM 形态下经 import 拿到，单文件形态下同处一个作用域。
/** 一天的分界点：凌晨 4:00（规格 §7.3），避免熬夜学习被劈成两天。 */
const DAY_START_HOUR = 4;

/** 按 4:00 切分的学习日标识，形如 2026-02-14。 */
function dayKey(ts = Date.now()) {
  const d = new Date(ts - DAY_START_HOUR * 3600000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 某天 4:00 的时间戳。 */
function dayStartTs(ts = Date.now()) {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR, 0, 0, 0).getTime();
  return start > ts ? start - DAY_MS : start;
}

/** 两个 dayKey 之间差几天（只用于「连续多少天没学」这类温和判断）。 */
function daysBetweenKeys(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((tb - ta) / DAY_MS);
}
function priorDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - DAY_MS;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// 新词出场顺序：随机，但**同一天内稳定**
// ─────────────────────────────────────────────────────────────
//
// 以前新词严格按词库顺序（也就是字母序）出：abandon → abundant → abolish …
// 结果是每天翻开都是「ab-」开头，背了三天还在 a 里打转，前面记熟的词反复
// 占位、后面 b/c/d… 永远轮不到。用户要的是随机。
//
// 但**不能每次翻开都重掷**，否则违反规格 §7.2 / §540：
//     「08:52 回到面板 → 队列从第 6 词继续（新词保序）」
// 每次重掷的话，第 6 词会变成另一个词，"接着背"就不成立了。
//
// 解法：**带种子的洗牌**。种子固定（默认用 dayKey），于是
//   · 对用户来说顺序是乱的（不是字母序）
//   · 同一天内每次算出来完全一样 → 「从第 6 词继续」照旧成立
//   · 换一天换一个排法
//
// 真正跨天接续靠的是 session 快照恢复（app.init 里的 S.restore），
// 不是靠这个排序，所以这里换序不会让用户丢掉进度。

/** FNV-1a：把种子字符串摊成一个 32 位整数。纯函数，不依赖环境。 */
function hashSeed(seed) {
  const s = String(seed ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而够用的确定性伪随机数发生器。同种子必然同序列。 */
function seededRandom(seed) {
  let a = hashSeed(seed) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 带种子的 Fisher–Yates 洗牌。**返回新数组，不改原数组。**
 * 同样的 (items, seed) 必然得到同样的顺序 —— 这是「可续」的前提。
 */
function seededShuffle(items, seed) {
  const out = items.slice();
  const rnd = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 容器大小：唯一允许偏离 N 的合法情形（规格 §6.6）
// ─────────────────────────────────────────────────────────────

/** 断签天数 → 今日容器大小。回归门槛必须比坚持门槛低（P12）。 */
function containerSize(gapDays, baseN = 20) {
  if (gapDays <= 3) return baseN;
  if (gapDays <= 14) return Math.max(1, Math.round(baseN * 0.6));
  return Math.max(1, Math.round(baseN * 0.4));
}

/** 断签文案。零指责：没有「落后」，没有「还差」。 */
function comebackCopy(gapDays) {
  if (gapDays <= 0) return null;
  if (gapDays <= 3) return null;
  if (gapDays <= 14) return '先热个身';
  return '好久不见 · 今天轻一点';
}

// ─────────────────────────────────────────────────────────────
// 三层优先级组队
// ─────────────────────────────────────────────────────────────
const TIER = { REVIEW: 1, PERSONAL: 2, NEW: 3 };

/**
 * 组队：产出今天的容器。
 *
 * @param words    当前词库的全部词条
 * @param mem      记忆表 { wordId: memoryState }
 * @param opts     { N, gapDays, balance ∈ [0,1] (0=先保住会的, 1=多背点新的),
 *                   now, collections(启用的词库标签), personal(生词本 id 集合),
 *                   profile(用户画像/已毕业词库), theta,
 *                   exclude(Set<wordId>：本轮已经排过的词，一律不再出现) }
 */
function buildDailyContainer(words, mem, opts = {}) {
  const now = opts.now ?? Date.now();
  const N = opts.N ?? 20;
  const balance = clamp01(opts.balance ?? 0.5);
  const items = [];
  // 已在本轮排过的词。**排除要发生在所有池子里**，不能等选出结果再过滤。
  //
  // ⚠️ 为什么必须在这里排除（用户报「点再来 5 个出现重复的词」）：
  // 「再来 5 个新词」原来是用更大的 N 重建一遍、再拿结果去重。但走完一轮后
  // mem 已经变了 —— 那 20 个词从"新词池"进了"到期复习池"，重建出来的
  // 大部分**不是**它们本身，于是去重几乎全部失灵：实测 20 个词的一轮，
  // 点一次「再来 5 个」后容器变成 45 个条目、session 队列里 40 个是重复的。
  // 从池子源头排除，才能保证"多要的 5 个"真的是没排过的。
  const exclude = opts.exclude instanceof Set ? opts.exclude : null;
  const skip = (w) => !!(exclude && exclude.has(w.id));

  // 第 1 层：到期复习词 —— 不可挤占，防遗忘的地基
  const duePool = [];
  for (const w of words) {
    if (skip(w)) continue;
    const m = mem[w.id] || M.newMemory({}, now);
    if (!M.isDue(m, now, opts.theta) && !M.isWeak(m, now, opts.theta)) continue;
    duePool.push({ word: w, mem: m, tier: TIER.REVIEW, overdueDays: (now - M.dueAt(m, now, opts.theta)) / DAY_MS });
  }
  // 最紧急的排前面：逾期越久 / 当前可回忆概率越低，越先上
  duePool.sort(
    (a, b) =>
      b.overdueDays - a.overdueDays ||
      M.strength(a.mem, now, opts.theta) - M.strength(b.mem, now, opts.theta),
  );

  // 第 2 层：用户主动收藏的词（真实遇到的盲点，命中率高于随机推送）
  const personalPool = [];
  for (const w of words) {
    if (!w.personal) continue;
    if (skip(w)) continue;
    const m = mem[w.id] || M.newMemory({}, now);
    if (M.isDue(m, now, opts.theta)) continue; // 已在第 1 层
    personalPool.push({ word: w, mem: m, tier: TIER.PERSONAL });
  }
  personalPool.sort((a, b) => (b.word.addedTs || 0) - (a.word.addedTs || 0));

  // 第 3 层：当前词库的新词
  const newPool = [];
  for (const w of words) {
    if (w.personal) continue;
    if (skip(w)) continue;
    if (opts.collections && !opts.collections.includes(w.collection)) continue;
    const m = mem[w.id];
    if (m && (m.encodeCount > 0 || M.isDue(m, now, opts.theta))) continue; // 学过的不算新
    newPool.push({ word: w, mem: m || M.newMemory({}, now), tier: TIER.NEW });
  }
  // 新词出场顺序。
  //
  // 默认**随机**（种子 = opts.seed，app 传 dayKey），同一天内结果稳定，
  // 所以规格 §7.2 / §540 的「队列从第 6 词继续」照样成立。
  // 想回到按词库/字母序，opts.order 传 'seq'（设置页的那个开关）。
  //
  // 注意：**只随机新词这一层**。上面两层（到期复习 / 收藏）是记忆调度，
  // 乱了会破坏间隔重复 —— 逾期越久越先上，那个次序是有意义的。
  if (opts.order === 'seq') {
    newPool.sort((a, b) => (a.word.seq ?? 0) - (b.word.seq ?? 0));
  } else {
    const shuffled = seededShuffle(newPool, opts.seed ?? 'vocab');
    newPool.length = 0;
    newPool.push(...shuffled);
  }

  // ── 攻守天平：复习与新词的配比，实时可见（§6.5）──
  // balance=0 → 尽量先保住会的；balance=1 → 多推新词
  const reviewCount = duePool.length;
  const totalPool = reviewCount + personalPool.length + newPool.length;
  const fill = Math.min(N, totalPool);
  let reviewQuota = Math.round(fill * (1 - 0.55 * balance)); // 天平右移时给复习留的位置变小
  reviewQuota = Math.max(0, Math.min(reviewQuota, reviewCount));

  const personalCap = Math.max(0, Math.round(N * 0.6)); // 第 2 层最多占预算 60%
  let used = 0;

  // 1) 到期复习词（含旧库维护词）
  for (const it of duePool.slice(0, Math.max(reviewQuota, 0))) {
    if (used >= N) break;
    items.push(it);
    used++;
  }
  // 2) 收藏词，最多 60%，超出顺延次日（不丢、不堆）
  let personalUsed = 0;
  for (const it of personalPool) {
    if (used >= N || personalUsed >= personalCap) break;
    items.push(it);
    used++;
    personalUsed++;
  }
  // 3) 新词填满剩余名额
  //
  // allowMoreNew：用户本人显式按了「我还是想继续」。
  // 安全阀（当天新词答错率 > 70% 自动停推新词）仍然保留并照常自动触发，
  // 但它不再是一堵没有门的墙 —— 门只有用户能开，代码不会替他开。
  // 规格 §7.6 原本写的是"无需询问"，用户的实际意见是"要询问我、但让我决定"。
  const cushion = reserveCushion(words, mem, opts);
  const bypassBlockNew = !!(opts && opts.allowMoreNew);
  for (const it of newPool) {
    if (used >= N) break;
    if (cushion.blockNew && !bypassBlockNew) break;
    items.push(it);
    used++;
  }
  // 4) 如果复习词还没放完但预算有空（收藏/新词都不够），回头补复习词
  for (const it of duePool.slice(reviewQuota)) {
    if (used >= N) break;
    if (items.some((x) => x.word.id === it.word.id)) continue;
    items.push(it);
    used++;
  }
  // 5) 实在凑不满，把 5% 安全垫里最弱的词拉进来轮转（§5.6：绝不宣称「全部掌握」）
  //    注意：安全垫是从**已学过**的词里挑的，所以必须也过一遍 exclude ——
  //    否则「再来 5 个新词」会把刚从"新词池"迁到"复习池"的那批又拉回来。
  if (used < N) {
    for (const it of cushion.weakest) {
      if (used >= N) break;
      if (skip(it.word)) continue;
      if (items.some((x) => x.word.id === it.word.id)) continue;
      items.push(it);
      used++;
    }
  }

  // ── DP 视角的「最优子集」记录：为什么是这 20 个 ──
  const stats = {
    dueTotal: reviewCount, // 只用于内部排序，绝不汇总展示给用户（§6.6）
    deferred: Math.max(0, reviewCount - items.filter((i) => i.tier === TIER.REVIEW).length),
    reviewCount: items.filter((i) => i.tier === TIER.REVIEW).length,
    personalCount: items.filter((i) => i.tier === TIER.PERSONAL).length,
    newCount: items.filter((i) => i.tier === TIER.NEW).length,
    cushionCount: items.filter((i) => i.tier === TIER.REVIEW && i.reason === 'cushion').length,
    size: items.length,
    containerSize: N,
    balance,
    offline: !!opts.offline,
    // 新词闸门：自动触发过、或本次是被用户显式放行。
    // UI 用这两个字段决定"要不要给用户一个『我还是想继续』的入口"——
    // 闸门关着时给入口，用户放行后就不再追着问。
    newBlocked: cushion.blockNew && !bypassBlockNew,
    newBlockBypassed: cushion.blockNew && bypassBlockNew,
  };

  return { items, stats, explanation: explain(items, words, mem, { ...opts, now, N }) };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
}

/**
 * 新词闸门：当天新词答错率 > 70% 且已答满 5 个新词 → 停止推新词（§7.6）。
 *
 * 为什么单独抽成一个函数：原来这段判断写在组队流程里，而组队**一天只跑一次**
 * （开局建容器时），那一刻 todayStats().newAnswerCount 恒为 0，所以闸门
 * 从来没真正关上过 —— 规格 §7.6 是一条实际不生效的死规则。测试
 * test/round-control.test.mjs 把它抓了出来。
 * 现在 UI 每次取快照都用同一个函数重算，保证"界面上看到闸门状态"和
 * "组队时是否推新词"用的是同一口径。
 */
function shouldBlockNew(todayStats) {
  if (!todayStats) return false;
  return todayStats.newAnswerCount >= 5 && todayStats.newWrongRate > 0.7;
}

/**
 * 安全垫：词库背完后保留 ≥5% 最低强度词永远轮转，绝不宣称「全部掌握」（§5.6）。
 * 同时：新词答错率 > 70% 时当天自动停止推新词，只做复习（§7.6，无需询问）。
 */
function reserveCushion(words, mem, opts) {
  const now = opts.now ?? Date.now();
  const learned = words.filter((w) => (mem[w.id]?.encodeCount || 0) > 0);
  const cushionTarget = Math.max(1, Math.round(words.length * 0.05));
  const weakest = learned
    .map((w) => ({ word: w, mem: mem[w.id], tier: TIER.REVIEW, reason: 'cushion' }))
    .sort((a, b) => M.strength(a.mem, now, opts.theta) - M.strength(b.mem, now, opts.theta))
    .slice(0, cushionTarget);

  const allLearned = learned.length >= words.length * 0.95 && learned.length > 0;
  const blockNew = shouldBlockNew(opts.todayStats);
  return { weakest, allLearned, blockNew };
}

/**
 * 一句话解释 + 每词角标（规格 §6.4）。
 * 不做数字展开：不显示强度 0.32 / 遗忘概率 71%。
 */
function explain(items, words, mem, opts = {}) {
  const now = opts.now ?? Date.now();
  const soonFuzzy = items.filter((it) => {
    const p = M.recallProb(it.mem, Math.max(0, (now - it.mem.lastSeenTs) / DAY_MS), opts.theta);
    return p < 0.75 && p >= 0.4;
  }).length;
  const top = soonFuzzy > 0 ? `今天重点：${soonFuzzy} 个词明天就会模糊` : '今天这批都是新面孔';
  return { headline: top, sub: null };
}

/** 每个词的角标。 */
function badgesFor(item, mem, opts = {}) {
  const out = [];
  const now = opts.now ?? Date.now();
  if (item.tier === TIER.PERSONAL) out.push({ icon: '📥', label: '收藏' });
  if (item.tier === TIER.NEW) out.push({ icon: '✨', label: '新词' });
  if ((mem?.e || 0) >= 3) out.push({ icon: '🔥', label: `错过 ${mem.e} 次` });
  else if (mem && mem.encodeCount > 0) {
    const p = M.recallProb(mem, Math.max(0, (now - mem.lastSeenTs) / DAY_MS), opts.theta);
    if (p < 0.6) out.push({ icon: '⏳', label: '明天忘' });
  }
  return out;
}

/** 队列空了怎么办（规格 §6.3 的空状态表）。文案永不指责。 */
function emptyState(kind) {
  switch (kind) {
    case 'allStable':
      return { text: '今天没有需要复习的词 · 去换本新的？', action: '换词库' };
    case 'noWords':
      return { text: '这个词库里暂时没有可背的词', action: '去设置' };
    default:
      return { text: '今天没有需要复习的词 · 去换本新的？', action: '换词库' };
  }
}

/** 今日进度：完成容器 ≥60% 即算打卡（§7.3），不必 100%。 */
const CHECKIN_RATIO = 0.6;
function isCheckedIn(doneCount, containerN) {
  if (!containerN) return false;
  return doneCount / containerN >= CHECKIN_RATIO;
}

/**
 * 连续天数：只在真实完成时 +1；同日多次完成不 +1；不可补签（P7、§7.3）。
 * 返回新的 streak 状态。
 */
function bumpStreak(streak, key, { count = 1 } = {}) {
  const s = { current: 0, longest: 0, lastDay: null, ...streak };
  if (s.lastDay === key) return s; // 同日多次不 +1
  if (s.lastDay && daysBetweenKeys(s.lastDay, key) === 1) s.current += 1;
  else s.current = 1;
  s.lastDay = key;
  s.longest = Math.max(s.longest || 0, s.current);
  s.totalDays = (s.totalDays || 0) + 1;
  void count;
  return s;
}

/**
 * 主动休假（§7.7）：「暂停到 X 日」—— 暂停期内胶囊消失、不产生到期词。
 * 有钥匙的退出，比偷偷溜走更容易回来。
 */
function isPaused(pause, now = Date.now()) {
  if (!pause || !pause.until) return false;
  return now < pause.until;
}

/** 恢复：连续 3 天正常完成 → 自动回到 N（不询问）。 */
function effectiveBaseN(baseN, streak, recentDays) {
  const last3 = (recentDays || []).slice(-3);
  if (last3.length === 3 && last3.every((d) => d.done)) return baseN;
  return null; // 由 containerSize 按断签天数决定
}


// ═══════════ core/game.mjs → G ═══════════
// vocab-study / core / game.mjs
// 轻游戏化：连击 Combo / 连续打卡 Streak / 词力值 EXP。
// 三条克制点（规格 §8）：只在面板内动效、不用红点催、不做排行榜。

/** 连击倍率阶梯：连对 3/5/10 → ×2/×3/×5。 */
const COMBO_STEPS = [
  { at: 10, mult: 5 },
  { at: 5, mult: 3 },
  { at: 3, mult: 2 },
];
function comboMult(combo) {
  for (const s of COMBO_STEPS) if (combo >= s.at) return s.mult;
  return 1;
}

/** 连击冻结窗口：中途离开 5 分钟内回来继续，不清零（§5.1）。 */
const COMBO_FREEZE_MS = 5 * 60 * 1000;
function newCombo(now = Date.now()) {
  return { combo: 0, best: 0, mult: 1, frozenAt: null, lastTs: now };
}

/** 一次作答后推进连击。不弹动画、不打断；纯状态。 */
function stepCombo(state, correct, now = Date.now()) {
  const s = { ...state, lastTs: now };
  if (correct) {
    s.combo = state.combo + 1;
    s.mult = comboMult(s.combo);
    s.best = Math.max(state.best || 0, s.combo);
    s.frozenAt = null;
  } else {
    s.combo = 0;
    s.mult = 1;
    s.frozenAt = null;
  }
  return s;
}

/** 面板收起 → 冻结而不是清零。 */
function freezeCombo(state, now = Date.now()) {
  if (state.combo === 0) return state;
  return { ...state, frozenAt: now };
}

/** 重新打开面板：5 分钟内回来，连击还在；超过就静默归零（不提示、不指责）。 */
function resumeCombo(state, now = Date.now()) {
  if (!state.frozenAt) return state;
  if (now - state.frozenAt <= COMBO_FREEZE_MS) return { ...state, frozenAt: null };
  return { ...newCombo(now), best: state.best };
}

// ─────────────────────────────────────────────────────────────
// 词力值：掌握度换算 EXP，攒够升级。纯个人成长，不做排行榜。
// ─────────────────────────────────────────────────────────────

/** 等级名走趣味路线（不叫 Lv.7，叫「词力值 7 级 · 拾穗人」）。 */
const LEVELS = [
  { at: 0, name: '初拾' },
  { at: 60, name: '备忘录' },
  { at: 160, name: '拾穗人' },
  { at: 320, name: '小词典' },
  { at: 560, name: '活字架' },
  { at: 900, name: '咬文者' },
  { at: 1400, name: '掌灯人' },
  { at: 2100, name: '藏书阁' },
  { at: 3200, name: '词林圣手' },
  { at: 5000, name: '百科之友' },
];
function levelFor(exp) {
  let cur = LEVELS[0];
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (exp >= LEVELS[i].at) {
      cur = LEVELS[i];
      idx = i;
    }
  }
  const next = LEVELS[idx + 1] || null;
  const span = next ? next.at - cur.at : 1;
  const progress = next ? Math.min(1, (exp - cur.at) / span) : 1;
  return { level: idx + 1, name: cur.name, exp, nextAt: next ? next.at : null, progress };
}

/**
 * 一次作答产出的 EXP。
 * 刻意与「学会」挂钩，不与「时长」挂钩 —— 挂机刷时长与学会背道而驰（§13）。
 */
function expFor({ rating, correct, mult = 1, isReview = false }) {
  let base = 0;
  if (correct && rating === 'known') base = 4;
  else if (rating === 'fuzzy') base = 2;
  else base = 1; // 答错也给 1：来过就算数，不惩罚（P3）
  if (isReview) base += 1; // 复习旧词同样有价值
  return Math.round(base * mult);
}

/** 已收服数：只增不减的计数（判定在 memory.isConquered，必须硬）。 */
function conqueredCount(words, mem, isConquered) {
  let n = 0;
  for (const w of words) {
    const m = mem[w.id];
    if (m && isConquered(m)) n++;
  }
  return n;
}


// ═══════════ core/beckon.mjs → B ═══════════
// vocab-study / core / beckon.mjs
// 情绪胶囊的状态机（规格 §3）。
//
// 三条不可违反的约束：
//   P3 文案永不指责 —— 断签只是空白，没有红字，没有「落后」
//   §3.1 优先级状态机「取第一个命中」
//   §3.2 注意力交接态：任务在流式输出时，胶囊只轻轻说一句，不抢焦点、不跳转、不闪动

/** §3.1 优先级状态机，取第一个命中。 */
const BECKON = {
  FIRST: 'first', // 🌱 今天第一词
  LONG_GONE: 'longGone', // 💤 好久不见
  DUE: 'due', // ⏳ 陪你补 12 个
  DONE: 'done', // ✨ 今日达成
  STREAK: 'streak', // 🔥 连续 7 天
  SOLID: 'solid', // 🏔️ 稳得很
  // §3.2 注意力交接态
  LEARNING: 'learning', // 📖 学词中
  HANDOFF: 'handoff', // ✅ 5 词收好 · 结果在左边
  PAUSED: 'paused', // 主动休假：胶囊消失
};

/** 色调（§3.3）。珊瑚只用于非文字内容；文字态用深一点的红 —— 见 §14.3。 */
const TONE = {
  fresh: { key: 'fresh', color: '#1F9D8F', textColor: '#157F73' }, // 青绿
  streak: { key: 'streak', color: '#FF6B5A', textColor: '#C24432' }, // 珊瑚
  due: { key: 'due', color: '#D9A23B', textColor: '#8A6420' }, // 暖黄
  done: { key: 'done', color: '#3FBFAE', textColor: '#157F73', ripple: true }, // 薄荷 + 一次涟漪
  away: { key: 'away', color: '#7C8A9A', textColor: '#5A6774' }, // 灰蓝，零指责
};

/** 关键天数：连续 ≥30 天走「稳得很」，≥3 天未学走「好久不见」。 */
const LONG_GONE_DAYS = 3;
const SOLID_DAYS = 30;
const DUE_THRESHOLD = 1; // 有欠账就温柔提示（但不显示总数之外的任何东西）

/**
 * 算出胶囊此刻该显示什么。
 * 注意：这个函数永远返回「一句话 + 一个色调」，不返回任何数字 KPI。
 */
function beckonState(ctx = {}) {
  const {
    hasRecords = false,
    streak = {},
    gapDays = 0,
    dueCount = 0,
    deferredCount = 0,
    containerDone = 0,
    containerSize = 0,
    session = null,
    streamActive = false,
    roundJustFinished = false,
    vacationUntil = null,
    now = Date.now(),
  } = ctx;

  // 主动休假：胶囊直接消失（§7.7），不显示倒计时、不劝
  if (vacationUntil && now < vacationUntil) {
    return { state: BECKON.PAUSED, visible: false, label: '', tone: TONE.away, needsAction: false };
  }

  // ── §3.2 注意力交接态优先于一切情绪展示（这是「不打扰」的唯一出口）──
  if (roundJustFinished && streamActive) {
    return {
      state: BECKON.HANDOFF,
      visible: true,
      label: `✅ ${containerDone || ''} 词收好 · 结果在左边`.replace('  ', ' ').trim(),
      tone: TONE.done,
      needsAction: false,
      note: '不抢焦点、不跳转、不闪动、不消失',
    };
  }
  if (streamActive && session && !isSessionFinished(session)) {
    return { state: BECKON.LEARNING, visible: true, label: '📖 学词中', tone: TONE.streak, needsAction: false };
  }
  if (roundJustFinished) {
    return { state: BECKON.DONE, visible: true, label: `✅ ${containerDone} 词收好`, tone: TONE.done, needsAction: false };
  }

  const doneAll = containerSize > 0 && containerDone >= containerSize;

  // ── §3.1 优先级状态机，取第一个命中 ──
  // 1. 首日 / 无记录 → 🌱 今天第一词
  if (!hasRecords && !streak.lastDay) {
    return { state: BECKON.FIRST, visible: true, label: '🌱 今天第一词', tone: TONE.fresh, needsAction: false };
  }
  // 2. 连续 ≥3 天未学 → 💤 好久不见（用旧荣耀接住，零指责）
  if (gapDays >= LONG_GONE_DAYS) {
    const longest = streak.longest || 0;
    const label = longest >= 3 ? `💤 好久不见 · 最长 ${longest} 天` : '💤 好久不见';
    return { state: BECKON.LONG_GONE, visible: true, label, tone: TONE.away, needsAction: false };
  }
  // 3. 到期欠账 > 阈值 → ⏳ 陪你补 N 个（只显示今天切片，绝不显示「待复习总数」）
  if (dueCount > DUE_THRESHOLD) {
    const n = Math.min(containerSize || dueCount, dueCount);
    return {
      state: BECKON.DUE,
      visible: true,
      label: `⏳ 陪你补 ${n} 个`,
      tone: TONE.due,
      needsAction: false,
      // 明确不显示 deferredCount —— 那是「欠你 180 个」的表述，规格 §6.6 禁止
      hidden: { deferred: deferredCount },
    };
  }
  // 4. 今日目标已达成 → ✨ 今日达成
  if (doneAll) {
    return { state: BECKON.DONE, visible: true, label: '✨ 今日达成', tone: TONE.done, needsAction: false };
  }
  // 5. 正常在学中 → 🔥 连续 7 天
  if ((streak.current || 0) >= LONG_GONE_DAYS) {
    // 6. 连续 ≥30 天 → 🏔️ 稳得很
    if ((streak.current || 0) >= SOLID_DAYS) {
      return { state: BECKON.SOLID, visible: true, label: '🏔️ 稳得很', tone: TONE.streak, needsAction: false };
    }
    return { state: BECKON.STREAK, visible: true, label: `🔥 连续 ${streak.current} 天`, tone: TONE.streak, needsAction: false };
  }
  // 兜底：有记录但不到 3 天连续
  if ((streak.current || 0) > 0) {
    return { state: BECKON.STREAK, visible: true, label: `🔥 连续 ${streak.current} 天`, tone: TONE.streak, needsAction: false };
  }
  return { state: BECKON.FIRST, visible: true, label: '🌱 今天第一词', tone: TONE.fresh, needsAction: false };
}

function isSessionFinished(session) {
  return !session || session.cursor >= session.queue.length;
}

/**
 * 断签回来的文案（§3.3）：用旧荣耀接住，而不是提醒损失。
 * 断签不羞辱、不红字、不弹窗催命。
 */
function comebackLine(gapDays, longest = 0) {
  if (gapDays < LONG_GONE_DAYS) return null;
  if (longest >= 3) return `💤 好久不见 · 最长 ${longest} 天`;
  return '💤 好久不见';
}

/**
 * 达成时的一次轻微涟漪（§3.3）。
 * prefers-reduced-motion 时全部降级为无动画（§14.3）。
 */
function shouldRipple(prefersReducedMotion) {
  return !prefersReducedMotion;
}


// ═══════════ core/session.mjs → S ═══════════
// vocab-study / core / session.mjs
// 一场学习的完整状态机：出卡 → 自评 → 揭晓 → 同轮重训 → 结算。
//
// 规格里最难也最重要的两条在这里：
//   §5.5 「答错后不得立刻重问同一个词」——必须隔 3–8 张卡
//   §5.2 「同屏最多 1 张卡；连续新词不超过 2 个，第 3 个前必须插入复习词」
//
// 这个文件不认识 DSH，也不认识 DOM；它只输出「下一张卡应该是什么」。

/** 同轮重训的插入间距：必须 ≥3 且 ≤8 张卡（§5.5）。取 4 落在安全带正中。 */
const RETRY_GAP_MIN = 3;
const RETRY_GAP_MAX = 8;
const RETRY_GAP_DEFAULT = 4;
/** 「模糊」的再现更靠后一点（第 6 张后）。 */
const FUZZY_GAP_DEFAULT = 6;
/** 连续新词上限：第 3 个前必须插复习词。 */
const MAX_CONSECUTIVE_NEW = 2;
/** 撤销窗口：2 秒内可撤销，不留脏数据（§5.2）。 */
const UNDO_WINDOW_MS = 2000;
/** 一个词错误计数 ≥3 → 自动切辨词模式（§5.3）。 */
const QUIZ_ERROR_THRESHOLD = 3;
const MODE = { RECOGNIZE: 'recognize', QUIZ: 'quiz' };
const RATING = { FORGOT: 'forgot', FUZZY: 'fuzzy', KNOWN: 'known' };

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
function createSession(container, opts = {}) {
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
function currentCard(session) {
  return session.queue[session.cursor] || null;
}

/** 是否还有卡。 */
function isFinished(session) {
  return session.cursor >= session.queue.length;
}

/**
 * 这场会话"覆盖了多少个**不同的词**"—— 界面上环和进度的**分子**。
 *
 * 为什么不能用 `session.stats.answered`：那个数的是**卡**，而答"忘了/模糊"
 * 会在同一轮里再插重训卡（§5.5，一个词最多再出现 2 次）。于是 20 个词走完
 * 会是 answered = 60，而分母 plannedSize/containerSize 数的是**词**（20），
 * 界面上的环就会显示「60/20」这种东西 —— 分子分母不是一个单位。
 *
 * `stats.answered` 的原义（签到判定 §…… 用它）保留不动，只是不用来当进度条。
 */
function coveredCount(session) {
  if (!session || !Array.isArray(session.queue)) return 0;
  const seen = new Set();
  for (const c of session.queue) {
    if (!c || !c.answered || !c.word) continue;
    seen.add(c.word.id);
  }
  return seen.size;
}

/**
 * 提交自评。这是核心动作：它决定这个词接下来发生什么。
 *
 * @returns 揭晓信息 payload { word, memory, reveal, plan }
 *   plan 里写明「这个词接下来还见不见、什么时候见」—— 这是 §5.5 的落地。
 */
function submitRating(session, card, rating, extra = {}) {
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
function revealFor(word, mem, extra = {}) {
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
function planRetry(session, card, rating, now = Date.now()) {
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
function insertRetry(session, card, { gap, reason, quiz, now = Date.now() }) {
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
function advance(session, now = Date.now()) {
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
function ensureNewWordCap(session, limit = MAX_CONSECUTIVE_NEW) {
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
function undoLast(session, now = Date.now()) {
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
function buildQuiz(card, session, rand = Math.random) {
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
function submitQuiz(session, card, optionId, { now = Date.now(), reactionMs, theta } = {}) {
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
function humanizeConfusion(target, chosen) {
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
function reportFakeMastery(session, card, confusedWith, { now = Date.now(), theta } = {}) {
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
function pauseSession(session, now = Date.now()) {
  return { ...session, combo: freezeCombo(session.combo, now), pausedTs: now };
}

/** 重开面板：恢复队列顺序与剩余词，已答过的不重考（§7.2 崩溃恢复）。 */
function resumeSession(session, now = Date.now()) {
  return { ...session, combo: resumeCombo(session.combo, now), pausedTs: null };
}

/** 把会话压成可持久化的快照（崩溃恢复用）。 */
function snapshot(session) {
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
function restore(snap, { words, mem, confusions, quizPool, now = Date.now() } = {}) {
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


// ═══════════ core/app.mjs → A ═══════════
// vocab-study / core / app.mjs
// 组合根：把记忆 / 队列 / 会话 / 记录 / 游戏 拼成一个能被 UI 直接驱动的门面。
//
// 这一层仍然不认识 DSH：它只跟一个 Ports 对象打交道（见 §15 adapter 分层）。
//   ports.storage  本地持久化（JSONL + 快照）
//   ports.now      时钟（测试可注入假时钟）
//   ports.fetcher  词库拉取（可注入；离线给 null）
//   ports.ai       AI 增强（可注入；不注入就只有词库自带内容）
//   ports.context  「我上一级输入」的语境（只在用户点了 ✨ 时才读，隐私最小化 —— §9.1）






// DAY_MS 只在 memory.mjs 声明一处：ESM 形态下经 import 拿到，单文件形态下同处一个作用域。
// （曾经三处重复声明，把整个单文件产物炸成 SyntaxError 白屏。）
function createApp(ports = {}) {
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
    // 「再背一轮」用的那一批卡（不含同轮重训插入）；「自己往后背」的加量次数。
    roundItems: null,
    extendCount: 0,
    offline: false,
    banner: null,
    librarySource: 'seed',
    /** 换词库的一次性结果，给设置页显示；成功/失败/原因都放这里（别只写 DOM） */
    lastLibraryChange: null,
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
      // 换词库的一次性结果（成功/失败/原因）。必须放进快照里：
      // changeCollection 成功后会 emit() 触发整页重绘，只写在 DOM 上的提示会被冲掉。
      lastLibraryChange: state.lastLibraryChange,
      stats: computeStats(),
      // ① 这里**必须**同时保住 container 和 container.items。
      //    `state` 是每次渲染都读的 getter，只要有一个容器形状不完整
      //    （items 缺失 / 被写坏 / 老版本存下来的数据结构），这一行就会抛
      //    TypeError —— 而它抛出来，整个界面就白屏，用户看到的是"插件坏了"。
      //    这次修「设置不留痕」时就真的踩到了：container 曾经是 null，
      //    去掉兜底后测试直接崩在这里，后面所有断言一条都跑不到。
      //    判空写成"形状不对就当空"，比"假设形状一定对"安全。
      empty: !state.container || !Array.isArray(state.container.items) || state.container.items.length === 0,
      // 本轮是否已经跑完（用来决定"再背一轮 / 再来几个新词"要不要出现）
      roundFinished: !state.session || S.isFinished(state.session),
      // 进度**分子**：这一个会话覆盖了多少个**不同的词**。
      //
      // 不能用 session.stats.answered：那个数的是"卡"，而重训会在同一轮里
      // 再插卡（答"忘了"一个词最多再出现 2 次），20 个词走完会变成 60 ——
      // 和"词"为单位的分母一除，环就显示「60/20」。分子分母必须同单位。
      // 核心侧算好放这里，界面直接读，省得再往命名空间注册表里加符号。
      covered: S.coveredCount(state.session),
      // 本轮排过的卡数（不含同轮重训插入），用于文案「这一轮 20 词」
      roundSize: (state.roundItems || []).length,
      extendedBy: state.extendCount || 0,
      canRestart: !!(state.roundItems && state.roundItems.length),
      // 新词闸门状态：**每次快照实时重算**。
      // 不能只读 container.stats.newBlocked —— 容器一天只建一次，
      // 建的时候今天还没答题，那个字段天然恒为 false（死代码）。
      // 这里用和组队时同一个 shouldBlockNew()，保证口径一致。
      //
      // `state.settings` 必须带兜底：面板在 createPanelPuppet 里是**先 append
      // 再异步 init**（adapter/dsh/puppet.mjs 的 `void ensureReady()`），所以
      // 第一帧渲染时 settings 还是 null。读 `.allowMoreNew` 会抛
      // "Cannot read properties of null" —— 渲染中断，用户看到的就是空标签页。
      // 初始化完成后 ensureReady() 会再 render 一次，那时才是真设置。
      newGate: (() => {
        const blocked = Q.shouldBlockNew(todayStats());
        const bypassed = state.settings?.allowMoreNew === true;
        return {
          autoBlocked: blocked,           // 自动判断：今天该不该停推新词
          bypassed,                       // 用户是否已显式放行
          closed: blocked && !bypassed,    // 当前是否真的关着（关着才给用户入口）
        };
      })(),
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

    // ⚠️ 恢复成功也必须把 container 补出来，不能只在"没 session"时才建。
    //
    // 这里原来只有一行 `if (!state.session) buildContainer();` —— 于是恢复成功的
    // 那条路上 `state.container` **永远是 null**，而界面上一大堆东西是从它算的：
    //   · 底部「今日 x/y」的分母、环的分母
    //   · st.empty（= !container || items.length === 0）→ 判成"今天没词"
    // 用户报「我设置了 10 个，每次进来就是 20」就是这一条：设置其实**存住了**
    // （存储里 dailyGoal 确实是 10），但容器是 null，界面拿不到真实的本轮规模，
    // 于是显示成"没有需要复习的词" / 默认数字，看起来就像设置没保存。
    //
    // 注意：这里**只能重建容器，绝不能重新选词建新 session** ——
    // 那会把用户恢复出来的队列位置冲掉（§7.2 要求从第 N 个词继续）。
    if (state.session && !state.container) rebuildContainerFromSession();

    if (!state.session) buildContainer();
    state.ready = true;
    emit();
    return snapshotState();
  }

  /**
   * 把容器从**已经恢复出来的 session** 反推出来：不重新选词、不新建 session，
   * 所以用户不会因为中途关掉面板而回到第 1 个词。
   *
   * 只在"有 session 但没有 container"（重启后恢复）时用。
   */
  function rebuildContainerFromSession() {
    const key = state.dayKey || Q.dayKey(now());
    const gap = gapDays();
    const byWord = new Map();
    // 过滤掉同轮重训卡：一个词在队列里可能出现多次（答"忘了"最多再现 2 次），
    // 但容器要的是"本轮排过的**词**"，不是"要做的卡"。
    for (const c of state.session.queue) {
      if (!c || !c.word) continue;
      if (c.isRetry) continue;
      // mem 从 state.mem 取，**不要**用 c.mem：S.restore() 重建队列时不带
      // mem 字段（见 session.mjs 里 restore 的 map），恢复出来的卡 c.mem 是
      // undefined。照抄它会让容器里的条目少一个字段，界面按层级/强度取用时踩空。
      if (!byWord.has(c.word.id)) {
        byWord.set(c.word.id, { word: c.word, mem: state.mem[c.word.id], tier: c.tier });
      }
    }
    const items = [...byWord.values()];
    const size = state.session.plannedSize || items.length;
    const tierCount = (t) => items.filter((i) => i.tier === t).length;
    state.container = {
      items,
      stats: {
        // 重训卡不算"词"，所以这些数字按去重后的词条重算，不照抄 session.stats
        reviewCount: tierCount(Q.TIER.REVIEW),
        personalCount: tierCount(Q.TIER.PERSONAL),
        newCount: tierCount(Q.TIER.NEW),
        size: items.length,
        // 用户设了多少就是多少 —— 恢复时也要用存下来的本轮规模，
        // 不能退回默认值，否则「我设了 10 却显示 20」会再犯一次。
        containerSize: size,
        balance: state.settings.balance,
        offline: !!state.offline,
        newBlocked: false,
        newBlockBypassed: false,
      },
      dayKey: key,
      gapDays: gap,
      comeback: Q.comebackCopy(gap),
      baseN: state.settings.dailyGoal,
      autoN: Q.containerSize(gap, state.settings.dailyGoal),
      restored: true,
    };
    // 「再背一轮」据此重建同一批卡，所以必须一起补上
    state.roundItems = items.map((it) => ({ ...it, isRetry: false }));
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
      // 用户显式放行新词闸门。默认 false（安全阀照常自动触发）；
      // 只有用户本人按了「我还是想继续」才变 true，代码不会替他打开。
      allowMoreNew: s.allowMoreNew === true,
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
        allowMoreNew: !!state.settings.allowMoreNew,
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
    // 本轮"排过队的词"（不含同轮重训插入）。「再背一轮」据此重建同一批卡：
    // 不重新选词，所以重背的就是刚才那一批，不会偷偷换成别的词。
    state.roundItems = state.container.items.map((it) => ({ ...it }));
    state.session = S.createSession({ ...state.container, dayKey: key }, sessionOpts());
    persist();
    emit();
    return state.container;
  }

  /**
   * 再背一轮：把刚才这一批卡重新跑一遍。
   *
   * 为什么不复用 buildContainer()：那个会重新选词（种子虽然按天稳定，但
   * mem 已经变了，到期/新词池都不同），重背出来的就不是刚才那一批了。
   * 用户要的是"把这一轮再来一次"，所以拿 roundItems 原样重建。
   *
   * 注意：这里**不动**任何记忆数据。重背只是多练一遍，答错照样照常更新记忆，
   * 所以"再背一轮"既不是惩罚也不是刷分，就是再练一次。
   */
  function restartRound() {
    if (!state.roundItems || !state.roundItems.length) return null;
    const dayKey = state.dayKey || Q.dayKey(now());
    state.session = S.createSession(
      { items: state.roundItems, stats: { ...(state.container?.stats || {}), containerSize: state.roundItems.length }, dayKey },
      sessionOpts(),
    );
    state.lastReveal = null;
    persist();
    emit();
    return state.session;
  }

  /**
   * 再来几个新词：突破当天计划 N，继续往后取。
   *
   * 自己控制"多背多少"：每点一次，目标加 5 个（不超过 dailyGoal）。
   * 为什么不一次给很多：用户说的是"能不能自己往后背"，要的是**由他决定继续**，
   * 不是系统一口气塞 100 个给他。一次 5 个，想继续再点。
   */
  /**
   * 「再来 5 个新词」：本轮再多排 step 个**没排过**的词，接在正在背的这一轮后面。
   *
   * ⚠️ 这里原来错得很厉害（用户报「点完显示 30 个」「出现的单词是重复的」）：
   * 老写法是「用更大的 N（base + step*next）重建一遍容器，再拿结果去重」。
   * 但走完一轮后 mem 已经变了 —— 那 20 个词从"新词池"迁进了"到期复习池"，
   * 于是重建出来的大部分**不是**它们本身，去重几乎全部失灵。实测：
   *   一轮 20 个词 → 点一次「再来 5 个」→ 容器 45 个条目、session 队列 40 个重复。
   *
   * 现在改成：把「本轮已排过的词」作为 exclude 交给 buildDailyContainer，
   * **只建设 step 个**。排除发生在池子源头（见 queue.mjs 的 skip），
   * 所以学过的词不会从复习池绕回来；再叠一层严格上限，凑不满就凑不满。
   */
  function extendRound(batch = 5) {
    const step = Math.max(1, Math.min(20, Math.round(batch) || 5));
    const key = state.dayKey || Q.dayKey(now());

    const prev = Array.isArray(state.roundItems) ? state.roundItems : [];
    const exclude = new Set(prev.map((it) => it.word.id).filter(Boolean));

    const built = Q.buildDailyContainer(personalToWords(), state.mem, {
      N: step,
      gapDays: state.container?.gapDays ?? gapDays(),
      balance: state.settings.balance,
      now: now(),
      collections: state.settings.collections,
      todayStats: todayStats(),
      // ⚠️ 这里**必须**沿用设置的闸门状态，不能写死成 true。
      // 我曾写成 `allowMoreNew: true`（理由是"用户亲手按了按钮"），结果
      // test/round-control.test.mjs 第 ⑦ 节立刻变红 —— 那条锁的是
      // 「闸门关着时 extendRound 不该硬塞新词」，而界面在闸门关着时
      // 根本不显示这个按钮。硬写 true 等于让这个函数**绕过安全阀**，
      // 那是产品决策，不该由修 bug 顺手改掉。
      allowMoreNew: !!state.settings.allowMoreNew,
      seed: key,
      order: state.settings.order,
      exclude,
    });

    // 严格只要没排过的，并且**不超过 step**。
    const seen = new Set(exclude);
    const fresh = [];
    for (const it of built.items) {
      const id = it.word && it.word.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fresh.push({ ...it });
      if (fresh.length >= step) break;
    }
    if (!fresh.length) return state.container;

    const merged = [...prev, ...fresh];
    state.extendCount = (state.extendCount || 0) + 1;
    state.container = {
      ...state.container,
      ...built,
      items: merged,
      stats: { ...built.stats, containerSize: merged.length, size: merged.length },
      dayKey: key,
      baseN: state.settings.dailyGoal,
      autoN: state.container?.autoN || state.container?.baseN || state.settings.dailyGoal,
      extendedBy: state.extendCount,
    };
    state.roundItems = merged.map((it) => ({ ...it }));

    // 续上正在背的这一轮，把新词接在后面。
    const s = state.session;
    if (!s || S.isFinished(s)) {
      // 上一轮**已经走完**时开新会话。这里要同时满足三件事，缺一样用户就会骂：
      //   ① 不许重考刚背过的（用户原话：「他会给我再原来的基础上加五个，
      //      然后从头过一遍我刚背的」）
      //   ② 计数器要连续（底部的「今日 x/y」不能因为续背而清零）
      //   ③ 这一轮的总量还是 25（环和底部说的是同一轮）
      //
      // 我第一版把队列直接缩成 fresh（5 张）—— ① 满足了，但 ② 挂了：
      // 新会话 answered 从 0 起，底部变成「今日 0/25」，看起来像进度被清空。
      // 正确做法是**队列保留整轮 25 个词，但把已经答过的标成已答、
      // 游标挪到新词开头**：currentCard() 只会拿到新词（①），
      // stats.answered 延续上一场的数（②），总量 25（③）。
      const doneIds = new Set();
      if (s) for (const c of s.queue) if (c.answered) doneIds.add(c.word.id);
      const next = S.createSession(
        { items: merged, stats: state.container.stats, dayKey: key },
        sessionOpts(),
      );
      for (const c of next.queue) if (doneIds.has(c.word.id)) c.answered = true;
      // 游标推到第一个还没背过的卡，这样开口问的就是新词
      next.cursor = next.queue.findIndex((c) => !c.answered);
      if (next.cursor < 0) next.cursor = next.queue.length;
      // 计数器要**接着上一场**，不能因为"这是新会话"就归零。
      // 用户刚背完 20 个，点了"再来 5 个"，进度条从 0/25 重新爬是错的 ——
      // 他看到的应该是 20/25 继续往上走。
      next.stats.answered = Math.max(next.stats.answered, doneIds.size);
      state.session = next;
    } else {
      const have = new Set(s.queue.map((c) => c.word.id));
      const add = fresh.filter((it) => !have.has(it.word.id));
      if (add.length) {
        const extra = S.createSession(
          { items: add, stats: built.stats, dayKey: key }, sessionOpts(),
        ).queue;
        for (const c of extra) s.queue.push(c);
        // 本轮总量要跟着队列一起长，否则环会说"这一轮已经完了"
        s.plannedSize = Math.max(s.plannedSize || 0, s.queue.length);
      }
    }
    state.lastReveal = null;
    persist();
    emit();
    return state.container;
  }

  /** 用户显式放行新词闸门（安全阀仍自动触发，只是不再无法绕过）。 */
  function allowMoreNew() {
    state.settings = { ...state.settings, allowMoreNew: true };
    buildContainer();
    // 放行之后必须**立刻给出卡**，而且只给还没背过的。
    //
    // 两个坑都在这几行里：
    //  1. buildContainer() 只是把容器重建（新词回到 container.items），
    //     但当前 session 已经走完了。不重开一场的话，界面会回到"这一轮
    //     走完了"，用户点了「我还是想继续」却什么也没发生。
    //  2. 更隐蔽的：container.items 里既有没有背过的**新词**，也有刚刚
    //     已经答完的卡。而 createSession 无条件把 items 全变成
    //     answered:false 的新队列 —— 直接把容器丢给它，等于让用户把
    //     刚背完的词原样再背一遍。所以要显式滤掉已答的。
    //     （这个坑我在无头浏览器里点出来才发现：点「我还是想继续」后，
    //      环显示 0/20、当前词是刚背过的第一个词。）
    const answered = new Set();
    if (state.session) {
      for (const c of state.session.queue) if (c.answered) answered.add(c.word.id);
    }
    const pending = state.roundItems.filter((it) => !answered.has(it.word.id));
    if (pending.length) {
      // 用 state.dayKey：buildContainer 里有它自己的 const key，出了那个函数
      // 就没了（我第一版直接写 key，会踩作用域错）。buildContainer 已经把
      // state.dayKey 设好了，restartRound 也是这么读的。
      state.session = S.createSession(
        { items: pending, stats: state.container.stats, dayKey: state.dayKey },
        sessionOpts(),
      );
    }
    state.lastReveal = null;
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
  /**
   * 今天的新词闸门统计 —— **只算当前这本词库**。
   *
   * ⚠️ 这里少了"按词库过滤"曾经是个真 bug（用户报「换词库显示成功但主页没反应」）：
   * 原来把当天所有词库的作答混在一起数。用户在四级全答"忘了"走完一轮 →
   * newAnswerCount=5、newWrongRate=1.0 → shouldBlockNew 为真；
   * 这时换到六级，闸门仍然认为"今天新词额度用完了"，于是六级的新词一个都不推；
   * 而六级的复习池又是空的（那些词还没学过）→ 队列 0 张 →
   * 主页继续显示「今天没有需要复习的词」，换多少个库都一样。
   *
   * 口径修成按词库之后：闸门问的是"**这本**今天推了几个新词、错得多不多"，
   * 换库自然重新开始，和用户"换本书重新学"的直觉一致。
   */
  function todayStats() {
    const active = state.settings?.collections?.[0] || null;
    const today = state.records.filter((r) => {
      if (r.dayKey !== state.dayKey) return false;
      if (!active) return true;
      // 老记录没有 collection 字段：从 wordId 前缀推（cet6:abandon），
      // 推不出来就当作"属于四级"，免得历史数据被算丢。
      const coll = r.collection || (String(r.wordId || '').includes(':') ? String(r.wordId).split(':')[0] : 'cet4');
      return coll === active;
    });
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
    enforceNewGate(s);
    persist();
    emit();
    return payload;
  }

  /**
   * 让新词闸门**真的生效**。
   *
   * 第二个真问题（第一个是判断用了永远为 0 的统计量）：容器是一天开局建一次的，
   * 那时还没答题、闸门必然算成"开"；等答完几个新词、答错率超过 70% 时，
   * 判断虽然变成"该关"，但**已经建好的队列不会因此改变** —— 判断结果对
   * 已排好的卡没有任何作用。规格 §7.6 因此还是一条空规则。
   *
   * 这里在每次作答后执行：闸门刚关上时，把本轮还没答的**新词**从队列里撤掉。
   * 三条克制：
   *   · 只撤"还没答"的新词；已答的不动（不抹掉用户已经做完的事）
   *   · 不撤复习词/收藏词（那些是维护记忆，与推新词无关，撤回会让记忆断档）
   *   · 撤掉不是作废：这些词没被标记学过，明天照常轮得到
   * 用户按下「我还是想继续」后 settings.allowMoreNew = true，本函数不再介入。
   */
  function enforceNewGate(s) {
    if (!s) return 0;
    if (state.settings.allowMoreNew) return 0;
    if (!Q.shouldBlockNew(todayStats())) return 0;
    const before = s.queue.length;
    // 撤掉 cursor 之后所有"还没答"的新词。已答过的卡都在 cursor 之前，不进候选人。
    const head = s.queue.slice(0, s.cursor);
    const rest = s.queue.slice(s.cursor).filter((c) => c.tier !== Q.TIER.NEW || c.answered);
    // 收尾：闸门关掉后，"cursor 之后已答过的卡"也切掉。
    // 它们永远排不到（cursor 只前进），却让 queue.length 虚高，
    // 界面上的"本轮还剩多少"就会骗人 —— 实测确实剩下 5 张这种卡。
    const tailIdx = rest.findIndex((c) => c.answered);
    s.queue = tailIdx >= 0 ? [...head, ...rest.slice(0, tailIdx)] : [...head, ...rest];
    const removed = before - s.queue.length;
    if (removed > 0) {
      // plannedSize 必须跟着队列走。它原本在会话创建时固定为 queue.length，
      // 而同轮重训（忘了 → 同轮再来一次，§5.5）会往队列里插新卡，
      // 于是"本轮总量"长期偏小：实测重背时实际要过 4 张卡，环却写 1/1，
      // 看起来这一轮已经完了。宁大不小，所以取 max。
      s.plannedSize = Math.max(s.plannedSize || 0, s.queue.length);
      // 容器统计跟着真实队列走：界面上的"新词"数量不能继续显示已经撤掉的那些
      if (state.container?.stats) {
        const remainingNew = s.queue.filter((c) => c.tier === Q.TIER.NEW && !c.answered).length;
        state.container = {
          ...state.container,
          stats: { ...state.container.stats, newCount: remainingNew },
        };
      }
    }
    return removed;
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
      // 这条记录属于哪本词库。todayStats() 用它把新词闸门**按词库**统计：
      // 换了词库之后，"上一本今天推过 5 个新词"不该继续挡住新词库。
      // 用户报的换库无反应，有一半就是这个原因（见 todayStats 的注释）。
      collection: card.word.collection || null,
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
    // 今日新词作答数：只数 tier 3（新词）且当天已作答的记录。
    // 用户抱怨"我抽空背了几个词却看不到"，就是缺这个数 —— 它一直在
    // todayStats() 里算着，只是从没挂到界面上。
    const todayNewCount = todayRecs.filter((r) => r.tier === 3).length;
    return {
      conquered, // 「已收服 N 词」取代「掌握度 x%」（§7.5 证据①）
      learned,
      totalWords: state.words.length,
      todayAnswered: todayRecs.length,
      todayNewCount,
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

  /**
   * 换词库：**真的把词换掉**。
   *
   * ⚠️ 这里曾经是个真 bug（用户报「显示更换成功但主页没反应」）：
   * 设置页的下拉框只调了 `updateSettings({ collections: [id] })`，
   * 而 updateSettings 只在 dailyGoal / balance 变化时重建容器 ——
   * 于是换库只改了一个设置字段：`state.words` 还是老词库的，
   * `state.container` 还是老的（多半已经背完、空着）。
   * 今日页因此永远停在「今天没有需要复习的词」，怎么换都不动。
   *
   * 而 `L.loadCollection()` 全仓库原本**只在 init() 里调用一次**，
   * 所以"换库"从来没有真正加载过另一个词库。
   *
   * 现在按和 init() 同样的顺序做：重载词表 → 重种记忆 → 重建今日队列。
   *
   * @param {string} id 词库 id（L.COLLECTIONS 里的）
   * @returns {Promise<{ok:boolean, count?:number, offline?:boolean, error?:string}>}
   */
  async function changeCollection(id) {
    const coll = String(id || '').trim();
    if (!coll) {
      const error = '词库 id 是空的';
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }
    // ⚠️ 必须校验词库 id 是**认识的**。
    // loadCollection() 对不认识的 id 不会报错，它会返回四级种子词、
    // 只是把 id 前缀换掉（见 library.mjs 的 seedFor）→ 于是"换库成功"是假的：
    // 界面上说成功、设置里写了新 id，实际背的还是四级那批词换个名字。
    // 这类"不认识的输入被默许"正是这一串 bug 的共同病根。
    const known = Object.keys(L.COLLECTIONS || {});
    if (known.length && !known.includes(coll)) {
      const error = `没有「${coll}」这个词库`;
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }
    if (coll === (state.settings.collections?.[0] || '')) {
      // 选的还是当前这本：不重建，免得把正在背的那一轮清掉
      state.lastLibraryChange = { ok: true, unchanged: true, at: now() };
      emit();
      return { ok: true, count: (state.words || []).length, unchanged: true };
    }

    // 词表可能来自网络；失败不能把状态搞坏，所以先加载、成功了再改设置。
    let res;
    try {
      res = await L.loadCollection(coll, { fetcher: ports.fetcher, cache: cachePort() });
    } catch (e) {
      const error = (e && e.message) || '词库加载失败';
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }
    if (!res || !Array.isArray(res.words) || !res.words.length) {
      const error = '这个词库里没有词';
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }

    state.settings = normalizeSettings({ ...state.settings, collections: [coll] });
    state.words = mergePersonal(res.words, state.personal);
    // 只对新词库的词补记忆种子；已有记忆原样保留（换库不该清掉学习记录）
    state.mem = L.seedMemories(state.words, state.mem, now());
    state.offline = res.offline;
    state.banner = res.banner;
    state.librarySource = res.source;
    // 换库结果要能被**重绘正确地渲染出来**，不能只写在 DOM 上：
    // buildContainer() 会 emit() → 整页重建，临时写进 DOM 的提示会被冲掉。
    state.lastLibraryChange = { ok: true, count: state.words.length, collection: coll, at: now() };

    // 关键的一步：重建今日队列。
    // 这会丢掉当前这一轮（未答完的部分）—— 和改 dailyGoal 的既有行为一致。
    // 换库本质上就是"换一批词"，留着旧队列反而更让人困惑。
    buildContainer();
    persist();
    emit();
    return { ok: true, count: state.words.length, offline: !!res.offline, source: res.source };
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
    restartRound,
    extendRound,
    allowMoreNew,
    rate,
    next,
    undo,
    quiz,
    answerQuiz,
    flagQuestion,
    reportFakeMastery,
    retention,
    updateSettings,
    changeCollection,
    setVacation,
    addPersonal,
    removePersonal,
    acceptProposal,
    dismissProposal,
    beckon,
    hookFor,
    hookPeek,
    refresh: () => {
      const key = Q.dayKey(now());
      // 跨天：新的一天要重新排容器，「自己往后背」的加量次数和本轮卡组也跟着重置。
      // 不重置的话，昨天点了 3 次加量会让今天一开场就是 N+15。
      if (key !== state.dayKey) {
        state.extendCount = 0;
        state.roundItems = null;
        state.dayKey = key;
        state.container = null;
        buildContainer();
        return;
      }
      state.dayKey = key;
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


// ── 收成命名空间（供 UI 层与外部使用）──
const M = { DEFAULT_THETA, DAY_MS, newMemory, features, halfLifeDays, recallProb, strength, isConquered, dueAt, isDue, isWeak, WEAK_THRESHOLD, encode, markQuizCorrect, retentionCurve, estimateMinutes };
const MK = { errorDelta, applyError, pairKey, noteConfusion, flagConfusion, pairsNeedingDrill, activePairs, blacklistedPartners, similarity, ERROR_KIND, classifyError, diagnosis, pickDistractors };
const SEED = { SEED_CET4_RAW: SEED_CET4_RAW, SEED_COLLECTIONS: SEED_COLLECTIONS };
const L = { COLLECTIONS, SOURCES, FIRST_CHUNK, parseWordlist, loadCollection, seedFor, seedMemories, extractWordsFromText, isPureEnglish, contextSentence, SEED_CET4 };
const SP = { speechAvailable, speak, stopSpeaking, speechSupportedLanguages };
const HK = { HOOK_SOURCE, HOOK_MAX_CHARS, buildHook, buildHooks, createHookCache };
const Q = { DAY_START_HOUR, dayKey, dayStartTs, daysBetweenKeys, priorDayKey, containerSize, comebackCopy, buildDailyContainer, explain, badgesFor, emptyState, CHECKIN_RATIO, isCheckedIn, bumpStreak, isPaused, effectiveBaseN, TIER, seededRandom, seededShuffle, shouldBlockNew };
const G = { COMBO_STEPS, comboMult, COMBO_FREEZE_MS, newCombo, stepCombo, freezeCombo, resumeCombo, LEVELS, levelFor, expFor, conqueredCount };
const B = { BECKON, TONE, LONG_GONE_DAYS, SOLID_DAYS, beckonState, comebackLine, shouldRipple };
const S = { RETRY_GAP_MIN, RETRY_GAP_MAX, MODE, RATING, MAX_CONSECUTIVE_NEW, UNDO_WINDOW_MS, QUIZ_ERROR_THRESHOLD, createSession, currentCard, isFinished, coveredCount, submitRating, revealFor, planRetry, insertRetry, advance, ensureNewWordCap, undoLast, buildQuiz, submitQuiz, humanizeConfusion, reportFakeMastery, pauseSession, resumeSession, snapshot, restore };
const A = { createApp };

const VOCAB_CORE = { M, MK, SEED, L, SP, HK, Q, G, B, S, A };

// ═══════════════════════════════════════════════════════════
// core 自检 —— 规格 §14.6 P0 的机器可读版本
// ═══════════════════════════════════════════════════════════
window.__vsCoreSelfTest = function () {
  const out = [];
  const DAY = 86400000;
  let pass = 0, fail = 0;
  const details = [];
  const ok = (cond, label, extra) => {
    if (cond) { pass++; out.push('PASS  ' + label); }
    else {
      fail++;
      out.push('FAIL  ' + label);
      if (extra) details.push('【' + label + '】\n' + String(extra));
    }
  };
  const day = 20260214;

  // ① 日容器铁律：词数 ≤ N，且到期词不可被挤占过多
  (() => {
    const words = L.seedFor('cet4');
    const mem = L.seedMemories(words, {}, day);
    // 造 60 个到期词
    for (let i = 0; i < 60; i++) {
      const id = words[i].id;
      mem[id] = Object.assign({}, mem[id], { lastSeenTs: day - 30 * DAY, encodeCount: 3, correct: 3, e: 1 });
    }
    const c = Q.buildDailyContainer(words, mem, { N: 20, gapDays: 0, balance: 0.5, now: day, collections: ['cet4'] });
    ok(c.items.length <= 20, '日容器不超过 20 词', '实际 ' + c.items.length);
    ok(c.stats.containerSize === 20, '容器大小 = 20');
    ok(c.stats.reviewCount + c.stats.personalCount + c.stats.newCount === c.items.length, '三层配比自洽');
    ok(c.stats.dueTotal > 20, '内部知道到期总数（' + c.stats.dueTotal + '）');
  })();

  // ② 断签越久，容器越小（§6.6 / §7.7）
  ok(Q.containerSize(0, 20) === 20, '断签 0 天 → 20 词');
  ok(Q.containerSize(3, 20) === 20, '断签 1–3 天 → 20 词');
  ok(Q.containerSize(7, 20) === 12, '断签 4–14 天 → 12 词');
  ok(Q.containerSize(20, 20) === 8, '断签 >14 天 → 8 词');

  // ③ 一天分界点是凌晨 4:00（§7.3）
  (() => {
    const t3 = new Date(2026, 1, 14, 3, 30, 0).getTime();
    const t5 = new Date(2026, 1, 14, 5, 0, 0).getTime();
    ok(Q.dayKey(t3) === '2026-02-13', '3:30 算前一天', Q.dayKey(t3));
    ok(Q.dayKey(t5) === '2026-02-14', '5:00 算当天', Q.dayKey(t5));
  })();

  // ④ 连续天数：同日不 +1、不可补签（§7.3）
  (() => {
    let s = Q.bumpStreak({ current: 0, longest: 0, lastDay: null }, '2026-02-10');
    s = Q.bumpStreak(s, '2026-02-10');
    ok(s.current === 1, '同日第二次不 +1', 'current=' + s.current);
    s = Q.bumpStreak(s, '2026-02-11');
    ok(s.current === 2, '隔天 +1');
    s = Q.bumpStreak(s, '2026-02-14');
    ok(s.current === 1, '断签后从 1 重来（不补签）', 'current=' + s.current);
    ok(s.longest === 2, '历史最长保留', 'longest=' + s.longest);
  })();

  // ⑤ 打卡口径：完成容器 ≥60% 即算（§7.3）
  ok(Q.isCheckedIn(12, 20) === true, '12/20 算打卡');
  ok(Q.isCheckedIn(11, 20) === false, '11/20 不算打卡');

  // ⑥ 错误计数：忘了 +1，假掌握 +2（§5.4）
  ok(MK.errorDelta({ rating: 'forgot' }) === 1, '自评「忘了」+1');
  ok(MK.errorDelta({ rating: 'known', fakeMastery: true }) === 2, '假掌握 +2');
  ok(MK.errorDelta({ rating: 'known', fakeMastery: false }) === 0, '真会了不加错频');

  // ⑦ 同轮重训：绝不立刻重问，间隔必须落在 3–8 张（§5.5）
  (() => {
    const words = L.seedFor('cet4').slice(0, 20);
    const mem = L.seedMemories(words, {}, day);
    const items = words.map((w, i) => ({ word: w, mem: mem[w.id], tier: i % 3 === 0 ? 3 : 1, reason: null }));
    const s = S.createSession({ items, stats: { containerSize: 20 }, dayKey: '2026-02-14' }, { words, mem, now: day });
    const card = S.currentCard(s);
    const plan = S.planRetry(s, card, 'forgot', day);
    ok(plan.action === 'retry', '「忘了」触发同轮重训');
    ok(plan.gap >= 3 && plan.gap <= 8, '重训间隔在 3–8 张内（' + plan.gap + '）');
    const at = s.queue.findIndex((c) => c.isRetry && c.word.id === card.word.id);
    ok(at > s.cursor + 1, '重训卡不是紧挨着下一张', '插入位置 ' + at + '，当前 ' + s.cursor);
  })();

  // ⑧ 连续新词守卫（§5.2）—— 分三个用例：机制、可调上限、以及「拆不动时不撒谎」
  (() => {
    const mk = (spec) => {
      const words = L.seedFor('cet4').slice(0, spec.length);
      const mem = L.seedMemories(words, {}, day);
      const items = spec.map((tier, i) => ({ word: words[i], mem: mem[words[i].id], tier, reason: null }));
      return S.createSession({ items, stats: { containerSize: spec.length }, dayKey: '2026-02-14' },
        { words, mem, now: day });
    };
    const runOf = (s) => {
      let run = 0, max = 0;
      for (const c of s.queue) {
        if (c.tier === 3 && !c.isRetry) { run++; max = Math.max(max, run); }
        else run = 0;
      }
      return max;
    };
    // 把守卫的判定函数暴露给测试，避免测试自己重写一遍逻辑（重写就测不到真东西）
    const isNewCard = globalThis.__VS_isNewCard;

    const mark = (s) => s.queue.map((c) => (isNewCard(c) ? 'N' : 'R')).join('');
    const readout = (s) => s.queue.map((c) => (isNewCard(c) ? '新' : '复')).join(' ');

    // 用例 A：2 个复习词 + 4 个新词，上限 2 → 需要 1 个间隔，够用。
    // 注意：createSession 自己就会跑一次守卫，所以这里拿到的队列已经整理过了。
    const sA = mk([1, 1, 3, 3, 3, 3]);
    ok(sA.queue.length === 6, '队列长度正确（' + sA.queue.length + '）');
    ok(/(N{3,})/.test(mark(sA)) === false, '开局守卫已把连续新词压到 ≤2（' + mark(sA) + '）');
    ok((mark(sA).match(/R/g) || []).length === 2, '复习词一张不多一张不少（' + mark(sA) + '）');
    const rA = S.ensureNewWordCap(sA, 2);
    ok(runOf(sA) <= 2, '再跑一次守卫仍然 ≤2（实测 ' + runOf(sA) + '）', '结果 ' + readout(sA));
    ok(sA.queue.length === 6, '拆卡是重排而不是丢失卡片（仍 ' + sA.queue.length + ' 张）');
    ok(new Set(sA.queue).size === 6, '拆卡不产生重复卡片（' + new Set(sA.queue).size + ' 张唯一）');

    // 用例 B：上限参数生效 —— 收到 1 就不许出现两个连续新词
    // （4 个复习词 + 4 个新词，上限 1 需要 3 个间隔，刚好够）
    const sB = mk([1, 1, 1, 1, 3, 3, 3, 3]);
    const rB = S.ensureNewWordCap(sB, 1);
    ok(rB.applied === true, '上限=1 时守卫确实动了队列（实插 ' + rB.moved + ' 张）', '结果 ' + readout(sB));
    ok(runOf(sB) <= 1, '上限=1 → 连续新词 ≤1（实测 ' + runOf(sB) + '）', '结果 ' + readout(sB));
    ok(new Set(sB.queue).size === 8, '上限=1 也不产生重复卡片（' + new Set(sB.queue).size + ' 张唯一）');

    // 用例 D：已走过的部分不许被改动（用户看过的历史不能变）
    (() => {
      const sD = mk([1, 3, 3, 3, 3, 3, 1, 3]);
      sD.cursor = 3; // 假装已经答完前 3 张
      const head = sD.queue.slice(0, 3);
      S.ensureNewWordCap(sD, 2);
      const headAfter = sD.queue.slice(0, 3);
      ok(headAfter.every((c, i) => c === head[i]), '已走过的 3 张卡一字未动');
      ok(sD.queue.length === 8, '重塑后总数不变（' + sD.queue.length + ' 张）');
      ok(new Set(sD.queue).size === 8, '重塑后无重复卡（' + new Set(sD.queue).size + ' 张唯一）');
      // 统计 cursor 之后的最大连续新词
      let run = 0, max = 0;
      for (let i = 3; i < sD.queue.length; i++) {
        if (isNewCard(sD.queue[i])) { run++; max = Math.max(max, run); } else run = 0;
      }
      ok(max <= 2, 'cursor 之后连续新词 ≤2（实测 ' + max + '）');
    })();

    // 用例 C：全是新词时不许撒谎 —— 没有复习词可插，就该如实报告未生效
    const sC = mk([3, 3, 3, 3, 3, 3, 3, 3]);
    const rC = S.ensureNewWordCap(sC, 2);
    ok(rC.applied === false, '队列里全是新词 → 如实报告「拆不动」');
    ok(runOf(sC) === 8, '拆不动时不篡改队列（仍为 ' + runOf(sC) + '）');
  })();

  // ⑨ 假掌握：错误计数净增 +2（种子词库会预置 e=0.3，所以只断言增量）
  (() => {
    const words = L.seedFor('cet4').slice(0, 20);
    const mem = L.seedMemories(words, {}, day);
    const items = words.map((w) => ({ word: w, mem: mem[w.id], tier: 1, reason: null }));
    const s = S.createSession({ items, stats: { containerSize: 20 }, dayKey: '2026-02-14' }, { words, mem, now: day });
    const card = S.currentCard(s);
    const e0 = s.mem[card.word.id].e;
    S.reportFakeMastery(s, card, 'x', { now: day });
    const e1 = s.mem[card.word.id].e;
    ok(Math.abs((e1 - e0) - 2) < 1e-9, '假掌握后错误计数净增 +2', e0.toFixed(1) + ' → ' + e1.toFixed(1));
  })();

  // ⑩ 「收服」判定必须硬：没在辨词里答对过就不算（§7.5）
  (() => {
    const w = L.seedFor('cet4')[0];
    let m = M.newMemory({ e: 0 }, day);
    m = Object.assign(m, { encodeCount: 9, correct: 9, stability: 20, difficulty: 0, lastSeenTs: day, reactionMs: 1200 });
    ok(M.isConquered(m, day) === false, '强度高但没辨词答对 → 不算收服');
    const m2 = M.markQuizCorrect(m, day);
    ok(M.isConquered(m2, day) === true, '辨词答对后 → 算收服');
    void w;
  })();

  // ⑪ 辨词干扰项必须「真难」（§5.3）
  (() => {
    const words = L.seedFor('cet4');
    const target = words.find((w) => w.word === 'adapt');
    const picks = MK.pickDistractors(target, words, { count: 3, rand: () => 0.5 });
    ok(picks.length === 3, '给出 3 个干扰项', '实际 ' + picks.length);
    const sims = picks.map((p) => MK.similarity(target.word, p.word));
    ok(Math.max.apply(null, sims) >= 0.6, '干扰项里至少有一个形近（最高相似度 ' + Math.max.apply(null, sims).toFixed(2) + '）');
    ok(picks.every((p) => p.id !== target.id), '不把自己当干扰项');
  })();

  // ⑫ 安全阀：同一对被 ⚑ ≥2 次 → 永久拉黑（§5.3）
  (() => {
    let c = {};
    c = MK.flagConfusion(c, 'a', 'b');
    ok(c[MK.pairKey('a', 'b')].blacklisted === false, '标 1 次还不拉黑');
    c = MK.flagConfusion(c, 'a', 'b');
    ok(c[MK.pairKey('a', 'b')].blacklisted === true, '标 2 次永久拉黑');
    const words = L.seedFor('cet4');
    const target = words.find((w) => w.word === 'adapt');
    const partner = words.find((w) => w.word === 'adopt');
    const picks = MK.pickDistractors(target, words, { count: 3, confusions: MK.flagConfusion(MK.flagConfusion({}, target.id, partner.id), target.id, partner.id) });
    ok(!picks.some((p) => p.id === partner.id), '被拉黑的干扰项不再出现');
  })();

  // ⑬ 记忆模型：错得越多，半衰期越短、复现越密
  (() => {
    const good = Object.assign(M.newMemory({ e: 0 }, day), { encodeCount: 6, correct: 6, stability: 4, difficulty: 0.1 });
    const bad = Object.assign(M.newMemory({ e: 6 }, day), { encodeCount: 6, correct: 0, stability: 0, difficulty: 0.9 });
    ok(M.halfLifeDays(good) > M.halfLifeDays(bad), '真会了的半衰期更长',
      M.halfLifeDays(good).toFixed(2) + ' vs ' + M.halfLifeDays(bad).toFixed(2));
    ok(M.recallProb(good, 3) > M.recallProb(bad, 3), '3 天后「会了」的词记得更牢');
  })();

  // ⑭ 保持曲线：按排期走必须优于不管它（§7.5 证据②）
  (() => {
    const words = L.seedFor('cet4').slice(0, 20);
    const mems = words.map((w) => M.newMemory({ e: 1 }, day));
    const cur = M.retentionCurve(mems, { days: 30, now: day });
    const s30 = cur.scheduled[cur.scheduled.length - 1].recall;
    const p30 = cur.passive[cur.passive.length - 1].recall;
    ok(s30 > p30, '30 天后：按排期 > 不管它', s30.toFixed(2) + ' vs ' + p30.toFixed(2));
  })();

  // ⑮ 情绪胶囊：优先级取第一个命中 + 零指责文案（§3.1）
  (() => {
    const first = B.beckonState({ hasRecords: false, streak: {}, gapDays: 0, dueCount: 0 });
    ok(first.state === 'first', '无记录 → 今天第一词', first.state);
    const gone = B.beckonState({ hasRecords: true, streak: { current: 0, longest: 23 }, gapDays: 5, dueCount: 180, containerSize: 12 });
    ok(gone.state === 'longGone', '断签 → 好久不见（优先于欠账）', gone.state);
    ok(gone.label.indexOf('23') >= 0, '用旧荣耀接住：' + gone.label);
    ok(!/落后|欠|还剩|未完成/.test(gone.label), '断签文案零指责');
    const handoff = B.beckonState({ hasRecords: true, streak: { current: 7 }, gapDays: 0, containerSize: 20, containerDone: 5, roundJustFinished: true, streamActive: true });
    ok(handoff.state === 'handoff', '任务在输出 + 刚答完 → 交接态', handoff.state);
    ok(handoff.needsAction === false, '胶囊不要求任何动作');
    const learning = B.beckonState({ hasRecords: true, streak: { current: 7 }, gapDays: 0, session: { cursor: 1, queue: [1, 2, 3] }, streamActive: true });
    ok(learning.state === 'learning', '任务在输出且没答完 → 学词中', learning.state);
  })();

  // ⑯ 词库降级：拉取失败要有种子库顶上，且不阻塞（§4.2）
  ok(L.seedFor('cet4').length > 100, '内置种子词库可用（' + L.seedFor('cet4').length + ' 词）');
  ok(L.seedFor('cet4').every((w) => w.word && w.ipa && w.meaning), '种子词条字段完整');
  ok(L.isPureEnglish('abandon') === true, '纯英文可收藏');
  ok(L.isPureEnglish('这是一个词') === false, '中文不触发收藏');

  // ⑰ 时间只作参考显示，不参与约束（§6.1.1）
  ok(M.estimateMinutes(20) >= 5 && M.estimateMinutes(20) <= 12, '20 词预估约 ' + M.estimateMinutes(20) + ' 分钟');

  // ⑱ UI 层要用的 core API 必须真的挂上了（这类缺失只在切到某个标签页时才炸）
  (() => {
    const need = {
      Q: ['buildDailyContainer', 'containerSize', 'dayKey', 'bumpStreak', 'isCheckedIn'],
      M: ['recallProb', 'strength', 'retentionCurve', 'estimateMinutes', 'isConquered'],
      MK: ['diagnosis', 'pickDistractors', 'similarity', 'activePairs'],
      G: ['levelFor', 'expFor', 'conqueredCount'],
      L: ['seedFor', 'seedMemories', 'extractWordsFromText'],
      B: ['beckonState'],
    };
    const missing = [];
    for (const ns of Object.keys(need)) {
      const bag = VOCAB_CORE[ns];
      if (!bag) { missing.push(ns + '（整个命名空间缺失）'); continue; }
      for (const fn of need[ns]) {
        if (typeof bag[fn] !== 'function') missing.push(ns + '.' + fn);
      }
    }
    ok(missing.length === 0, 'UI 需要的 core API 全部就位', '缺失：' + missing.join(', '));
  })();

  out.unshift('core 自检：' + pass + ' 通过 / ' + fail + ' 失败');
  if (details.length) {
    out.push('');
    out.push('── 失败详情 ──');
    for (const d of details) out.push(d);
  }
  return out;
};

// ═══════════ ui/core-ref.mjs → UI_CORE_REF ═══════════
VOCAB_CORE.UI_CORE_REF = (() => {

// vocab-study / ui / core-ref.mjs
//
// UI 层拿 core 命名空间的**唯一**通道。
//
// 背景：单文件产物把所有文件摊平进同一作用域，ESM 绑定全部消失。所以界面
// 代码不能用 `import * as Q` 拿到命名空间，必须有人在运行时把命名空间交给它。
//
// 这件事之前散在几个地方（「谁记得调 injectCore 谁就对」），结果 demo 调了、
// 插件形态没调：今日页不碰命名空间所以看着正常，一切到设置页就
// “Q.buildDailyContainer is not a function”。现在收成一处：
//
//   · ESM 形态：ui/pages.mjs 自己导入命名空间并 setCore(...)
//   · 摊平形态：构建脚本在 UI 代码之前插一段 setCore({...})（作用域里只有名字）
//
// 两种形态、同一个读法，没有第三种可能。

let CORE = {
  memory: {},
  mistake: {},
  game: {},
  queue: {},
  library: {},
  beckon: {},
  speech: {},
  hook: {},
};

/**
 * 填命名空间。同时接受全名与单字母键 —— demo/构建/测试三处的写法不统一
 * 曾经就是那次静默失败的原因，这里一次兼容掉。
 */
function setCore(input) {
  const c = input || {};
  const pick = (...names) => {
    for (const n of names) if (c[n]) return c[n];
    return null;
  };
  CORE = {
    memory: pick('memory', 'M') || CORE.memory,
    mistake: pick('mistake', 'MK') || CORE.mistake,
    game: pick('game', 'G') || CORE.game,
    queue: pick('queue', 'Q') || CORE.queue,
    library: pick('library', 'L') || CORE.library,
    beckon: pick('beckon', 'B') || CORE.beckon,
    speech: pick('speech', 'SP') || CORE.speech,
    hook: pick('hook', 'HK') || CORE.hook,
  };
  return CORE;
}

/**
 * 读命名空间。每个界面函数调用时读，不缓存成模块级常量（避免早读成空对象）。
 *
 * 键名**只有全名**（memory / mistake / game / queue / library / beckon / speech / hook）。
 * 单字母键（M / Q / …）只在 setCore 的**入参**里被兼容 —— 那是构建产物与
 * ESM 两边的写法差异。读的时候必须写全名：
 *
 *     const { queue: Q } = getCore();   ✅
 *     const { Q } = getCore();          ❌ Q 会是 undefined
 *
 * 后者在设置页炸过一次（previewBalance 里），症状是
 * “Cannot read properties of undefined (reading 'buildDailyContainer')”。
 * tools/build.py 与 tools/build-plugin.py 都会在构建期扫描这种写法并报错。
 */
function getCore() {
  return CORE;
}

return { setCore, getCore };
})();

// ═══════════ ui/dom.mjs → UI_DOM ═══════════
VOCAB_CORE.UI_DOM = (() => {

// vocab-study / ui / dom.mjs
// 极小的 DOM 工具。刻意不引入任何 UI 框架：
// 插件要跟宿主共享一个页面，DOM 越小、依赖越少，越不容易跟 DSH 的样式打架。

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  // 子节点允许嵌套数组，也允许 null/false 这种「条件不成立就什么都不放」的写法
  const append = (c) => {
    if (c === null || c === undefined || c === false || c === true) return;
    if (Array.isArray(c)) {
      for (const inner of c) append(inner);
      return;
    }
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  };
  for (const c of [].concat(children)) append(c);
  return node;
}

const h = el;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function mount(parent, ...nodes) {
  clear(parent);
  const place = (n) => {
    if (n === null || n === undefined || n === false || n === true) return;
    if (Array.isArray(n)) {
      n.forEach(place);
      return;
    }
    if (!(n instanceof Node)) {
      // 这类 bug 的典型后果是整块界面静默不渲染，所以直接点名报出来
      throw new TypeError(
        `mount() 收到了非节点值：${Object.prototype.toString.call(n)} ` +
          `（parent=<${parent.tagName?.toLowerCase() || '?'} class="${parent.className || ''}">）`,
      );
    }
    parent.appendChild(n);
  };
  nodes.forEach(place);
  return parent;
}

/** 只在内容真的变了时才写 DOM —— 避免无谓的重排，也让文本选区不被打断。 */
function setText(node, text) {
  if (!node) return;
  const next = text == null ? '' : String(text);
  if (node.textContent !== next) node.textContent = next;
}

function setClass(node, cls, on) {
  if (!node) return;
  if (on) node.classList.add(cls);
  else node.classList.remove(cls);
}

function toggle(node, on) {
  if (!node) return;
  node.hidden = !on;
}

/** 聚焦到卡片正文（带 tabindex 的容器），不抢输入框焦点。 */
function focusSelf(node) {
  if (!node) return;
  try {
    node.focus({ preventScroll: true });
  } catch {
    /* 忽略 */
  }
}

function prefersReducedMotion() {
  try {
    return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

return { el, h, clear, mount, setText, setClass, toggle, focusSelf, prefersReducedMotion };
})();

// ═══════════ ui/pages.mjs → UI_PAGES ═══════════
VOCAB_CORE.UI_PAGES = (() => {
const el = VOCAB_CORE.UI_DOM.el;
const mount = VOCAB_CORE.UI_DOM.mount;
const clear = VOCAB_CORE.UI_DOM.clear;
const getCore = VOCAB_CORE.UI_CORE_REF.getCore;
const setCore = VOCAB_CORE.UI_CORE_REF.setCore;
// vocab-study / ui / pages.mjs
// 进度页 / 生词本 / 设置页 / 周报。全部只吃 props，不认识 app 内部结构。


// 摊平用的替换是「单行 import」正则，所以这里必须一行一个，别折行。






// core 命名空间统一走 ui/core-ref.mjs 的注册表（那里解释了为什么需要它）。
// ESM 形态下本文件自己填一次；摊平形态下由构建脚本填，读法完全一样。
// 必须写成单行 —— 摊平用整行剥离来去掉它，折行会漏掉。


/** 兼容旧调用点：转发到注册表。 */
function injectCore(core) {
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
function collectionLabel(state) {
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
function renderProgress(root, state, app) {
  const { memory: M, queue: Q, game: G } = getCore();
  clear(root);
  const stats = state.stats;
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
function heatmap(days) {
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
function renderVocab(root, state, app) {
  const { library: L, mistake: MK } = getCore();
  clear(root);
  mount(
    root,
    el('div', { class: 'vs-h2', text: '我的生词本' }),
    el('div', {
      class: 'vs-sub',
      text: '在对话里选中一个纯英文单词 → 悬浮条「加入生词本」。收藏时会顺手抓下它在对话里的那句话当例句。',
    }),
    state.personal && state.personal.length
      ? el(
          'div',
          { class: 'vs-list', style: { marginTop: '8px' } },
          state.personal.map((p) =>
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
function renderSettings(root, state, app) {
  const { library: L, queue: Q } = getCore();
  clear(root);
  const s = state.settings;
  const bal = s.balance;
  const preview = previewBalance(state, app, bal);

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
          const p = previewBalance(state, app, v);
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
      // 于是换库只改了一个字段：state.words 还是老词库的、今日队列还是老的
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
    // 换库结果从**快照**里读（state.lastLibraryChange）：
    // 成功换库会 emit() → 整页重绘，只写 DOM 的提示会被冲掉。
    collectionStatusLine(state.lastLibraryChange),
    el('div', { class: 'vs-sub', text: state.librarySource === 'seed' ? '现在用的是内置词表（离线）' : '词表已缓存到本地，之后永久离线可用' }),

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
function renderWeeklyReport(root, report) {
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

return { injectCore, renderProgress, renderVocab, renderSettings, renderWeeklyReport, heatmap, collectionLabel };
})();

// ═══════════ ui/panel.mjs → UI_PANEL ═══════════
VOCAB_CORE.UI_PANEL = (() => {
const el = VOCAB_CORE.UI_DOM.el;
const mount = VOCAB_CORE.UI_DOM.mount;
const clear = VOCAB_CORE.UI_DOM.clear;
const setText = VOCAB_CORE.UI_DOM.setText;
const focusSelf = VOCAB_CORE.UI_DOM.focusSelf;
const prefersReducedMotion = VOCAB_CORE.UI_DOM.prefersReducedMotion;
const renderProgress = VOCAB_CORE.UI_PAGES.renderProgress;
const renderVocab = VOCAB_CORE.UI_PAGES.renderVocab;
const renderSettings = VOCAB_CORE.UI_PAGES.renderSettings;
const renderWeeklyReport = VOCAB_CORE.UI_PAGES.renderWeeklyReport;
const heatmap = VOCAB_CORE.UI_PAGES.heatmap;
const collectionLabel = VOCAB_CORE.UI_PAGES.collectionLabel;
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


const TABS = [
  ['today', '今日'],
  ['progress', '进度'],
  ['vocab', '生词本'],
  ['settings', '设置'],
];
function createPanel(app, ctx = {}) {
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
    // 分子用 st.covered（覆盖了多少个**不同的词**），不用 session.stats.answered
    // —— 后者数的是"卡"，重训会让 20 个词变成 60，和"词"为单位的分母一除
    // 就是「60/20」。详见 core/app.mjs 里 covered 那段注释。
    const done = st.container?.done ?? (typeof st.covered === 'number' ? st.covered : (st.session ? st.session.stats.answered : 0));
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
          // ② 自己往后背：突破当天计划，每次 +5
          //
          // 闸门关着时**不给这个按钮**。实测过：闸门一关，新词池就被挡住，
          // extendRound 会把容器从 20 扩到 25，但新增词数是 0 —— 按钮点下去
          // 什么也没发生。一个"点了没反应"的按钮比没有按钮更坏，所以这里
          // 直接不显示它，只留下真正有效的那条路（「我还是想继续」）。
          !gate.closed
            ? el('div', { style: { textAlign: 'center' } },
                el('button', { class: 'vs-btn', onclick: () => app.extendRound(5) }, '再来 5 个新词'))
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
    return (
      `<svg class="vs-ring" viewBox="0 0 48 48" aria-hidden="true">` +
      `<circle class="track" cx="24" cy="24" r="${R}"/>` +
      `<circle class="arc" cx="24" cy="24" r="${R}" ` +
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
        el('span', { class: 'lbl', text: '这半个月' }),
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

return { createPanel };
})();

// ═══════════ ui/capsule.mjs → UI_CAPSULE ═══════════
VOCAB_CORE.UI_CAPSULE = (() => {
const el = VOCAB_CORE.UI_DOM.el;
const setText = VOCAB_CORE.UI_DOM.setText;
const prefersReducedMotion = VOCAB_CORE.UI_DOM.prefersReducedMotion;
// vocab-study / ui / capsule.mjs
// 情绪胶囊：输入框工具栏里那一格。
//
// 规格 §2.3 的落点是 conversation.input.right（模型选择器正前方）。
// 这个组件只认 props：{ label, tone, visible }。
// 它不要求任何动作 —— 像同伴轻轻说一句，不是系统弹窗（§3.2）。
function createCapsule(ctx = {}) {
  const root = el('button', {
    class: 'vs vs-capsule',
    type: 'button',
    title: '今日背单词',
    'aria-label': '今日背单词',
    dataset: { tone: 'fresh' },
  });
  const dot = el('span', { class: 'vs-cap-dot' });
  const label = el('span', { class: 'vs-cap-label' });
  root.append(dot, label);

  let lastState = null;
  let rippleTimer = null;

  root.addEventListener('click', () => ctx.onToggle?.());

  function render(b) {
    if (!b) return;
    root.hidden = b.visible === false;
    root.dataset.tone = b.tone?.key || 'fresh';
    if (b.tone?.textColor) root.style.color = '';
    setText(label, b.label || '');

    // 达成时一次轻微涟漪，3 秒后沉静（§5.1：一轮结束不做全屏庆祝）
    const justDone = b.state === 'done' && lastState !== 'done';
    if (justDone && !prefersReducedMotion()) {
      root.dataset.ripple = '1';
      clearTimeout(rippleTimer);
      rippleTimer = setTimeout(() => {
        root.dataset.ripple = '0';
      }, 900);
    }
    lastState = b.state;
  }

  function destroy() {
    clearTimeout(rippleTimer);
  }

  return { root, render, destroy };
}

return { createCapsule };
})();

// ═══════════ ui/shell.mjs → UI_SHELL ═══════════
VOCAB_CORE.UI_SHELL = (() => {
const createApp = VOCAB_CORE.A.createApp;
const createPanel = VOCAB_CORE.UI_PANEL.createPanel;
const createCapsule = VOCAB_CORE.UI_CAPSULE.createCapsule;
const speak = VOCAB_CORE.SP.speak;
// vocab-study / ui / shell.mjs
// demo 外壳：在浏览器里搭出 DSH 的样子，好让胶囊和面板能真的被点、被看。
//
// 这一层只属于 demo / 预览，不属于插件本体。
// 插件形态下，胶囊由 adapter/dsh/client.js 注册进 conversation.input.right，
// 面板注册进 sidebar.right.pane.tab —— 位置与这里的 DOM 顺序一一对应。




/**
 * 启动 demo。单文件形态下由构建产物末尾调用；ESM 形态下也可直接 import 使用。
 */
async function boot(mountPoint) {
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
  const STREAM_LINES = [
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
      return mem[k] || [];
    },
  };
}

/** 首次打开时补一段「过去 7 天」的记录，好让连续天数与热力图有东西可看。 */
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
  await storage.set('records', records);
  await storage.set('streak', { current: 7, longest: 7, lastDay: dk(now - DAY), totalDays: 7 });
  await storage.set('exp', 268);
  await storage.set('demoSeeded', true);
}

function dk(ts) {
  const d = new Date(ts - 4 * 3600000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

return { boot };
})();

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════
(function () {
  // 顺序有讲究，三个步骤谁都别抢在谁前面：
  //   ① 登记命名空间（依赖 UI_CORE_REF 已建好）
  //   ② 跑 core 自检（要读 ① 的结果，验证界面层真的拿到了命名空间）
  //   ③ 启动外壳
  // 曾经把 ① 塞进自检函数体里，结果自检在 UI_CORE_REF 之前执行，
  // 直接抛 “无法读取 undefined 的 setCore”，把 ③ 一起带走 ——
  // 症状就是外壳 11 项全 FAIL、页面什么都没有。
  VOCAB_CORE.UI_CORE_REF.setCore(VOCAB_CORE);

  const probe = VOCAB_CORE.UI_CORE_REF.getCore();
  window.__vsCoreSelfTest = (function (original) {
    return function () {
      const report = original.apply(this, arguments);
      try {
        const passed = !!probe && !!probe.queue && typeof probe.queue.buildDailyContainer === 'function';
        report.push((passed ? 'PASS ' : 'FAIL ') + '界面层已拿到 core 命名空间（Q.buildDailyContainer 可见）');
      } catch (err) {
        report.push('FAIL 界面层命名空间探针抛错: ' + err.message);
      }
      return report;
    };
  })(window.__vsCoreSelfTest);

  const root = document.getElementById('dsh-root');
  if (root) VOCAB_CORE.UI_SHELL.boot(root);

  // 把命名空间挂一份到 window：浏览器控制台里可以直接敲
  // VOCAB_CORE.queue.dayKey(Date.now()) 查状态，自动化测试也能读到它。
  // （顶层 `const` 在浏览器里是词法绑定，外面的脚本看不见，
  //   所以这里必须显式暴露，不能指望它自己出现。）
  window.VOCAB_CORE = VOCAB_CORE;
})();
