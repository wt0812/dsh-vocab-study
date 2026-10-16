// 核对要写进宣传文案 / README 的数字
//
// ⚠️ 这个脚本有两件事容易踩：
//   1) 「静默失败」有两个口径，别混用：
//        - 严格（本脚本用）：不报错 / 毫无反应 / 不提示     → 用来对外说「N 起一点报错都没有」
//        - 宽松（见 tools/count-silent-failures.mjs）：再加「测试全绿」→ 会数到 12 起
//      两个数都对，但**用途不同**，对外只用严格的 5。
//   2) EXPECTED_BYTES 是**期望值**，不是基准：
//      它跟着 README 走。改了 README 就同步改这里，否则会对着新产物报假警报。
//      （2026-10-16 就踩过一次：产物已经 3,003,897，脚本还写着 3,002,297。）
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// README 里当前写的体积（改了 README 记得改这里）
const EXPECTED_BYTES = 3003897;

const actual = statSync(join(ROOT, 'lib/client.js')).size;
console.log(
  `  lib/client.js 实测 ${actual} 字节，期望 ${EXPECTED_BYTES} → ` +
    (actual === EXPECTED_BYTES ? '一致 ✅' : `不一致 ⚠️ 差 ${actual - EXPECTED_BYTES}`),
);

const lines = readFileSync(join(ROOT, 'docs/INCIDENTS.md'), 'utf8').split('\n');
const idx = [];
lines.forEach((l, i) => {
  if (/^### 事故/.test(l)) idx.push(i);
});
// 严格口径：只认「用户完全看不出出事了」这几种说法
const KEYS = ['不报错', '毫无反应', '不提示'];
let n = 0;
const names = [];
idx.forEach((s, k) => {
  const e = k + 1 < idx.length ? idx[k + 1] : lines.length;
  let hit = false;
  for (let j = s; j < e; j++) if (KEYS.some((x) => lines[j].includes(x))) hit = true;
  if (hit) {
    n++;
    names.push(lines[s].replace(/^### /, '').slice(0, 16));
  }
});
console.log(`  事故总数 ${idx.length}，严格口径（不报错/毫无反应/不提示）${n} 起`);
console.log(`  分别是：${names.join(' / ')}`);
console.log('');
console.log('  > 对外口径用这个数。宽松口径（含「测试全绿」）见 tools/count-silent-failures.mjs。');
