// vocab-study / core / library.mjs
// 词库：拉取 → 落缓存 → 永久离线可用；失败则部分降级到内置种子库。
//
// 规格 §4.2 的六条都在这里落地，尤其是第 3 条：
// 「重试 3 次后才降级，且是部分降级：已拉到的批次照常可用，不因后续失败而全量作废」。

import { SEED_CET4_RAW, SEED_COLLECTIONS } from './seed-cet4.mjs';

export const SEED_CET4 = SEED_CET4_RAW;
export const COLLECTIONS = SEED_COLLECTIONS;

export const FIRST_CHUNK = 20; // 首批 20 词到达即开始学习，不阻塞首卡

/** 词表源：纯词表 + 音标 + 释义 + 例句 + 搭配，无版权风险。 */
export const SOURCES = {
  cet4: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/CET4_edited.txt'],
  cet6: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/CET6_edited.txt'],
};

/** 把各种来源的原始文本解析成统一词条。接受 JSON 数组或每行「词 音标 释义」。 */
export function parseWordlist(raw, collection = 'cet4', startSeq = 0) {
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
export async function loadCollection(collection, { fetcher = null, cache = null, retries = 3, onChunk, signal } = {}) {
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
export function seedFor(collection = 'cet4') {
  if (collection === 'cet4') return dedupeById(SEED_CET4_RAW);
  return dedupeById(SEED_CET4_RAW).map((w) => ({ ...w, id: `${collection}:${w.word}`, collection }));
}

/** 给词库种入初始记忆（e=0.3，区分「真会」与「未校准」—— 规格 §5.4）。 */
export function seedMemories(words, existing = {}, now = Date.now()) {
  const mem = { ...existing };
  for (const w of words) {
    if (!mem[w.id]) mem[w.id] = { e: 0.3, difficulty: 0.3, stability: 0, correct: 0, wrong: 0, hintCount: 0, hintRate: 0, reactionMs: 3500, encodeCount: 0, lastSeenTs: now, firstSeenTs: now, lastQuizCorrectTs: null };
  }
  return mem;
}

/** 批量导入：粘贴英文段落自动切词（§10）。 */
export function extractWordsFromText(text) {
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
export function isPureEnglish(sel) {
  const s = String(sel || '').trim();
  if (!s) return false;
  if (s.length > 48) return false;
  return /^[A-Za-z][A-Za-z' -]*$/.test(s);
}

/** 从一段文本中抓取该词所在的句子，作为专属例句（§10）。 */
export function contextSentence(text, word) {
  if (!text || !word) return null;
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/);
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return sentences.find((s) => re.test(s))?.trim().slice(0, 220) || null;
}
