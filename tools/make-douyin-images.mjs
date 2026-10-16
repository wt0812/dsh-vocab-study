// 抖音图文素材：把小红书那 9 张复用成抖音图文版
//
// 每张统一 1080×1440（3:4 竖版，小红书/抖音图文通用）：
//   y   0-1210  图片区（按宽铺满，多余上下裁掉；源图暗底，和画布融在一起）
//   y   0-   8  顶部强调色条
//   y1210-1440  文字区（深色条 + 白字说明）—— 放在这里而不是压在图上是刻意的：
//               抖音底部会被信息栏遮挡，文字放底部才不会被挡住那句关键话
//
// ⚠️ 制图必须内嵌 base64，不能给 file:// 路径（headless Chrome 不加载本地子资源）
// ⚠️ 生成用 sharp 合成，不走浏览器，所以这里用 SVG buffer 直接叠字
//
// 用法: node tools/make-douyin-images.mjs

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { assetsDir, asset } from './assets-dir.mjs';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const SRC = asset('04-小红书');
const OUT = asset('11-抖音');

const W = 1080, H = 1440, IMG_H = 1210;
const BG = { r: 8, g: 10, b: 10, alpha: 1 };
const ACCENT = '#3fd0c9';

// 每张的文案：图和字一一对应，发的时候按这个顺序
const SLIDES = [
  { src: '2-封面.png',        out: '2-封面.png',        cap: '我给 DSH 写了个背单词插件' },
  { src: '3-背词界面.png',     out: '3-背词界面.png',     cap: '点开就是一张词卡：正面单词，翻面释义' },
  { src: '4-进度与热力图.png',  out: '4-进度与热力图.png',  cap: '它会算「接下来 30 天还剩多少」' },
  { src: '5-生词本.png',      out: '5-生词本.png',      cap: '生词本：选中就收藏，自动进复习队列' },
  { src: '6-设置.png',        out: '6-设置.png',        cap: '数据只在本机，网络请求 0 次' },
  { src: '7-功能巡览.gif',     out: '7-功能巡览.png',     cap: '忘了 / 模糊 / 会了，键盘 123 自评' },
  { src: '8-测试全绿.png',     out: '8-测试全绿.png',     cap: '8 个套件 / 400 项断言全绿' },
  { src: '9-社交卡片.png',     out: '9-社交卡片.png',     cap: '零依赖 · 断网能背 · MIT 开源' },
];

mkdirSync(OUT, { recursive: true });

// 文字区的 SVG：顶部一条强调色，右边一个序号
function captionSvg(num, text) {
  const y0 = IMG_H;
  return `<svg width="${W}" height="${H - IMG_H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="6" fill="${ACCENT}" opacity="0.85"/>
    <text x="56" y="152" font-family="Microsoft YaHei UI, Microsoft YaHei, sans-serif"
          font-size="46" font-weight="700" fill="#ffffff">${text}</text>
    <text x="${W - 56}" y="152" text-anchor="end"
          font-family="Microsoft YaHei UI, Microsoft YaHei, sans-serif"
          font-size="34" font-weight="700" fill="${ACCENT}">${num}/8</text>
  </svg>`;
}

let n = 0;
for (const s of SLIDES) {
  n++;
  const meta = await sharp(`${SRC}/${s.src}`).metadata();

  // 按宽铺满 1080，高度超出 1210 的部分上下均裁
  const scale = W / meta.width;
  const sw = W;
  const sh = Math.max(IMG_H, Math.round(meta.height * scale));
  const resized = await sharp(`${SRC}/${s.src}`)
    .resize(sw, sh, { fit: 'fill' })
    .toBuffer();

  // 从中间裁 1080×1210（图片居中，上下各切掉多余）
  const top = Math.max(0, Math.round((sh - IMG_H) / 2));
  const img = await sharp(resized)
    .extract({ left: 0, top, width: sw, height: Math.min(IMG_H, sh) })
    .png()
    .toBuffer();

  // 合成：画布 → 图片贴顶部 → 文字区
  const out = await sharp({ create: { width: W, height: H, channels: 4, background: BG } })
    .composite([
      { input: img, left: 0, top: 0 },
      { input: Buffer.from(captionSvg(n, s.cap)), left: 0, top: IMG_H },
    ])
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/${s.out}`);

  const st = statSync(`${OUT}/${s.out}`);
  console.log(`  ${String(n).padStart(2)}. ${s.out.padEnd(20)} ${meta.width}x${meta.height} → 1080x1440  ${(st.size / 1024).toFixed(0)} KB`);
}

console.log('');
console.log(`  共 ${n} 张，输出到 ${OUT}`);
