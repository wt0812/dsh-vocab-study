// 精确统计 INCIDENTS.md 里 14 起事故中，哪些属于「静默失败」
// 判据：该起事故的正文里出现「静默 / 不报错 / 毫无反应 / 测试全绿 / 全绿」
//
// 用法: node tools/count-silent-failures.mjs
import { readFileSync } from 'node:fs';

const f = 'F:/DeepSeek Harness/projects/vocab-study/docs/INCIDENTS.md';
const text = readFileSync(f, 'utf8');
const lines = text.split('\n');

// 找 14 个事故标题的起始行
const idx = [];
lines.forEach((l, i) => { if (/^### 事故/.test(l)) idx.push(i); });

const KEYS = ['静默', '不报错', '毫无反应', '测试全绿', '全绿', '没有报错', '不警告'];
const rows = [];
idx.forEach((start, k) => {
  const end = k + 1 < idx.length ? idx[k + 1] : lines.length;
  const body = lines.slice(start, end).join('\n');
  const hits = KEYS.filter((key) => body.includes(key));
  const title = lines[start].replace(/^### /, '');
  rows.push({ n: k + 1, title, silent: hits.length > 0, hits });
});

console.log('  #   静默?  命中的关键词                    事故');
console.log('  ' + '─'.repeat(104));
for (const r of rows) {
  const mark = r.silent ? '✅是 ' : '❌否 ';
  console.log(`  ${String(r.n).padStart(2)}  ${mark} ${r.hits.join('/').padEnd(30)} ${r.title.slice(0, 44)}`);
}

const silent = rows.filter((r) => r.silent).length;
console.log('');
console.log(`  ══ 精确计数 ══`);
console.log(`     事故总数          : ${rows.length} 起`);
console.log(`     含「静默/不报错」 : ${silent} 起`);
console.log(`     不含              : ${rows.length - silent} 起`);
console.log('');
console.log(`  ⚠️ 注意：事故二（整个客户端起不来）是硬失败，本次判定=${rows.find(r=>r.n===2).silent ? '静默' : '非静默'}`);
