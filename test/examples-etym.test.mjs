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
import { EXAMPLES, EXAMPLES_COVERAGE } from '../core/examples-data.mjs';
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
  if (!Array.isArray(v) || v.length !== 2 || !v[0] || !v[1]) {
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
push('每条都是 [英文, 中文] 两个非空字符串', shapeOk, shapeBad);
push('每条英文都是 3–14 词的完整句子（有句末标点）', sentenceOk, sentenceBad);
push('每条中文都像中文（含汉字、≤40 字）', zhOk, zhBad);
push('中文全部是简体（繁体残留 = 0）', tradOk, tradBad);
push('每条英文例句里真有这个词本身', tokenOk, tokenBad);
push(
  '覆盖率不低于 40%（低于就是数据塌了）',
  exKeys.length / EXAMPLES_COVERAGE.words >= 0.4,
  `${exKeys.length}/${EXAMPLES_COVERAGE.words} = ${((exKeys.length / EXAMPLES_COVERAGE.words) * 100).toFixed(1)}%`,
);

// 同一句例句重复率不能太高（否则等于没给例子）
const uniqSentences = new Set(exKeys.map((k) => EXAMPLES[k][0]));
push(
  '例句重复率 < 5%',
  uniqSentences.size / exKeys.length > 0.95,
  `${exKeys.length - uniqSentences.size} 条重复`,
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
const cet4WithEx = L.seedFor('cet4').filter((w) => w.example);
push('cet4 人工例句仍然在', cet4WithEx.length >= 100, `${cet4WithEx.length} 词`);
push(
  'cet4 人工例句没有被告成英文（exampleZh 都在）',
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
