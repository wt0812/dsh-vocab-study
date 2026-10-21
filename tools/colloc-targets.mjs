/** 给 tools/make-colloc-titles.py 备料：
 *   · 目前没有常见搭配的词（title 通道只补它们）
 *   · 每个词的词性（从词库释义里的 n./v./adj. 标记推；Python 不解析 ESM，所以让 Node 吐）
 *
 *  用法: node tools/colloc-targets.mjs > _colloc-targets.json
 */
import { COLLOCATIONS } from '../core/colloc-data.mjs';
import { parseWordlist, seedFor } from '../core/library.mjs';

const LIBS = ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
const seen = new Map();
// 专有名词集合：词库里首字母大写的词（America / Roman / English）。
// 标题通道要拿它过滤掉「south africa」这种专名组合 —— 那不是学习搭配。
const properSet = new Set();
for (const l of LIBS) {
  for (const w of parseWordlist(JSON.stringify(seedFor(l)), l)) {
    const k = w.word.toLowerCase();
    if (/^[A-Z]/.test(String(w.word))) properSet.add(k);
    const cur = seen.get(k);
    // 释义要合并：词性靠释义里的 n./v./adj. 标记推，只留第一个词库会把词性弄丢
    if (!cur) seen.set(k, { word: k, meaning: w.meaning || '', pos: w.pos || '' });
    else {
      const add = String(w.meaning || '').trim();
      if (add && !cur.meaning.includes(add) && cur.meaning.length < 300) {
        cur.meaning = cur.meaning ? `${cur.meaning} ${add}` : add;
      }
      if (w.pos && !cur.pos.includes(w.pos)) cur.pos = `${cur.pos}${w.pos}`;
    }
  }
}

const targets = [];
const pos = {};
for (const [k] of seen) {
  const v = seen.get(k);
  pos[k] = v.pos || '';
  if (!COLLOCATIONS[k]) targets.push(k);
}
targets.sort();
process.stdout.write(JSON.stringify({ total: seen.size, targets, pos, proper: [...properSet].sort() }));
process.stderr.write(`\n  缺搭配 ${targets.length} 词（并集 ${seen.size}）\n`);
