// vocab-study / test / collocations.test.mjs
//
// 常见搭配（Tatoeba 语料按「闭类词结构」统计，CC BY 2.0）：数据表自洽 + 查询层
// + 数据层接线。
//
//   node test/collocations.test.mjs
//
// 这个套件守的是**精度**，不是覆盖率。上一版用「相邻二元组词频」挖出来的东西
// 是这样的：consult → better consult / to consult；fish → fish is / this fish
// （实测精确率约六成，根本写不到卡片上）。这一版只收语法上几乎不可能凑错的
// 结构，所以断言重点全是「不许出现那种垃圾」。

import * as RT from '../core/roots.mjs';
import * as L from '../core/library.mjs';
import { SEED_CET4_RAW } from '../core/seed-cet4.mjs';
import { COLLOCATIONS, COLLOC_COVERAGE } from '../core/colloc-data.mjs';

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

console.log('vocab-study · 常见搭配\n');

// ══ ① 数据表自洽 ═══════════════════════════════════════════════
console.log('① 数据表自洽');

const keys = Object.keys(COLLOCATIONS);
push('COLLOCATIONS 非空', keys.length > 0, `${keys.length} 词`);
push(
  'COLLOC_COVERAGE.withColloc 与表长度一致',
  COLLOC_COVERAGE.withColloc === keys.length,
  `表 ${keys.length} / 声明 ${COLLOC_COVERAGE.withColloc}`,
);

let shapeOk = true;
let shapeBad = '';
let countOk = true;
let countBad = '';
let charsOk = true;
let charsBad = '';
let selfOk = true;
let selfBad = '';
let dupOk = true;
let dupBad = '';
for (const w of keys) {
  const arr = COLLOCATIONS[w];
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > 3) {
    shapeOk = false;
    shapeBad = `${w}: ${JSON.stringify(arr)}`;
    break;
  }
  if (new Set(arr).size !== arr.length) {
    dupOk = false;
    dupBad = `${w}: ${arr.join(' | ')}`;
    break;
  }
  for (const p of arr) {
    if (typeof p !== 'string' || !p.trim()) {
      shapeOk = false;
      shapeBad = `${w}: ${p}`;
      break;
    }
    // 只允许小写字母、空格、连字符和撇号（数据表里不该有标点或中文）
    if (!/^[a-z][a-z'’\- ]*$/.test(p)) {
      charsOk = false;
      charsBad = `${w}: ${p}`;
      break;
    }
    // 每个搭配里都必须真有这个词本身（按词边界，不是子串）
    const toks = p.split(' ');
    if (!toks.includes(w)) {
      selfOk = false;
      selfBad = `${w}: ${p}`;
      break;
    }
    // 至少两个词才算"搭配"
    if (toks.length < 2) {
      countOk = false;
      countBad = `${w}: ${p}`;
      break;
    }
  }
}
push('每条的形态是 1~3 个字符串组成的数组', shapeOk, shapeBad);
push('没有重复项', dupOk, dupBad);
push('只含小写英文与空格', charsOk, charsBad);
push('每个搭配都至少两个词', countOk, countBad);
push('每个搭配里真有这个词本身', selfOk, selfBad);

// ══ ② 精度回归：上一版的垃圾不许回来 ══════════════════════════
console.log('\n② 精度回归（上一版的垃圾形态）');

// 这些词是上一版「相邻词频」的典型受害者。现在要么有正确搭配，要么干脆没有，
// 但**绝不能**出现下面这些形态。
const BAD_SUFFIX = new Set([
  'is', 'are', 'was', 'were', 'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'very', 'too', 'better', 'more', 'most', 'not',
]);

let junkOk = true;
let junkBad = '';
for (const w of keys) {
  for (const p of COLLOCATIONS[w]) {
    const toks = p.split(' ');
    const last = toks[toks.length - 1];
    const first = toks[0];
    // 结尾是系动词/冠词 → 典型的"相邻词频"垃圾（fish is / consult the）
    if (BAD_SUFFIX.has(last) && last !== w) {
      junkOk = false;
      junkBad = `${w}: ${p}`;
      break;
    }
    // 以冠词开头（"a fish"）也不是搭配
    if (['a', 'an', 'the'].includes(first)) {
      junkOk = false;
      junkBad = `${w}: ${p}`;
      break;
    }
  }
  if (!junkOk) break;
}
push('没有「词 + 系动词/冠词」这类假搭配', junkOk, junkBad);

const expect = {
  consult: ['consult with'],
  rely: ['rely on'],
  give: ['give up'],
  responsible: ['be responsible for'],
};
let expOk = true;
let expBad = '';
for (const [w, wanted] of Object.entries(expect)) {
  const got = COLLOCATIONS[w] || [];
  for (const p of wanted) {
    if (!got.includes(p)) {
      expOk = false;
      expBad = `${w}: 期望 ${p}，实际 ${JSON.stringify(got)}`;
      break;
    }
  }
  if (!expOk) break;
}
push('known-good 搭配都在（consult with / rely on / give up / be responsible for）', expOk, expBad);

// 「名词 + 介词」是 0.3.0 新开的结构（access to / solution to / appetite for）——
// 以前这里反过来断言「纯名词不许出现词+介词」，因为那时只有动词渠道。
// 现在结构变了，规则也得换：直接钉住「该有的要有」「已知假搭配不许回来」。
//
// 为什么不再按词性验：名词渠道的闸门是**语料统计**（介词偏好度 ≥60~75% + 裸用占比），
// 测试里拿不到语料计数，只能拿结论做回归。闸门参数改坏会立刻在这两组断言上红。
const NOUN_PREP_MUST = {
  access: 'access to',
  solution: 'solution to',
  appetite: 'appetite for',
  effect: 'effect on',
  increase: 'increase in',
  abbreviation: 'abbreviation for',
  reason: 'reason for',
};
for (const [w, phrase] of Object.entries(NOUN_PREP_MUST)) {
  push(
    `名词+介词：${w} 必须有 ${phrase}`,
    (COLLOCATIONS[w] || []).includes(phrase),
    (COLLOCATIONS[w] || []).join(' / ') || '（没有）',
  );
}

// 已知假搭配：名词只是被地点介词包裹（"go to the gym in the morning" 里的 gym in）。
// 收进来就是噪声，学习者照着背会背错 —— 上一版就漏出过这些。
const NOUN_PREP_JUNK = ['gym to', 'gym in', 'gym on', 'violin as', 'violin in'];
const junkFound = [];
for (const w of keys) {
  for (const p of COLLOCATIONS[w]) {
    if (NOUN_PREP_JUNK.includes(p)) junkFound.push(`${w}: ${p}`);
  }
}
push('名词+介词不收回地点短语（gym to / gym in / violin as）', junkFound.length === 0, junkFound.join('、'));


// ══ ②b 精度探针：一批"人人都知道的搭配"，漏太多就说明挖掘器退化了 ══
//
// 这不是权威金标（谁也没有），但它能抓住两类真实退化：
//   1. 排序 bug —— 真实发生过：`vote for` 出现 234 次（占 48%），却因为
//      「动词+小品词」比「动词+介词」优先级高、`vote in` 被两条结构各算一次，
//      三个名额被 in/on/by（8~30 次）占满，最高频的 for 被挤掉。
//   2. 只做相邻统计 —— `protect sb from` / `accuse sb of` / `spend sth on`
//      介词离动词隔着一个宾语，相邻统计永远抓不到（现在是窗口规则覆盖）。
//
// 词表里没有的词（agree/arrive/hear/spend 这些四级词离线表里根本没有）不算漏，
// 单独列出来提醒：那是**词表缺口**，不是搭配挖掘的问题。
const PROBE = {
  distribute: ['distribute to'],
  compare: ['compare with', 'compare to'],
  protect: ['protect from'],
  accuse: ['accuse of'],
  congratulate: ['congratulate on'],
  translate: ['translate into'],
  vote: ['vote for'],
  deal: ['deal with'],
  insist: ['insist on'],
  prefer: ['prefer to'],
  rely: ['rely on'],
  consult: ['consult with'],
  give: ['give up'],
  responsible: ['be responsible for'],
  depend: ['depend on'],
  belong: ['belong to'],
  consist: ['consist of'],
  apologize: ['apologize for'],
  concentrate: ['concentrate on'],
  contribute: ['contribute to'],
  result: ['result in'],
  benefit: ['benefit from'],
  complain: ['complain about'],
  comply: ['comply with'],
  graduate: ['graduate from'],
  participate: ['participate in'],
  specialize: ['specialize in'],
  escape: ['escape from'],
  focus: ['focus on'],
  recover: ['recover from'],
};
const inWordlist = new Set();
for (const c of ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre']) {
  const rows = c === 'cet4' ? L.parseWordlist(JSON.stringify(L.seedFor(c)), c) : L.seedFor(c);
  for (const w of rows) inWordlist.add(w.word);
}
let probeTotal = 0;
let probeHit = 0;
const probeMiss = [];
for (const [w, list] of Object.entries(PROBE)) {
  if (!inWordlist.has(w)) continue;
  for (const phrase of list) {
    probeTotal++;
    if ((COLLOCATIONS[w] || []).includes(phrase)) probeHit++;
    else probeMiss.push(`${w}: ${phrase}`);
  }
}
const probeRate = probeTotal ? probeHit / probeTotal : 0;
push(
  '常识搭配命中率 ≥ 90%（现在 95%，漏了就是挖掘器退化）',
  probeRate >= 0.9,
  `${probeHit}/${probeTotal} = ${(probeRate * 100).toFixed(0)}% · 漏: ${probeMiss.join('、') || '无'}`,
);
push(
  '排序 bug 回归：vote 的第一条必须是 vote for（高频优先于低频）',
  (COLLOCATIONS['vote'] || [])[0] === 'vote for',
  `实际 ${JSON.stringify(COLLOCATIONS['vote'])}`,
);

// ══ ③ 查询层 ═══════════════════════════════════════════════════
console.log('\n③ 查询层');

push('collocationsOf 查得到', RT.collocationsOf('consult').includes('consult with'));
push('collocationsOf 大小写/空格不敏感', RT.collocationsOf('  CONSULT  ').includes('consult with'));
push('查不到返回空数组（不是 undefined/null）', Array.isArray(RT.collocationsOf('zzzzznotaword')));
push('空输入返回空数组', RT.collocationsOf('').length === 0 && RT.collocationsOf(null).length === 0);
push('返回值是副本语义（改它不影响数据表）', (() => {
  const a = RT.collocationsOf('consult');
  a.push('xxx');
  return !RT.collocationsOf('consult').includes('xxx');
})());

// ══ ④ 数据层接线（两条入口都要通）══════════════════════════════
console.log('\n④ 数据层接线');

const cet4 = L.parseWordlist(JSON.stringify(L.seedFor('cet4')), 'cet4');
const cet6 = L.seedFor('cet6');
push('cet4 手写搭配优先保留（abandon → abandon a plan）', (() => {
  const w = cet4.find((x) => x.word === 'abandon');
  return w && w.collocations.includes('abandon a plan') && w.collocations.includes('with abandon');
})());
push('六级词也补上了搭配（语料表接线生效）', cet6.filter((w) => (w.collocations || []).length > 0).length > 1000,
  `${cet6.filter((w) => (w.collocations || []).length > 0).length} / ${cet6.length}`);
push('内置种子词库这条路也补了（不只是 parseWordlist）',
  cet6.every((w) => Array.isArray(w.collocations)));

// ══ ⑤ 覆盖率闸门 ═══════════════════════════════════════════════
console.log('\n⑤ 覆盖率');
const cov = keys.length / COLLOC_COVERAGE.words;
push('覆盖率不低于 15%（现在实测 21%，掉下来就是生成器坏了）', cov >= 0.15,
  `${keys.length}/${COLLOC_COVERAGE.words} = ${(cov * 100).toFixed(1)}%`);
// 手写那 116 个词是人工配的搭配，覆盖率必须高；补全的 4,375 个词只能靠语料表，
// 拿全量当分母会把这条闸门冲淡（116 → 4,491 之后就不再是"手写覆盖率"了）。
const HAND4 = new Set(SEED_CET4_RAW.map((w) => String(w.word).toLowerCase()));
const handCet4 = cet4.filter((w) => HAND4.has(String(w.word).toLowerCase()));
push('手写四级词覆盖率不低于 60%', (() => {
  const hit = handCet4.filter((w) => (w.collocations || []).length > 0).length;
  return hit / handCet4.length >= 0.6;
})(), (() => {
  const hit = handCet4.filter((w) => (w.collocations || []).length > 0).length;
  return `${hit}/${handCet4.length} = ${((hit / handCet4.length) * 100).toFixed(1)}%`;
})());

// ══ 汇总 ═══════════════════════════════════════════════════════
console.log('');
console.log(`  ${DIM}有搭配 ${keys.length} / ${COLLOC_COVERAGE.words} 词，` +
  `语料 ${COLLOC_COVERAGE.sentences.toLocaleString()} 句，minCount=${COLLOC_COVERAGE.minCount}${OFF}`);
console.log('');
if (fail === 0) {
  console.log(`${GREEN}  全部通过：${pass} 项断言${OFF}\n`);
  process.exit(0);
}
console.log(`${RED}  ${fail} 项失败（共 ${pass + fail} 项）：${failures.join('、')}${OFF}\n`);
process.exit(1);
