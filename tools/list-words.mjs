// vocab-study / tools / list-words.mjs
//
// 把六个词库的所有词（去重）打成 JSON 打到 stdout，给离线生成器用：
//   node tools/list-words.mjs            → 全部词（去重）
//   node tools/list-words.mjs cet4       → 只要四级
//
// 为什么单独一个文件：生成器（make-examples.py / make-etym.py）要跑在 Python 里，
// 但词表是 core/ 里的 ESM 模块 —— 让 Python 去解析 JS 源码是错的方向，
// 让 Node 把词表吐成 JSON 才是。

import { seedFor, parseWordlist } from '../core/library.mjs';

const COLLS = ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
const want = process.argv[2];
const use = want ? [want] : COLLS;

const seen = new Map();
for (const c of use) {
  for (const w of parseWordlist(JSON.stringify(seedFor(c)), c)) {
    if (!seen.has(w.word)) seen.set(w.word, { word: w.word, meaning: w.meaning || '', pos: w.pos || '' });
    else {
      // 释义也要合并：同一个词在不同词库里的释义不同，而**词性靠释义里的
      // `n.` / `vt.` / `adj.` 标记推出来**（seed 词条本身不带 pos 字段）。
      // 只留第一个词库的释义，会让补全进来的四级词把原来 cet6 释义里的
      // 词性标记挤掉 —— 实测搭配条目从 2,926 掉到 2,583，掉的就是这类。
      const cur = seen.get(w.word);
      const add = String(w.meaning || '').trim();
      if (add && !cur.meaning.includes(add) && cur.meaning.length < 300) {
        cur.meaning = cur.meaning ? `${cur.meaning} ${add}` : add;
      }
      if (w.pos) {
        // 同一个词在不同词库里 pos 可能不一致（give 在某个库里只有 n.），
        // 合并起来才不会漏掉动词身份 —— 搭配挖掘要靠它判断能不能接介词。
        const have = new Set(String(cur.pos).split('/').map((s) => s.trim()).filter(Boolean));
        for (const p of String(w.pos).split('/').map((s) => s.trim()).filter(Boolean)) have.add(p);
        cur.pos = [...have].join('/');
      }
    }
  }
}
process.stdout.write(JSON.stringify([...seen.values()]));
