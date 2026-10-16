// 生成 BGM：纯合成，零版权风险（不用任何外部音频素材）
// 思路：柔和的和弦垫 —— 多个正弦波叠加 + 慢起慢落包络 + 低通 + 回声
// 和声走向：Am - F - C - G（最稳妥、不抢戏的进行）
//
// 增益策略：不靠猜 —— 先出一版，测峰值，再精确归一化到目标响度
//
// 用法: node tools/make-bgm.mjs [秒数] [目标峰值dB]

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';

const FF = 'C:/Users/21653/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe';
const OUT = 'F:/DeepSeek Harness/projects/_bili_build';
mkdirSync(OUT, { recursive: true });

const DUR = Number(process.argv[2] || 86);
const TARGET_PEAK_DB = Number(process.argv[3] || -12); // 峰值上限，留 headroom

// 和弦（Hz）：Am / F / C / G
const chords = [
  { name: 'Am', f: [220.00, 261.63, 329.63] },
  { name: 'F',  f: [174.61, 220.00, 261.63] },
  { name: 'C',  f: [196.00, 261.63, 329.63] },
  { name: 'G',  f: [196.00, 246.94, 293.66] },
];

const BEAT = 1.6;
const LOOP = chords.length * BEAT;

function run(args, opts = {}) {
  return execFileSync(FF, ['-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// 每个和弦渲染一段（音尾留 1.2 秒余韵，供叠加）
const segs = chords.map((c, ci) => {
  const args = [];
  c.f.forEach((freq) => args.push('-f', 'lavfi', '-t', String(BEAT + 1.2), '-i', `sine=frequency=${freq}:sample_rate=44100`));
  const fc = [
    ...c.f.map((_, i) => `[${i}:a]volume=0.5[a${i}]`),
    `${c.f.map((_, i) => `[a${i}]`).join('')}amix=inputs=3:duration=longest:normalize=0[chord]`,
    `[chord]afade=t=in:st=0:d=0.9,afade=t=out:st=${(BEAT + 1.2 - 1.4).toFixed(2)}:d=1.4[env]`,
  ].join(';');
  const seg = `${OUT}/seg${ci}.wav`;
  run([...args, '-filter_complex', fc, '-map', '[env]', '-ar', '44100', '-ac', '2', seg, '-y']);
  return seg;
});

// 四段按 0/1.6/3.2/4.8 秒错开叠加 => 一轮 6.4 秒
const inArgs = segs.flatMap((s) => ['-i', s]);
const delays = chords.map((_, i) => `[${i}:a]adelay=${Math.round(i * BEAT * 1000)}|${Math.round(i * BEAT * 1000)}[d${i}]`).join(';');
const mixIn = chords.map((_, i) => `[d${i}]`).join('');
const padFc = [
  delays,
  `${mixIn}amix=inputs=4:duration=longest:normalize=0[pad]`,
  `[pad]lowpass=f=1100,highpass=f=70[soft]`,
  `[soft]aecho=0.8:0.9:420|680:0.28|0.18[out]`,
].join(';');

const padWav = `${OUT}/pad.wav`;
run([...inArgs, '-filter_complex', padFc, '-map', '[out]', '-ar', '44100', '-ac', '2', padWav, '-y']);

// ── 测峰值，精确算增益（不猜）──
// 注意：volumedetect 的输出走 stderr，必须用 shell 合并后才能被捕获
function volumeStats(file, maxDur) {
  const dur = maxDur ? `-t ${maxDur} ` : '';
  const cmd = `"${FF}" -hide_banner ${dur}-i "${file}" -af volumedetect -f null - 2>&1`;
  const out = execFileSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 1e8 });
  const peak = out.match(/max_volume:\s*(-?[\d.]+) dB/);
  const mean = out.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return {
    peak: peak ? parseFloat(peak[1]) : null,
    mean: mean ? parseFloat(mean[1]) : null,
  };
}

const m0 = volumeStats(padWav, 8);
if (m0.peak === null) throw new Error('峰值测量失败');
const gainDb = TARGET_PEAK_DB - m0.peak;
console.log(`  测得峰值 ${m0.peak} dB  →  增益 ${gainDb.toFixed(2)} dB  (目标 ${TARGET_PEAK_DB} dB)`);

// 循环到目标时长 + 结尾淡出
const bgm = `${OUT}/bgm.wav`;
run(['-stream_loop', '-1', '-i', padWav, '-t', String(DUR),
  '-af', `volume=${gainDb.toFixed(2)}dB,afade=t=in:st=0:d=2,afade=t=out:st=${(DUR - 3.5).toFixed(1)}:d=3.5`,
  '-ar', '44100', '-ac', '2', bgm, '-y']);
run(['-i', bgm, '-c:a', 'aac', '-b:a', '160k', `${OUT}/bgm.m4a`, '-y']);

// 复测成品
const m1 = volumeStats(bgm);
console.log('');
console.log('  ✅ 和弦走向 ' + chords.map((c) => c.name).join(' - ') + `，一轮 ${LOOP} 秒，循环到 ${DUR} 秒`);
console.log('  ✅ bgm.m4a 已生成（自己合成，零版权）');
console.log(`     峰值 ${m1.peak} dB   平均 ${m1.mean} dB`);
