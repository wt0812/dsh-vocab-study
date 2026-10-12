/**
 * 验证 seedDemoHistory 的修复：全新 profile 打开 demo，看 state 里有没有数据。
 *
 * 判断标准（这是「界面为什么是空的」的直接答案）：
 *   state.streak.current 应该是 7（曾经是 0）
 *   state.exp            应该是 268（曾经是 0）
 *   state.history.days   应该有 7 天（曾经没有 history）
 *
 * 用法: node tools/verify-seed.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-verify');
const PORT = 9225;
const PAGE = resolve('demo/preview-progress.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--allow-file-access-from-files', '--window-size=1600,1000', 'about:blank',
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
  if (r.exceptionDetails) throw new Error('页面抛错: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}

let cdp;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: pathToFileURL(PAGE).href });
  await sleep(3500);

  const got = await ev(cdp, `(() => {
    const p = JSON.parse(localStorage.getItem('vocab-study-demo') || '{}');
    const st = p.state || {};
    return {
      lsKeys: Object.keys(localStorage),
      hasState: !!p.state,
      streak: st.streak,
      exp: st.exp,
      historyDays: st.history && st.history.days ? st.history.days.length : null,
      historySample: st.history && st.history.days ? st.history.days.slice(0, 3) : null,
      recordsTopLevel: Array.isArray(p.records) ? p.records.length : null,
      bootError: document.getElementById('vs-boot-error') ? 'YES' : null,
      visibleStreakText: (document.body.innerText.match(/连续[^\\n]{0,12}/) || [null])[0],
    };
  })()`);

  console.log('=== seed 修复后，state 里的真实数据 ===');
  console.log(JSON.stringify(got, null, 2));
  console.log();
  const ok = got.streak && got.streak.current === 7 && got.exp === 268 && got.historyDays === 7;
  console.log(ok ? '✅ 通过：连击 7 / 经验 268 / 热力图 7 天，都进 state 了'
                 : '❌ 未通过：数据没进 state');
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
