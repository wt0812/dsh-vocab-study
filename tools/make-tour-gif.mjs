/** 出「多页巡览」动图：把插件的四个页面都拍进一张 GIF。
 *
 *  用法: node tools/make-tour-gif.mjs [outDir]
 *
 *  为什么单独写一个、不动 make-gif.mjs：
 *  那个只拍「今日」页的翻卡（15 帧全是同一个页面），拿给别人看只看到"翻卡"，
 *  看不到进度页的热力图 / 30 天趋势、生词本、设置 —— 等于没把插件讲清楚。
 *  这个脚本按标签页巡览一遍，每页停一下，长页面滚动展示。
 *
 *  实测出来的两个关键点：
 *  · 画幅取"所有页面里最高的那个面板高度"，四页统一 —— GIF 每帧尺寸必须一致。
 *  · 必须等页面**真的导航到 preview.html** 再操作。不等的话 WebSocket 还连在
 *    about:blank 上，报「localStorage Access is denied」「__vsDemo undefined」，
 *    看着像插件坏了，其实只是连错了 target。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9387;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 极简 CDP 客户端（tools/cdp.mjs 是 CLI 脚本、没有导出，所以这里内联一份）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); }
      }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

const CHAT = {
  subtitle: '侧栏插件 · 离线背单词',
  hideHint: true,
  messages: [{ who: '你', body: '帮我看看这段英文里哪些词是我没掌握的。' }],
  streamLines: ['顺手标出了 5 个你之前背过、但这里换了用法的词。'],
};

async function waitCdp() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; } catch { /* */ }
    await sleep(250);
  }
  throw new Error('CDP 没起来');
}

/** 找页面 target。顺序是「先连上 about:blank → 注入 → 导航 → 再回头找
 *  preview.html 那个 target」，不能一上来就等 preview.html（那时还没导航）。 */
async function findPageTarget(preferPreview) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((x) => x.type === 'page');
  if (preferPreview) {
    const t = pages.find((x) => /preview\.html/.test(x.url ?? ''));
    if (t) return t;
    return null;
  }
  return pages[0] ?? list[0];
}

async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

const outDir = resolve(process.argv[2] ?? '_tour');
const framesDir = resolve(outDir, '_frames');
mkdirSync(outDir, { recursive: true });
if (existsSync(framesDir)) rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const profile = resolve(process.env.TEMP ?? '.', 'cdp-vocab-tour');
if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=520,1000', 'about:blank',
], { stdio: 'ignore' });

let cdp;
try {
  await waitCdp();
  // ① 先连上 about:blank，才谈得上导航
  let t = await findPageTarget(false);
  if (!t) throw new Error('没有可用的 page target');
  cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 440 CSS px ≈ 真实 DSH 侧栏宽度；2x 输出，缩到动图尺寸还清楚
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 1000, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__vsChat = ${JSON.stringify(CHAT)};` });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3600);

  // ② 导航后 WebSocket 可能换了 target：回头确认连的是 preview.html 那个，
  //    不是的话重连一次。这一步不做就会出现「localStorage Access is denied」
  //    和「__vsDemo undefined」—— 看着像插件坏了，其实只是连错了 target。
  const cur = await findPageTarget(true);
  if (cur && !/preview\.html/.test(t.url ?? '')) {
    cdp.close();
    cdp = await Cdp.connect(cur.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
  }

  const url = await ev(cdp, `location.href`);
  const kind = await ev(cdp, `typeof window.__vsDemo`);
  console.log(`  连到 = ${url}`);
  if (kind !== 'object') throw new Error(`__vsDemo 是 ${kind}，页面没起来`);

  // 清干净：不然沿用上次进度，同一批素材里数字会打架
  await ev(cdp, `(() => { try { localStorage.clear(); } catch (e) {} return 'ok'; })()`);
  await ev(cdp, `location.reload()`);
  await sleep(3600);
  await ev(cdp, `(window.__vsDemo.openPanel(), 'ok')`);
  await sleep(1000);

  const setTab = async (label) => {
    const hit = await ev(cdp, `(() => {
      const tb = [...document.querySelectorAll('.vs-tab')].find(n => (n.textContent||'').indexOf(${JSON.stringify(label)}) >= 0);
      if (!tb) return false;
      tb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    if (!hit) throw new Error(`找不到标签「${label}」`);
    await sleep(700);
  };

  const setScroll = async (top) => {
    await ev(cdp, `(() => {
      const B = document.querySelector('.vs-panel .vs-body');
      if (B) B.scrollTop = ${top};
      return B ? B.scrollTop : null;
    })()`);
    await sleep(300);
  };

  const measure = async () => ev(cdp, `(() => {
    const P = document.querySelector('.vs-panel');
    const B = P.querySelector('.vs-body');
    const r = P.getBoundingClientRect();
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      scrollH: B ? B.scrollHeight : 0,
      clientH: B ? B.clientHeight : 0,
      need: B ? Math.max(0, B.scrollHeight - B.clientHeight) : 0,
    };
  })()`);

  // ── 第一遍：量所有页面，定统一画幅 ──────────────────────────
  const TABS = ['今日', '进度', '生词本', '设置'];
  const dims = {};
  console.log('  量各页高度（决定统一画幅）：');
  for (const label of TABS) {
    await setTab(label);
    await setScroll(0);
    dims[label] = await measure();
    const d = dims[label];
    console.log(`    ${label.padEnd(4)} 面板 ${d.w}x${d.h}  body ${d.clientH}/${d.scrollH}  需滚动 ${d.need}px`);
  }
  const maxH = Math.max(...TABS.map((t) => dims[t].h));
  const maxW = Math.max(...TABS.map((t) => dims[t].w));
  console.log(`  → 统一画幅 ${maxW}x${maxH}`);
  const clip = { x: Math.max(0, dims['今日'].x - 8), y: Math.max(0, dims['今日'].y - 8), width: maxW + 16, height: maxH + 16, scale: 1 };

  const frames = [];
  const grab = async (tag) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
    const f = resolve(framesDir, `t${String(frames.length).padStart(3, '0')}-${tag}.png`);
    writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ file: f, tag });
  };

  // ── 第二遍：按巡览顺序截帧 ────────────────────────────────
  //
  // 「今日」页的正确顺序（读 ui/panel.mjs 得来的，不是猜的）：
  //   · 初始就是**正面**（只显示单词和音标，没有释义）。
  //   · `app.rate(n)` **本身就是"揭晓"** —— 它写好 lastReveal 后重渲染，
  //     正面变背面（panel.mjs L42-50）。
  //   · 想换下一张要再调 `app.next()`（L54-61）。
  //
  // ⚠️ 踩过的坑：一开始写成「点卡片 → 拍一帧 → rate+next → 拍一帧」，
  // 结果第一帧和初始帧**字节完全相同**（45/46 KB 两两一致）—— 因为
  //   (a) `.vs-card` 上没有 onclick，`dispatchEvent` 点了等于没点；
  //       卡片上唯一可点的是 `.vs-word`，而那个是**发音**不是翻面；
  //   (b) 在这个脚本里是 `rate()` 负责揭晓，不是点击。
  // 所以：拍"正面"→ rate → 拍"揭晓"→ next，一个动作一帧，别合并。
  await setTab('今日');
  await setScroll(0);
  for (let i = 0; i < 2; i++) {
    await grab('today-front');
    await ev(cdp, `(window.__vsDemo.app.rate(${i === 0 ? 3 : 1}), 'ok')`);
    await sleep(420);
    await grab('today-reveal');
    await ev(cdp, `(window.__vsDemo.app.next(), 'ok')`);
    await sleep(320);
  }

  // ② 进度：热力图 + 30 天趋势（有滚动就滚到底）
  await setTab('进度');
  await setScroll(0);
  await grab('progress-top');
  const needP = dims['进度'].need;
  if (needP > 40) {
    await setScroll(Math.round(needP / 2));
    await grab('progress-mid');
    await setScroll(needP);
    await grab('progress-bottom');
    await setScroll(0);
  }

  // ③ 生词本
  await setTab('生词本');
  await setScroll(0);
  await grab('vocab-top');
  if (dims['生词本'].need > 40) {
    await setScroll(dims['生词本'].need);
    await grab('vocab-bottom');
    await setScroll(0);
  }

  // ④ 设置
  await setTab('设置');
  await setScroll(0);
  await grab('settings-top');
  if (dims['设置'].need > 40) {
    await setScroll(Math.round(dims['设置'].need / 2));
    await grab('settings-mid');
    await setScroll(dims['设置'].need);
    await grab('settings-bottom');
    await setScroll(0);
  }

  // 回到今日收尾，循环播放时不突兀
  await setTab('今日');
  await setScroll(0);
  await grab('end');
  console.log(`  截了 ${frames.length} 帧`);

  // ── 合成 ────────────────────────────────────────────────────
  const FFMPEG = findFfmpeg();
  if (!FFMPEG) throw new Error('找不到 ffmpeg');
  console.log('  ffmpeg: ' + FFMPEG);

  // 巡览图不需要均速：重点页多停，过渡帧快过。
  const HOLD = {
    'today-front': 1.0, 'today-reveal': 1.4,
    'progress-top': 1.6, 'progress-mid': 1.4, 'progress-bottom': 1.6,
    'vocab-top': 1.3, 'vocab-bottom': 1.1,
    'settings-top': 1.2, 'settings-mid': 1.1, 'settings-bottom': 1.2,
    end: 1.0,
  };
  const lines = [];
  for (const f of frames) {
    lines.push(`file '${f.file.replace(/\\/g, '/')}'`);
    lines.push(`duration ${(HOLD[f.tag] ?? 0.45).toFixed(3)}`);
  }
  // 末帧不补：ffmpeg 9 + 帧自带 duration 时补末帧会多出一页
  const listFile = resolve(outDir, '_tour.txt');
  writeFileSync(listFile, lines.join('\n') + '\n', 'utf8');

  const outWebp = resolve(outDir, 'tour.webp');
  const rc = spawnSync(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-fps_mode', 'vfr', '-loop', '0',
    '-c:v', 'libwebp', '-q:v', '78', '-compression_level', '6', '-pix_fmt', 'bgra', '-an', outWebp,
  ], { encoding: 'utf8' });
  if (rc.status !== 0) throw new Error('ffmpeg 出 webp 失败: ' + (rc.stderr ?? '').slice(0, 300));

  const outGif = resolve(outDir, 'tour.gif');
  const rc2 = spawnSync(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-fps_mode', 'vfr', '-loop', '0',
    '-vf', 'split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=bayer',
    outGif,
  ], { encoding: 'utf8' });
  if (rc2.status !== 0) throw new Error('ffmpeg 出 GIF 失败: ' + (rc2.stderr ?? '').slice(0, 300));

  const mw = await sharp(outWebp, { animated: true }).metadata();
  const mg = await sharp(outGif, { animated: true }).metadata();
  const sameTiming = JSON.stringify(mw.delay ?? []) === JSON.stringify(mg.delay ?? []);
  console.log('');
  console.log(`  ${mw.width}x${Math.round(mw.height / mw.pages)} · ${mw.pages} 页 · ${(statSync(outWebp).size / 1024).toFixed(0)} KB · ${mw.pages === frames.length ? '✅ 页数对' : '❌ 页数不对'}`);
  console.log(`     → ${outWebp}`);
  console.log(`  ${mg.width}x${Math.round(mg.height / mg.pages)} · ${mg.pages} 页 · ${(statSync(outGif).size / 1024).toFixed(0)} KB · ${mg.pages === frames.length ? '✅ 页数对' : '❌ 页数不对'} · ${sameTiming ? '✅ 延时一致' : '❌ 延时不一致'}`);
  console.log(`     → ${outGif}`);
} finally {
  try { cdp?.close(); } catch { /* */ }
  try { chrome.kill(); } catch { /* */ }
}
