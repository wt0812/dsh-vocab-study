// vocab-study / core / library.mjs
// 词库：拉取 → 落缓存 → 永久离线可用；失败则部分降级到内置种子库。
//
// 规格 §4.2 的六条都在这里落地，尤其是第 3 条：
// 「重试 3 次后才降级，且是部分降级：已拉到的批次照常可用，不因后续失败而全量作废」。

import { SEED_CET4_RAW, SEED_COLLECTIONS } from './seed-cet4.mjs';
import { SEED_CET4_EXTRA_RAW } from './seed-cet4-extra.mjs';
import { SEED_CET6, SEED_KAOYAN, SEED_TOEFL, SEED_GRE, SEED_IELTS } from './seed-exams.mjs';
import { decompose, relativesOf, examplesOf, originOf, collocationsOf } from './roots.mjs';

// 四级词表 = 手写的 116 个词（带人工例句/译文/搭配/词根）+ 考纲补全的 4,375 个词。
// 手写的在前：parseWordlist 按顺序去重，重复的词保留下手写那条。
// 为什么必须补：四级离线词表原来只有手写那 116 个词，agree / arrive / hear /
// spend 这些最基础的四级词**根本不在词表里** —— 用户看到的是「这个词没有例句」，
// 真相是「这个词不存在」。远程词表能补，但断网时就只剩 116 个词。
export const SEED_CET4 = [...SEED_CET4_RAW, ...SEED_CET4_EXTRA_RAW];
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
    // 例句：词表自己带的优先，没有就问 Tatoeba 语料（39% 左右的词能问出真实例句）。
    const tatoeba = withExample(word);
    out.push({
      id: `${collection}:${word.toLowerCase()}`,
      word,
      ipa: r.ipa || r.phonetic || '',
      pos: r.pos || guessPos(r.meaning) || '',
      meaning: r.meaning || r.trans || r.zh || '',
      example: r.example || r.ex || (tatoeba ? tatoeba[0] : null),
      exampleZh: r.exampleZh || (tatoeba ? tatoeba[1] : null),
      // 常见搭配：四级那 116 个手写词优先；其余问语料统计表（10.5% 的词有）。
      collocations: r.collocations?.length ? r.collocations : withColloc(word),
      roots: r.roots || withRoots(word),
      etym: r.etym ?? withEtym(word),
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
 * 例句补充：查不到就是 null（不编）。
 * 包一层 try：数据表坏了不该让整个词库解析失败。
 */
function withExample(word) {
  try {
    return examplesOf(word);
  } catch {
    return null;
  }
}

/**
 * 常见搭配补充（语料统计）：`string[]`，查不到就是空数组。
 *
 * 这是 0.3.0 之前最大的空洞：只有四级那 116 个手写词有搭配（0.4%），
 * 其余 14000 多个词的卡片上根本没有「常见搭配」这一块。
 */
function withColloc(word) {
  try {
    return collocationsOf(word);
  } catch {
    return [];
  }
}

/**
 * 词源补充（Wiktionary）：`{ kind: 'split' | 'origin', text }` 或 null。
 * 这是「词根词缀表拆不出来」时的第二条路，界面上和拆解分开显示。
 */
function withEtym(word) {
  try {
    return originOf(word);
  } catch {
    return null;
  }
}

// ── 词根词缀（数据层接线）──────────────────────────────────────────
//
// 为什么要有这几个函数：`ui/panel.mjs` 的「词根词源」折叠项**早就写好了**，
// 但它只在词条带 `roots` 字段时才出现。而五个考纲词库是
// `[单词, 音标, 释义]` 三元组格式，从来不提供这个字段 ——
// 所以对 98% 以上的词，那个折叠项一直是空的。功能不是没做，是没喂数据。
//
// ⚠️ 必须**两个入口都补**：`parseWordlist`（远程/粘贴的词表）和
//    `seedFor`（内置种子词库）。第一版只补了前者，单测全绿但界面是坏的 ——
//    因为种子词库那条路根本不走 parseWordlist。

/**
 * 词库里自带 `roots` 就用它的（cet4 精编那 120 词人工写过，优先）；
 * 没带就问词根表 —— **查不到就返回 null，不编**。
 */
function withRoots(word) {
  try {
    return decompose(word);
  } catch {
    return null; // 数据表坏了不该让整个词库解析失败
  }
}

/** 词 → 释义 的懒建索引，**直接从原始种子数组建**，不走 seedFor（否则会递归）。 */
let BRIEF_INDEX = null;

function briefIndexOf() {
  if (BRIEF_INDEX) return BRIEF_INDEX;
  BRIEF_INDEX = new Map();
  for (const c of Object.keys(SEED_BY_COLLECTION)) {
    for (const raw of SEED_BY_COLLECTION[c] || []) {
      const w = Array.isArray(raw) ? raw[0] : raw && raw.word;
      const m = Array.isArray(raw) ? raw[2] : raw && raw.meaning;
      const k = String(w ?? '').trim().toLowerCase();
      if (!k || BRIEF_INDEX.has(k)) continue;
      BRIEF_INDEX.set(k, String(m ?? ''));
    }
  }
  return BRIEF_INDEX;
}

/**
 * 同族词列表里用的**短释义**：去掉词性标记、只取第一个义项、超长截断。
 * 折叠项里一行要放下 4–5 个词，释义不能太长。
 */
function briefMeaning(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^\s*(?:[a-z]+\.\s*){1,3}/i, '').trim(); // 去掉开头的 "n." "vt." "a."
  const cut = s.search(/[;；]/);
  if (cut > 0) s = s.slice(0, cut).trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length <= 18) return s;
  const head = s.slice(0, 18);
  const sp = head.lastIndexOf(' ');
  return (sp > 8 ? head.slice(0, sp) : head).replace(/[,，、\s]+$/, '') + '…';
}

/**
 * 同族词：和这个词共享词根的**我们词库里真实存在的**其他词，带短释义。
 *
 * 为什么放在这里而不是 roots.mjs：释义在种子词库里，roots.mjs 是纯数据表查询，
 * 不该反过来依赖 library。分层清楚才不会绕成环。
 *
 * @param {string} word
 * @param {number} [limit=5]
 * @returns {{word: string, meaning: string}[]}
 */
export function familyOf(word, limit = 5) {
  let rel = [];
  try {
    rel = relativesOf(word);
  } catch {
    return [];
  }
  if (!rel.length) return [];
  const idx = briefIndexOf();
  const out = [];
  for (const r of rel) {
    if (out.length >= limit) break;
    out.push({ word: r.word, meaning: briefMeaning(idx.get(r.word) || ''), root: r.root, kind: r.kind });
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
  // 从释义开头的词性标记猜词性。补全的四级词表用的是考纲写法（`vt.` / `vi.` /
  // `a.` / `ad.`），原来只认 n / v / a / ad / adj / adv，于是 707 个词的
  // pos 全是空 —— 界面上词性行空着，「每个词都有词性」自检也会红。
  //
  // 还有几个源文件自己就不干净，只能放宽匹配、不能编词性：
  //   · `n 自行车` / `prep 在…之中`   —— 漏了句点
  //   · `ini.嗨`                     —— 想写 int.
  //   · `(缩作 OK)a.&ad.对`          —— 前面有括号，a. 后面跟 &
  //   · `\uF05D n.闪电`              —— 行首带了个私用区字符（源文件的项目符号）
  const text = String(meaning).replace(/[\uE000-\uF8FF\uFFFD]/g, ' ');
  const m = text.match(
    /(^|[\s()])(n|v|vt|vi|a|ad|adj|adv|prep|conj|pron|num|int|ini|art|aux)(?:\.|\s|&|$)/,
  );
  if (!m) return '';
  const MAP = {
    vt: 'v.', vi: 'v.', v: 'v.', adj: 'adj.', a: 'a.', adv: 'adv.', ad: 'ad.',
    ini: 'int.',
  };
  return MAP[m[2]] || `${m[2]}.`;
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
  cet4: SEED_CET4,
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
    norm.map((w) => {
      // 例句与词源同样要在这里补（理由见下面 roots 那两段注释 —— 同一类坑）：
      // 种子词库这条路不走 parseWordlist，只在那补就等于没补。
      const tatoeba = w.example ? null : withExample(w.word);
      return {
        ...w,
          // 补全的四级词条（seed-cet4-extra）只有 [单词, 音标, 释义] 三元组，没有 pos 字段。
          // 以前只有手写词、pos 是显式写了的，所以没人发现；扩表后 4,375 个词的 pos
          // 全是 undefined —— 界面上词性行空着，「种子词条字段完整」自检也会红。
          // 用和 parseWordlist 同一个 guessPos 兜底，保证两条数据入口字段形状一致。
          pos: w.pos || guessPos(w.meaning),
        // ⚠️ roots 必须在这里补，不能只补在 parseWordlist 里。
        // 这是**真实踩过的坑**：种子词库这条路不走 parseWordlist，
        // 只在那边补的话，界面上「词根词源」折叠项对 5406 个六级词
        // 一个都不会出现（实测 app.state.words 里 roots 字段直接不存在）。
        // 单测因为直接调 parseWordlist，反而看不出来。
        //
        // ⚠️ 第二个坑：`...w` 必须在前、roots 在后。
        // seed-cet4.mjs 的工厂函数给**每一条**都写了 `roots: extra.root ?? null`，
        // 所以没有人工词根的词也带着 `roots: null` 这个键。
        // 把 roots 写在 spread 前面会被它覆盖回 null —— 实测 cet4 只有 43 条有词根，
        // 而正确答案是 79 条（43 人工 + 36 自动匹配）。
        // 用 `??` 而不是 `||`：null / undefined 都兜底，且空串也算「没有」。
        roots: w.roots ?? withRoots(w.word),
        example: w.example ?? (tatoeba ? tatoeba[0] : null),
        exampleZh: w.exampleZh ?? (tatoeba ? tatoeba[1] : null),
        etym: w.etym ?? withEtym(w.word),
        collocations: w.collocations?.length ? w.collocations : withColloc(w.word),
        id: `${collection}:${w.word}`,
        collection: w.collection || collection,
      };
    })
  );
}

/**
 * 按单词拼写查内置词库，拿到音标 / 词性 / 释义。
 *
 * 为什么要有它：用户在对话里划一个词加进生词本、或者批量粘贴一整段英文
 * 收录进来的词，**本来就没带释义** —— 收的时候给的是 `meaning: ''`，
 * 于是生词本里永远显示「（还没释义）」。而内置的 6 个词库（29,841 词）
 * 里本来就带着音标和释义，只是从来没人去查。
 *
 * 关键点：`seedFor()` 读的是打包进产物的种子数据，所以这个查询是
 * **同步、纯离线、零网络**的 —— 不需要等 `init()`，也不需要 await。
 *
 * 查询范围：6 个词库全查（cet4 → cet6 → kaoyan → ielts → toefl → gre 的键序），
 * 一个词在多个考纲里都出现时**按这个顺序取第一次命中**，结果稳定。
 * 找不到就返回 null，调用方负责显示「（还没释义）」并给手填入口。
 *
 * @param {string} word 单词拼写（大小写不敏感，忽略首尾空白）
 * @param {string} [preferCollection] **当前未使用**，保留参数是为了调用方签名稳定。
 *   （曾经想做"优先用当前词库的释义"，但那样同一个词的释义会因为用户在背哪本
 *   而变，生词本里的释义会自己跳变 —— 明确不做，所以也不假装支持。）
 * @returns {{word, ipa, pos, meaning, collection, id}|null}
 */
/**
 * `lookupWord` 的小写拼写 → 词条 索引，首次查词时懒建（见该函数内的说明）。
 * 模块级变量：摊平进产物后就是顶层绑定，整包共享一份。
 */
let LOOKUP_INDEX = null;

export function lookupWord(word, preferCollection = null) {
  const key = String(word ?? '').trim().toLowerCase();
  if (!key || !/^[a-z][a-z'-]*$/.test(key)) return null;

  /*
   * 懒建索引（首次调用时建，之后复用）。
   *
   * 为什么需要：6 个词库一共 29,841 个词，如果每次都线性扫一遍，
   * 批量导入 50 个词就是 50 × 29,841 ≈ 150 万次字符串比较 —— 卡在点击那一帧里。
   * 建一次 Map 是 3 万次插入，之后每次查词就是一次哈希查找。
   *
   * 每个词只留**第一次**命中（顺序就是 COLLECTIONS 的键序），
   * 所以「同一个词在多个考纲里都有」时结果稳定、不会因为查询顺序变化而改释义。
   * 代价是拿不到「这个词在 GRE 里也出现」这类信息 —— 界面不需要，不为此增复杂。
   */
  if (!LOOKUP_INDEX) {
    LOOKUP_INDEX = new Map();
    for (const c of Object.keys(COLLECTIONS)) {
      for (const w of seedFor(c)) {
        const k = String(w.word).toLowerCase();
        if (!LOOKUP_INDEX.has(k)) LOOKUP_INDEX.set(k, { entry: w, collection: c });
      }
    }
  }

  const hit = LOOKUP_INDEX.get(key);
  if (!hit) return null;
  const { entry: w, collection: c } = hit;

  // 种子里的考试词库只有 word/ipa/meaning（没有词性字段），
  // 就从释义开头把「n.」「vt.」这种标记抠出来当 pos。
  const meaning = w.meaning || '';
  const m = meaning.match(/^\s*((?:[a-z]+\.){1,3})\s*/i);
  return {
    word: w.word,
    ipa: w.ipa || '',
    pos: w.pos || (m ? m[1] : ''),
    meaning: (m ? meaning.slice(m[0].length) : meaning).trim() || meaning,
    collection: c,
    id: w.id || `${c}:${w.word}`,
  };
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
