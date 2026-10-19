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
    if (!seen.has(w.word)) seen.set(w.word, { word: w.word, meaning: w.meaning || '' });
  }
}
process.stdout.write(JSON.stringify([...seen.values()]));
