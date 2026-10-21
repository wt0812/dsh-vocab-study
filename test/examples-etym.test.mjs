// vocab-study / test / examples-etym.test.mjs
//
// 例句（Tatoeba，CC BY 2.0）+ 词源（Wiktionary，CC BY-SA 4.0）：数据表自洽 + 查询层
// 行为 + 数据层接线。
//
//   node test/examples-etym.test.mjs
//
// 这个套件守的核心还是**诚实**，只是换了个数据源：
//   · 例句必须是真句子（≥3 词、有句末标点、含目标词），不是从词表里拼出来的
//   · 中文必须是简体，且不能是空的
//   · 词源必须能分清「构词拆解」和「只追到来源」—— 混在一起就是骗人
//   · 查不到就返回 null，界面上整块不显示，绝不硬编
//   · 两个入口（远程词表 / 内置种子词库）都得补上 —— 这是词根功能真实踩过的坑

import * as RT from '../core/roots.mjs';
import * as L from '../core/library.mjs';
import { SEED_CET4_RAW } from '../core/seed-cet4.mjs';
import { EXAMPLES, EXAMPLES_COVERAGE } from '../core/examples-data.mjs';
import { EXAMPLES_WIKI, EXAMPLES_WIKI_COVERAGE } from '../core/examples-wiki-data.mjs';
import { ETYM, ETYM_COVERAGE } from '../core/etym-data.mjs';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let pass = 0;
let fail = 0;
const failures = [];

function push(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`${GREEN}  ✓ ${name}${OFF}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`${RED}  ✗ ${name}${OFF}${detail ? `  ${DIM}(${detail})${OFF}` : ''}`);
  }
}

console.log('vocab-study · 例句与词源\n');

const HAN = /[\u4e00-\u9fff]/;
// 常见繁体字（只用来抓"繁转简漏了"，不追求完备）
const TRAD = /[個這們時間說對應該國學與為實現點麼裡東車錢來後會開關問題經過發現]|諮|詢|醫|誤/;
// 词数按**空白**算（和生成器 tools/make-examples.py 的 en.split() 一致）。
// 不能用 [A-Za-z] 抓 token：Tatoeba 里有 `everyone’s` 这种弯引号，
// 一拆就多出一个词，把 14 词上限顶爆（真实误报过一次）。
const wordCount = (s) => s.trim().split(/\s+/).length;
// 判「例句里真有这个词」时把弯引号也算进词内
const WORD_RE = /[A-Za-z][A-Za-z'’\-]*/g;

// ══ ① 例句数据表自洽 ═══════════════════════════════════════════
console.log('① 例句数据表自洽');

const exKeys = Object.keys(EXAMPLES);
push('EXAMPLES 非空', exKeys.length > 0, `${exKeys.length} 词`);
push(
  'EXAMPLES_COVERAGE.withExample 与表长度一致',
  EXAMPLES_COVERAGE.withExample === exKeys.length,
  `表 ${exKeys.length} / 声明 ${EXAMPLES_COVERAGE.withExample}`,
);

let shapeOk = true;
let shapeBad = '';
let sentenceOk = true;
let sentenceBad = '';
let zhOk = true;
let zhBad = '';
let tradOk = true;
let tradBad = '';
let tokenOk = true;
let tokenBad = '';
for (const k of exKeys) {
  const v = EXAMPLES[k];
  // 译文允许 null：语料里没配对译文时**只给英文**，绝不给假翻译。
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || !v[0]) {
    shapeOk = false;
    shapeBad = k;
    break;
  }
  if (v[1] !== null && (typeof v[1] !== 'string' || !v[1])) {
    shapeOk = false;
    shapeBad = k;
    break;
  }
  const [en, zh] = v;
  const words = en.match(WORD_RE) || [];
  if (wordCount(en) < 3 || wordCount(en) > 14 || en.length > 100) {
    sentenceOk = false;
    sentenceBad = `${k}: ${en}`;
    break;
  }
  if (!/[.!?]$/.test(en.trim())) {
    sentenceOk = false;
    sentenceBad = `${k}: 没有句末标点 — ${en}`;
    break;
  }
  if (zh === null) continue;
  if (!HAN.test(zh) || zh.length > 40) {
    zhOk = false;
    zhBad = `${k}: ${zh}`;
    break;
  }
  if (TRAD.test(zh)) {
    tradOk = false;
    tradBad = `${k}: ${zh}`;
    break;
  }
  // 例句里必须真有这个词（按单词边界，不是子串）。
  // 注意要把词首尾的引号剥掉：`‘antonym’` 抓出来会是 `antonym’`。
  const norm = (s) => s.toLowerCase().replace(/^[’']+|[’']+$/g, '');
  if (!words.some((w) => norm(w) === k)) {
    tokenOk = false;
    tokenBad = `${k}: ${en}`;
    break;
  }
}
push('每条都是 [英文, 中文或 null]（英文必须非空）', shapeOk, shapeBad);
push('每条英文都是 3–14 词的完整句子（有句末标点）', sentenceOk, sentenceBad);
push('有译文的那部分，中文像中文（含汉字、≤40 字）', zhOk, zhBad);
push('中文全部是简体（繁体残留 = 0）', tradOk, tradBad);

// 台版用词：生成器用的是 OpenCC 的 tw2sp（台版繁体→简体，带地区词替换），
// 不是 t2s。t2s 只换字形，"義大利" → "義大利" 还是台版叫法 —— 用户实测抓到过
// 「Italian → 我是义大利人」，大陆写「意大利」。
const TW_WORDS = ['义大利', '软体', '网路', '记忆体', '脚踏车', '计程车', '萤幕', '硬碟', '程式', '泡面'];
let twOk = true;
let twBad = '';
for (const k of exKeys) {
  const zh = EXAMPLES[k][1];
  if (!zh) continue;
  const hit = TW_WORDS.find((w) => zh.includes(w));
  if (hit) {
    twOk = false;
    twBad = `${k}: ${hit} — ${zh}`;
    break;
  }
}
push('译文里没有台版用词（义大利 / 软体 / 网路 …）', twOk, twBad);

// 译文允许为 null，但声明数字必须和实际一致
const zhCount = exKeys.filter((k) => EXAMPLES[k][1] !== null).length;
push(
  'EXAMPLES_COVERAGE.withZh 与实际一致',
  EXAMPLES_COVERAGE.withZh === zhCount,
  `实际 ${zhCount} / 声明 ${EXAMPLES_COVERAGE.withZh}`,
);
push(
  '英文单语通道确实在工作（存在 null 译文的条目）',
  zhCount < exKeys.length,
  `null 译文 ${exKeys.length - zhCount} 条`,
);
push('每条英文例句里真有这个词本身', tokenOk, tokenBad);
push(
  '覆盖率不低于 85%（现在实测 91.6%，掉下来就是数据塌了）',
  exKeys.length / EXAMPLES_COVERAGE.words >= 0.85,
  `${exKeys.length}/${EXAMPLES_COVERAGE.words} = ${((exKeys.length / EXAMPLES_COVERAGE.words) * 100).toFixed(1)}%`,
);

// 同一句例句重复率不能太高（否则等于没给例子）
const uniqSentences = new Set(exKeys.map((k) => EXAMPLES[k][0]));
push(
  '例句重复率 < 5%',
  uniqSentences.size / exKeys.length > 0.95,
  `${exKeys.length - uniqSentences.size} 条重复`,
);

// ══ ①-b Wikipedia 补的例句 ═════════════════════════════════════
// 这是「例句」的第二来源：Tatoeba 里一次都没出现的词，从 Simple English
// Wikipedia 里捞一句真句子。**只有英文，没有译文** —— 语料里没有配对，
// 编一句中文就是假数据。
console.log('\n①-b Wikipedia 补的例句（CC BY-SA 4.0）');

const wkKeys = Object.keys(EXAMPLES_WIKI);
push('EXAMPLES_WIKI 非空（Tatoeba 挖不到的词确实补上了）', wkKeys.length > 0, `${wkKeys.length} 词`);

let wkShapeOk = true;
let wkShapeBad = '';
let wkSentOk = true;
let wkSentBad = '';
let wkNoneInTat = true;
let wkNoneBad = '';
let wkTokenOk = true;
let wkTokenBad = '';
for (const k of wkKeys) {
  const v = EXAMPLES_WIKI[k];
  // 形状：只有一句英文（长度 1），没有中文占位
  if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== 'string' || !v[0]) {
    wkShapeOk = false;
    wkShapeBad = k;
    break;
  }
  const en = v[0];
  // 和 Tatoeba 那份同一个排版约束：3~14 词、≤100 字符、有句末标点
  if (wordCount(en) < 3 || wordCount(en) > 14 || en.length > 100 || !/[.!?]$/.test(en.trim())) {
    wkSentOk = false;
    wkSentBad = `${k}: ${en}`;
    break;
  }
  // 不许出现汉字（这一份没有译文，混进汉字就是串了）
  if (HAN.test(en)) {
    wkSentOk = false;
    wkSentBad = `${k}: 中文混进英文例句 — ${en}`;
    break;
  }
  // 只补 Tatoeba 没有的词：已有的词绝不能被覆盖（覆盖 = 丢掉译文）
  if (EXAMPLES[k]) {
    wkNoneInTat = false;
    wkNoneBad = k;
    break;
  }
  // 例句里必须真有这个词（允许复数/词尾变化）
  const norm = (x) => x.toLowerCase().replace(/^[’']+|[’']+$/g, '');
  const toks = (en.match(WORD_RE) || []).map(norm);
  const infl = ['s', 'es', 'ed', 'd', 'ing'];
  const hitIt = toks.some((t) => t === k || (t.startsWith(k) && infl.includes(t.slice(k.length))));
  if (!hitIt) {
    wkTokenOk = false;
    wkTokenBad = `${k}: ${en}`;
    break;
  }
}
push('每条都是 [英文句]（只有英文，没有假译文）', wkShapeOk, wkShapeBad);
push('每条英文都是 3–14 词的完整句子，且不含汉字', wkSentOk, wkSentBad);
push('只补 Tatoeba 没有的词（绝不覆盖已有译文）', wkNoneInTat, wkNoneBad);
push('每条英文里真有这个词本身（允许词尾变化）', wkTokenOk, wkTokenBad);
push(
  'EXAMPLES_WIKI_COVERAGE.words 与实际一致',
  EXAMPLES_WIKI_COVERAGE.words === wkKeys.length,
  `实际 ${wkKeys.length} / 声明 ${EXAMPLES_WIKI_COVERAGE.words}`,
);
// 查询层必须真的回退到它：随便拿一个 wiki 独有的词，examplesOf 要返回那句英文
const wkProbe = wkKeys[0];
const wkHit = RT.examplesOf(wkProbe);
push(
  `查询层回退到 Wikipedia 例句（${wkProbe}）`,
  Array.isArray(wkHit) && wkHit[0] === EXAMPLES_WIKI[wkProbe][0],
  JSON.stringify(wkHit),
);

// ══ ② 词源数据表自洽 ═══════════════════════════════════════════
console.log('\n② 词源数据表自洽');

const etKeys = Object.keys(ETYM);
push('ETYM 非空', etKeys.length > 0, `${etKeys.length} 词`);

let kindOk = true;
let kindBad = '';
let splitOk = true;
let splitBad = '';
let originOk = true;
let originBad = '';
let splitCount = 0;
let originCount = 0;
for (const k of etKeys) {
  const v = ETYM[k];
  if (!Array.isArray(v) || v.length !== 2 || !v[1]) {
    kindOk = false;
    kindBad = k;
    break;
  }
  const [kind, text] = v;
  if (kind === 'split') {
    splitCount++;
    // 真拆解必须能看出是几个词素拼的
    if (!text.includes('+')) {
      splitOk = false;
      splitBad = `${k}: ${text}`;
      break;
    }
  } else if (kind === 'origin') {
    originCount++;
    if (!/来自|←|词根/.test(text)) {
      originOk = false;
      originBad = `${k}: ${text}`;
      break;
    }
  } else {
    kindOk = false;
    kindBad = `${k}: 未知类型 ${kind}`;
    break;
  }
}
push('每条都是 [类型, 文本]，类型只有 split / origin', kindOk, kindBad);
push('split 条目都含 " + "（真的是拆解）', splitOk, splitBad);
push('origin 条目都写成「来自…」或「A ← B」（不冒充拆解）', originOk, originBad);
push(
  'ETYM_COVERAGE 与表一致',
  ETYM_COVERAGE.split + ETYM_COVERAGE.origin === etKeys.length,
  `声明 ${ETYM_COVERAGE.split}+${ETYM_COVERAGE.origin} / 表 ${etKeys.length}`,
);
push(
  '词源覆盖率不低于 60%（低于就是抓取退化了）',
  etKeys.length / ETYM_COVERAGE.words >= 0.6,
  `${etKeys.length}/${ETYM_COVERAGE.words} = ${((etKeys.length / ETYM_COVERAGE.words) * 100).toFixed(1)}%（拆解 ${splitCount} / 来源 ${originCount}）`,
);

// ══ ③ 查询层行为 ═══════════════════════════════════════════════
console.log('\n③ 查询层行为');

const exConsult = RT.examplesOf('consult');
push('examplesOf(consult) 是 [英文, 中文]', Array.isArray(exConsult) && exConsult.length === 2, JSON.stringify(exConsult));
push(
  'examplesOf(consult) 英文里含 consult',
  !!exConsult && exConsult[0].toLowerCase().includes('consult'),
);
push('examplesOf 大小写不敏感', JSON.stringify(RT.examplesOf('Consult')) === JSON.stringify(exConsult));
push('examplesOf 查不到返回 null', RT.examplesOf('zzzznotaword') === null);
push('examplesOf 空值不炸', RT.examplesOf('') === null && RT.examplesOf(null) === null);

const oAbrupt = RT.originOf('abrupt');
push('originOf(abrupt) 是「来源」类型', !!oAbrupt && oAbrupt.kind === 'origin', JSON.stringify(oAbrupt));
push('originOf(abrupt) 说了来自拉丁语', !!oAbrupt && /拉丁/.test(oAbrupt.text), oAbrupt && oAbrupt.text);
const oAbnormal = RT.originOf('abnormal');
push('originOf(abnormal) 是「拆解」类型', !!oAbnormal && oAbnormal.kind === 'split', JSON.stringify(oAbnormal));
push('originOf 查不到返回 null', RT.originOf('zzzznotaword') === null);

// ══ ④ 数据层接线（两个入口都要补）═══════════════════════════════
console.log('\n④ 数据层接线');

const remote = L.parseWordlist('consult [kənˈsʌlt] v. 咨询', 'x', 0);
push('远程词表：consult 自动带上了例句', remote.length === 1 && !!remote[0].example, remote[0] && remote[0].example);
push('远程词表：带上的是真例句（含 consult）', !!remote[0] && /consult/i.test(remote[0].example || ''));
push('远程词表：中文翻译也带上了', !!remote[0] && !!remote[0].exampleZh, remote[0] && remote[0].exampleZh);

const cet6 = L.seedFor('cet6');
const sample = cet6.filter((_, i) => i % 13 === 0).slice(0, 300);
const withEx = sample.filter((w) => w.example).length;
const withEt = sample.filter((w) => w.etym).length;
push(
  '内置词库（cet6）：抽样 300 词里有例句的 ≥ 40%',
  withEx / sample.length >= 0.4,
  `${withEx}/${sample.length} = ${((withEx / sample.length) * 100).toFixed(1)}%`,
);
push(
  '内置词库（cet6）：抽样 300 词里有词源的 ≥ 60%',
  withEt / sample.length >= 0.6,
  `${withEt}/${sample.length} = ${((withEt / sample.length) * 100).toFixed(1)}%`,
);

// cet4 精编那 116 词人工写过例句，**不能被语料覆盖**
//
// ⚠️ 0.3.0 起 cet4 不再只有 116 个手写词：离线词表补了 4,375 个考纲词，
//    它们的例句来自 Tatoeba 语料、有些没有中文译文（exampleZh = null，界面不显示中文）。
//    所以「人工例句/人工译文」这两条断言必须只看手写那批 —— 否则测的还是补全词，
//    真正的回归（手写例句被语料覆盖）反而测不出来。
const HAND4 = new Set(SEED_CET4_RAW.map((w) => String(w.word).toLowerCase()));
const cet4WithEx = L.seedFor('cet4').filter(
  (w) => HAND4.has(String(w.word).toLowerCase()) && w.example,
);
push('cet4 手写例句仍然在（116 词里满编）', cet4WithEx.length >= 100, `${cet4WithEx.length} / ${HAND4.size} 词`);
push(
  'cet4 手写例句的中文译文都在（exampleZh 非空）',
  cet4WithEx.every((w) => typeof w.exampleZh === 'string' && w.exampleZh.length > 0),
);

// 没有数据的词必须**静默**：不编、不报错
const nothing = L.seedFor('cet6').find((w) => !ETYM[w.word.toLowerCase()]);
push(
  '词源表里没有的词，etym 就是 null（不编）',
  !nothing || nothing.etym === null,
  nothing ? nothing.word : '（cet6 里全部词都有词源，未触发）',
);

// 词根和词源是两个字段，不能互相覆盖
const withRoots = L.seedFor('cet6').find((w) => w.roots);
push(
  '有词根的词，roots 与 etym 各自独立',
  !!withRoots && typeof withRoots.roots === 'string' && (withRoots.etym === null || !!withRoots.etym.text),
  withRoots ? withRoots.word : '（没找到）',
);

// 例句、词源都不能破坏词条本身
push(
  '例句/词源不影响 id / word / meaning',
  remote[0].id === 'x:consult' && remote[0].word === 'consult' && /咨询/.test(remote[0].meaning),
  remote[0].id,
);

// ══ 汇总 ═══════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log(`${GREEN}${pass} 通过 / 0 失败${OFF}  （${pass} 组用例）`);
} else {
  console.log(`${RED}${pass} 通过 / ${fail} 失败${OFF}`);
  console.log(`${RED}失败项：${failures.join(' / ')}${OFF}`);
}
console.log(
  `${DIM}实况：例句 ${EXAMPLES_COVERAGE.withExample} / ${EXAMPLES_COVERAGE.words} = ${(
    (EXAMPLES_COVERAGE.withExample / EXAMPLES_COVERAGE.words) * 100
  ).toFixed(2)}%；词源 ${etKeys.length} / ${ETYM_COVERAGE.words} = ${(
    (etKeys.length / ETYM_COVERAGE.words) * 100
  ).toFixed(2)}%（拆解 ${ETYM_COVERAGE.split} · 来源 ${ETYM_COVERAGE.origin}）${OFF}`,
);
console.log('─'.repeat(56));
process.exit(fail === 0 ? 0 : 1);
