/**
 * 验证「周度回顾」在真实渲染的面板上显示正确。
 *
 * 背景：用户周一早上打开，看到「本周：学 56 词 · 收服 10 词 · 最长连续 2 天」
 * 和「诊断：今天的 42 个错词」，而他今天只背了 9 个词、那天才周一。
 *
 * 这个脚本做三件事：
 *   1. 往 app 里塞一批**上一个自然周**的记录（错误次数、打卡日都造好）
 *   2. 真的把一轮走完（周报在结算时才算）
 *   3. 把渲染出来的文字抓出来 + 截图，逐条比对文案
 *
 *   node tools/verify-weekly-report.mjs [输出目录]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-weekly');
const PORT = 9247;
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
    '--window-size=1600,1600',
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1600, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3600);

  console.log('  打开面板: ' + (await ev(cdp, `(window.__vsDemo && (window.__vsDemo.openPanel(), 'ok')) || 'no-handle'`)));
  await sleep(1000);

  // ── 造数据：上一个自然周 ───────────────────────────────────
  // 用页面里的真实 now 往前推，不用我这边的时间，免得跨机器不一致。
  const seeded = await ev(cdp, `(() => {
    const app = window.__vsDemo.app;
    const DAY = 86400000;
    const words = app.raw.words.slice(0, 12);
    if (!words.length) return { err: '没有词库' };
    const t0 = Date.now();
    const recs = [];
    // 上周三/四/五 连续 3 天有记录；某个词错了 4 次；另加 2 次答对
    const push = (daysAgo, w, correct) => recs.push({
      ts: t0 - daysAgo * DAY,
      dayKey: null, // 下面用页面自己的 dayKey 填
      wordId: w.id,
      mode: correct ? 'quiz' : 'quiz',
      correct, incorrect: !correct,
      reactionMs: 3000, tier: 3,
    });
    push(7, words[0], false);
    push(7, words[0], false);
    push(7, words[1], true);
    push(6, words[0], false);
    push(6, words[2], true);
    push(5, words[3], false);
    push(5, words[0], false);
    // 今天也来两条：用来验证「今天的不算进上周」
    push(0, words[4], false);
    push(0, words[5], false);

    // dayKey 用 app 自己的口径填（4:00 分界），否则统计对不上
    const Q = app.__Q || null;
    return { recs: recs.map((r) => ({ ...r })), words: words.map((w) => w.word) };
  })()`);
  if (seeded.__error || seeded.err) {
    console.log('  ✗ 造数据失败: ' + JSON.stringify(seeded));
    code = 1;
  } else {
    // 第二次注入：拿 app 的内部 dayKey 函数把 dayKey 补上（拆两步，避免序列化函数）
    const injected = await ev(cdp, `(() => {
      const app = window.__vsDemo.app;
      const recs = ${JSON.stringify(seeded.recs)};
      // app 暴露了 raw，dayKey 从队列模块走不到；直接按 4:00 分界本地算
      const DAY = 86400000;
      const START = 4; // DAY_START_HOUR
      const dayKey = (ts) => {
        const d = new Date(ts - START * 3600000);
        const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + dd;
      };
      for (const r of recs) r.dayKey = dayKey(r.ts);
      app.raw.records = recs;
      // 清掉本日已出周报的标记，让它重算
      app.raw.settings.lastReportDay = null;
      app.raw.report = null;
      // 最长连续故意设成一个很大的历史值：用来证明周报不拿它充数
      app.raw.streak = { ...(app.raw.streak || {}), longest: 99 };
      return { n: recs.length, dayKeys: [...new Set(recs.map((r) => r.dayKey))] };
    })()`);
    console.log('  已注入记录: ' + JSON.stringify(injected));

    // ── 走完一轮，触发周报结算 ───────────────────────────────
    // 先点「再背一轮」保证有进行中的一轮
    await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      const b = [...p.querySelectorAll('button')].find((x) => (x.textContent || '').includes('再背一轮'));
      if (b) b.click();
    })()`);
    await sleep(900);

    let guard = 0;
    while (guard++ < 120) {
      const st = await ev(cdp, `(() => {
        const p = document.querySelector('.vs-panel');
        if (!p) return { err: 'no-panel' };
        if (p.querySelector('.vs-reveal')) {
          const b = p.querySelector('[data-act="next"]');
          if (b) { b.click(); return { step: 'next' }; }
          return { step: 'stuck-back' };
        }
        const r = p.querySelector('.vs-rate[data-k="known"]');
        if (r) { r.click(); return { step: 'rate' }; }
        return { step: 'idle' };
      })()`);
      if (st.step === 'idle' || st.step === 'stuck-back') break;
      await sleep(220);
    }
    await sleep(1200);

    // ── 抓渲染出来的文字 ────────────────────────────────────
    const got = await ev(cdp, `(() => {
      const app = window.__vsDemo.app;
      const p = document.querySelector('.vs-panel');
      const rep = app.raw.report;
      const card = [...p.querySelectorAll('.vs-report')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim());
      const h2 = [...p.querySelectorAll('.vs-h2')].map((n) => (n.textContent || '').trim());
      const heatLbl = [...p.querySelectorAll('.vs-deck-heat .lbl, .vs-deck-heat span')].map((n) => (n.textContent || '').trim());
      return {
        reportObj: rep,
        reportCards: card,
        headings: h2,
        heatLabels: heatLbl,
        panelText: (p.textContent || '').replace(/\\s+/g, ' ').trim(),
      };
    })()`);

    console.log('\n  页面里的 report 对象: ' + JSON.stringify(got.reportObj));
    console.log('  h2 标题: ' + JSON.stringify(got.headings));
    console.log('  热力图标签: ' + JSON.stringify(got.heatLabels));
    console.log('  周报那段文字: ' + JSON.stringify(got.reportCards));

    const txt = (got.reportCards || []).join(' ') + ' ' + (got.headings || []).join(' ');
    const checks = [
      ['标题是「上周回顾」', /上周回顾/.test(txt)],
      ['不再出现「本周对账单」', !/本周对账单/.test(txt)],
      ['不再出现「本周：学」', !/本周：学/.test(txt)],
      ['有「上周：背了 N 个词」', /上周：背了 \d+ 个词/.test(txt)],
      ['有「辨词答对 N 次」', /辨词答对 \d+ 次/.test(txt)],
      ['有「最长连续 N 天」', /最长连续 \d+ 天/.test(txt)],
      ['没有「今天的 N 个错词」', !/今天的 \d+ 个错词/.test(txt)],
      ['诊断句说的是「上周」', /诊断：上周/.test(txt)],
      ['建议句是「这周建议」', /这周建议/.test(txt)],
      ['热力图标签和数据量一致', (got.heatLabels || []).some((h) => !h.includes('半个') && h.length > 0)],
      ['最长连续没有拿历史 99 充数', got.reportObj && got.reportObj.longestStreak !== 99],
    ];
    console.log('');
    let bad = 0;
    for (const [name, cond] of checks) {
      console.log('  ' + (cond ? '✓' : '✗') + ' ' + name);
      if (!cond) bad++;
    }
    if (bad) code = 1;

    // ── 截图 ────────────────────────────────────────────────
    await ev(cdp, `(() => {
      const h = [...document.querySelectorAll('.vs-panel .vs-h2')].find((n) => (n.textContent || '').includes('上周回顾'));
      if (h) h.scrollIntoView({ block: 'center' });
    })()`);
    await sleep(600);

    const rect = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      const r = p.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const full = resolve(outDir, '_full-weekly.png');
    writeFileSync(full, Buffer.from(data, 'base64'));
    const fm = await sharp(full).metadata();
    const pad = 14;
    const left = Math.max(0, Math.round((rect.x - pad) * 2));
    const top = Math.max(0, Math.round((rect.y - pad) * 2));
    const width = Math.min(fm.width - left, Math.round((rect.w + pad * 2) * 2));
    const height = Math.min(fm.height - top, Math.round((rect.h + pad * 2) * 2));
    const out = resolve(outDir, 'panel-weekly.png');
    if (width < 8 || height < 8) await sharp(full).png().toFile(out);
    else await sharp(full).extract({ left, top, width, height }).png().toFile(out);
    const meta = await sharp(out).metadata();
    console.log(`\n  ✅ 截图: ${out}  (${meta.width}x${meta.height})`);
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
