/** 复算五项占比 —— **走查询层**（roots.mjs），也就是界面真正看到的那些数据。
 *
 *  为什么必须走查询层：例句现在有两个来源（Tatoeba + Wikipedia），搭配有三个
 *  来源；如果这里直接读数据表，就会漏掉回退/合并逻辑，算出来的数和界面不一致。
 *
 *  用法: node tools/coverage-now.mjs
 */
import { parseWordlist, seedFor } from '../core/library.mjs';
import { collocationsOf, decompose, examplesOf, morphOf, originOf, relativesOf, rootLine } from '../core/roots.mjs';

const LIBS = ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
const union = new Set();
for (const l of LIBS) for (const w of parseWordlist(JSON.stringify(seedFor(l)), l)) union.add(w.word);
const words = [...union];
const N = words.length;

const exOf = (w) => {
  const e = examplesOf(w);
  return Array.isArray(e) ? e : null;
};
const hasEx = (w) => !!exOf(w);
const hasZh = (w) => {
  const e = exOf(w);
  return !!(e && typeof e[1] === 'string' && e[1].trim());
};
const hasRoot = (w) => {
  if (morphOf(w)) return true;
  if (rootLine(w)) return true;
  if (decompose(w)?.length) return true;
  const o = originOf(w);
  return !!(o && o.kind === 'split' && o.text);
};
const hasEtym = (w) => {
  const o = originOf(w);
  return !!(o && o.text && o.text.trim());
};
const hasColloc = (w) => (collocationsOf(w) || []).length > 0;
const hasRel = (w) => (relativesOf(w) || []).length > 0;

const rows = [
  ['例句（Tatoeba + Wikipedia）', hasEx],
  ['例句带中文译文', hasZh],
  ['词根词缀行', hasRoot],
  ['词源', hasEtym],
  ['常见搭配', hasColloc],
  ['同族词', hasRel],
];
for (const [name, fn] of rows) {
  const n = words.filter(fn).length;
  console.log(`  ${name.padEnd(24)} ${String(n).padStart(6)} / ${N} = ${(n / N * 100).toFixed(2)}%`);
}
const none = words.filter((w) => !(hasEx(w) || hasRoot(w) || hasEtym(w) || hasColloc(w) || hasRel(w))).length;
console.log(`  ${'五项全无'.padEnd(24)} ${String(none).padStart(6)} / ${N} = ${(none / N * 100).toFixed(2)}%`);
console.log(`  ${'至少有一项'.padEnd(24)} ${String(N - none).padStart(6)} / ${N} = ${((N - none) / N * 100).toFixed(2)}%`);
console.log('  分库搭配: ' + LIBS.map((l) => {
  const ws = parseWordlist(JSON.stringify(seedFor(l)), l).map((x) => x.word);
  const h = ws.filter(hasColloc).length;
  return `${l} ${(h / ws.length * 100).toFixed(1)}%`;
}).join('  '));
