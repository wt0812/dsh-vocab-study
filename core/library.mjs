// vocab-study / core / library.mjs
// 词库：拉取 → 落缓存 → 永久离线可用；失败则部分降级到内置种子库。
//
// 规格 §4.2 的六条都在这里落地，尤其是第 3 条：
// 「重试 3 次后才降级，且是部分降级：已拉到的批次照常可用，不因后续失败而全量作废」。

import { SEED_CET4_RAW, SEED_COLLECTIONS } from './seed-cet4.mjs';
import { SEED_CET6, SEED_KAOYAN, SEED_TOEFL, SEED_GRE, SEED_IELTS } from './seed-exams.mjs';

export const SEED_CET4 = SEED_CET4_RAW;
export const COLLECTIONS = SEED_COLLECTIONS;

export const FIRST_CHUNK = 20; // 首批 20 词到达即开始学习，不阻塞首卡

/** 词表源：纯词表 + 音标 + 释义，无版权风险（MIT/公共领域的整理版）。
 *
 *  ⚠️ 这里是「切到六级拿到的还是四级词」那个 bug 的另一半。
 *  这些 URL 原来就写着，但**一行都没生效** —— 因为 loadCollection 里
 *  用 `meta.urls || SOURCES[...]` 取源，而 meta.urls 是空数组（真值），
 *  把这里挡住了。现在改成按 .length 判断（见 loadCollection 里的注释）。
 *
 *  各源的真实格式不一样，parseWordlist 必须两种都能吃：
 *    · 单空格：`abandon [əˈbændən] v. 放弃`   ← CET6 / 考研 / GRE
 *    · 多空格：`abandon    [ə'bændən]   vt.  放弃`  ← TOEFL
 *  只按「2+ 空格」切会让 CET6 只解出 7 个词、考研 0 个、GRE 1 个。
 */
export const SOURCES = {
  cet4: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/CET4_edited.txt'],
  cet6: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/CET6_edited.txt'],
  kaoyan: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/NPEE_Wordlist.txt'],
  toefl: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/TOEFL.txt'],
  gre: ['https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/GRE_8000_Words.txt'],
  // 雅思：这批源里**没有**雅思专属词表（IELTS_edited.txt / ielts.txt 都是 404）。
  // 留空 = 断网/取不到时退回内置词表，界面显示「离线模式 · 用内置词表」。
  // 不拿别的词库冒充雅思 —— 那是假数据。
  ielts: [],
};

/** 把各种来源的原始文本解析成统一词条。接受 JSON 数组或每行「词 音标 释义」。
 *
 *  ⚠️ 这里踩过一个会让**五个词库全部失效**的坑，改之前先看这段：
 *
 *  原来只有一种切法：`l.split(/\t|  +/)` —— 按「制表符或**两个以上**空格」切。
 *  而实际词表源的格式并不统一：
 *
 *    TOEFL.txt        abandon           [ə'bændən]            vt.  放弃   ← 多空格 ✅
 *    CET6_edited.txt  abandon [əˈbændən] v. 1. 抛弃，放弃              ← 单空格 ❌
 *    NPEE_Wordlist    abandon [əˈbændən] vt.离弃,丢弃;遗弃,抛弃;放弃     ← 单空格 ❌
 *    GRE_8000_Words   abandon [ə'bændən] v./n.放弃；放纵               ← 单空格 ❌
 *
 *  单空格的切不开 → parts.length === 1 → `return { word: l }` 把**整行**
 *  当成一个单词，然后被第 47 行的 `/^[A-Za-z][A-Za-z '-]*$/` 判掉。
 *  实测后果：CET6 那一万多个字符只解析出 **7 个词**，GRE 出 **1 个**，
 *  考研 **0 个**。界面不报错，只是词表空的。
 *
 *  现在改成**优先用 `[...]` 音标括号定位**（上面四个源全都有方括号音标，
 *  这是这批词表最稳的共同特征）：括号前是词，括号里是音标，括号后是释义。
 *  没有方括号时才退回原来的分隔符切法。
 */
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
      .map(parseTextLine);
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

/**
 * 解析一行文本词条。**优先用 `[...]` 音标括号切开**（见 parseWordlist 上方注释，
 * 单空格格式的源靠这个才解得出来）；没有方括号时退回「制表符 / 2+ 空格」切法。
 */
function parseTextLine(l) {
  const m = String(l).match(/^([A-Za-z][A-Za-z'’.\- ]*?)\s*[\[［]([^\]］]*)[\]］]\s*(.*)$/);
  if (m) {
    const word = m[1].trim();
    // 词后面还可能跟着序号之类的东西，取第一个词
    const first = word.split(/\s+/)[0];
    return { word: first, ipa: m[2].trim(), meaning: m[3].trim() };
  }
  // 兼容「word /ipa/ pos. meaning」与制表符分隔
  const parts = String(l).split(/\t|  +/).filter(Boolean);
  if (parts.length >= 2) return { word: parts[0], ipa: parts[1], meaning: parts.slice(2).join(' ') };
  return { word: l };
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
  // ⚠️ 这里原来是 `meta.urls || SOURCES[collection] || []`，是个**静默 bug**：
  // `urls` 是空数组 `[]`，而空数组是**真值**，所以 `||` 永远不会落到 SOURCES。
  // 后果：SOURCES 里那两个 URL 一行都没生效，六个词库全部走内置种子。
  // 实测证据（已修）：cet6 返回 116 个词、source='seed'，
  // 而且那 116 个词和 cet4 **完全相同** —— 切到六级拿到的就是四级词。
  // 必须用 .length 判断，不能靠真值。
  const urls = (meta.urls && meta.urls.length) ? meta.urls : (SOURCES[collection] || []);
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

/** 内置种子库（离线降级 + 首屏立刻可用）。
 *
 *  ⚠️ 这里原来是这么写的：
 *
 *      if (collection === 'cet4') return dedupeById(SEED_CET4_RAW);
 *      return dedupeById(SEED_CET4_RAW).map(w => ({ ...w, id: `${collection}:${w.word}` }));
 *
 *  也就是**把四级那 120 个词换个 id 前缀，就当成六级/考研/雅思/托福/GRE**。
 *  后果不是"报错"，是**静默给错东西**：用户切到雅思，看到的是四级词；
 *  而且 id 前缀一变，原来那些词的学习记忆全部对不上号了。
 *  这是比"词表为空"更坏的情况 —— 空的用户知道不对，假的用户不知道。
 *
 *  现在每个词库都有自己的内置词表（core/seed-*.mjs，由 tools/make-seeds.mjs
 *  从公开词表生成）。取不到远程源时退到这里，词是真的，只是数量少。
 */
const SEED_BY_COLLECTION = {
  cet4: SEED_CET4_RAW,
  cet6: SEED_CET6,
  kaoyan: SEED_KAOYAN,
  ielts: SEED_IELTS,
  toefl: SEED_TOEFL,
  gre: SEED_GRE,
};

export function seedFor(collection = 'cet4') {
  const raw = SEED_BY_COLLECTION[collection];
  if (!raw || !raw.length) return [];
  // seed-cet4.mjs 是对象数组，seed-exams.mjs 是 [单词, 音标, 释义] 三元组数组
  // （三元组省体积，1.6MB 的文件里这个差别很实在）。这里统一成对象。
  const norm = raw.map((w) => {
    if (Array.isArray(w)) {
      const [word, ipa, meaning] = w;
      return { word, ipa: ipa || '', meaning: meaning || '' };
    }
    return w;
  });
  return dedupeById(
    norm.map((w) => ({ ...w, id: `${collection}:${w.word}`, collection: w.collection || collection }))
  );
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
