// B站视频生成：前面静态轮播 + 后面拼接录屏 + BGM
// 用法: node tools/make-bili-video.mjs
//
// 参考对象：桌面小猫 DesktopCat-bilibili-upload-v1.1-merged.mp4
//   1920x1080 / 30fps / 幻灯片硬切，每张淡入淡出
//
// 重要：源录屏左下角有真实计费金额、掩码手机号、私人工作区名，
//       必须裁掉左侧 >=420px 才能公开发布。
//
// BGM：由 tools/make-bgm.mjs 合成（零版权，不用任何外部音频素材）

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

import { assetsDir, asset } from './assets-dir.mjs';
const FF = 'C:/Users/21653/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe';
const FP = FF.replace(/ffmpeg\.exe$/, 'ffprobe.exe');

// 录屏原片。放在发布素材的根目录里（和「发布总流程.md」「00-先看这里.txt」同级）。
// ⚠️ 这个路径改过：原来指向 C:/Users/21653/Desktop/QQ20261013-152809.mp4 ——
//    素材目录整体搬到工作目录之后，桌面那份就不存在了，脚本会直接失败。
const REC = asset('QQ20261013-152809.mp4');
const LIB = assetsDir;
const CARDS = 'F:/DeepSeek Harness/projects/_bili_build/cards';
const OUT = 'F:/DeepSeek Harness/projects/_bili_build';
mkdirSync(OUT, { recursive: true });

const FONT = "C\\:/Windows/Fonts/msyhbd.ttc";
const W = 1920, H = 1080, FPS = 30, FADE = 0.3;

// BGM 增益：实测校准得出（-8 dB → mean -31 dB；原音 mean -50.2 dB）
const BGM = `${OUT}/bgm.m4a`;
const BGM_GAIN = -8;

// 源录屏隐私区宽度：左侧栏含 工作区列表/掩码手机号/计费卡
const CROP_X = 420, SRC_H = 1602, CROP_W = 1858 - CROP_X;

// ────────────────────────────────────────────────
// 1) 轮播幻灯片
//    第 1、4 张用现成横版图；第 2、3 张是竖长条面板截图，
//    居中放进横版很难看 => 用 tools/make-cards 生成的专门横版构图
// ────────────────────────────────────────────────
const slides = [
  { img: `${LIB}/素材库-02-宣传图/hero-1600x1200.png`, dur: 3.0,
    main: '我给 DSH 写了个背单词插件', sub: '长在侧栏里，不用另开 App' },
  { img: `${CARDS}/cardA.png`, dur: 3.0,
    main: '忘了 / 模糊 / 会了', sub: '对应键盘 1 2 3，手不离键盘' },
  { img: `${CARDS}/cardB.png`, dur: 3.0,
    main: '它敢回答「你变强了没有」', sub: '按记忆强度排期算出来的预测' },
  { img: `${LIB}/素材库-02-宣传图/github社交卡片-1280x640.png`, dur: 3.0,
    main: '零运行时依赖 · 400 项断言全绿', sub: 'MIT 开源 · 数据全存本地' },
];

// 已经是 1920x1080 的成品卡片就直接用；否则做背景模糊+居中前景
const isWide = (p) => {
  try {
    const m = execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', p], { encoding: 'utf8' }).trim().split(',');
    return Number(m[0]) === W && Number(m[1]) === H;
  } catch { return false; }
};

const slideParts = [];
slides.forEach((s, i) => {
  if (!existsSync(s.img)) throw new Error(`缺图: ${s.img}`);
  const wide = isWide(s.img);   // 1920x1080 成品卡片 => 直接用，不叠字、不补边

  let fc;
  if (wide) {
    fc = `[0:v]scale=${W}:${H},setsar=1,format=yuv420p,fade=t=in:st=0:d=${FADE},fade=t=out:st=${(s.dur - FADE).toFixed(2)}:d=${FADE}[v]`;
  } else {
    // textfile 必须用相对名 —— 滤镜语法里 ':' 是选项分隔符，绝对路径会被截断
    const fMain = `txt_main${i}.txt`, fSub = `txt_sub${i}.txt`;
    writeFileSync(`${OUT}/${fMain}`, s.main, 'utf8');
    writeFileSync(`${OUT}/${fSub}`, s.sub, 'utf8');
    fc = [
      `[0:v]split=2[bg][fg]`,
      `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=34,eq=brightness=-0.30[bx]`,
      `[fg]scale=${Math.round(W * 0.82)}:-2[fx]`,
      `[bx][fx]overlay=(W-w)/2:(H-h)/2-50[ov]`,
      `[ov]drawbox=x=0:y=${Math.round(H * 0.70)}:w=${W}:h=${Math.round(H * 0.30)}:color=black@0.58:t=fill[db]`,
      `[db]drawtext=fontfile='${FONT}':textfile='${fMain}':x=(w-text_w)/2:y=${Math.round(H * 0.745)}:fontsize=64:fontcolor=white[dt1]`,
      `[dt1]drawtext=fontfile='${FONT}':textfile='${fSub}':x=(w-text_w)/2:y=${Math.round(H * 0.858)}:fontsize=42:fontcolor=0xA8CBFF[dt2]`,
      `[dt2]fade=t=in:st=0:d=${FADE},fade=t=out:st=${(s.dur - FADE).toFixed(2)}:d=${FADE},format=yuv420p[v]`,
    ].join(';');
  }

  const o = `${OUT}/slide${i}.mp4`;
  execFileSync(FF, ['-v', 'error', '-loop', '1', '-t', String(s.dur), '-i', s.img,
    '-filter_complex', fc, '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium',
    '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(s.dur), o, '-y'],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: OUT });
  slideParts.push(o);
  console.log(`  ✅ slide${i}  ${s.dur}s  ${wide ? '[成品横版]' : '[补边]'}  ${s.main || '(卡片自带文案)'}`);
});

writeFileSync(`${OUT}/intro_list.txt`, slideParts.map((p) => `file '${p}'`).join('\n'), 'utf8');
execFileSync(FF, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'intro_list.txt',
  '-c', 'copy', 'intro.mp4', '-y'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: OUT });
console.log(`  ✅ intro.mp4  ${slides.reduce((a, s) => a + s.dur, 0)}s`);

// ────────────────────────────────────────────────
// 2) 录屏段：裁隐私 + 补边到 1920x1080 + 烧字幕
//    字幕只描述界面上真实可见的功能，不编造
// ────────────────────────────────────────────────
const subs = [
  [0.3,  9.0,  '这是我自己写的 DSH 背单词插件'],
  [9.0,  19.0, '碎片时间点开背几个词'],
  [19.0, 30.0, '忘了 / 模糊 / 会了 —— 对应键盘 1 2 3'],
  [30.0, 42.0, '进度页：它敢预测「接下来 30 天还剩多少」'],
  [42.0, 52.0, '生词本：在对话里选中单词就能收藏'],
  [52.0, 62.0, '设置里可换词库、调每天背多少个'],
  [62.0, 73.5, '零运行时依赖 · MIT 开源 · 数据全存本地'],
];

const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
writeFileSync(`${OUT}/sub.ass`, [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Def,Microsoft YaHei UI,46,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,62,1',
  '', '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...subs.map(([a, b, t]) => `Dialogue: 0,${fmt(a)},${fmt(b)},Def,,0,0,0,,${t}`),
].join('\n'), 'utf8');

mkdirSync(`${OUT}/rec`, { recursive: true });
const recFc = [
  `[0:v]crop=${CROP_W}:${SRC_H}:${CROP_X}:0,split=2[bg0][fg0]`,
  `[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28,eq=brightness=-0.25[bgb]`,
  `[fg0]scale=-2:1040[fgs]`,
  `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[comp]`,
  `[comp]ass='sub.ass'[v]`,
].join(';');

execFileSync(FF, ['-v', 'error', '-i', REC, '-filter_complex', recFc,
  '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '128k',
  'rec/rec.mp4', '-y'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: OUT, maxBuffer: 1e8 });
console.log('  ✅ rec.mp4（已裁隐私 + 字幕）');

// ────────────────────────────────────────────────
// 3) 拼接 + 混 BGM
//    音频：轮播段补静音 → 接录屏原音 → 垫上 BGM
//    BGM 增益实测校准（-8 dB → mean -31 dB；原音 mean -50.2 dB）
//
//    ⚠️ 这里**绝对不能用 `-stream_loop -1`**：它是无限输入，
//       配上 amix 会让编码永远不结束（实测跑出 475 MB 还在涨的坏文件）。
//       BGM 改用 tools/make-bgm.mjs 生成**固定长度**文件。
// ────────────────────────────────────────────────

// 成品总时长 = 轮播段 + 录屏段（现测，不写死）
const introDur = slides.reduce((a, s) => a + s.dur, 0);
const recDur = Number(execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', 'rec/rec.mp4'], { encoding: 'utf8', cwd: OUT }).trim());
const TOTAL = introDur + recDur;

// BGM 必须够长；不够就直接报错，而不是偷偷循环
const bgmDur = Number(execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', BGM], { encoding: 'utf8' }).trim());
if (bgmDur < TOTAL) {
  throw new Error(`BGM 只有 ${bgmDur}s，但成品要 ${TOTAL.toFixed(1)}s —— 请重跑 tools/make-bgm.mjs ${Math.ceil(TOTAL) + 3}`);
}
console.log(`  轮播 ${introDur}s + 录屏 ${recDur.toFixed(2)}s = 成品 ${TOTAL.toFixed(2)}s（BGM ${bgmDur}s）`);

const finFc = [
  `[0:v]scale=${W}:${H},setsar=1,fps=${FPS}[iv]`,
  `[1:v]scale=${W}:${H},setsar=1,fps=${FPS}[rv]`,
  `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${introDur},asetpts=N/SR/TB[ia]`,
  `[2:a]aformat=sample_rates=44100:channel_layouts=stereo[ra]`,
  `[iv][ia][rv][ra]concat=n=2:v=1:a=1[v][voice]`,
  `[3:a]volume=${BGM_GAIN}dB,aformat=sample_rates=44100:channel_layouts=stereo[bgm]`,
  `[bgm][voice]amix=inputs=2:duration=first:normalize=0[aout]`,
].join(';');

const FINAL = `${OUT}/dsh-vocab-study-bilibili.mp4`;
execFileSync(FF, ['-v', 'error',
  '-i', 'intro.mp4', '-i', 'rec/rec.mp4', '-i', 'rec/rec.mp4',
  '-i', BGM,
  '-filter_complex', finFc, '-map', '[v]', '-map', '[aout]',
  // 第二道保险：明确限长，任何情况下都不会无限编码
  '-t', TOTAL.toFixed(3),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  'dsh-vocab-study-bilibili.mp4', '-y'],
  { stdio: ['ignore', 'pipe', 'pipe'], cwd: OUT, maxBuffer: 1e8 });

console.log('');
console.log('  ══ 成品 ══');
console.log(execFileSync(FP, ['-v', 'error', '-show_entries',
  'format=duration,size', '-show_entries',
  'stream=codec_type,width,height,r_frame_rate', '-of', 'default=noprint_wrappers=1', FINAL],
  { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => '    ' + l).join('\n'));
