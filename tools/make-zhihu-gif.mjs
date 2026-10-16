// 从录屏原片剪一段做成知乎正文用的 GIF
//
// 为什么重做：原来的 功能巡览.gif 只有 431×696 / 5fps / 12 帧 —— 本质是幻灯片，
// 知乎正文宽度约 690px，放大会糊。录屏原片是 1438×1602 裁切后的高清，重做能得到
// 更宽、帧率更高、体积可控的 GIF（并带调色板优化，否则 GIF 会巨大）。
//
// 用法: node tools/make-zhihu-gif.mjs [起始秒] [时长秒]

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync } from 'node:fs';

import { assetsDir, asset } from './assets-dir.mjs';
const FF = 'C:/Users/21653/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe';
const REC = 'F:/DeepSeek Harness/projects/_bili_build/rec/rec.mp4';
const OUT = asset('10-知乎/文章');

const START = process.argv[2] ?? '4';    // 从第几秒开始（录屏 0-30s 是今日词卡）
const DUR = process.argv[3] ?? '7';      // 剪多长

if (!existsSync(REC)) { console.error('录屏原片不在: ' + REC); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const W = 700;          // 输出宽（知乎正文 ~690px，取 700 基本 1:1）
const FPS = 12;         // 对齐桌面小猫那份的帧率
const target = `${OUT}/2-动画演示.gif`;

// 滤镜链：裁切 → 缩放到宽 700 → 12fps → 调色板 → 抖动
//
// ⚠️ 裁切范围是量出来的，不是估的。第一版用 crop=iw*0.72:ih*0.62:iw*0.16:ih*0.08，
//    实测把「忘了/模糊/会了」三个评分按钮的下沿切掉了 —— 而那排按钮正是这段演示的重点。
//    这一版把纵向起点往上挪、高度加大，保证整排按钮完整。
const vf = [
  `crop=iw*0.66:ih*0.80:iw*0.19:ih*0.02`,   // 纵向覆盖 y≈2%~82%，装得下整排按钮
  `scale=${W}:-1:flags=lanczos`,
  `fps=${FPS}`,
  `split[a][b]`,
  `[a]palettegen=max_colors=128[p]`,
  `[b][p]paletteuse=dither=bayer:bayer_scale=3`,
].join(',');

const cmd = `"${FF}" -v error -ss ${START} -t ${DUR} -i "${REC}" -vf "${vf}" -loop 0 "${target}" -y`;
execFileSync(cmd, { shell: true, stdio: 'inherit' });

const st = statSync(target);
console.log(`  ✅ ${target}`);
console.log(`     ${W}px 宽 · ${FPS}fps · ${DUR} 秒 · ${(st.size / 1024).toFixed(0)} KB`);
