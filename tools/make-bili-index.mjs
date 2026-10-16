// 生成 08-B站 的专用索引（含视频信息）
import { readdirSync, statSync, writeFileSync } from 'node:fs';

import { assetsDir, asset } from './assets-dir.mjs';
const p = asset('08-B站');
const files = readdirSync(p).filter((f) => !f.startsWith('本文件夹内容')).sort();
const sz = (f) => statSync(`${p}/${f}`).size;
const out = [];
out.push('本文件夹：08-B站 —— 视频 + 简介 + 置顶评论都备好了');
out.push('='.repeat(56));
out.push('');
out.push('【先看这两个 · 纯文字】');
out.push('  0-操作步骤与标题.md');
out.push(`      ${sz('0-操作步骤与标题.md')} 字节   ← 标题候选 + 发布步骤，先打开这个`);
out.push('  1-正文（整篇粘贴）.md');
out.push(`      ${sz('1-正文（整篇粘贴）.md')} 字节   ← 视频简介 + 标签 + 置顶评论`);
out.push('');
out.push('【视频】');
const vid = files.find((f) => f.endsWith('.mp4'));
out.push(`  ${vid}`);
out.push(`      ${(sz(vid) / 1048576).toFixed(2)} MB  ·  1920×1080  ·  30 fps  ·  84.80 秒`);
out.push('      前面 12 秒是 4 张静态轮播，后面 72.8 秒是录屏（已裁掉隐私边缘 + 上了字幕）');
out.push('');
out.push('【图】文件名数字 = 上传顺序');
files.filter((f) => /\.(png|gif)$/.test(f)).forEach((f) => {
  out.push(`  ${f.padEnd(30)} ${(sz(f) / 1024).toFixed(0).padStart(5)} KB`);
});
out.push('');
out.push('【发布顺序】');
out.push('  1. 传视频（dsh-vocab-study-bilibili-v1.mp4）');
out.push('  2. 封面用 2-封面-带界面.png（备选：3-封面-备选.png）');
out.push('  3. 简介整段复制 1-正文（整篇粘贴）.md 里的「视频简介」那一段');
out.push('  4. 发布后自己发一条置顶评论（同文件里的「置顶评论」）');
out.push('');

writeFileSync(`${p}/本文件夹内容.txt`, out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
console.log('  ✅ 08-B站/本文件夹内容.txt 已更新');
out.forEach((l) => console.log('    ' + l));
