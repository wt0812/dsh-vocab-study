/**
 * 造一份「真实机制产生」的 demo 状态，用于宣传截图。
 *
 * 原则（用户的硬约束）：不伪造任何东西。
 *   - 不 P 图、不手改 localStorage 原始字符串
 *   - 一律通过插件自己的 storage 端口写（demoStorage(...).set/append），
 *     也就是走 seedDemoHistory 用的同一套接口
 *   - 记录的结构、字段、取值域全部照抄 seedDemoHistory
 *
 * 产物：一张 Today 状态概览 + 一张「今日进行中」的状态，写到 stdout 供检查。
 *
 * 用法: node tools/seed-promo.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-promo');
const PORT = 9224;
const PAGE = resolve('demo/preview-progress.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每次都是全新 profile —— 保证 demoSeeded 为空，seed 真的会跑一遍
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--allow-file-access-from-files',
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch { /* 没起来 */ }
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
      ws.addEventListener('error', () => rej(new Error('连不上 CDP')), { once: true });
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
  if (r.exceptionDetails) throw new Error('页面抛错: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}

let cdp;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page') ?? list[0];
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: pathToFileURL(PAGE).href });
  await sleep(3000);

  const fresh = await ev(cdp, `(() => {
    const p = JSON.parse(localStorage.getItem('vocab-study-demo') || '{}');
    return { demoSeeded: p.demoSeeded, records: (p.records||[]).length,
             streak: p.streak, exp: p.exp,
             recordSample: (p.records||[])[0] || null };
  })()`);
  console.log('=== 全新 profile 首启后（验证 seed 真的跑了）===');
  console.log(JSON.stringify(fresh, null, 2));

  // 看「今日」进度是怎么算的：dayKey 与 state 的形状
  const shape = await ev(cdp, `(() => {
    const p = JSON.parse(localStorage.getItem('vocab-study-demo') || '{}');
    return { state: p.state, session: p.session,
             dayKeyNow: window.VOCAB_CORE?.queue?.dayKey ? window.VOCAB_CORE.queue.dayKey(Date.now()) : null,
             dayKeyYs: window.VOCAB_CORE?.queue?.dayKey ? window.VOCAB_CORE.queue.dayKey(Date.now() - 86400000) : null,
             coreQueueKeys: window.VOCAB_CORE?.queue ? Object.keys(window.VOCAB_CORE.queue) : null };
  })()`);
  console.log();
  console.log('=== 状态形状（用来造「今日进行中」）===');
  console.log(JSON.stringify(shape, null, 2));
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
