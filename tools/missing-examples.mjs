/** 列出六库并集里「目前没有例句」的词，给 tools/make-examples-wiki.py 用。
 *
 *  为什么要单独一个文件：词表和例句都在 ESM 里，Python 去解析 JS 是错的方向；
 *  让 Node 把「还缺例句的词」吐成 JSON，Python 只读 JSON。
 *
 *  用法: node tools/missing-examples.mjs > _missing-examples.json
 */
import { EXAMPLES } from '../core/examples-data.mjs';
import { EXAMPLES_WIKI } from '../core/examples-wiki-data.mjs';
import { parseWordlist, seedFor } from '../core/library.mjs';

const LIBS = ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
const seen = new Map(); // 小写 → 原始拼写（词库里的写法）
for (const l of LIBS) {
  for (const w of parseWordlist(JSON.stringify(seedFor(l)), l)) {
    const k = w.word.toLowerCase();
    if (!seen.has(k)) seen.set(k, w.word);
  }
}

const missing = [];
for (const [k, raw] of seen) {
  if (EXAMPLES[k]) continue;            // Tatoeba 已有
  if (EXAMPLES_WIKI[k]) continue;       // Wikipedia 已经补过
  missing.push(k);
}
missing.sort();
process.stdout.write(JSON.stringify(missing));
process.stderr.write(`\n  缺例句 ${missing.length} 词（并集 ${seen.size}）\n`);
