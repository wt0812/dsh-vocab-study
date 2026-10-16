// vocab-study / tools / assets-dir.mjs
// 发布素材根目录的唯一解析处。
//
// 为什么要有这个文件：素材目录以前写死在 `C:/Users/21653/Desktop/vocab-study-发布素材`，
// 分散在 10 个工具脚本里。素材一挪地方，10 个脚本全断。
// 现在所有脚本都从这里取路径，以后挪只用改这一处（或者设个环境变量）。
//
// 查找顺序：
//   1. 环境变量 VOCAB_ASSETS —— 想临时指到别处（比如 U 盘、另一台机器）就设它
//   2. 脚本旁边的 ../vocab-study-发布素材      （仓库的兄弟目录，当前实际位置）
//   3. 老位置的桌面副本                        （过渡期兼容，桌面那份删掉后就自动失效）
//
// 用法:
//   import { assetsDir, asset } from './assets-dir.mjs';
//   const OUT = asset('11-抖音');

import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // .../vocab-study/tools
const REPO = resolve(HERE, '..');                        // .../vocab-study

// 显式设了 VOCAB_ASSETS 就以它为准：不许静默回退。
// 打错一个字就悄悄用回兄弟目录，比直接报错更难查。
if (process.env.VOCAB_ASSETS) {
  if (!existsSync(process.env.VOCAB_ASSETS)) {
    console.error('');
    console.error(`  ❌ VOCAB_ASSETS 指向的目录不存在：`);
    console.error(`       ${process.env.VOCAB_ASSETS}`);
    console.error('     既然显式设了它，就以它为准（不会静默改用别处）。');
    console.error('');
    process.exit(1);
  }
  console.log(`  [assets] 用 VOCAB_ASSETS 指定的目录: ${process.env.VOCAB_ASSETS}`);
}

const CANDIDATES = [
  process.env.VOCAB_ASSETS,
  join(REPO, '..', 'vocab-study-发布素材'),              // 兄弟目录（当前）
  'C:/Users/21653/Desktop/vocab-study-发布素材',         // 老位置（过渡期）
];

const found = CANDIDATES.find((p) => p && existsSync(p));

if (!found) {
  console.error('');
  console.error('  ❌ 找不到发布素材目录。找过这些位置：');
  for (const p of CANDIDATES) if (p) console.error(`       ${p}`);
  console.error('');
  console.error('  解决办法（二选一）：');
  console.error('    1. 把素材目录放回 vocab-study 旁边，名字叫 vocab-study-发布素材');
  console.error('    2. 设环境变量指定位置：');
  console.error('       $env:VOCAB_ASSETS = "D:\\某处\\vocab-study-发布素材"');
  console.error('');
  process.exit(1);
}

/** 发布素材根目录（绝对路径，正斜杠） */
export const assetsDir = found.replace(/\\/g, '/');

/** 拼一个素材子路径：asset('11-抖音') → <root>/11-抖音 */
export const asset = (...parts) => [assetsDir, ...parts].join('/');

export default assetsDir;
