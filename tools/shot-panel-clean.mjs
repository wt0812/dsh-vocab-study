/**
 * 出「干净的面板图」：视口调足让整块面板不被压缩、不留大片黑边，然后按实测
 * rect 精确裁到面板本身。
 *
 * 为什么必须裁：整屏截图中面板只占下方约 40%，上方 60% 是纯黑聊天区。
 * 当宣传图会显得「空」，缩到缩略图尺寸后面板里的字更看不清。
 * （tools/make-screenshots.py 里记过裁切的曲折：CSS 改布局会把面板推出屏外，
 *   所以这里**只裁像素，不动布局**。）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-clean');
const PORT = 9233;
const outDir = resolve(process.argv[2] ?? '_promo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const PROMO_CHAT = {
  subtitle: '侧栏插件 · 离线背单词',
  hideHint: true,
  messages: [
    { who: '你', body: '帮我把这段接口文档翻译一下，顺便看看里面那些形容词我认不认识。' },
    { body: '好，先提炼要点。你右侧那颗胶囊可以随时点开背两个词，不打断当前对话。' },
  ],
  streamLines: [
    '正在提炼第 3 节的要点：涉及 6 个接口、2 处兼容性改动。',
    '顺手标出了 5 个你之前背过、但这里换了用法的词。',
    '再往下是错误码表，我先把它整理成表格。',
  ],
};
const INJECT = `window.__vsChat = ${JSON.stringify(PROMO_CHAT)};`;

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=1600,1200', 'about:blank',
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

/** 读热力图格子的真实颜色分布（用来核实「到底几格着色」）。 */
const HEAT = `(() => {
  const heads = [...document.querySelectorAll('*')].filter(n => n.children.length === 0 && (n.textContent||'').trim() === '这半个月');
  if (!heads.length) return { err: '没找到热力图' };
  let box = heads[0].parentElement;
  for (let i = 0; i < 4 && box; i++) {
    if (box.querySelectorAll('*').length > 20) break;
    box = box.parentElement;
  }
  const cells = [...box.querySelectorAll('*')].filter(n => {
    const b = n.getBoundingClientRect();
    return b.width >= 4 && b.width <= 30 && Math.abs(b.width - b.height) <= 3 && b.height > 0;
  });
  const hist = {};
  for (const n of cells) { const bg = getComputedStyle(n).backgroundColor; hist[bg] = (hist[bg]||0)+1; }
  return { total: cells.length, hist };
})()`;

const TABS = [['today', '今日'], ['progress', '进度'], ['vocab', '生词本'], ['settings', '设置']];

let cdp;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 视口给足：面板有 max-height: min(64vh, 560px)，视口太矮会把它压出滚动条
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1400, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3400);
  await ev(cdp, `(window.__vsDemo && window.__vsDemo.openPanel) ? (window.__vsDemo.openPanel(), 'ok') : 'no'`);
  await sleep(1100);

  for (const [slug, label] of TABS) {
    await ev(cdp, `(() => {
      const tabs = [...document.querySelectorAll('.tabs span, [class*=tab]')];
      const t = tabs.find(n => (n.textContent||'').trim() === ${JSON.stringify(label)});
      if (t) t.click();
    })()`);
    await sleep(1000);

    if (slug === 'progress') {
      const heat = await ev(cdp, HEAT);
      console.log('  热力图实测: ' + JSON.stringify(heat));
    }

    // 实测面板 rect（CSS 像素）；2x 渲染 → 设备像素要乘 2
    const rect = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
               iw: window.innerWidth, ih: window.innerHeight };
    })()`);
    if (!rect) throw new Error('找不到 .vs-panel');

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const full = resolve(outDir, `_full-${slug}.png`);
    writeFileSync(full, Buffer.from(data, 'base64'));

    // 裁到面板（留 12 CSS px 内边距，别把阴影切掉）
    const pad = 12;
    const left = Math.max(0, (rect.x - pad)) * 2;
    const top = Math.max(0, (rect.y - pad)) * 2;
    const width = Math.min(rect.iw - (rect.x - pad), rect.w + pad * 2) * 2;
    const height = Math.min(rect.ih - (rect.y - pad), rect.h + pad * 2) * 2;
    const out = resolve(outDir, `panel-${slug}.png`);
    await sharp(full)
      .extract({ left, top, width: Math.round(width), height: Math.round(height) })
      .png()
      .toFile(out);
    const meta = await sharp(out).metadata();
    console.log(`  ${label.padEnd(4)} 面板 ${rect.w}x${rect.h} → ${out.split('\\').pop()} (${meta.width}x${meta.height})`);
  }
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
