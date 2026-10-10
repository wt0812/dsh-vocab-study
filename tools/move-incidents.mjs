// 把 README 里的排查笔记（事故记录）搬到 docs/INCIDENTS.md。
//
// 做法刻意写得**没有歧义**：只在「## 排查笔记」这一行切一刀，得到
//   A = 前段（产品文档正文）
//   B = 后段（排查笔记 + 目录速查）
// 再把 B 里的「## 目录速查」切出来放回 A 的末尾。每个原始行有且只有一个去处，
// 守恒检查因此是算术（A + M + C 的行数 == 原文行数），而不是靠肉眼看边界。
//
// 上一版我在两边各自"吃掉多余的空行和 ---"，结果自己写出了边界矛盾、
// 还绕了三轮没找出来 —— 所以这版不允许做任何吞噬。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const OUT = path.join(ROOT, 'docs', 'INCIDENTS.md');
const CHECK_ONLY = process.argv.includes('--check');

const src = fs.readFileSync(README, 'utf8');
const L = src.split('\n');

const idxOf = (prefix) => {
  const hits = [];
  for (let i = 0; i < L.length; i++) if (L[i].startsWith(prefix)) hits.push(i);
  if (hits.length !== 1) throw new Error(`「${prefix}」应当只出现一次，实际 ${hits.length} 次`);
  return hits[0];
};

const iLog = idxOf('## 排查笔记');
const iDir = idxOf('## 目录速查');
if (!(iLog < iDir)) throw new Error(`分界点顺序不对：排查笔记@${iLog + 1} 目录速查@${iDir + 1}`);

const A = L.slice(0, iLog);        // 产品文档正文
const M = L.slice(iLog, iDir);      // 排查笔记（要搬走的）
const C = L.slice(iDir);            // 目录速查（留在 README）

console.log('=== 切割（1-based）===');
console.log('  排查笔记起始行 :', iLog + 1, JSON.stringify(L[iLog].slice(0, 44)));
console.log('  目录速查起始行 :', iDir + 1, JSON.stringify(L[iDir].slice(0, 44)));
console.log('  A 产品正文     :', A.length, '行');
console.log('  M 排查笔记     :', M.length, '行');
console.log('  C 目录速查     :', C.length, '行');
console.log('  A+M+C          :', A.length + M.length + C.length, '== 原文', L.length,
  A.length + M.length + C.length === L.length ? '✓' : '✗');

// 守恒：三个片段拼回去必须逐字节等于原文
const rebuilt = A.concat(M, C);
if (rebuilt.length !== L.length || rebuilt.some((v, i) => v !== L[i])) {
  for (let i = 0; i < L.length; i++) if (rebuilt[i] !== L[i]) {
    console.log('  第一处不同 @', i + 1, JSON.stringify(rebuilt[i]), '≠', JSON.stringify(L[i]));
    break;
  }
  throw new Error('守恒检查失败 —— 拒绝写文件');
}
console.log('  逐行恒等       : ✓（拼回去和原文一模一样）');

// 事故小节必须都在 M 里
const inc = M.filter((l) => /^### 事故/.test(l));
const stray = A.filter((l) => /^### 事故/.test(l)).concat(C.filter((l) => /^### 事故/.test(l)));
console.log('  M 里的事故小节 :', inc.length);
inc.forEach((l) => console.log('     ', l.replace(/^### /, '').slice(0, 46)));
if (stray.length) throw new Error('有事故小节留在了 A/C 里：' + stray.join(' | '));

if (CHECK_ONLY) {
  console.log('\n[--check] 只干跑，未写任何文件。');
  process.exit(0);
}

// ── 组装 docs/INCIDENTS.md ────────────────────────────────────
const header = `# 排查笔记（事故记录）

> \`dsh-vocab-study\` 开发过程中**真实踩过的坑**，按「症状 → 根因 → 修法 → 怎么验的」记录。
> 单独成篇是为了让 README 保持成一份产品文档；**内容一行都没删**。
>
> 其中对**其他 DSH 插件作者**也有用的部分，README 里留了摘要 ——
> 尤其是「客户端模块清单是启动时扫的，装完必须完全退出 DSH」这一条。

---

`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + M.join('\n'), 'utf8');
console.log('\n✓ 写了', path.relative(ROOT, OUT), `(${header.split('\n').length + M.length} 行)`);
console.log('  README 未改动（下一步单独做）。');
