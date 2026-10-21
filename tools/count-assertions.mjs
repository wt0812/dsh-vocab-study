/** 数一遍全部测试套件的断言数（给文档 / 发布说明用，避免手写数字）。
 *
 *  口径（和 `tools/make-promo.mjs` 的 countAssertions 一致）：
 *  **套件打印的汇总数字 + 该套件「健全性附加检查」里 ✓ 的条数**。
 *  为什么不能只抓汇总行：core.test.mjs 先打印 `85 通过 / 0 失败`，之后还跑一段
 *  附加体检，那些 ✓ 不在汇总里 —— 只抓汇总的话，附加检查里加多少条数字都不动。
 *
 *  用法: node tools/count-assertions.mjs
 */
import { spawnSync } from 'node:child_process';

const SUITES = ['core', 'roots', 'weekly-report', 'plugin', 'demo-boot', 'client-activation',
  'bundle-audit', 'mount', 'round-control', 'multi-conversation', 'examples-etym', 'collocations'];

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let total = 0;
const per = {};
const failed = [];
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [`test/${s}.test.mjs`], { encoding: 'utf8' });
  const out = strip(`${r.stdout || ''}${r.stderr || ''}`);
  const m = out.match(/(\d+)\s*(?:通过|passed)/);
  let n = m ? Number(m[1]) : (out.match(/[✓✔]/g) || []).length;
  const extraSeg = out.includes('健全性附加检查')
    ? out.slice(out.lastIndexOf('健全性附加检查'))
    : '';
  n += (extraSeg.match(/[✓✔]/g) || []).length;
  per[s] = n;
  total += n;
  if (r.status !== 0) failed.push(s);
  console.log(`  ${s.padEnd(20)} ${String(n).padStart(4)} 条${r.status !== 0 ? '  ✗ 套件失败' : ''}`);
}
console.log(`  合计 ${total} 条断言 / ${SUITES.length} 个套件${failed.length ? `（失败：${failed.join(', ')}）` : '，全部通过'}`);
console.log('  明细: ' + Object.entries(per).map(([k, v]) => `${k}=${v}`).join('  '));
process.exitCode = failed.length ? 1 : 0;
