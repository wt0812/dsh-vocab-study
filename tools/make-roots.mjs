#!/usr/bin/env node
// 从 ECDICT 的 wordroot.txt 生成 core/roots-data.mjs
//
// ⚠️ 这个脚本**只做核对，不做推断**。
//    它把 ECDICT 明确列在某个词根下的例词，与我们 6 个词库里的词对上号；
//    对不上的就丢掉。绝不因为「这个词看起来像有某个词根」而补一条。
//
// 为什么：给一个词安上它没有的词根，用户看不出来，而且会记住错的东西 ——
// 那比不显示更坏（规格 §9 禁止编造词源）。
//
// 用法：
//   node tools/make-roots.mjs            # 写出 core/roots-data.mjs
//   node tools/make-roots.mjs --audit    # 只打印审计报告，不写文件
//
// 数据源：https://github.com/skywind3000/ECDICT 的 wordroot.txt
//         MIT License, Copyright (c) 2025 Linwei
//         该文件不进仓库（见 .gitignore），生成产物 core/roots-data.mjs 进仓库。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SEED_CET4_RAW, SEED_COLLECTIONS } from '../core/seed-cet4.mjs';
import { SEED_CET6, SEED_KAOYAN, SEED_TOEFL, SEED_GRE, SEED_IELTS } from '../core/seed-exams.mjs';
import { PREFIXES, SUFFIXES, ROOTS, KNOWN_BASE } from './morph-table.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.VOCAB_WORDROOT || join(ROOT_DIR, '_ecdict', 'wordroot.txt');
const OUT = join(ROOT_DIR, 'core', 'roots-data.mjs');
const AUDIT_ONLY = process.argv.includes('--audit');

// ── 词根类别 → 中文标签 + 排序权重 ────────────────────────────────
// 排序决定拆解那一行怎么读。语感上「词根在前、词缀在后」最顺：
//   abstract → tract(draw, pull) + ab-, abs-(from, away from)
// 而不是 ab- + tract + ...
const CLASS_ZH = {
  root: '词根',
  prefix: '前缀',
  'noun-forming suffix': '名词后缀',
  'verb-forming suffix': '动词后缀',
  'adjective-forming suffix': '形容词后缀',
  'adverb-forming suffix': '副词后缀',
  'adjective- and noun-forming suffix': '形容词/名词后缀',
};
const KIND_RANK = {
  词根: 0,
  前缀: 1,
  名词后缀: 2,
  动词后缀: 2,
  '形容词/名词后缀': 2,
  形容词后缀: 3,
  副词后缀: 4,
};

// ── 文本清洗 ─────────────────────────────────────────────────────
/**
 * ECDICT 用数字后缀区分「同形但不同源」的词根条目（`in-2`、`cap1`、`-al1`）。
 * 这些编号是对内的，显示给用户必须去掉。
 * 按**逗号分段**清洗，避免把 `cap1, cip` 清成 `cap, cip` 时误伤。
 */
function rootCleanKey(key) {
  return String(key)
    .split(/[,，]/)
    .map((piece) => piece.replace(/\d+/g, '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * 字典式释义太长（`capable of being, being, doing, or undergoing`）。
 * 取第一个义项；仍超长就按词边界截断加省略号。
 * 上限 42 字符是量出来的：再长就开始把卡片撑宽。
 */
function rootShortMeaning(meaning) {
  let s = String(meaning || '').trim();
  const cut = s.search(/[;；]/);
  if (cut > 0) s = s.slice(0, cut).trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length <= 42) return s;
  const head = s.slice(0, 42);
  const sp = head.lastIndexOf(' ');
  return (sp > 24 ? head.slice(0, sp) : head).replace(/[,;:]\s*$/, '') + '…';
}

// ── 我们词库里的词（本次覆盖率的分母）────────────────────────────
const COLLECTION_ORDER = SEED_COLLECTIONS ? Object.keys(SEED_COLLECTIONS) : ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
const SEED_LIST = {
  cet4: SEED_CET4_RAW.map((w) => w.word),
  cet6: SEED_CET6.map((r) => r[0]),
  kaoyan: SEED_KAOYAN.map((r) => r[0]),
  ielts: SEED_IELTS.map((r) => r[0]),
  toefl: SEED_TOEFL.map((r) => r[0]),
  gre: SEED_GRE.map((r) => r[0]),
};

/** word → Set(词库名)。同时得到去重后的唯一词集合。 */
const WORD_LIBS = new Map();
for (const c of COLLECTION_ORDER) {
  for (const raw of SEED_LIST[c] || []) {
    const w = String(raw ?? '').trim().toLowerCase();
    if (!w) continue;
    if (!WORD_LIBS.has(w)) WORD_LIBS.set(w, []);
    const libs = WORD_LIBS.get(w);
    if (!libs.includes(c)) libs.push(c);
  }
}
const UNIQUE_WORDS = WORD_LIBS.size;
// 注意：WORD_LIBS 只在**生成期**用来判断「这个词在不在我们词库里」，
// 不进产物 —— 界面不需要「这词属于哪几个词库」，带上它会白增约 425 KB。

// ── 读数据源 ─────────────────────────────────────────────────────
if (!existsSync(SOURCE)) {
  console.error(`  ✗ 找不到数据源：${SOURCE}`);
  console.error('');
  console.error('    这个文件**故意不进仓库**（362 KB，而且版权归 ECDICT）。');
  console.error('    需要重新下载到 _ecdict/ 下，方法二选一：');
  console.error('');
  console.error('    A. 浏览器直接打开另存为 _ecdict/wordroot.txt：');
  console.error('       https://raw.githubusercontent.com/skywind3000/ECDICT/master/wordroot.txt');
  console.error('');
  console.error('    B. 走 GitHub Contents API（本机实测 raw.githubusercontent.com 不通时用这个）：');
  console.error('       GET https://api.github.com/repos/skywind3000/ECDICT/contents/wordroot.txt');
  console.error('       返回 JSON 的 content 字段是 base64，解出来写进 _ecdict/wordroot.txt（应是 370,702 字节）');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(SOURCE, 'utf8'));
const rawKeys = Object.keys(raw);

// ── 核对：ECDICT 的例词 ∩ 我们的词库 ─────────────────────────────
const droppedExamples = new Set();
let exampleSlots = 0;

// 先把「例词 → 所属词根条目」反查表建起来，再统一挑要保留的家族。
const families = []; // { key, kind, meaning, origin, members: [] }
for (const rawKey of rawKeys) {
  const entry = raw[rawKey] || {};
  const examples = Array.isArray(entry.example) ? entry.example : [];
  const members = [];
  for (const ex of examples) {
    exampleSlots++;
    const w = String(ex ?? '').trim().toLowerCase();
    // 只认单个英文词：短语（Homo sapiens）和带符号的不收
    if (!/^[a-z][a-z'-]*$/.test(w)) {
      droppedExamples.add(String(ex).trim());
      continue;
    }
    if (!WORD_LIBS.has(w)) {
      droppedExamples.add(String(ex).trim());
      continue;
    }
    if (!members.includes(w)) members.push(w);
  }
  if (!members.length) continue;
  members.sort();
  families.push({
    key: rootCleanKey(rawKey),
    kind: CLASS_ZH[entry.class] || String(entry.class || '词根'),
    meaning: rootShortMeaning(entry.meaning),
    origin: String(entry.origin || '').trim(),
    members,
  });
}

// 排序必须**确定**：同样的输入永远生成同样的字节。
// 否则每次构建产物都有 diff，CI 的「产物是最新的」检查会永远红。
families.sort((a, b) => {
  const ra = KIND_RANK[a.kind] ?? 9;
  const rb = KIND_RANK[b.kind] ?? 9;
  if (ra !== rb) return ra - rb;
  return a.key.localeCompare(b.key, 'en');
});

// ── 反查：词 → 词根家族下标（1-based，和注释里的编号一致）────────
const wordToFamilies = new Map();
families.forEach((f, i) => {
  for (const w of f.members) {
    if (!wordToFamilies.has(w)) wordToFamilies.set(w, []);
    wordToFamilies.get(w).push(i + 1);
  }
});

// 每个词的家族下标按家族顺序排好（families 已排过序，天然是「词根优先」）
const WORD_ROOTS_ENTRIES = [...wordToFamilies.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'));

const covered = WORD_ROOTS_ENTRIES.length;
const withRelatives = WORD_ROOTS_ENTRIES.filter(([w, idxs]) => {
  const f = families[idxs[0] - 1];
  return f && f.members.length > 1;
}).length;

// ── 手写词根词缀表：给 ECDICT 覆盖不到的 75% 补上结构 ─────────────
//
// 背景：ECDICT 的 wordroot.txt 只有 611 条，缺 spect / graph / phon / bio /
// chron / mit / duc 这些最基本的词根，覆盖率只有 25.06%。用户报的
// 「词根词缀太少了，大部分都是没有的」就是这个数据天花板。
//
// 这里用 tools/morph-table.mjs（手写标准构词法表）做一次**切分**：
//   前缀 + 词干  ←→  词根 + 后缀
//
// 宁可少也不要错 —— 切不出可信结构的词，一个字都不显示：
//   · 有词根的解析优先（按「词根长度×2 + 词缀个数」打分，取最高分）；
//   · 只有词缀没有词根时，剩下的词干必须是**已知单词**（reason 不能切成 re+ason）；
//   · 单个词的词根就是它自己、又没有词缀的，不显示（accompany → 词根 accompany 无意义）。
const PREFIX_BY_LEN = [...PREFIXES].sort((a, b) => b[0].length - a[0].length);
const SUFFIX_BY_LEN = [...SUFFIXES].sort((a, b) => b[0].length - a[0].length);

const ROOT_VARIANTS = [];
for (const [key, variants, meaning, origin] of ROOTS) {
  for (const v of String(variants).split(/\s+/).filter(Boolean)) {
    // 2 个字母的「词根」几乎都是巧合（ag 在 agree 里、an 在 anything 里），不要
    if (v.length < 3) continue;
    ROOT_VARIANTS.push({ v, key, meaning, origin });
  }
}
// 长的优先 → 同一个词干上先匹配最具体的长词根
ROOT_VARIANTS.sort((a, b) => b.v.length - a.v.length || a.v.localeCompare(b.v, 'en'));

/** 判断「词干像不像一个真词」用的集合：我们词库 + 高频基础词。 */
const BASE_WORDS = new Set([...WORD_LIBS.keys(), ...KNOWN_BASE.map((w) => w.toLowerCase())]);

function pickPrefix(word) {
  for (const [k, m] of PREFIX_BY_LEN) {
    if (word.length - k.length >= 3 && word.startsWith(k)) return [k, m];
  }
  return null;
}

/** 所有「能切的前缀」都要试。只取最长的会毁掉解析：
 *  absorption 的最长前缀是 abs，但 abs+orption 切不出词根；
 *  ab+sorption=ab+sorp+tion 才对得上 sorb(吸收)。 */
function allPrefixes(word) {
  const out = [];
  for (const [k, m] of PREFIX_BY_LEN) {
    if (word.length - k.length >= 3 && word.startsWith(k)) out.push([k, m]);
  }
  return out;
}

function allSuffixes(rest) {
  const out = [];
  for (const [k, m, kind] of SUFFIX_BY_LEN) {
    if (rest.length - k.length >= 3 && rest.endsWith(k)) out.push([k, m, kind]);
  }
  return out;
}

function pickSuffix(rest) {
  for (const [k, m, kind] of SUFFIX_BY_LEN) {
    if (rest.length - k.length >= 3 && rest.endsWith(k)) return [k, m, kind];
  }
  return null;
}

/** 只有前缀、没有词根时，只认这批「几乎总是真前缀」的（其余前缀和后缀同形，
 *  单靠字面切分会把 reason 切成 re+ason、profit 切成 pro+fit）。 */
const SAFE_PREFIX_ONLY = new Set([
  'un', 'non', 'mis', 'dis', 'pre', 'post', 'over', 'under', 'out', 'anti',
  'auto', 'semi', 'multi', 'mono', 'bi', 'tri', 'uni', 'inter', 'trans',
  'super', 'micro', 'macro', 'hyper', 'fore', 'counter', 'ultra',
]);

/** 只有后缀、没有词根时，只认这些「几乎不会看错」的后缀。
 *  -er/-or/-ar/-en 这类跟普通词尾太像（lower、cumber、slither、riven 全会被误判），
 *  单独出现时一律不报。 */
const RELIABLE_SUFFIX_ONLY = new Set([
  'ability', 'ibility', 'ation', 'ition', 'ution', 'sion', 'tion', 'ance', 'ence',
  'ancy', 'ency', 'ment', 'ness', 'ship', 'hood', 'dom', 'ism', 'ist', 'ity',
  'ety', 'tude', 'ure', 'age', 'ery', 'ory', 'ary', 'ee', 'eer', 'ster', 'let',
  'cy', 'ess', 'ology', 'able', 'ible', 'al', 'ial', 'ical', 'ic', 'ous',
  'ious', 'eous', 'uous', 'ive', 'less', 'ing', 'ed', 'ly', 'wards', 'ize',
  'ise', 'ify', 'fy', 'ant', 'ent', 'est',
]);

/** 在词干里找词根。词根两侧多出来的字母必须能被词缀解释，否则不算。 */
function findRoot(stem, hasPre, hasSuf) {
  for (const r of ROOT_VARIANTS) {
    if (r.v.length > stem.length) continue;
    const L = stem.indexOf(r.v);
    if (L < 0) continue;
    const R = stem.length - L - r.v.length;
    // 光秃秃一个词（没有前后缀可解释残余）时，词根必须**覆盖整词**，
    // 否则 forth 会被 fort(强壮) 吃掉、pennant 会被 enn(年) 吃掉。
    if (!hasPre && !hasSuf) {
      if (L === 0 && R === 0) return r;
      continue;
    }
    // 有词缀：左边只容忍 1 个连接字母；
    // 右边没后缀时只容忍末尾的 e（tribute = tribut + e），
    // 容忍到任意 1 个字母会把 comity 切成 co + mit(送)。
    const leftOk = L === 0 || L === 1;
    const rightOk = R === 0 || (hasSuf && R <= 2) || (R === 1 && stem.endsWith('e'));
    if (leftOk && rightOk) return r;
  }
  return null;
}

/** 词干得像个人话：能还原成一个已知基词。
 *  accommodation 去掉 -ation 剩 accommod，基词是 accommod+ate；
 *  alliance 去掉 -ance 剩 alli，基词是 all+y。 */
function plausibleStem(s, wholeWord) {
  const cands = [
    s, s + 'e', s + 'y', s + 'ate', s + 'ive', s + 'en', s + 'er',
    s + 't', s + 's', s + 'se', s + 'ce',
  ];
  if (s.endsWith('i')) cands.push(s.slice(0, -1) + 'y', s.slice(0, -1) + 'y' + 'e');
  for (const c of cands) {
    if (c === wholeWord) continue; // 「基词就是这个词本身」不算还原
    if (BASE_WORDS.has(c)) return true;
  }
  return false;
}

function analyse(word) {
  if (!/^[a-z]{4,}$/.test(word)) return null;
  // ① 「去掉后缀剩一个真词」精确度最高：commonly = common + ly，
  //    而不是 com + mon(提醒) + ly。必须先于词根匹配。
  const suf1 = pickSuffix(word);
  if (suf1 && RELIABLE_SUFFIX_ONLY.has(suf1[0])) {
    const base = word.slice(0, word.length - suf1[0].length);
    if (base.length >= 3 && plausibleStem(base, word) && BASE_WORDS.has(base)) {
      return { prefix: null, suffix: suf1, root: null, score: 5 };
    }
  }
  // ② 所有「前缀 × 后缀」组合都试一遍，选带词根、且词根最长的那条。
  //    这一步必须在「前缀+真词」捷径之前，否则 distribute 会被 shortcuts 成
  //    只剩 dis（因为 tribute 本身是个词），丢掉 tribut(给予) 这个真词根。
  const candidates = [];
  for (const pre of [...allPrefixes(word), null]) {
    const rest = pre ? word.slice(pre[0].length) : word;
    if (rest.length < 3) continue;
    for (const suf of [...allSuffixes(rest), null]) {
      const stem = suf ? rest.slice(0, rest.length - suf[0].length) : rest;
      if (stem.length < 2) continue;
      const root = findRoot(stem, !!pre, !!suf);
      if (!root) continue;
      // 词根就是整个词、又没有任何词缀 → 没信息量，跳过
      if (!pre && !suf && root.v === word) continue;
      candidates.push({
        prefix: pre,
        suffix: suf,
        root,
        score: root.v.length * 2 + (pre ? 1 : 0) + (suf ? 1 : 0),
      });
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || (a.suffix ? 0 : 1) - (b.suffix ? 0 : 1));
    const best = candidates[0];
    // 若「词干本身就是一个真词」，而词根只是它里面更短的一段，说明切错了：
    // remind 的 stem 是 mind（真词），不能因为里面有个 min 就说是「小」。
    // 但 test 这种「真词且正好是完整词根」的要保留（contest = con + test）。
    const stemOfBest = best.suffix
      ? (best.prefix ? word.slice(best.prefix[0].length) : word).slice(0, -(best.suffix[0].length))
      : best.prefix
        ? word.slice(best.prefix[0].length)
        : word;
    const badShortRoot = BASE_WORDS.has(stemOfBest) && best.root.v.length < stemOfBest.length && best.root.v.length <= 3;
    if (!badShortRoot) return best;
  }
  // ③ 前缀 + 一个独立真词（disagree = dis + agree）—— 没有词根解析时的最佳答案
  const pre0 = pickPrefix(word);
  if (pre0 && BASE_WORDS.has(word.slice(pre0[0].length))) {
    return { prefix: pre0, suffix: null, root: null, score: 3 };
  }
  // ④ 后缀：只认可靠后缀，词干是真词就报（teacher 会被这条筛掉，可接受）
  if (suf1 && RELIABLE_SUFFIX_ONLY.has(suf1[0])) {
    const stem = word.slice(0, word.length - suf1[0].length);
    if (stem.length >= 3 && plausibleStem(stem, word)) return { prefix: null, suffix: suf1, root: null, score: 2 };
  }
  // ⑤ 前缀单独出现：只认高可信那批，且剩下的必须是个真词
  if (pre0 && SAFE_PREFIX_ONLY.has(pre0[0])) {
    const rest = word.slice(pre0[0].length);
    if (rest.length >= 4 && plausibleStem(rest, word)) return { prefix: pre0, suffix: null, root: null, score: 1 };
  }
  return null;
}

// ── 把切分结果收成压缩表：词 → [前缀下标, 词根下标, 后缀下标]（0 = 无）──
const MORPH_TABLE = []; // { k, kind, m }
const morphSeen = new Map();
function morphIdx(k, kind, m) {
  const id = kind + '|' + k;
  if (morphSeen.has(id)) return morphSeen.get(id);
  MORPH_TABLE.push({ k, kind, m });
  morphSeen.set(id, MORPH_TABLE.length);
  return MORPH_TABLE.length;
}

const WORD_MORPH_ENTRIES = [];
let statPrefix = 0;
let statSuffix = 0;
let statTableRoot = 0;
let statAffixOnly = 0;
for (const word of [...WORD_LIBS.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
  const a = analyse(word);
  if (!a) continue;
  // 词根优先用 ECDICT 的（它带「同族词」，界面能连起来看）；
  // 但只有 ECDICT 给了**真正的词根**时才让位 —— 如果 ECDICT 只给了前缀条目
  // （absorb 只有 ab-，没有 sorb），手写表的 sorb(吸收) 就该补上，
  // 否则 absorb 会退化成一行光秃秃的前缀。
  const ecdictIdxs = wordToFamilies.get(word) || [];
  const kindOf = (i) => String(families[i - 1]?.kind || '');
  const hasEcdictRoot = ecdictIdxs.some((i) => !kindOf(i).includes('前缀') && !kindOf(i).includes('后缀'));
  const hasEcdictPrefix = ecdictIdxs.some((i) => kindOf(i).includes('前缀'));
  const hasEcdictSuffix = ecdictIdxs.some((i) => kindOf(i).includes('后缀'));
  const pI = a.prefix && !hasEcdictPrefix ? morphIdx(a.prefix[0], '前缀', a.prefix[1]) : 0;
  const rI = !hasEcdictRoot && a.root ? morphIdx(a.root.v, '词根', a.root.meaning) : 0;
  const sI = a.suffix && !hasEcdictSuffix ? morphIdx(a.suffix[0], '后缀', `${a.suffix[1]}（${a.suffix[2]}）`) : 0;
  if (!pI && !rI && !sI) continue;
  if (pI) statPrefix++;
  if (sI) statSuffix++;
  if (rI) statTableRoot++;
  if (!rI) statAffixOnly++;
  WORD_MORPH_ENTRIES.push([word, pI, rI, sI]);
}
const morphCovered = WORD_MORPH_ENTRIES.length;

// ── 审计报告 ─────────────────────────────────────────────────────
const pct = (n) => ((n / UNIQUE_WORDS) * 100).toFixed(2) + '%';
if (AUDIT_ONLY) {
  console.log('  ══ 词根数据审计（不写文件）══');
  console.log(`  数据源        ${SOURCE}`);
  console.log(`  源文件大小    ${(readFileSync(SOURCE).length / 1024).toFixed(1)} KB`);
  console.log(`  词根条目      ${rawKeys.length} 条`);
  console.log(`  例词位（含重）${exampleSlots}`);
  console.log(`  去重例词      ${new Set(rawKeys.flatMap((k) => (raw[k].example || []).map((e) => String(e).trim().toLowerCase()))).size}`);
  console.log('');
  console.log(`  我们词库唯一词 ${UNIQUE_WORDS}`);
  console.log(`  对得上的家族   ${families.length}`);
  console.log(`  对得上的词     ${covered}  = ${pct(covered)}`);
  console.log(`  有同族词的词   ${withRelatives}  = ${pct(withRelatives)}`);
  console.log(`  被丢掉的例词   ${droppedExamples.size} 个（不在我们词库里）`);
  console.log('');
  const byKind = {};
  for (const f of families) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  console.log('  家族按类别: ' + Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  '));
  const biggest = [...families].sort((a, b) => b.members.length - a.members.length).slice(0, 12);
  console.log('  最大的 12 个家族:');
  for (const f of biggest) console.log(`    ${String(f.members.length).padStart(3)}  ${f.key}  (${f.kind})`);
  const singles = families.filter((f) => f.members.length === 1).length;
  console.log(`  只有 1 个成员的家族: ${singles} / ${families.length}`);
  console.log('');
  console.log('  ── 词根词缀切分（手写表）──');
  console.log(`  有任意词缀/词根   ${morphCovered}  = ${pct(morphCovered)}`);
  console.log(`  带前缀            ${statPrefix}`);
  console.log(`  带后缀            ${statSuffix}`);
  console.log(`  手写表补的词根    ${statTableRoot}`);
  console.log(`  只有词缀没词根    ${statAffixOnly}`);
  console.log(`  合并后总覆盖      ${new Set([...WORD_ROOTS_ENTRIES.map(([w]) => w), ...WORD_MORPH_ENTRIES.map(([w]) => w)]).size}  = ${pct(new Set([...WORD_ROOTS_ENTRIES.map(([w]) => w), ...WORD_MORPH_ENTRIES.map(([w]) => w)]).size)}`);
  console.log(`  压缩表条目        ${MORPH_TABLE.length}`);
  console.log('');
  const sample = process.argv.find((a) => a.startsWith('--sample='));
  if (sample) {
    const want = sample.slice(9).split(',');
    for (const w of want) {
      const a = analyse(w.toLowerCase());
      console.log(
        `    ${w.padEnd(14)} ` +
          (a
            ? [
                a.prefix ? `前缀 ${a.prefix[0]}(${a.prefix[1]})` : '',
                a.root ? `词根 ${a.root.v}(${a.root.meaning})` : '',
                a.suffix ? `后缀 ${a.suffix[0]}(${a.suffix[1]})` : '',
              ]
                .filter(Boolean)
                .join(' + ')
            : '（无）'),
      );
    }
  }
  const rnd = process.argv.find((a) => a.startsWith('--random='));
  if (rnd) {
    const n = Number(rnd.slice(9)) || 40;
    let seed = 20261019;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pool = [...WORD_MORPH_ENTRIES];
    console.log(`    ── 随机抽 ${n} 个（人工核准确率用）──`);
    for (let i = 0; i < n && pool.length; i++) {
      const [w, pI, rI, sI] = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      const parts = [];
      if (pI) parts.push(`前缀 ${MORPH_TABLE[pI - 1].k}(${MORPH_TABLE[pI - 1].m})`);
      if (rI) parts.push(`词根 ${MORPH_TABLE[rI - 1].k}(${MORPH_TABLE[rI - 1].m})`);
      if (sI) parts.push(`后缀 ${MORPH_TABLE[sI - 1].k}(${MORPH_TABLE[sI - 1].m})`);
      console.log(`    ${w.padEnd(16)} ${parts.join(' + ')}`);
    }
  }
  process.exit(0);
}

// ── 写文件 ───────────────────────────────────────────────────────
const banner = `// 词根词缀数据表 —— **由 tools/make-roots.mjs 自动生成，不要手改。**
//
// 数据来源：ECDICT 的 wordroot.txt
//   https://github.com/skywind3000/ECDICT
//   MIT License, Copyright (c) 2025 Linwei
//   完整许可见 docs/third-party/
//
// 生成方式：把 ECDICT **明确列在某个词根下**的例词，与我们 6 个词库里的词
// 对上号；对不上的丢掉。**没有任何推断** —— 查不到的词就是查不到。
//
// 覆盖率（生成时实测）：${covered} / ${UNIQUE_WORDS} 个唯一词有词根 = ${pct(covered)}
// 词根家族：${families.length} 个
//
// 重新生成：
//   node tools/make-roots.mjs --audit   # 只看报告
//   node tools/make-roots.mjs           # 重新生成本文件
`;

const lines = [];
lines.push(banner);
lines.push('/* eslint-disable */');
lines.push('');
lines.push('/** 词根家族。family 里是**我们词库里真实存在**的词，已按字母排序。 */');
lines.push('export const ROOT_FAMILIES = [');
for (const f of families) {
  lines.push(
    `  { key: ${JSON.stringify(f.key)}, kind: ${JSON.stringify(f.kind)}, meaning: ${JSON.stringify(f.meaning)}, origin: ${JSON.stringify(
      f.origin,
    )}, family: [${f.members.map((m) => JSON.stringify(m)).join(', ')}] },`,
  );
}
lines.push('];');
lines.push('');
lines.push('/** 词 → 词根家族下标（1-based，对应 ROOT_FAMILIES 里的位置）。 */');
lines.push('export const WORD_ROOTS = {');
for (const [w, idxs] of WORD_ROOTS_ENTRIES) {
  lines.push(`  ${JSON.stringify(w)}: [${idxs.join(', ')}],`);
}
lines.push('};');
lines.push('');
lines.push('/** 词根/前缀/后缀条目表（手写标准构词法表 + ECDICT 词根）。 */');
lines.push('export const MORPH_TABLE = [');
for (const m of MORPH_TABLE) {
  lines.push(`  { k: ${JSON.stringify(m.k)}, kind: ${JSON.stringify(m.kind)}, m: ${JSON.stringify(m.m)} },`);
}
lines.push('];');
lines.push('');
lines.push('/** 词 → [前缀下标, 词根下标, 后缀下标]（1-based，0 = 无），下标指向 MORPH_TABLE。 */');
lines.push('export const WORD_MORPH = {');
for (const [w, pI, rI, sI] of WORD_MORPH_ENTRIES) {
  lines.push(`  ${JSON.stringify(w)}: [${pI}, ${rI}, ${sI}],`);
}
lines.push('};');
lines.push('');
lines.push('/** 生成时的实测口径，给测试和文档用，免得文案里虚报。 */');
lines.push(`export const ROOTS_COVERAGE = ${JSON.stringify(
  {
    uniqueWords: UNIQUE_WORDS,
    wordsWithRoots: covered,
    families: families.length,
    wordsWithMorph: morphCovered,
    morphEntries: MORPH_TABLE.length,
    prefixCount: statPrefix,
    suffixCount: statSuffix,
    tableRootCount: statTableRoot,
    affixOnlyCount: statAffixOnly,
    combinedCovered: new Set([...WORD_ROOTS_ENTRIES.map(([w]) => w), ...WORD_MORPH_ENTRIES.map(([w]) => w)]).size,
    source: 'ECDICT wordroot.txt (MIT) + tools/morph-table.mjs (手写标准构词法表)',
  },
  null,
  2,
)
  .replace(/\n/g, '\n')};`);
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`  ✅ 写出 ${OUT}`);
console.log(`     ${(readFileSync(OUT).length / 1024).toFixed(1)} KB`);
console.log(`     家族 ${families.length} 个，覆盖 ${covered} / ${UNIQUE_WORDS} = ${pct(covered)}`);
