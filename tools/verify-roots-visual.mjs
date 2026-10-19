/**
 * 验证「词根词缀」在**真实渲染出来的面板**上确实出现了。
 *
 * 为什么不看单测：上一版单测 61 项全绿，界面上一个词根都没有 ——
 * 因为测试直接调数据函数，绕过了真正的渲染路径。这里走的是真 DOM。
 *
 * 做法：headless Chrome 打开 demo/preview.html（就是构建产物），
 * 点「😰 不认识」翻到背面，如果这一张没有词根折叠项就点「下一张」，
 * 直到找到有词根的卡，再展开折叠项截图。
 *
 *   node tools/verify-roots-visual.mjs [输出目录]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-roots');
const PORT = 9241;
const outDir = resolve(process.argv[2] ?? '_verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--window-size=1600,1400',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('CDP 没起来');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* */
    }
  }
}

/** 在页面里跑一段表达式，返回它的值（异常转成字符串，方便看到真实错误）。 */
async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
}

let cdp;
let code = 0;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1400,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3600);

  const opened = await ev(cdp, `(() => {
    if (!window.__vsDemo) return 'no-demo-handle';
    window.__vsDemo.openPanel();
    return 'ok';
  })()`);
  console.log('  打开面板: ' + opened);
  await sleep(1200);

  /**
   * 截一张、裁到面板、存成 outDir/name。
   * 注意：展开折叠项后面板可能比视口还高，直接按 rect 算裁剪框会越界
   * （sharp 报 `bad extract area`）。所以先拿截图真实尺寸再夹到边界内。
   */
  async function snap(name) {
    const rect = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      const r = p.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const full = resolve(outDir, `_full-${name}`);
    writeFileSync(full, Buffer.from(data, 'base64'));

    const fullMeta = await sharp(full).metadata();
    const pad = 14;
    const left = Math.max(0, Math.round((rect.x - pad) * 2));
    const top = Math.max(0, Math.round((rect.y - pad) * 2));
    const width = Math.min(fullMeta.width - left, Math.round((rect.w + pad * 2) * 2));
    const height = Math.min(fullMeta.height - top, Math.round((rect.h + pad * 2) * 2));
    const out = resolve(outDir, name);
    if (width < 8 || height < 8) {
      console.log(`  ⚠️ 裁剪框异常（left=${left} top=${top} w=${width} h=${height}），存整屏`);
      await sharp(full).png().toFile(out);
    } else {
      await sharp(full).extract({ left, top, width, height }).png().toFile(out);
    }
    const meta = await sharp(out).metadata();
    console.log(`  ✅ 截图: ${name}  (${meta.width}x${meta.height})`);
    return out;
  }

  // 词库由 demo 自己决定；这里不强切（没有 setCollection 这个 API）。
  // 只确认面板和卡片在，然后靠「多翻几张」自然碰到有词根的词。

  // 逐张翻：点「不认识」翻背面 → 看有没有「词根词源」→ 没有就「下一张」
  let found = null;
  for (let i = 1; i <= 25; i++) {
    const state = await ev(cdp, `(() => {
      const body = document.querySelector('.vs-panel');
      if (!body) return { err: 'no-panel' };
      // 翻面：背面还没出来就点「不认识」
      const back = body.querySelector('.vs-reveal');
      if (!back) {
        const b = body.querySelector('.vs-rate[data-k="forgot"]');
        if (!b) return { err: 'no-rate-btn' };
        b.click();
        return { step: 'revealed' };
      }
      const heads = [...body.querySelectorAll('.vs-folds details summary')].map((s) => (s.textContent || '').trim());
      const title = (body.querySelector('.vs-word, .vs-head')?.textContent || '').trim().slice(0, 40);
      return { step: 'back', heads, title };
    })()`);
    await sleep(600);

    if (state && state.heads) {
      const hasRoots = state.heads.some((h) => h.includes('词根'));
      console.log(
        `  第 ${String(i).padStart(2)} 张  ${state.title || '(无题)'}  折叠项=[${state.heads.join(' | ')}]` +
          (hasRoots ? '  ← 有词根！' : ''),
      );
      if (hasRoots) {
        found = state;
        break;
      }
      // 不然看下一张
      await ev(cdp, `(() => {
        const b = document.querySelector('.vs-panel [data-act="next"]');
        if (b) b.click();
      })()`);
      await sleep(700);
    }
  }

  if (!found) {
    console.log('\n  ✗ 翻了 25 张都没找到带「词根词源」折叠项的卡 —— 功能没出现在界面上');
    code = 1;
  } else {
    // ── 第一拍：**默认状态**，什么都不点 ────────────────────────
    // 要证明两件事：词根词源默认是展开的；同族词默认是收起的。
    const defState = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      return [...p.querySelectorAll('.vs-folds details')].map((d) => ({
        title: (d.querySelector('summary')?.textContent || '').trim(),
        open: d.open,
      }));
    })()`);
    console.log('\n  默认状态（没有点任何折叠项）:');
    for (const f of defState) {
      console.log(`    [${f.open ? '展开' : '收起'}] ${f.title}`);
    }
    // 只用 `open` 属性判定：闭合的 <details> 内容由浏览器保证不可见，
    // 而「子元素尺寸」不是可靠信号（Chrome 里闭合的 details 子元素仍报出尺寸）。
    // 真正的可见性靠下面两张图肉眼/视觉模型复核。
    const rootsFold = defState.find((f) => f.title.includes('词根'));
    const familyFold = defState.find((f) => f.title.includes('同族'));
    const okRootsOpen = !!(rootsFold && rootsFold.open);
    const okFamilyClosed = !!(familyFold && !familyFold.open);
    console.log('  断言「词根词源默认展开」: ' + (okRootsOpen ? '✓' : '✗'));
    console.log('  断言「同族词默认收起」  : ' + (okFamilyClosed ? '✓' : '✗'));
    if (!okRootsOpen || !okFamilyClosed) code = 1;

    await snap('panel-roots-default.png');

    // ── 第二拍：手动把同族词也点开 ─────────────────────────────
    await ev(cdp, `(() => {
      document.querySelectorAll('.vs-panel .vs-folds details').forEach((d) => { d.open = true; });
      const s = document.querySelector('.vs-panel .vs-folds');
      if (s) s.scrollIntoView({ block: 'center' });
    })()`);
    await sleep(700);

    // 把折叠项里的文字抓出来（文本层面的证据，不只看图）
    const text = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      const word = (p.querySelector('.vs-panel-word, .vs-word, .vs-head')?.textContent || '').trim();
      const folds = [...p.querySelectorAll('.vs-folds details')].map((d) => ({
        title: (d.querySelector('summary')?.textContent || '').trim(),
        body: (d.querySelector('.vs-foldbody')?.textContent || '').trim(),
      }));
      return { word: word.slice(0, 60), folds, panelText: (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 700) };
    })()`);
    console.log('\n  折叠项文字（真 DOM 抓的）:');
    for (const f of text.folds || []) console.log(`    [${f.title}] ${f.body}`);

    await snap('panel-roots-expanded.png');

    // 断言：文本里必须同时出现词根拆解和同族词
    const all = (text.folds || []).map((f) => f.title + ' ' + f.body).join(' ');
    const hasRootsText = /\(.+\)/.test((text.folds.find((f) => f.title.includes('词根')) || {}).body || '');
    const hasFamily = /同族词/.test(all);
    console.log('  断言「词根拆解有内容」: ' + (hasRootsText ? '✓' : '✗'));
    console.log('  断言「同族词出现」  : ' + (hasFamily ? '✓' : '✗'));
    if (!hasRootsText || !hasFamily) code = 1;
  }
} finally {
  cdp?.close();
  try {
    chrome.kill();
  } catch {
    /* */
  }
  await sleep(400);
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch {
    /* */
  }
}
process.exit(code);
