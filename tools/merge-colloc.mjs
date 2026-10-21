/** 合并两份挖掘结果，带「两库交叉验证」：
 *    · 基线：Tatoeba（闸门调到最严，产出全部保留，精度有回归测试守着）
 *    · 补充：Simple English Wikipedia 只补 Tatoeba 挖不出的词，而且**每条搭配
 *      必须在 Tatoeba 里也出现过**（哪怕次数不够过闸门）才收 —— 两份语料都看到的
 *      组合才算真搭配，单靠 Wiki 看出来的多半是 "abdicate in" 这种窗口误抓。
 *
 *  用法: node tools/merge-colloc.mjs [--min-tatoeba 1] [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
// 基线固定读 _colloc-base.mjs（Tatoeba 那次挖掘的产物），
// 不读 core/colloc-data.mjs —— 否则第二次合并会把上次的合并结果当基线，越合越乱。
import { COLLOCATIONS as BASE, COLLOC_COVERAGE as CBASE } from '../_colloc-base.mjs';
import { COLLOCATIONS as WIKI, COLLOC_COVERAGE as CWIKI } from '../_colloc-wiki.mjs';
// 第三个来源：Wikipedia 文章标题（人工起的名字）+ Tatoeba 句子交叉验证。
// 文件不存在就跳过 —— 只跑 Tatoeba + Wikipedia 两步的老流程仍然能用。
let TITLES = {};
let CTITLES = {};
try {
  ({ COLLOC_TITLES: TITLES, COLLOC_TITLES_COVERAGE: CTITLES } = await import('../_colloc-titles.mjs'));
} catch {
  TITLES = {};
}

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const mi = argv.indexOf('--min-tatoeba');
const MIN_TATOEBA = mi >= 0 ? Number(argv[mi + 1]) : 1;

const tat = JSON.parse(readFileSync('_counts-tatoeba.json', 'utf8'));
const wikiCnt = JSON.parse(readFileSync('_counts-wiki.json', 'utf8'));
const POS = tat.__pos__ || {};
delete tat.__pos__;
delete wikiCnt.__pos__;
const WBASE = wikiCnt.__base__ || {};
delete wikiCnt.__base__;
const TBASE = tat.__base__ || {};
delete tat.__base__;

const added = {};
const dropped = [];
for (const [w, list] of Object.entries(WIKI)) {
  if (w in BASE) continue;
  // of/in/by/as 这四个介词在语料里大量是「X 的 X」这种结构噪声（accept an offer of…、
  // airports in Europe），不是真搭配。对它们要求更强的交叉证据：Tatoeba 里至少 3 次。
  const RISKY = /\b(of|in|by|as)$/;
  const pos = POS[w] || '';
  const pureNoun = pos.includes('n') && !pos.includes('v') && !pos.includes('adj');
  const keep = list.filter((p) => {
    const c = tat[p] || 0;
    if (RISKY.test(p)) {
      // 纯名词 + of/in/by/as 绝大多数是「X in 某地」这类位置短语（airport in），不收。
      if (pureNoun) return false;
      // 占比闸门：Wiki 里这条搭配要占该词全部出现次数的 10% 以上。
      // "accept of" 这种窗口误抓在 Wiki 里可能出现 8 次，但 accept 本身出现 2000+ 次 → 占比 0.4%，挡掉。
      const wc = wikiCnt[p] || 0;
      const wbase = WBASE[w] || 0 || TBASE[w] || 0;
      if (wbase && wc / wbase < 0.10) return false;
      return c >= Math.max(3, MIN_TATOEBA);
    }
    return c >= MIN_TATOEBA;
  });
  if (keep.length) added[w] = keep;
  else dropped.push([w, list]);
}
// ── 第三来源：文章标题里的名词组合 ──
// 这些词在语料里没有固定介词（zebra / kitchen / wheat 这类具体名词），
// 但有固定名词搭配（zebra crossing / kitchen table）。标题本身就是人写的组合名，
// 再要求同一组合在 Tatoeba 句子里出现 ≥2 次（生成标题数据时已做过），双证据才收。
const tAdded = {};
let tDropped = 0;
for (const [w, list] of Object.entries(TITLES)) {
  if (w in BASE || w in added) continue;      // 已有搭配的词不动
  const keep = list.filter((p) => p && p.includes(' ') && p.length < 40);
  if (keep.length) tAdded[w] = keep;
  else tDropped++;
}
Object.assign(added, tAdded);

const union = new Set([...Object.keys(BASE), ...Object.keys(added)]);
console.log(`  Tatoeba 基线 ${Object.keys(BASE).length} 词`);
console.log(`  Wiki 候选 ${Object.keys(WIKI).length} 词 → 交叉验证后补进 ${Object.keys(added).length} 词（丢弃 ${dropped.length}）`);
console.log(`  标题候选 ${Object.keys(TITLES).length} 词 → 补进 ${Object.keys(tAdded).length} 词`);
console.log(`  合计 ${union.size} / ${CBASE.words} = ${(union.size / CBASE.words * 100).toFixed(2)}%`);

console.log('  补进来的词（前 30）：');
for (const [w, l] of Object.entries(added).slice(0, 30)) console.log(`    ${w.padEnd(16)} ${l.join(' · ')}`);
console.log('  被丢弃的（前 12，应该是噪声）：');
for (const [w, l] of dropped.slice(0, 12)) console.log(`    ${w.padEnd(16)} ${l.join(' · ')}`);

// 交叉验证强度分布：Tatoeba 里这条搭配出现过几次
const hist = {};
for (const l of Object.values(added)) {
  for (const p of l) {
    const c = tat[p] || 0;
    const bucket = c >= 10 ? '10+' : c >= 5 ? '5-9' : c >= 3 ? '3-4' : c >= 2 ? '2' : '1';
    hist[bucket] = (hist[bucket] || 0) + 1;
  }
}
console.log('  新增搭配在 Tatoeba 里的出现次数分布:', JSON.stringify(hist));

if (!dry) {
  const all = { ...BASE, ...added };
  const lines = [
    '// vocab-study / core / colloc-data.mjs',
    '// ⚠️ 生成产物，不要手改。三步重生成：',
    '//   1) python tools/make-collocations.py --out _colloc-base.mjs --dump-counts _counts-tatoeba.json',
    '//   2) python tools/make-collocations.py --wiki-only --out _colloc-wiki.mjs --dump-counts _counts-wiki.json',
    '//   3) python tools/make-colloc-titles.py    （文章标题那一路，可选）',
    '//   4) node tools/merge-colloc.mjs',
    '//',
    '// 三个来源：',
    '//   · Tatoeba 英文语料（CC BY 2.0）：闸门最严，产出全部保留。',
    '//   · Simple English Wikipedia 正文（CC BY-SA 4.0）：**只补** Tatoeba 挖不出的词，',
    '//     且每条搭配必须在 Tatoeba 里也出现过 —— 两库都看到的组合才算数。',
    '//   · Simple English Wikipedia 文章标题（CC BY-SA 4.0）：补「名词+名词」这类',
    '//     闭类结构挖不到的搭配（zebra crossing / kitchen table），同样要求在 Tatoeba',
    '//     句子里出现过 ≥2 次。',
    '//',
    '// 这不是词典里的"标准搭配"，是**这两个语料里稳定出现的搭配**。',
    '//',
    '// 许可：Tatoeba 部分是 CC BY 2.0；Simple English Wikipedia 部分是 CC BY-SA 4.0，',
    '// 本文件作为派生数据按 **CC BY-SA 4.0** 分发（share-alike）。',
    '// 署名与许可全文见 docs/third-party/README.md §6 与 SIMPLEWIKI-NOTICE.txt。',
    '// 查不到的词就完全留空，界面上不出现「常见搭配」这一项。',
    '',
    'export const COLLOCATIONS = {',
  ];
  for (const w of Object.keys(all).sort()) {
    const arr = all[w].map((p) => "'" + p.replace(/'/g, "\\'") + "'").join(', ');
    lines.push(`  '${w}': [${arr}],`);
  }
  lines.push('};', '');
  const cov = {
    words: CBASE.words,
    withColloc: Object.keys(all).length,
    sentences: CBASE.sentences + CWIKI.sentences,
    minCount: CBASE.minCount,
    source: 'Tatoeba (CC BY 2.0) + Simple English Wikipedia (CC BY-SA 4.0)',
    sentencesTatoeba: CBASE.sentences,
    sentencesWiki: CWIKI.sentences,
    minTatoebaEvidence: MIN_TATOEBA,
    mergedFrom: { tatoeba: Object.keys(BASE).length,
      wikiFilled: Object.keys(added).length - Object.keys(tAdded).length,
      titleFilled: Object.keys(tAdded).length },
  };
  lines.push('export const COLLOC_COVERAGE = ' + JSON.stringify(cov) + ';', '');
  writeFileSync('core/colloc-data.mjs', lines.join('\n'), 'utf8');
  console.log('  ✓ 已写出 core/colloc-data.mjs');
}
