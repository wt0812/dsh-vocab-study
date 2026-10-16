// 把「素材库-01-效果截图」的四张拼成一张横排长图
//
// 思路：四张宽度接近（706~1006）、高度差很大（1223~2130），
//       所以按**统一高度**缩放后并排，高度对齐、宽度自然不同，不会留大片空白。
//       每张加圆角 + 细边框 + 柔和投影，底色用插件自己的暗色 #080a0a，看起来像一套。
//
// 用法: node tools/make-contact-sheet.mjs [每张高度，默认 1200]

import { createRequire } from 'node:module';
import { statSync, mkdirSync } from 'node:fs';
import { assetsDir, asset } from './assets-dir.mjs';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const SRC = asset('素材库-01-效果截图');
const OUT = assetsDir;
mkdirSync(OUT, { recursive: true });

const FILES = ['1-背词界面.png', '2-进度与热力图.png', '3-生词本.png', '4-设置.png'];
const H = Number(process.argv[2] ?? 1200);   // 每张统一高
const GAP = 36;        // 图之间留白
const PAD = 56;        // 画布四周留白
const BG = { r: 8, g: 10, b: 10, alpha: 1 };

// 四张各自先缩放，再统一切出圆角 + 边框
const tiles = [];
for (const f of FILES) {
  const p = `${SRC}/${f}`;
  const meta = await sharp(p).metadata();
  const w = Math.round(H * meta.width / meta.height);

  // 先缩放到目标尺寸
  const scaled = await sharp(p).resize(w, H, { fit: 'fill' }).png().toBuffer();

  // 做圆角遮罩（半径 18）
  const R = 18;
  const mask = Buffer.from(
    `<svg width="${w}" height="${H}"><rect x="0" y="0" width="${w}" height="${H}" rx="${R}" ry="${R}" fill="#fff"/></svg>`,
  );
  const rounded = await sharp(scaled)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 加一圈细边框：做一张同尺寸的透明层，只在边描线
  const border = Buffer.from(
    `<svg width="${w}" height="${H}"><rect x="1" y="1" width="${w - 2}" height="${H - 2}" rx="${R}" ry="${R}" fill="none" stroke="rgba(255,255,255,0.13)" stroke-width="2"/></svg>`,
  );
  const final = await sharp(rounded).composite([{ input: border }]).png().toBuffer();

  tiles.push({ buf: final, w, h: H });
  console.log(`  ${f.padEnd(20)} ${meta.width}x${meta.height}  →  ${w}x${H}`);
}

// 画布尺寸
const totalW = PAD * 2 + tiles.reduce((a, t) => a + t.w, 0) + GAP * (tiles.length - 1);
const totalH = PAD * 2 + H;

console.log('');
console.log(`  画布 ${totalW}x${totalH}`);

const composites = [];
let x = PAD;
for (const t of tiles) {
  composites.push({ input: t.buf, left: x, top: PAD });
  x += t.w + GAP;
}

await sharp({ create: { width: totalW, height: totalH, channels: 4, background: BG } })
  .composite(composites)
  .png({ compressionLevel: 9 })
  .toFile(`${OUT}/功能总览-4合1.png`);

const st = statSync(`${OUT}/功能总览-4合1.png`);
console.log(`  ✅ 输出 ${OUT}/功能总览-4合1.png`);
console.log(`     ${totalW}x${totalH}   ${(st.size / 1024).toFixed(0)} KB`);
