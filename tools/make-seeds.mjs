/**
 * 生成各词库的**内置**词表 → core/seed-exams.mjs
 *
 * 为什么要自己生成：
 *   1. 常规词表源（mahavivo/english-wordlists）**没有雅思**，实测 404。
 *   2. 内置降级原来是把四级那 120 个词换个前缀冒充六级/雅思 —— 假数据。
 *
 * 数据来源：ECDICT（https://github.com/skywind3000/ECDICT，MIT 许可，可再分发）
 * 它的 `tag` 列带官方考纲标签：zk / gk / cet4 / cet6 / ky / toefl / ielts / gre
 *
 * ⚠️ 这是**离线跑一次**的工具，产物 core/seed-exams.mjs 要提交进仓库。
 *    源码 50MB 太大不能打进来，运行时要的是筛完的小文件。
 *
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 node tools/make-seeds.mjs
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const SRC = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';
const OUT = resolve('core/seed-exams.mjs');

/** ECDICT 的 tag 值 → 我们的词库 key */
const TARGETS = [
  ['cet6', 'cet6', 'SEED_CET6'],
  ['kaoyan', 'ky', 'SEED_KAOYAN'],
  ['toefl', 'toefl', 'SEED_TOEFL'],
  ['gre', 'gre', 'SEED_GRE'],
  ['ielts', 'ielts', 'SEED_IELTS'],
];

/** CSV 解析：字段里有引号包裹、逗号、转义的 \n，必须按引号规则切。 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

console.log('下载 ECDICT…');
const res = await fetch(SRC, { headers: { 'User-Agent': 'vocab-study-seed-gen' } });
if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
const text = await res.text();
console.log(`  ${(text.length / 1048576).toFixed(1)} MB`);

const lines = text.split(/\r?\n/);
const header = parseCsvLine(lines[0]);
const idx = (k) => header.indexOf(k);
const iWord = idx('word');
const iPhon = idx('phonetic');
const iTrans = idx('translation');

// 每个目标词库各收一批
const buckets = new Map(TARGETS.map(([key]) => [key, new Map()]));
let scanned = 0;

for (const line of lines.slice(1)) {
  if (!line) continue;
  scanned++;
  const cols = parseCsvLine(line);
  const tag = cols[idx('tag')] || '';
  if (!tag) continue;
  const tags = tag.trim().split(/\s+/);

  for (const [key, tagValue, _constName] of TARGETS) {
    if (!tags.includes(tagValue)) continue;
    const bucket = buckets.get(key);
    const word = (cols[iWord] || '').trim();
    if (!word || !/^[A-Za-z][A-Za-z '-]*$/.test(word)) continue;
    const k = word.toLowerCase();
    if (bucket.has(k)) continue;

    const ipa = (cols[iPhon] || '').trim();
    let meaning = (cols[iTrans] || '').replace(/\\n/g, '；').replace(/\s+/g, ' ').trim();
    if (!meaning) meaning = (cols[idx('definition')] || '').replace(/\\n/g, '；').replace(/\s+/g, ' ').trim();
    bucket.set(k, { word, ipa, meaning: meaning.slice(0, 120) });
  }
}

console.log(`  扫描 ${scanned} 行`);
console.log();
console.log('词库      词数');
console.log('-'.repeat(30));
const parts = [];
for (const [key, _tag, constName] of TARGETS) {
  const rows = [...buckets.get(key).values()].sort((a, b) =>
    a.word.toLowerCase().localeCompare(b.word.toLowerCase())
  );
  console.log(`${key.padEnd(10)}${rows.length}`);
  parts.push({ constName, rows });
}

const head =
  '// vocab-study / core / seed-exams.mjs\n' +
  '//\n' +
  '// ⚠️ **这个文件是生成的，不要手改。**\n' +
  '//    生成命令：NODE_USE_ENV_PROXY=1 HTTPS_PROXY=... node tools/make-seeds.mjs\n' +
  '//\n' +
  '// 各词库的**内置**词表，用途有两个：\n' +
  '//   1. 取不到远程词表时降级（界面显示「离线模式 · 用内置词表」）\n' +
  '//   2. 六个词库的降级内容**各不相同** —— 以前是把四级那 120 个词换个\n' +
  '//      id 前缀冒充六级/雅思，那是假数据，比"词表为空"更坏。\n' +
  '//\n' +
  '// 来源：ECDICT (https://github.com/skywind3000/ECDICT) MIT 许可，按考纲 tag 筛出。\n' +
  '// 每条格式：[单词, 音标, 释义]，压缩成数组省体积。\n' +
  '\n';

const body = parts
  .map(({ constName, rows }) =>
    `export const ${constName} = [\n` +
    rows.map((r) => `  ${JSON.stringify([r.word, r.ipa, r.meaning])},`).join('\n') +
    '\n];\n'
  )
  .join('\n');

const counts = parts.map(({ constName, rows }) => `${constName}: ${rows.length}`).join('\n');
const tail = `\nexport const SEED_EXAM_COUNTS = {\n${counts.split('\n').map((l) => '  ' + l.split(': ')[0] + ': ' + l.split(': ')[1] + ',').join('\n')}\n};\n`;

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, head + body + tail, 'utf8');
console.log();
console.log(`写入 ${OUT}  (${((head + body + tail).length / 1024).toFixed(1)} KB)`);
for (const { constName, rows } of parts) {
  console.log(`  ${constName} 样例: ${JSON.stringify(rows.slice(0, 2).map((r) => r.word))}`);
}
