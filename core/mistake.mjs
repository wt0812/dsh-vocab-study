// vocab-study / core / mistake.mjs
// 错误计数、混淆对、错因诊断句。
//
// 这一层是 DP 的输入质量保障：
//   · 忘了        +1
//   · 假掌握      +2（自评「会了」但揭晓后发现搞混 —— 比「忘了」更危险）
//   · 反应时长    不进错频，只作为遗忘模型参数（规格 §5.4）

/** 一次作答对错误计数的增量。 */
export function errorDelta({ rating, fakeMastery }) {
  if (fakeMastery) return 2; // 假掌握：错误计数 +2
  if (rating === 'forgot') return 1;
  return 0; // 模糊 / 会了 不涨错频（模糊只影响路径与难度）
}

/** 把增量写回记录（纯函数）。 */
export function applyError(rec, delta) {
  return { ...rec, e: Math.max(0, (rec.e || 0) + delta) };
}

/** 两个词的配对键，前后无关：abandon|abundant 与 abundant|abandon 是同一对。 */
export function pairKey(a, b) {
  return [a, b].map(String).sort().join('|');
}

/**
 * 记录一次「把 A 和 B 搞混了」。
 * 混淆对永久记录 → 达到 3 次自动生成对抗专项（规格 §5.3）。
 */
export function noteConfusion(confusions, a, b, now = Date.now()) {
  const key = pairKey(a, b);
  const prev = confusions[key] || { a, b, count: 0, flags: 0, firstTs: now, lastTs: now, blacklisted: false };
  const next = { ...prev, count: prev.count + 1, lastTs: now };
  return { ...confusions, [key]: next };
}

/** 安全阀：用户在题上点了「⚑ 这题有问题」。同一对被标 ≥2 次 → 干扰项永久拉黑（§5.3）。 */
export function flagConfusion(confusions, a, b, now = Date.now()) {
  const key = pairKey(a, b);
  const prev = confusions[key] || { a, b, count: 0, flags: 0, firstTs: now, lastTs: now, blacklisted: false };
  const flags = prev.flags + 1;
  const next = { ...prev, flags, lastTs: now, blacklisted: flags >= 2 };
  return { ...confusions, [key]: next };
}

/** 需要开对抗专项的混淆对（≥3 次，且没被拉黑）。 */
export function pairsNeedingDrill(confusions, threshold = 3) {
  return Object.values(confusions)
    .filter((c) => c.count >= threshold && !c.blacklisted)
    .sort((x, y) => y.count - x.count);
}

/** 用于出干扰项的混淆对：真难，且已被拉黑的绝不再出现。 */
export function activePairs(confusions) {
  return Object.values(confusions).filter((c) => !c.blacklisted);
}

/** 已被永久拉黑的词对（AI 生成的烂题目不许反复回来骚扰）。 */
export function blacklistedPartners(confusions, wordId) {
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
export function similarity(a, b) {
  const sa = skeleton(a);
  const sb = skeleton(b);
  const dist = editDistance(sa, sb);
  return 1 - dist / Math.max(sa.length, sb.length, 1);
}

export const ERROR_KIND = {
  sound: { label: '发音相近', human: '读起来像' },
  shape: { label: '拼写相近', human: '长得像' },
  meaning: { label: '意思相近', human: '意思挨着' },
  unknown: { label: '没记住', human: '没印象' },
  attention: { label: '看错了', human: '看岔了' },
};

/** 单条错误记录 → 错因。 */
export function classifyError(rec, { wordById } = {}) {
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
export function diagnosis(records, { wordById, minErrors = 3 } = {}) {
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
export function pickDistractors(target, pool, { confusions = {}, count = 3, rand = Math.random } = {}) {
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
