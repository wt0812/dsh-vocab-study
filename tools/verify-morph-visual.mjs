/**
 * 验证「词根词缀」在真实面板上的**覆盖率与内容**。
 *
 * 和 verify-roots-visual.mjs 的区别：那个只证明「有没有出现」，
 * 这个统计「翻了 N 张，多少张有词根词缀、各是什么样」，并分类截图：
 *   ① root  前缀+词根  ② affix 只有词缀（无词根）  ③ none 什么都没有（诚实留空）
 *
 *   node tools/verify-morph-visual.mjs [输出目录] [翻多少张]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-morph');
const PORT = 9243;
const outDir = resolve(process.argv[2] ?? '_verify');
const COLL = process.argv[3] ?? '';
const MAX = Number(process.argv[4] ?? 60);
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1400, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3600);

  console.log('  打开面板: ' + (await ev(cdp, `(() => { window.__vsDemo?.openPanel(); return 'ok'; })()`)));
  await sleep(1200);

  // 换词库：demo 默认是 cet4（116 词里 104 个有词根，看着过于乐观），
  // 要看到真实覆盖率得切到一个大词库。
  if (COLL) {
    await ev(cdp, `(() => {
      const t = [...document.querySelectorAll('.vs-tab')].find((x) => (x.textContent || '').includes('设置'));
      t?.click();
    })()`);
    await sleep(700);
    const sw = await ev(cdp, `(() => {
      const s = document.getElementById('vs-collection');
      if (!s) return 'no-select';
      s.value = ${JSON.stringify(COLL)};
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'switched';
    })()`);
    console.log(`  换词库 → ${COLL}: ${sw}`);
    await sleep(3000);
    await ev(cdp, `(() => {
      const t = [...document.querySelectorAll('.vs-tab')].find((x) => (x.textContent || '').includes('今日'));
      t?.click();
    })()`);
    await sleep(900);
  }

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
      await sharp(full).png().toFile(out);
    } else {
      await sharp(full).extract({ left, top, width, height }).png().toFile(out);
    }
    const meta = await sharp(out).metadata();
    console.log(`  ✅ 截图: ${name}  (${meta.width}x${meta.height})`);
    return out;
  }

  const rows = [];
  const shots = new Set();
  for (let i = 1; i <= MAX; i++) {
    // 这一轮走完了 → 点「再背一轮」继续抽样
    const restarted = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      if (!p) return 'no-panel';
      const again = [...p.querySelectorAll('.vs-btn')].find((b) => (b.textContent || '').includes('再背一轮'));
      if (again) { again.click(); return 'restarted'; }
      return 'no-need';
    })()`);
    if (restarted === 'restarted') await sleep(900);

    // 翻到背面
    const step = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      if (!p) return 'no-panel';
      if (!p.querySelector('.vs-reveal')) {
        const b = p.querySelector('.vs-rate[data-k="forgot"]');
        if (!b) return 'no-rate-btn';
        b.click();
        return 'revealed';
      }
      return 'already';
    })()`);
    await sleep(step === 'revealed' ? 650 : 60);

    const info = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      const word = (p.querySelector('.vs-panel-word, .vs-word')?.textContent || '').trim().split(/\\s+/)[0];
      const heads = [...p.querySelectorAll('.vs-folds details')].map((d) => (d.querySelector('summary')?.textContent || '').trim());
      const rootFold = [...p.querySelectorAll('.vs-folds details')].find((d) => (d.querySelector('summary')?.textContent || '').includes('词根词缀'));
      const body = rootFold ? (rootFold.querySelector('.vs-foldbody')?.textContent || '').trim() : '';
      return { word, heads, body, open: rootFold ? rootFold.open : null };
    })()`);

    if (info && info.word) {
      const cat = !info.heads.some((h) => h.includes('词根词缀')) ? 'none' : info.body.includes('词根') ? 'root' : 'affix';
      rows.push({ ...info, cat });
      if (cat === 'root' && !shots.has('root')) {
        shots.add('root');
        await snap('panel-morph-root.png');
      } else if (cat === 'affix' && !shots.has('affix')) {
        shots.add('affix');
        await snap('panel-morph-affix.png');
      } else if (cat === 'none' && !shots.has('none')) {
        shots.add('none');
        await snap('panel-morph-none.png');
      }
    }

    await ev(cdp, `(() => { document.querySelector('.vs-panel [data-act="next"]')?.click(); })()`);
    await sleep(420);
  }

  console.log(`\n  ── 翻了 ${rows.length} 张，逐张记录（真 DOM）──`);
  for (const r of rows) {
    const tag = r.cat === 'root' ? '词根' : r.cat === 'affix' ? '词缀' : '空  ';
    console.log(`    ${tag}  ${String(r.word).padEnd(16)} ${r.body || '（没有这一块）'}`);
  }

  const nRoot = rows.filter((r) => r.cat === 'root').length;
  const nAffix = rows.filter((r) => r.cat === 'affix').length;
  const nNone = rows.filter((r) => r.cat === 'none').length;
  const nAny = nRoot + nAffix;
  const pct = rows.length ? ((nAny / rows.length) * 100).toFixed(1) : '0.0';
  console.log(`\n  ── 统计 ──`);
  console.log(`    有词根       ${nRoot}`);
  console.log(`    只有词缀     ${nAffix}`);
  console.log(`    什么都没有   ${nNone}`);
  console.log(`    合计有内容   ${nAny} / ${rows.length} = ${pct}%`);

  const checks = [
    ['这一批里出现了「词根」拆解', nRoot > 0],
    ['这一批里出现了「只有词缀」的', nAffix > 0],
    ['默认就是展开的（没有人点过）', rows.filter((r) => r.cat !== 'none').every((r) => r.open === true)],
    ['没有 sider 被当成「坐」（上一版的错）', rows.every((r) => !/sider\(坐/.test(r.body))],
    ['每一条都带括号含义（不是光秃秃一个词根名）', rows.filter((r) => r.cat !== 'none').every((r) => /\(.+\)/.test(r.body))],
  ];
  console.log('');
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) code = 1;
  }
} catch (e) {
  console.log('  ✗ ' + (e && e.message));
  code = 1;
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
