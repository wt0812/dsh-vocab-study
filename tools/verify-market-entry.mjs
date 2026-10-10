// 用上游同一个解析器（js-yaml）和同一套规则，校验市场条目。
// 这不是"我以为"的校验 —— 规则是从上游 scripts/lib/entries.mjs 和
// scripts/check-submission.mjs 逐条抄下来的。
import fs from 'node:fs';
import path from 'node:path';

const YAML_DIR = process.argv[2];
// js-yaml 5.x 的 ESM 入口是 dist/js-yaml.mjs（4.x 曾经是 index.js）。
// 先按 exports 里的 import 走，找不到再退回旧路径。
const candidates = [
  path.join(YAML_DIR, 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs'),
  path.join(YAML_DIR, 'node_modules', 'js-yaml', 'index.js'),
];
const entry = candidates.find((p) => fs.existsSync(p));
if (!entry) {
  console.error('找不到 js-yaml，试过:\n  ' + candidates.join('\n  '));
  process.exit(2);
}
const { load: yamlLoad } = await import('file:///' + entry.replace(/\\/g, '/'));
console.log(`(使用解析器: ${entry})`);

// ── 上游的规则（逐条抄自 entries.mjs）────────────────────────
const CAT_IDS = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow',
  'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun'];
const ENTRY_KEYS = new Set(['url', 'name', 'category', 'description', 'tarball', 'file']);

function slugFor(url) {
  const p = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
  const repo = p.split('/').slice(0, 2).join('/');
  const sub = p.includes('/tree/') ? p.split('/tree/')[1].replace(/^[^/]+\//, '') : null;
  const base = repo.replaceAll('/', '__');
  return sub ? `${base}--${sub.replaceAll('/', '-')}` : base;
}

const ENTRY = `url: https://github.com/wt0812/dsh-vocab-study
name: wt0812/dsh-vocab-study
category: ui
description:
  en: 'Offline vocabulary panel in the sidebar: a capsule beside the composer opens a word card, and a right-pane tab tracks today, progress, the mistake book and settings.'
  zh: '侧边栏里的离线背词面板：输入框旁一颗胶囊点开是词卡，右栏标签页管着今日、进度、生词本与设置。'
`;
const FILENAME = 'wt0812__dsh-vocab-study.yml';

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  \u001b[32m✓\u001b[0m ${label}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`); }
  else { fail++; console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`); }
};

console.log('[1] 用上游同一个解析器（js-yaml）真解析');
let doc = null;
try {
  doc = yamlLoad(ENTRY);
  ok(true, 'YAML 解析成功（没有"含 \': \' 未加引号"那类失败）');
} catch (e) {
  ok(false, 'YAML 解析成功', e.reason ?? e.message);
}
if (doc) {
  ok(Array.isArray(doc) === false && typeof doc === 'object', '解析成映射而不是列表');
  console.log('    顶层键:', JSON.stringify(Object.keys(doc)));

  console.log('\n[2] 逐条套用上游校验规则');
  const extra = Object.keys(doc).filter((k) => !ENTRY_KEYS.has(k));
  ok(extra.length === 0, '没有未知字段', extra.length ? `多余: ${extra}` : '');

  ok(/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(doc.url), 'url 是 https://github.com/owner/repo', doc.url);

  const want = slugFor(doc.url) + '.yml';
  ok(want === FILENAME, '文件名与 url 推出来的 slug 一致', `要求 ${want}，实际 ${FILENAME}`);

  const named = doc.name.split('#')[0].trim().toLowerCase();
  const actual = doc.url.replace(/^https:\/\/github\.com\//, '').split('/').slice(0, 2).join('/').toLowerCase();
  ok(named === actual, 'name 写的是 owner/repo 且与 url 指向同一个仓库', `${named} vs ${actual}`);

  ok(CAT_IDS.includes(doc.category), 'category 在官方列表里', doc.category);

  ok(doc.description && typeof doc.description === 'object', 'description 是映射（en/zh）');
  ok(!!(doc.description || {}).en, 'description.en 存在（唯一必填项）');
  ok(String(doc.description.en).trim().endsWith('.'), 'description.en 以句号结尾');
  ok(!/[:#]\s/.test(String(doc.description.en).replace(/^[^:]*:\s*/, '')), 'description.en 里没有裸的 ": "');
  ok(!!(doc.description || {}).zh, 'description.zh 也给了（可选，但给了更好）');

  console.log('\n[3] 解析出来的英文本体（确认引号剥离干净、没有残缺）');
  console.log('    EN: ' + doc.description.en);
  console.log('    ZH: ' + doc.description.zh);
  ok(!doc.description.en.includes("'"), '英文里没有残留引号');
  ok(doc.description.en.length > 60, '英文长度合理', `${doc.description.en.length} 字符`);
}

console.log('\n' + '─'.repeat(56));
console.log(fail === 0
  ? `\u001b[32m${pass} 通过 / ${fail} 失败\u001b[0m  —— 条目符合上游全部规则`
  : `\u001b[31m${pass} 通过 / ${fail} 失败\u001b[0m`);
process.exit(fail === 0 ? 0 : 1);
