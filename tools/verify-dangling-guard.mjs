// 验证「悬空命名空间前缀」检查器本身还有效，并对两份样本做对照。
//
// 历史（记下来，免得再犯）：
//   ① 第一版判据用"成员名在 setCore 注册表里就跳过"来排除误报。但
//      `shouldBlockNew` **本身就是合法成员**（它被正确登记了），于是
//      `Q.shouldBlockNew` 这个真·悬空引用被"跳过"规则放过了 —— 好坏样本都判 0。
//   ② 第二版判据改成"看前缀本身在产物里有没有声明"，判据对了，但**自己又写了一份
//      屏蔽器**（只去注释），于是把数据文本当代码：例句里 `A.I. won't reach
//      singularity.` 的 `A.I` 被当成"命名空间 A 的成员 I"→ 好产物误报 1 → 判定
//      断言失效 → CI 从 0.3.0 起一路红（本机不跑这个脚本，所以三天没发现）。
//
// 现在的做法：**不再自己写屏蔽器**，直接调唯一实现 tools/lib/dangling.py
// （构建期守卫 tools/build-plugin.py 用的也是它）。两边判据同一个来源，
// 不会再出现"验证脚本和守卫各错一半、互相掩盖"的情况。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = path.join(ROOT, 'lib', 'client.js');
const CHECKER = path.join(ROOT, 'tools', 'lib', 'dangling.py');

const good = fs.readFileSync(ARTIFACT, 'utf8');
const bad = good.replace(
  /const blocked = shouldBlockNew\(todayStats\(\)\);/,
  'const blocked = Q.shouldBlockNew(todayStats());',
);
if (bad === good) {
  console.log('✗ 无法制造坏样本（产物里那段代码改名了？先看 verify-dangling-guard.mjs 的注入点）');
  process.exit(1);
}

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python');
const tmpBad = path.join(os.tmpdir(), `vocab-study-dangling-bad-${process.pid}.js`);

function check(file) {
  const r = spawnSync(PYTHON, [CHECKER, file], { encoding: 'utf8' });
  if (r.error) {
    console.log(`✗ 跑不动 ${PYTHON}：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.log(`✗ 检查器异常退出（${r.status}）：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    process.exit(1);
  }
  const out = (r.stdout || '').trim().split('\n');
  const count = Number((out.find((l) => l.startsWith('COUNT ')) || 'COUNT -1').slice(6));
  const hits = out.filter((l) => l.startsWith('HIT ')).map((l) => l.slice(4));
  return { count, hits };
}

let goodRes;
let badRes;
try {
  goodRes = check(ARTIFACT);
  fs.writeFileSync(tmpBad, bad, 'utf8');
  badRes = check(tmpBad);
} finally {
  fs.rmSync(tmpBad, { force: true });
}

console.log(`好产物 悬空数 = ${goodRes.count}`);
console.log(`坏产物 悬空数 = ${badRes.count}`);
if (badRes.hits.length) console.log('  坏产物抓到的: ' + badRes.hits.join(', '));

const pass = goodRes.count === 0 && badRes.hits.some((h) => h.startsWith('Q.shouldBlockNew'))
  && badRes.count === 1;
console.log('');
if (goodRes.count > 0) {
  console.log('⚠ 好产物也有悬空（判据过严，会误报）: ' + goodRes.hits.join(', '));
}
if (badRes.count === 0) {
  console.log('⚠ 坏产物没被抓到（判据过松，会漏报）: 注入的 Q.shouldBlockNew 没被扫出来');
}
console.log(pass ? '✅ 断言有效：好产物干净、坏产物被抓出' : '❌ 断言无效');
process.exit(pass ? 0 : 1);
