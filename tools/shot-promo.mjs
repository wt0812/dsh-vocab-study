/**
 * 出宣传素材：用真 Chrome 渲染 demo，换成贴题的对话文案，逐个面板截图。
 *
 * 两条硬规矩（跟桌面上 DesktopCat 那套一致）：
 *   1. **画面必须来自插件自己的渲染** —— 每一张都是真页面截出来的；数据是
 *      seedDemoHistory 按插件自己的机制造出来的真实状态，不 P 图、不编数字。
 *   2. **不留开发痕迹** —— 顶部 demo 副标题、底部「这是故意的」调试提示、
 *      以及那段跟背单词无关的 weather-deck 对话，在宣传图里必须换掉。
 *      换法走 ui/shell.mjs 的 window.__vsChat 钩子，不改插件行为。
 *
 * 用法: node tools/shot-promo.mjs <输出目录>
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-promo2');
const PORT = 9231;
const outDir = resolve(process.argv[2] ?? '_promo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** 宣传版文案：让没听过 DSH 的人也看得懂「这是什么、解决什么」。 */
export const PROMO_CHAT = {
  subtitle: '侧栏插件 · 离线背单词',
  hideHint: true,
  messages: [
    { who: '你', body: '帮我把这段接口文档翻译一下，顺便看看里面那些形容词我认不认识。' },
    { body: '好，先提炼要点。你右侧那颗胶囊可以随时点开背两个词，不打断当前对话。' },
  ],
  // 「任务进行中」的演示动画也要换成贴题的话，否则会和上面的对话打架
  streamLines: [
    '正在提炼第 3 节的要点：涉及 6 个接口、2 处兼容性改动。',
    '顺手标出了 5 个你之前背过、但这里换了用法的词。',
    '再往下是错误码表，我先把它整理成表格。',
  ],
};

// 在 documentStart 就跑（那时 document.head 还没有，所以只挂 window，不碰 DOM）
const INJECT = `window.__vsChat = ${JSON.stringify(PROMO_CHAT)};`;

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

const TABS = [['today', '今日'], ['progress', '进度'], ['vocab', '生词本'], ['settings', '设置']];

let cdp;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3400);

  // 校验：文案换上了、外壳起来了、调试提示藏了。没做到就别出图。
  const check = await ev(cdp, `(() => {
    const t = document.querySelector('.dsh-top .dim');
    const chat = document.querySelector('#dsh-scroll');
    const h = document.getElementById('dsh-hint');
    return {
      hasShell: !!document.querySelector('.dsh-demo'),
      subtitle: t ? t.textContent : null,
      chatText: chat ? chat.innerText.replace(/\\n+/g, ' | ').slice(0, 140) : null,
      hintDisplay: h ? getComputedStyle(h).display : 'missing',
      bootError: document.getElementById('vs-boot-error') ? 'BOOT FAILED' : null,
    };
  })()`);
  console.log('文案核对: ' + JSON.stringify(check, null, 2));
  if (!check.hasShell || check.bootError) throw new Error('外壳没起来，停止出图');
  if (check.hintDisplay !== 'none') console.log('  ⚠ 调试提示没藏掉');

  console.log('打开面板: ' + JSON.stringify(await ev(cdp, `(() => {
    if (!window.__vsDemo || typeof window.__vsDemo.openPanel !== 'function') return 'no openPanel';
    window.__vsDemo.openPanel(); return 'ok';
  })()`)));
  await sleep(1100);

  for (const [slug, label] of TABS) {
    await ev(cdp, `(() => {
      const tabs = [...document.querySelectorAll('.tabs span, [class*=tab]')];
      const t = tabs.find(n => (n.textContent||'').trim() === ${JSON.stringify(label)});
      if (t) t.click();
    })()`);
    await sleep(950);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(outDir, `${slug}.png`), Buffer.from(data, 'base64'));
    console.log(`  ${label.padEnd(4)} → ${resolve(outDir, slug + '.png')}`);
  }
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
