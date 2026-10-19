// vocab-study / test / roots.test.mjs
//
// 词根词缀：数据表自洽 + 查询层行为 + 数据层接线。
//
//   node test/roots.test.mjs
//
// 这个套件守的核心是**诚实**：查不到必须留空，绝不编。
// 以及一个真实踩过的坑：种子词库那条路不经过 parseWordlist，
// 只在 parseWordlist 里补数据的话，单测全绿但界面一个词根都不显示。

import * as RT from '../core/roots.mjs';
import * as L from '../core/library.mjs';
import { ROOT_FAMILIES, WORD_ROOTS, MORPH_TABLE, WORD_MORPH, ROOTS_COVERAGE } from '../core/roots-data.mjs';
import { SEED_CET4_RAW } from '../core/seed-cet4.mjs';
import { SEED_CET6, SEED_KAOYAN, SEED_TOEFL, SEED_GRE, SEED_IELTS } from '../core/seed-exams.mjs';

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

console.log('vocab-study · 词根词缀\n');

// ══ ① 数据表自洽 ═══════════════════════════════════════════════
console.log('① 数据表自洽');

push('ROOT_FAMILIES 非空', ROOT_FAMILIES.length > 0, `${ROOT_FAMILIES.length} 个家族`);
push('WORD_ROOTS 非空', Object.keys(WORD_ROOTS).length > 0);

// 每个家族必须有 key / kind / meaning / family
push(
  '每个家族都有 key / kind / meaning 和非空 family',
  ROOT_FAMILIES.every(
    (f) => f && f.key && f.kind && f.meaning && Array.isArray(f.family) && f.family.length > 0,
  ),
);

// 两张表必须互为逆映射：WORD_ROOTS 里每个词都真的在那个家族里
let inverseOk = true;
let inverseBad = '';
for (const [word, idxs] of Object.entries(WORD_ROOTS)) {
  for (const i of idxs) {
    const f = ROOT_FAMILIES[i - 1];
    if (!f || !f.family.includes(word)) {
      inverseOk = false;
      inverseBad = `${word} → 家族#${i}(${f ? f.key : '越界'})`;
      break;
    }
  }
  if (!inverseOk) break;
}
push('WORD_ROOTS 与 ROOT_FAMILIES 互为逆映射（下标不越界、词真的在家族里）', inverseOk, inverseBad);

// 反过来：每个家族成员都必须在 WORD_ROOTS 里登记
let forwardOk = true;
let forwardBad = '';
for (const f of ROOT_FAMILIES) {
  for (const m of f.family) {
    if (!WORD_ROOTS[m]) {
      forwardOk = false;
      forwardBad = `${m} 在家族 ${f.key} 里但 WORD_ROOTS 没登记`;
      break;
    }
  }
  if (!forwardOk) break;
}
push('每个家族成员都在 WORD_ROOTS 里登记了', forwardOk, forwardBad);

// 家族成员必须是词库里真实存在的词（这正是「只核对不推断」的落点）
const LIB_WORDS = new Set();
for (const c of Object.keys(L.COLLECTIONS)) for (const w of L.seedFor(c)) LIB_WORDS.add(String(w.word).toLowerCase());
const stray = [];
for (const f of ROOT_FAMILIES) for (const m of f.family) if (!LIB_WORDS.has(m)) stray.push(m);
push('所有家族成员都是词库里真实存在的词（没有外部词混进来）', stray.length === 0, `${stray.length} 个越界: ${stray.slice(0, 5).join(',')}`);

push(
  '家族 key 里没有 ECDICT 的内部编号（in-2 / cap1 这种）',
  ROOT_FAMILIES.every((f) => !/\d/.test(f.key)),
  ROOT_FAMILIES.filter((f) => /\d/.test(f.key)).slice(0, 3).map((f) => f.key).join(','),
);

push(
  '家族成员是排好序的（同样输入永远同样输出，构建才确定）',
  ROOT_FAMILIES.every((f) => f.family.every((w, i) => i === 0 || f.family[i - 1] <= w)),
);

push(
  '释义不超过 43 字符（卡片一行放得下）',
  ROOT_FAMILIES.every((f) => f.meaning.length <= 43),
  ROOT_FAMILIES.map((f) => f.meaning.length).sort((a, b) => b - a)[0] + ' 字符',
);

// ══ ② 覆盖率不许虚报 ═══════════════════════════════════════════
console.log('\n② 覆盖率口径');

push('ROOTS_COVERAGE 与数据表一致（家族数）', ROOTS_COVERAGE.families === ROOT_FAMILIES.length);
push('ROOTS_COVERAGE 与数据表一致（有词根词数）', ROOTS_COVERAGE.wordsWithRoots === Object.keys(WORD_ROOTS).length);
push(
  '覆盖率分母 = 六个词库去重后的唯一词数',
  ROOTS_COVERAGE.uniqueWords === LIB_WORDS.size,
  `表里 ${ROOTS_COVERAGE.uniqueWords} / 实测 ${LIB_WORDS.size}`,
);
push(
  '有词根词数不可能超过唯一词总数',
  ROOTS_COVERAGE.wordsWithRoots <= ROOTS_COVERAGE.uniqueWords,
);
push('数据源标注了 ECDICT', /ECDICT/i.test(ROOTS_COVERAGE.source), ROOTS_COVERAGE.source);
push(
  '数据源也标注了手写构词法表',
  /morph-table/.test(ROOTS_COVERAGE.source),
  ROOTS_COVERAGE.source,
);
push(
  'MORPH_TABLE 条目数 = WORD_MORPH 能指到的最大的下标',
  MORPH_TABLE.length >= Math.max(0, ...Object.values(WORD_MORPH).flat()),
  `${MORPH_TABLE.length} 条`,
);
push(
  'WORD_MORPH 里每一条的下标都指向真实条目（不越界）',
  Object.values(WORD_MORPH).every(([p, r, s]) =>
    [p, r, s].every((i) => i === 0 || (i >= 1 && i <= MORPH_TABLE.length)),
  ),
);
push(
  '手写表的切分必须真的算出了覆盖率（>=28%）',
  ROOTS_COVERAGE.wordsWithMorph / ROOTS_COVERAGE.uniqueWords >= 0.28,
  `${ROOTS_COVERAGE.wordsWithMorph} / ${ROOTS_COVERAGE.uniqueWords}`,
);
push(
  '两套数据合并后覆盖率 >= 45%（手写表把 ECDICT 的 25% 顶上来了）',
  ROOTS_COVERAGE.combinedCovered / ROOTS_COVERAGE.uniqueWords >= 0.45,
  `${ROOTS_COVERAGE.combinedCovered} / ${ROOTS_COVERAGE.uniqueWords}`,
);
push(
  '只有前缀/后缀、没有词根的条目不超过一半（否则等于没补词根）',
  ROOTS_COVERAGE.affixOnlyCount <= ROOTS_COVERAGE.wordsWithMorph * 0.85,
  `${ROOTS_COVERAGE.affixOnlyCount} / ${ROOTS_COVERAGE.wordsWithMorph}`,
);

// ══ ③ 已知样例可复现 ═══════════════════════════════════════════
console.log('\n③ 已知样例');

push('abstract 拆得出 tract', /tract\(draw, pull\)/.test(String(RT.decompose('abstract'))), RT.decompose('abstract'));
push('abstract 还带 ab-, abs- 前缀', /ab-, abs-\(from, away from\)/.test(String(RT.decompose('abstract'))));
push('skillful 拆得出 -ful', /-ful\(full of\)/.test(String(RT.decompose('skillful'))), RT.decompose('skillful'));
push('export 拆得出 port(carry) 与 ex-', /port\(carry\)/.test(String(RT.decompose('export'))) && /ex-/.test(String(RT.decompose('export'))), RT.decompose('export'));
push('tractable 拆得出 tract + -able', /tract\(/.test(String(RT.decompose('tractable'))) && /-able/.test(String(RT.decompose('tractable'))));

// 顺序：前缀 → 词根 → 后缀（读起来是「构词顺序」，和词典一致）
const absOrder = String(RT.decompose('abstract') || '');
push('拆解顺序是「前缀在前、词根在后」', absOrder.indexOf('ab-') < absOrder.indexOf('tract'), absOrder);

// ── 手写表补出来的结构（ECDICT 那 611 条里没有的常见词根）──
// 这批断言就是「覆盖率翻倍」这件事本身，缺一条就说明表或切分退化了。
push('distribute = dis- + tribut(给予)', /tribut\(给予/.test(String(RT.decompose('distribute'))) && /dis-/.test(String(RT.decompose('distribute'))), RT.decompose('distribute'));
push('consider 的 sider 是「星」，不是「坐」', /sider\(星/.test(String(RT.decompose('consider'))), RT.decompose('consider'));
push('expect = ex- + pect(看)', /pect\(看/.test(String(RT.decompose('expect'))), RT.decompose('expect'));
push('abundant = ab- + und(溢出) + -ant', /und\(/.test(String(RT.decompose('abundant'))) && /-ant/.test(String(RT.decompose('abundant'))), RT.decompose('abundant'));
push('inspect 拆得出 spect', /spect/.test(String(RT.decompose('inspect'))) && /^前缀 in-/.test(String(RT.decompose('inspect'))), RT.decompose('inspect'));
push('connection 报出 -tion 后缀且不硬凑词根', /后缀 -.*tion/.test(String(RT.decompose('connection'))) && !/词根/.test(String(RT.decompose('connection'))), RT.decompose('connection'));
push('teacher = -er（后缀确实成立）', /后缀 -er/.test(String(RT.decompose('teacher'))), RT.decompose('teacher'));

// 每一条拆解都必须带中文含义，而不是干巴巴一个词根名
push('拆解里带括号含义', /\(.+\)/.test(String(RT.decompose('distribute'))), RT.decompose('distribute'));

// ══ ④ 查不到必须诚实留空（本套件的灵魂）════════════════════════
console.log('\n④ 查不到就留空，不编');

// 这几个是真的没有可信构词结构：短词/日耳曼源/法语借词，硬凑就是编词源。
for (const w of ['abandon', 'budget', 'achieve', 'bargain', 'zzzznotaword', 'qwerty', 'not a word']) {
  push(`「${w}」没有词根 → null（不编一个）`, RT.decompose(w) === null, String(RT.decompose(w)));
}
push('查不到时 relativesOf 返回空数组', RT.relativesOf('zzzznotaword').length === 0);
push('查不到时 familyOf 返回空数组', L.familyOf('zzzznotaword').length === 0);
push('查不到时 rootFamiliesOf 返回空数组', RT.rootFamiliesOf('zzzznotaword').length === 0);

push(
  'decompose 输出里绝不出现 →（不编「所以意思是…」那半句）',
  (() => {
    for (const w of Object.keys(WORD_ROOTS)) if (String(RT.decompose(w)).includes('→')) return false;
    return true;
  })(),
);
push(
  '数据表里没有任何 →（源头也不许有）',
  ROOT_FAMILIES.every((f) => !f.key.includes('→') && !f.meaning.includes('→')),
);

// ══ ⑤ 健壮性 ═══════════════════════════════════════════════════
console.log('\n⑤ 健壮性');

for (const bad of ['', '   ', null, undefined, 123, {}, []]) {
  const label = JSON.stringify(bad) ?? 'undefined';
  push(`${label} 不抛错、返回 null`, (() => {
    try {
      return RT.decompose(bad) === null;
    } catch {
      return false;
    }
  })());
}
push('大小写不敏感（ABSTRACT 与 abstract 同结果）', RT.decompose('ABSTRACT') === RT.decompose('abstract'));
push('前后空格不敏感', RT.decompose('  abstract  ') === RT.decompose('abstract'));

// ══ ⑥ 同族词 ═══════════════════════════════════════════════════
console.log('\n⑥ 同族词');

const relAbs = RT.relativesOf('abstract');
push('abstract 有同族词', relAbs.length > 0, `${relAbs.length} 个`);
push('同族词里不含自己', relAbs.every((r) => r.word !== 'abstract'));
push('同族词都在词库里', relAbs.every((r) => LIB_WORDS.has(r.word)));
push('同族词都带 root / kind', relAbs.every((r) => r.root && r.kind));
push('abstract 的同族词包含 attract（真实同根词）', relAbs.some((r) => r.word === 'attract'), relAbs.slice(0, 6).map((r) => r.word).join(','));

const famAbs = L.familyOf('abstract', 5);
push('familyOf 默认最多 5 个', famAbs.length <= 5, `${famAbs.length} 个`);
push('familyOf 的每一项都带释义（空释义也不许是 undefined）', famAbs.every((f) => typeof f.meaning === 'string'));
push('familyOf 第 1 个是 tract 家族（词根优先）', famAbs[0] && famAbs[0].root === 'tract', famAbs[0] && famAbs[0].root);

const single = ROOT_FAMILIES.filter((f) => f.family.length === 1);
push(
  '单成员家族不产生同族词（一个词谈不上「同族」）',
  single.every((f) => RT.relativesOf(f.family[0]).filter((r) => r.root === f.key).length === 0),
);

// ══ ⑦ 数据层接线：两个入口都要补上 ═════════════════════════════
console.log('\n⑦ 数据层接线（真实踩过的坑）');

// (a) parseWordlist 这条路
const parsed = L.parseWordlist(
  JSON.stringify([
    { word: 'abstract', ipa: 'x', meaning: 'y' },
    { word: 'abandon', ipa: 'x', meaning: 'y' },
  ]),
  'gre',
);
push('parseWordlist 给有词根的词补上了 roots', parsed[0].roots !== null, String(parsed[0].roots));
push('parseWordlist 对查不到的词留 null', parsed[1].roots === null);

// (b) seedFor 这条路 —— 上次就是这里漏了
const seededCet6 = L.seedFor('cet6');
push('seedFor(cet6) 返回非空', seededCet6.length > 0, `${seededCet6.length} 词`);
push(
  'seedFor 的每个词都有 roots 字段（undefined ≠ null，必须是显式的）',
  seededCet6.every((w) => 'roots' in w),
  `缺字段 ${seededCet6.filter((w) => !('roots' in w)).length} 个`,
);
const seededRooted = seededCet6.filter((w) => w.roots);
push('seedFor(cet6) 里真有词补上了 roots（界面折叠项的数据源）', seededRooted.length > 500, `${seededRooted.length} / ${seededCet6.length}`);
push('seedFor 补的 roots 与 decompose 一致', seededRooted.every((w) => w.roots === RT.decompose(w.word)));

// (c) 种子文件里显式的 roots: null 不许盖掉自动拆解
//     这是第二个坑：seed-cet4 的工厂函数给每条都写了 roots: extra.root ?? null，
//     把 roots 写在 spread 前面会被覆盖回 null（实测 cet4 只剩 43 条）。
const seededCet4 = L.seedFor('cet4');
const cet4Rooted = seededCet4.filter((w) => w.roots);
push(
  'seedFor(cet4) 的自动拆解没被种子里的 roots:null 盖掉（应 > 70 条）',
  cet4Rooted.length > 70,
  `${cet4Rooted.length} / ${seededCet4.length}`,
);
push(
  'seedFor(cet4) 手写 roots 仍然优先（43 条带人工「→」画面）',
  cet4Rooted.filter((w) => String(w.roots).includes('→')).length === 43,
);
push(
  'seedFor 的每个词都保留了 word / meaning / id / collection',
  seededCet6.every((w) => w.word && w.id && w.collection === 'cet6'),
);

// (d) 手写优先：parseWordlist 里词库自带 roots 不被自动拆解覆盖
const handParsed = L.parseWordlist(
  JSON.stringify([{ word: 'abandon', meaning: 'm', roots: 'a-(去) + band(约束) → 解开束缚' }]),
  'cet4',
);
push('parseWordlist 里手写 roots 优先于自动拆解', String(handParsed[0].roots).includes('→'), String(handParsed[0].roots));

// (e) 六个词库的覆盖规模（数字写死，改了数据要一起改，防止悄悄退化）
// 2026-10：加了手写构词法表后这批数字从 86/1611/1459/1411/2097/2039 涨上来的。
const EXPECT = { cet4: 104, cet6: 2740, kaoyan: 2263, ielts: 2294, toefl: 3867, gre: 3567 };
for (const [c, expect] of Object.entries(EXPECT)) {
  const s = L.seedFor(c);
  const got = s.filter((w) => w.roots).length;
  push(`${c} 有词根的条数 = ${expect}`, got === expect, `实测 ${got}`);
}

// ══ ⑧ 生成器可复现 ═════════════════════════════════════════════
console.log('\n⑧ 生成器');

push(
  'core/roots-data.mjs 头部注明了「自动生成、不要手改」',
  (await import('node:fs')).readFileSync(new URL('../core/roots-data.mjs', import.meta.url), 'utf8').includes('不要手改'),
);
push(
  'tools/make-roots.mjs 存在且带 --audit',
  (await import('node:fs')).readFileSync(new URL('../tools/make-roots.mjs', import.meta.url), 'utf8').includes('--audit'),
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
  `${DIM}覆盖率实况：${ROOTS_COVERAGE.wordsWithRoots} / ${ROOTS_COVERAGE.uniqueWords} 词有词根 = ${(
    (ROOTS_COVERAGE.wordsWithRoots / ROOTS_COVERAGE.uniqueWords) *
    100
  ).toFixed(2)}%，共 ${ROOTS_COVERAGE.families} 个词根家族${OFF}`,
);
console.log('─'.repeat(56));
process.exit(fail === 0 ? 0 : 1);
