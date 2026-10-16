// 生成每个平台目录的「本文件夹内容.txt」，格式照 DesktopCat 的 00-先看这里.txt：
// 文件名 + 字节数 + (图片额外加尺寸)，并给出上传顺序
//
// 用法: node tools/make-folder-index.mjs

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { assetsDir, asset } from './assets-dir.mjs';
const R = assetsDir;
const FF = 'C:/Users/21653/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-essentials_build/bin/ffprobe.exe';

const PLATFORMS = {
  '04-小红书': { name: '小红书', how: '打开就能发，图已按上传顺序编号' },
  '05-少数派': { name: '少数派', how: '要审核（慢），但背书强' },
  '06-Appinn': { name: '小众软件 Appinn', how: '要审核（慢），新号审核期会被临时禁用' },
  '08-B站': { name: 'B站', how: '视频 + 简介 + 置顶评论都备好了' },
  '09-掘金': { name: '稀土掘金', how: '写文章，不是答题；图已按上传顺序编号' },
  '10-知乎': { name: '知乎', how: '去回答已有问题，别自问自答' },
  '11-抖音': { name: '抖音', how: '缺视频本身，要你录' },
};

const isImg = (f) => /\.(png|jpe?g|gif|webp)$/i.test(f);
const dims = (p) => {
  try {
    const d = execFileSync(FF, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p], { encoding: 'utf8' }).trim();
    return d ? ` (${d.replace(',', '×')})` : '';
  } catch { return ''; }
};

for (const [folder, meta] of Object.entries(PLATFORMS)) {
  const dir = `${R}/${folder}`;
  const files = readdirSync(dir).filter((f) => !f.startsWith('本文件夹内容') && !f.startsWith('.')).sort();

  const docs = files.filter((f) => /\.(md|txt)$/i.test(f));
  const imgs = files.filter(isImg);
  const vids = files.filter((f) => /\.(mp4|mov)$/i.test(f));

  const out = [];
  out.push(`本文件夹：${folder} —— ${meta.how}`);
  out.push('='.repeat(56));
  out.push('');

  if (docs.length) {
    out.push('【先看这两个 · 纯文字，不含图】');
    docs.forEach((f) => {
      const p = `${dir}/${f}`;
      out.push(`  ${f}`);
      const hint = f.startsWith('0-') ? '  ← 操作步骤 + 标题候选，先打开这个'
        : f.startsWith('1-') ? '  ← 正文，整段复制粘贴到发布框'
          : '';
      out.push(`      ${statSync(p).size} 字节${hint}`);
    });
    out.push('');
  }

  if (imgs.length) {
    out.push(`【图】共 ${imgs.length} 张，文件名前面的数字 = 上传顺序`);
    imgs.forEach((f) => {
      const p = `${dir}/${f}`;
      const kb = (statSync(p).size / 1024).toFixed(0);
      out.push(`  ${f.padEnd(28)} ${String(kb).padStart(5)} KB${dims(p)}`);
    });
    out.push('');
  }

  if (vids.length) {
    out.push('【视频】');
    vids.forEach((f) => {
      const p = `${dir}/${f}`;
      out.push(`  ${f}   ${(statSync(p).size / 1024 / 1024).toFixed(2)} MB`);
    });
    out.push('');
  }

  out.push('【发布顺序】');
  const imgsNum = imgs.filter((f) => /^\d/.test(f));
  if (imgsNum.length) {
    out.push(`  图按 ${imgsNum[0].split('-')[0]} → ${imgsNum[imgsNum.length - 1].split('-')[0]} 的顺序上传`);
  }
  out.push('');

  writeFileSync(`${dir}/本文件夹内容.txt`, out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', { encoding: 'utf8' });
  console.log(`  ✅ ${folder}/本文件夹内容.txt  （${docs.length} 文档 / ${imgs.length} 图 / ${vids.length} 视频）`);
}
