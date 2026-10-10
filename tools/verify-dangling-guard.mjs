// 验证「悬空命名空间前缀」断言的正确判据，并对两份样本做对照。
//
// 上一版断言为什么失效（记下来，免得再犯）：
//   我用"成员名在 setCore 注册表里就跳过"来排除误报。但 `shouldBlockNew`
//   **本身就是合法成员**（它被正确登记了），于是 `Q.shouldBlockNew` 这个
//   真·悬空引用被我的"跳过"规则放过了 —— 好样本坏样本都判 0。
//
// 正确判据：看**前缀本身**在产物里有没有声明。
//   摊平后没有 `Q` 这个变量（只有裸函数 shouldBlockNew），
//   所以任何 `Q.xxx` 都是悬空引用 —— 与 xxx 叫什么无关。
//   而 `M.foo` 可能是合法的局部对象（比如某个 `const M = {...}`），
//   所以必须先查"前缀是否被声明"，不能只看成员名。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 相对本文件定位仓库根，这样换台机器 / 换个目录也能跑
// （原来写死了作者本机的 F:\DeepSeek Harness\projects\vocab-study）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = path.join(ROOT, 'lib', 'client.js');
const good = fs.readFileSync(P, 'utf8');
const bad = good.replace(
  /const blocked = shouldBlockNew\(todayStats\(\)\);/,
  'const blocked = Q.shouldBlockNew(todayStats());',
);
if (bad === good) {
  console.log('✗ 无法制造坏样本');
  process.exit(1);
}

const PREFIXES = ['M', 'MK', 'SEED', 'L', 'SP', 'HK', 'Q', 'G', 'B', 'S', 'A'];

function analyse(t) {
  const noComment = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const dangling = new Map();
  for (const prefix of PREFIXES) {
    // 前缀在产物里有没有被声明成变量/函数/类/形参/属性？
    // 只要有任何一种声明，就不能断定它悬空（可能是合法的局部对象）。
    const declared = new RegExp(
      String.raw`(?:^|[\s,;({\[])(?:const|let|var|function|class)\s+${prefix}\b` +
        String.raw`|\b${prefix}\s*[:=]` +
        String.raw`|\(\s*${prefix}\b`,
      'm',
    ).test(noComment);
    if (declared) continue;
    const re = new RegExp(String.raw`\b${prefix}\.([A-Za-z_$][\w$]*)`, 'g');
    for (const m of noComment.matchAll(re)) {
      const full = `${prefix}.${m[1]}`;
      if (!dangling.has(full)) dangling.set(full, noComment.slice(0, m.index).split('\n').length);
    }
  }
  return dangling;
}

const g = analyse(good);
const b = analyse(bad);

console.log('好产物 悬空数 = ' + g.size);
console.log('坏产物 悬空数 = ' + b.size);
if (b.size) {
  console.log('  坏产物抓到的: ' + [...b].map(([k, l]) => k + '@约' + l + '行').join(', '));
}

const pass = g.size === 0 && b.has('Q.shouldBlockNew');
console.log('');
if (!pass && g.size) {
  console.log('⚠ 好产物也有悬空（判据过严，会误报）: ' + [...g.keys()].join(', '));
}
console.log(pass ? '✅ 断言有效：好产物干净、坏产物被抓出' : '❌ 断言无效');
process.exit(pass ? 0 : 1);
