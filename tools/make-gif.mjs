/**
 * 出演示动图：用真 Chrome 渲染 demo，再调插件自己的 rate()/next() 翻真实的词卡，
 * 逐帧截图 → 合成 WebP。
 *
 * 为什么不用视频录屏：真插件装在 DSH 里，录屏会拍到我的聊天记录和别的窗口。
 * 而「翻卡」这个动作本来就是插件自己的渲染 —— 逐帧截的是同一批像素，没有造假。
 *
 * 用法: node tools/make-gif.mjs <输出目录>
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9236;

/** ffmpeg 不在这台机器的 PATH 上，但 WinGet 装过；把常见位置都试一遍。 */
function findFfmpeg() {
  const direct = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
  if (direct.status === 0) return direct.stdout.split(/\r?\n/)[0].trim();
  const winget = resolve(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(winget)) {
    for (const d of readdirSync(winget)) {
      if (!/FFmpeg/i.test(d)) continue;
      for (const sub of readdirSync(resolve(winget, d))) {
        const exe = resolve(winget, d, sub, 'bin', 'ffmpeg.exe');
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}


const outDir = resolve(process.argv[2] ?? '_promo');
const framesDir = resolve(outDir, '_frames');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });
if (existsSync(framesDir)) rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const CHAT = {
  subtitle: '侧栏插件 · 离线背单词',
  hideHint: true,
  messages: [{ who: '你', body: '帮我看看这段英文里哪些词是我没掌握的。' }],
  streamLines: ['顺手标出了 5 个你之前背过、但这里换了用法的词。'],
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${resolve(process.env.TEMP ?? '.', 'cdp-vocab-gif')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=520,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; } catch { /* */ }
    await sleep(250);
  }
  throw new Error('CDP 没起来');
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve: res, reject: rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('连不上')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时 ' + method)); } }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}
async function ev(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

let cdp;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 440 CSS px ≈ 真实 DSH 侧栏宽度；2x 输出，缩到动图尺寸还清楚
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__vsChat = ${JSON.stringify(CHAT)};` });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3400);
  // 跟 make-promo.mjs 一样先清干净：不然沿用上次的进度，
  // 动图和宣传图上的数字会对不上，同一批素材里数字打架看着就假。
  await ev(cdp, `(() => { try { localStorage.clear(); return 'ok'; } catch (e) { return 'failed'; } })()`);
  await ev(cdp, `location.reload()`);
  await sleep(3400);
  await ev(cdp, `(window.__vsDemo.openPanel(), 'ok')`);
  await sleep(1000);

  const rect = await ev(cdp, `(() => {
    const p = document.querySelector('.vs-panel');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log('面板 rect: ' + JSON.stringify(rect));

  const frames = [];
  const grab = async (tag) => {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: rect.w + 16, height: rect.h + 16, scale: 1 },
    });
    const f = resolve(framesDir, `f${String(frames.length).padStart(3, '0')}-${tag}.png`);
    writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push(f);
  };

  // ── 帧序列：每张卡「正面 → 翻面 → 自评」，评完翻下一张 ──────────
  const PLAN = [3, 3, 1, 3, 3, 1];   // 3=会了, 1=忘了
  await grab('start');
  for (let i = 0; i < PLAN.length; i++) {
    // 翻到答案面（真事件：点卡片）
    await ev(cdp, `(() => {
      const card = document.querySelector('.vs-card, [class*=card]');
      if (card) card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(320);
    await grab('reveal');
    await ev(cdp, `(window.__vsDemo.app.rate(${PLAN[i]}), window.__vsDemo.app.next(), 'ok')`);
    await sleep(320);
    await grab('next');
    // 中间多补一帧，动图更顺
    if (i === 2) { await sleep(260); await grab('hold'); }
  }
  await sleep(500);
  await grab('end');
  console.log(`截了 ${frames.length} 帧`);

  // ── 合成动图 ─────────────────────────────────────────────────
  //
  // 踩的坑（记下来，别再犯）：
  //   我一开始用 sharp 的 `join: { animated: true }` 合帧，试了 6 种写法
  //   （pageHeight / width+height / 不给参数 / 输出 GIF / 手工拼长图 / across）
  //   —— **全部给出错误页数**：15 帧恒定变成 7 页。
  //   sharp 的 animated 输入侧（读多页）是可靠的，**拼接输出侧不是它的活**。
  //
  //   桌面小猫那套动图也没用 sharp，是 PIL 逐帧合。
  //   这台机器上有 ffmpeg 9.0.1（WinGet 装的），那才是出动图的正路。
  //   而且要注意：帧尺寸不一致时 ffmpeg 会挑最大的帧尺寸，必须自己先统一。
  const metas = await Promise.all(frames.map((f) => sharp(f).metadata()));
  const W0 = Math.max(...metas.map((m) => m.width));
  const H0 = Math.max(...metas.map((m) => m.height));
  const OUT_W = 660;
  const s = OUT_W / W0;
  const W = Math.round(W0 * s) & ~1;  // 偶数，编解码器要求
  const H = Math.round(H0 * s) & ~1;
  console.log(`  画布: ${W}x${H}（帧高 ${[...new Set(metas.map((m) => m.height))].join(', ')}，原 ${W0}x${H0}）`);

  const normDir = resolve(outDir, '_frames-norm');
  if (existsSync(normDir)) rmSync(normDir, { recursive: true, force: true });
  mkdirSync(normDir, { recursive: true });
  for (let i = 0; i < frames.length; i++) {
    const m = await sharp(frames[i]).metadata();
    // 只夹宽度不够：862→660 时高度按比例变成 730，超过画布高 700，
    // sharp 就报「Image to composite must have same dimensions or smaller」。
    // 必须**宽高同时给上限**等比缩（fit:'inside'），再居中。
    const fitted = await sharp(frames[i])
      .resize({ width: W, height: H, fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();
    const fm = await sharp(fitted).metadata();
    await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0x14, g: 0x11, b: 0x0e, alpha: 1 } },
    })
      .composite([{
        input: fitted,
        left: Math.round((W - fm.width) / 2),
        top: Math.round((H - fm.height) / 2),
      }])
      .png()
      .toFile(resolve(normDir, `n${String(i).padStart(3, '0')}.png`));
  }

  const FFMPEG = findFfmpeg();
  if (!FFMPEG) throw new Error('找不到 ffmpeg —— 这台机器上原本是有的（WinGet 安装的 Gyan.FFmpeg）');
  console.log('  ffmpeg: ' + FFMPEG);

  // concat 分离器让每帧可以有自己的时长（首尾多停一会）
  const fps = 3;
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const hold = i === 0 || i === frames.length - 1 ? 3 : 1;   // 单位：帧（@fps）
    lines.push(`file '${resolve(normDir, `n${String(i).padStart(3, '0')}.png`).replace(/\\/g, '/')}'`);
    lines.push(`duration ${(hold / fps).toFixed(4)}`);
  }
  // concat 分离器在最后一帧没有 duration 时会丢掉它，常规套路是把末帧再写一遍。
  // 但 ffmpeg 9 + 帧自带 duration 的情况下，那个补丁会**多出一页**（15 帧变 16 页），
  // 所以这里只给每帧写 duration、**不再补末帧**。
  const listFile = resolve(outDir, '_frames.txt');
  writeFileSync(listFile, lines.join('\n') + '\n', 'utf8');

  const out = resolve(outDir, 'demo.webp');
  // ffmpeg 9 已经把 -vsync 删了（换成 -fps_mode），照旧知识写会报
  // Unrecognized option 'vsync'。这里用 -fps_mode vfr 保留 concat 里各帧的时长。
  const rc = spawnSync(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-fps_mode', 'vfr',
    '-loop', '0',
    '-c:v', 'libwebp', '-q:v', '78', '-compression_level', '6',
    '-pix_fmt', 'bgra',
    '-an', out,
  ], { encoding: 'utf8' });
  if (rc.status !== 0) throw new Error('ffmpeg 失败: ' + (rc.stderr ?? '').slice(0, 400));

  // 自检：页数必须等于帧数，且各帧真的不一样
  const meta = await sharp(out, { animated: true }).metadata();
  const ok = meta.pages === frames.length;
  console.log(`  动图 → ${out}`);
  console.log(`  ${meta.width}x${meta.height} · ${meta.pages} 页 · ${(readFileSync(out).length / 1024).toFixed(0)} KB · ${ok ? '✅ 页数对' : `❌ 页数不对（期望 ${frames.length}）`}`);

  const prints = [];
  for (let i = 0; i < (meta.pages ?? 1); i++) {
    const raw = await sharp(out, { animated: true, page: i }).raw().toBuffer();
    let sum = 0;
    for (let k = 0; k < raw.length; k += 997) sum = (sum + raw[k]) % 1e9;
    prints.push(sum);
  }
  const uniq = new Set(prints).size;
  console.log(`  不同帧: ${uniq}/${prints.length} ${uniq > 1 ? '✅ 确实是动的' : '❌ 全一样'}`);
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
