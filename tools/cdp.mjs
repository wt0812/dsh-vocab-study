/**
 * 用真实 Chrome 驱动 demo 页：读状态 / 执行 JS / 截图。
 *
 * 为什么要这个：demo 预览页的素材问题（数据是不是真的、seed 有没有生效、
 * 面板长什么样）**靠读代码判断不了**，必须在真实浏览器里看。
 * 手工点也不可靠，所以走 CDP。
 *
 * 用法：
 *   node tools/cdp.mjs eval  <file.html> "<js 表达式>"
 *   node tools/cdp.mjs shot  <file.html> <out.png> [width] [height]
 *   node tools/cdp.mjs probe <file.html>
 *
 * 依赖：Node 内置 WebSocket（v22+），零外部依赖。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-profile');
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个 headless Chrome，返回它的 CDP http 端点。 */
function launchChrome() {
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome: ' + CHROME);
  const args = [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    // localStorage 在 file:// 下需要一个稳定的源，给个假的
    '--force-device-scale-factor=2',
    '--window-size=1600,1000',
    'about:blank',
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  return child;
}

/** 等 CDP 的 /json/version 起来。 */
async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome CDP 没在 ' + timeoutMs + 'ms 内起来');
}

/** 极简 CDP 客户端。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 60000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 在页面里跑一段表达式，返回它的值（已 JSON 化）。 */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面里抛错: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  }
  return r.result?.value;
}

/** 打开一个页面并等它稳定（boot 是异步的，多等一会儿）。 */
async function openPage(cdp, filePath, width, height, settleMs = 2500) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: false,
  });
  const url = pathToFileURL(resolve(filePath)).href;
  await cdp.send('Page.navigate', { url });
  // 等 load 事件，再等 boot 里的异步 seed 落定
  await sleep(settleMs);
}

async function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error('用法: node tools/cdp.mjs <eval|shot|probe> <file.html> [...]');
    process.exit(2);
  }

  const chrome = launchChrome();
  let cdp;
  try {
    await waitForCdp();
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/list`))
      .json().then((l) => l.find((t) => t.type === 'page') ?? l[0]);
    cdp = await Cdp.connect(webSocketDebuggerUrl);

    if (cmd === 'eval') {
      const expr = rest[0];
      await openPage(cdp, file, 1600, 1000);
      const v = await evaluate(cdp, expr);
      console.log(JSON.stringify(v, null, 2));
    } else if (cmd === 'probe') {
      await openPage(cdp, file, 1600, 1000);
      const info = await evaluate(
        cdp,
        `(() => {
           const raw = localStorage.getItem('vocab-study-demo');
           let parsed = null;
           try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = 'PARSE_ERROR'; }
           return {
             url: location.href,
             lsKeys: Object.keys(localStorage),
             rawLen: raw ? raw.length : 0,
             innerKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
             demoSeeded: parsed ? parsed.demoSeeded : null,
             recordCount: parsed && Array.isArray(parsed.records) ? parsed.records.length : null,
             streak: parsed ? parsed.streak : null,
             exp: parsed ? parsed.exp : null,
             hasVsDemo: typeof window.__vsDemo,
             hasVocabCore: typeof window.VOCAB_CORE,
             bootError: document.getElementById('vs-boot-error') ? document.getElementById('vs-boot-error').textContent.slice(0, 400) : null,
             bodyText: document.body.innerText.slice(0, 300),
           };
         })()`
      );
      console.log(JSON.stringify(info, null, 2));
    } else if (cmd === 'shot') {
      const out = rest[0];
      const w = Number(rest[1] ?? 1600);
      const h = Number(rest[2] ?? 1000);
      await openPage(cdp, file, w, h);
      if (rest[3]) {
        // 可选的「截图前先跑一段 JS」（用来打开面板、切标签页、造数据）
        const v = await evaluate(cdp, rest[3]);
        console.error('  预置脚本返回: ' + JSON.stringify(v));
        await sleep(600);
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), Buffer.from(data, 'base64'));
      console.log(resolve(out));
    } else {
      throw new Error('未知命令: ' + cmd);
    }
  } finally {
    cdp?.close();
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
