// vocab-study / tools / make-cet4-extra.mjs
//
// 生成 core/seed-cet4-extra.mjs —— 四级词表的「补全部分」。
//
// 背景（真实缺口，不是凑数）：
//   四级离线词表原来只有 core/seed-cet4.mjs 里手写的 116 个词，而四级考纲有
//   4,600+ 词。后果是「离线模式 · 用内置词表」选四级时，agree / arrive / hear /
//   spend 这些最基础的四级词**根本不在词表里** —— 不是没有例句，是这个词不存在。
//   远程词表能补上，但断网时用户就只剩 116 个词。
//
// 做法：把公开四级词表（mahavivo/english-wordlists 的 CET4_edited.txt）里
//   手写 116 个词之外的词全部收进来，作为 seed 的一部分。手写的 116 个词
//   **仍然优先**（它们带人工例句/例句译文/搭配/词根），这里只补缺。
//
// 用法：
//   node tools/make-cet4-extra.mjs            # 下载（有缓存则用缓存）后生成
//   node tools/make-cet4-extra.mjs --offline  # 只用本地缓存，不联网
//
// 输出格式与 seed-exams.mjs 一致：[单词, 音标, 释义] 三元组（省体积）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedFor } from '../core/library.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE_DIR = resolve(ROOT, '_ecdict');
const CACHE = resolve(CACHE_DIR, 'CET4_edited.txt');
const OUT = resolve(ROOT, 'core/seed-cet4-extra.mjs');
const SRC = 'https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/CET4_edited.txt';

const offline = process.argv.includes('--offline');

async function loadSource() {
  if (existsSync(CACHE)) {
    console.log(`  用缓存：${CACHE}`);
    return readFileSync(CACHE, 'utf8');
  }
  if (offline) {
    throw new Error(`离线模式但缓存不存在：${CACHE}`);
  }
  console.log(`  下载：${SRC}`);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE, text, 'utf8');
  console.log(`  已缓存：${CACHE}`);
  return text;
}

// 行格式：`abandon [əˈbændən] vt.丢弃；放弃，抛弃`
// 也有 `a art.一(个)；每一(个)` 这种没有音标的，和 `ice cream [..] n.` 这种带空格的词。
//
// ⚠️ 不能用懒匹配 `^([A-Za-z][A-Za-z '-]*?)\s*(?:\[([^\]]*)\])?\s*(.*)$`：
//   lazy 会让 word 组只吃第一个字母，`baby [ˈbeibi] n.婴儿` 变成 word='b'、
//   meaning='aby [ˈbeibi] n.婴儿'（实测生成出 a/b/c/d/e 五个假词条就是这么来的）。
// 正确做法：先看有没有音标方括号做分隔符，没有就找词性标记 `n.` / `vt.` 之类再切。
const POS_START = /\s(?=(?:art|prep|pron|conj|ad|adv|adj|vt|vi|v|n|a|num|int|aux|abbr)\s*\.)/;

function parseLine(line) {
  const s = line.trim();
  if (!s) return null;
  if (!/^[A-Za-z]/.test(s)) return null;
  if (/^\(共/.test(s)) return null;
  if (/^[A-Z]$/.test(s)) return null;
  if (/^[A-Za-z ]+$/.test(s) && !/^[a-z]/.test(s)) return null; // 标题行

  let word = '';
  let ipa = '';
  let meaning = '';

  const br = s.match(/^(.+?)\s*\[([^\]]*)\]\s*(.*)$/);
  if (br) {
    word = br[1].trim();
    ipa = br[2].trim();
    meaning = br[3].trim();
  } else {
    const m = s.match(POS_START);
    if (!m) return null;
    word = s.slice(0, m.index).trim();
    meaning = s.slice(m.index).trim();
  }

  if (!word || !meaning) return null;
  if (!/^[A-Za-z][A-Za-z '-]*$/.test(word)) return null;
  if (!/^[a-z]/.test(word)) return null;          // 表头那种大写开头的不要
  meaning = meaning.replace(/\s+/g, ' ').slice(0, 60);
  return { word, ipa, meaning };
}

const text = await loadSource();
const rows = text.split(/\r?\n/).map(parseLine).filter(Boolean);

// 手写的 116 个词优先，不再重复收
const manual = new Set(seedFor('cet4').map((w) => String(w.word).toLowerCase()));
const seen = new Set();
const keep = [];
for (const r of rows) {
  const key = r.word.toLowerCase();
  if (manual.has(key) || seen.has(key)) continue;
  seen.add(key);
  keep.push(r);
}

const lines = [
  '// vocab-study / core / seed-cet4-extra.mjs',
  '// ⚠️ 生成产物，不要手改：node tools/make-cet4-extra.mjs',
  '//',
  '// 四级词表的补全部分：core/seed-cet4.mjs 里手写的 116 个词之外的考纲词。',
  '// 手写的词仍然优先（带人工例句/译文/搭配/词根），这里只补缺。',
  '// 来源：https://github.com/mahavivo/english-wordlists 的 CET4_edited.txt',
  '// 格式与 seed-exams.mjs 一致：[单词, 音标, 释义]',
  '',
  'export const SEED_CET4_EXTRA_RAW = [',
];
for (const r of keep) {
  const cell = (v) => JSON.stringify(v);
  lines.push(`  [${cell(r.word)}, ${cell(r.ipa)}, ${cell(r.meaning)}],`);
}
lines.push('];', '');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`  源词条 ${rows.length} 个，手写已收 ${manual.size} 个，写出补全 ${keep.length} 个`);
console.log(`  产物 ${OUT}  ${(readFileSync(OUT).length / 1024).toFixed(0)} KB`);

