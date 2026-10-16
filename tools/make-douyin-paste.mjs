import { writeFileSync } from 'node:fs';
import { asset } from './assets-dir.mjs';

// 从手写的正本里抽出「发布时要粘」的部分，生成抖音的一键复制文件。
// 为什么不让 make-copy-paste.mjs 自己内嵌一份：内嵌的副本会过期
// （它那份还是旧的视频分镜 + 「11 起事故」，实际已是图文 + 14 起）。

const raw = (await import('node:fs')).readFileSync(asset('11-抖音', '1-正文（整篇粘贴）.md'), 'utf8');

const sec = (start, end) => {
  const a = raw.indexOf(start);
  if (a < 0) throw new Error(`找不到小节: ${start}`);
  const b = end ? raw.indexOf(end, a) : raw.length;
  return raw.slice(a + start.length, b < 0 ? raw.length : b).trim();
};

const titles = raw.split('════════ 标题')[1].split('════════ 发布时的文案')[0]
  .split('\n').filter(l => /^\s*\d\.\s/.test(l)).join('\n');

const body = sec('════════ 发布时的文案（整段复制）════════', '════════ 每张图的贴纸文字');
const sticker = sec('════════ 每张图的贴纸文字（你在抖音编辑器里加文字用）════════', '════════ 标签');
const tags = sec('════════ 标签（复制到标签栏）════════', '════════ 发完之后：置顶评论');
const comment = sec('════════ 发完之后：置顶评论 ════════');

const out = `抖音 · 图文（8 张图，不用录屏）
${'─'.repeat(48)}

【标题】抖音硬上限 20 字，挑一个：

${titles}

${'─'.repeat(48)}
【正文】（整段复制到文案框）

${body}

${'─'.repeat(48)}
【标签】

${tags}

${'─'.repeat(48)}
【第一张评论 · 置顶】

${comment}

${'─'.repeat(48)}
【每张图的贴纸文字】（可选：想自己加更大字号的文字时用）

${sticker}
`;

writeFileSync(asset('11-抖音', '一键复制-粘贴用.txt'), out.trimEnd() + '\n', { encoding: 'utf8' });
console.log(`  ✅ 11-抖音/一键复制-粘贴用.txt  ${out.length} 字`);
console.log(`     （内容全部来自手写的 1-正文（整篇粘贴）.md，没有内嵌副本）`);
