/** 剩余空间体检：还差的那批词，在语料里到底有没有踪影。
 *  用来回答「还有优化空间吗」—— 有语料 = 有空间，没语料 = 到头了。
 */
import { readFileSync } from 'node:fs';
import { EXAMPLES } from '../core/examples-data.mjs';
import { parseWordlist, seedFor } from '../core/library.mjs';
import { relativesOf } from '../core/roots.mjs';
import { COLLOCATIONS } from '../core/colloc-data.mjs';
import { ETYM } from '../core/etym-data.mjs';

const LIBS = ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
const union = new Set();
for (const l of LIBS) for (const w of parseWordlist(JSON.stringify(seedFor(l)), l)) union.add(w.word);
const words = [...union];

const tat = JSON.parse(readFileSync('_counts-tatoeba.json', 'utf8'));
const wiki = JSON.parse(readFileSync('_counts-wiki.json', 'utf8'));
const TB = tat.__base__ || {};
const WB = wiki.__base__ || {};
const tatBase = (w) => TB[w] || TB[w.toLowerCase()] || 0;
const wikiBase = (w) => WB[w] || WB[w.toLowerCase()] || 0;

const buckets = (arr) => {
  const b = { '0': 0, '1-2': 0, '3-9': 0, '10-49': 0, '50+': 0 };
  for (const n of arr) {
    if (n === 0) b['0']++;
    else if (n <= 2) b['1-2']++;
    else if (n <= 9) b['3-9']++;
    else if (n <= 49) b['10-49']++;
    else b['50+']++;
  }
  return b;
};
const has = (table, w) => !!(table[w] ?? table[w.toLowerCase()]);
const p = (table, w) => table[w] ?? table[w.toLowerCase()];

const noEx = words.filter((w) => !has(EXAMPLES, w));
const noColloc = words.filter((w) => !has(COLLOCATIONS, w));
const noRel = words.filter((w) => relativesOf(w.toLowerCase()).length === 0);
const noEtym = words.filter((w) => { const e = p(ETYM, w); return !(Array.isArray(e) && e[0] !== 'none' && (e[1] || '').trim()); });

console.log(`  分母 ${words.length} 词`);
console.log(`  缺例句 ${noEx.length} 词 → 在语料里的出现次数分布`);
console.log(`     Tatoeba: ${JSON.stringify(buckets(noEx.map(tatBase)))}`);
console.log(`     Wikipedia: ${JSON.stringify(buckets(noEx.map(wikiBase)))}`);
const exWiki5 = noEx.filter((w) => wikiBase(w) >= 5).length;
const exWiki1 = noEx.filter((w) => wikiBase(w) >= 1).length;
console.log(`     → Wikipedia 出现 ≥1 次: ${exWiki1}（${(exWiki1 / noEx.length * 100).toFixed(0)}% of 缺口），≥5 次: ${exWiki5}`);
console.log('');
console.log(`  缺常见搭配 ${noColloc.length} 词 → 在语料里的出现次数分布`);
console.log(`     Tatoeba: ${JSON.stringify(buckets(noColloc.map(tatBase)))}`);
console.log(`     Wikipedia: ${JSON.stringify(buckets(noColloc.map(wikiBase)))}`);
const colWiki20 = noColloc.filter((w) => wikiBase(w) >= 20).length;
const colWiki50 = noColloc.filter((w) => wikiBase(w) >= 50).length;
console.log(`     → Wikipedia 出现 ≥20 次: ${colWiki20}，≥50 次: ${colWiki50}（这些是真有语料、只是没过闸门）`);
console.log('');
console.log(`  缺同族词 ${noRel.length} 词 —— 词根/派生数据已用尽（ECDICT + WordNet），只能靠构词规则，风险高`);
console.log(`  缺词源 ${noEtym.length} 词 —— 维基词典本身没有词源段落`);
