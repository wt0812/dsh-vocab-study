/** 打包前清掉 Python 字节码缓存。
 *
 *  为什么需要这一步：`package.json` 的 `files` 白名单里写了 `"tools"`，
 *  而 **npm 明确规定「files 里点名的目录，.npmignore 排不掉」** ——
 *  所以 `.npmignore` 里的 `__pycache__/` 对 `tools/` 无效。
 *  Python 脚本跑过一次就会留下 `tools/__pycache__/*.pyc`，
 *  实测 0.3.0 发布时就把其中一个 31 KB 的 .pyc 打进了包里。
 *  这里在 prepack 阶段直接删掉，不靠人记得。
 *
 *  ⚠️ 路径必须走 fileURLToPath：第一次写成 `new URL('..', import.meta.url).pathname`，
 *  路径里带 `%20`（"DeepSeek Harness" 有空格）→ readdir 抛错 → 被 catch 吞掉 →
 *  脚本"成功"地什么也没删，而包里那个 .pyc 还在。所以这里不再吞异常。
 */
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir, hits = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '__pycache__') hits.push(full);
      else walk(full, hits);
    }
  }
  return hits;
}

const hits = walk(ROOT);
for (const dir of hits) rmSync(dir, { recursive: true, force: true });
console.log(hits.length ? `清掉 ${hits.length} 个 __pycache__ 目录` : '没有 __pycache__ 需要清理');
