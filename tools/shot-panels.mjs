/** 出成品截图：把 demo 的 6 个面板逐个打开并截图（1x，好对坐标）。
 *  用法: node tools/shot-panels.mjs <outDir>
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-panels');
const PORT = 9230;
const outDir = resolve(process.argv[2] ?? '_promo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=1600,1000', 'about:blank',
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
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

const TABS = [
  ['today', '今日'],
  ['progress', '进度'],
  ['vocab', '生词本'],
  ['settings', '设置'],
];

let cdp;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3200);

  // 打开面板
  console.log('打开面板: ' + JSON.stringify(await ev(cdp, `(() => {
    if (!window.__vsDemo || typeof window.__vsDemo.openPanel !== 'function') return 'no openPanel';
    window.__vsDemo.openPanel();
    return 'ok';
  })()`)));
  await sleep(1000);

  for (const [slug, label] of TABS) {
    // 点对应标签页
    const clicked = await ev(cdp, `(() => {
      const tabs = [...document.querySelectorAll('.tabs span, [class*=tab]')];
      const t = tabs.find(n => (n.textContent||'').trim() === ${JSON.stringify(label)});
      if (!t) return '没找到标签「${label}」';
      t.click();
      return 'clicked';
    })()`);
    await sleep(900);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = resolve(outDir, `${slug}.png`);
    writeFileSync(f, Buffer.from(data, 'base64'));
    console.log(`  ${label.padEnd(4)} → ${f}   (${clicked})`);
  }
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
