/** 统计搭配覆盖（六库并集口径，和文档里 14,668 同一分母）。
 *  两种口径都算：原样并集（大小写敏感）和全小写并集，看哪个和文档一致。
 */
import { parseWordlist, seedFor } from '../core/library.mjs';
import { COLLOCATIONS, COLLOC_COVERAGE } from '../core/colloc-data.mjs';

const LIBS = ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
const raw = new Set();
const lower = new Set();
const per = {};
for (const l of LIBS) {
  const ws = parseWordlist(JSON.stringify(seedFor(l)), l).map((x) => x.word);
  per[l] = ws;
  for (const w of ws) { raw.add(w); lower.add(w.toLowerCase()); }
}
const hitRaw = [...raw].filter((w) => COLLOCATIONS[w] || COLLOCATIONS[w.toLowerCase()]).length;
const hitLower = [...lower].filter((w) => COLLOCATIONS[w]).length;
console.log(`  原样并集 ${raw.size} 词 → 有搭配 ${hitRaw} = ${(hitRaw / raw.size * 100).toFixed(2)}%`);
console.log(`  小写并集 ${lower.size} 词 → 有搭配 ${hitLower} = ${(hitLower / lower.size * 100).toFixed(2)}%`);
for (const l of LIBS) {
  const ws = per[l];
  const h = ws.filter((w) => COLLOCATIONS[w] || COLLOCATIONS[w.toLowerCase()]).length;
  console.log(`    ${l.padEnd(8)} ${String(h).padStart(5)} / ${String(ws.length).padStart(5)} = ${(h / ws.length * 100).toFixed(1)}%`);
}
console.log('  产物元数据:', JSON.stringify(COLLOC_COVERAGE));
