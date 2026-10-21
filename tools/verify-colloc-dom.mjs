/** 真 DOM 验证：demo 卡片背面的「常见搭配」是不是真的渲染了新数据。
 *  用法: node tools/verify-colloc-dom.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = resolve(process.env.TEMP ?? '.', 'cdp-colloc-dom');
const PORT = 9243;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

async function cdpWs() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return (await r.json()).webSocketDebuggerUrl; } catch { /**/ }
    await sleep(250);
  }
  throw new Error('Chrome 没起来');
}
const ws = new WebSocket(await cdpWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
const sid = a.sessionId;
await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  return r.result?.exceptionDetails ? { __err: r.result.exceptionDetails.text } : r.result?.result?.value;
};

await send('Page.navigate', { url: pathToFileURL(resolve('demo/preview-reveal.html')).href }, sid);
await sleep(2200);

// 页面内查数据：新补进来的词在构建产物里有没有
const probe = await ev(`(() => {
  const c = window.VOCAB_CORE || {};
  const CO = c.CLD && c.CLD.COLLOCATIONS;
  const keys = CO ? Object.keys(CO) : [];
  const pick = ['accede','adherence','admit','aesthetic','allege','allegiance','amenable','amendment','allusion','adhesive'];
  const out = {};
  for (const w of pick) out[w] = CO && CO[w] ? CO[w] : null;
  return { entries: keys.length, sample: out };
})()`);
console.log('  ① 构建产物里的搭配表:', JSON.stringify(probe).slice(0, 700));

const found = [];
for (let i = 0; i < 40; i++) {
  const snap = await ev(`(() => {
    const w = (document.querySelector('#vs-word')?.textContent || '').replace(/\\s+/g, '').replace('🔊', '');
    // 搭配是折叠块里的 <li>（summary 写「常见搭配」），不是 chip 组件
    const fold = [...document.querySelectorAll('#vs-card .vs-fold')].find(
      (f) => (f.querySelector('summary')?.textContent || '').indexOf('搭配') >= 0);
    const chips = fold ? [...fold.querySelectorAll('li')].map((x) => x.textContent.trim()) : [];
    const labels = fold ? [(fold.querySelector('summary')?.textContent || '').trim()] : [];
    return { w, chips, labels };
  })()`);
  if (snap && !snap.__err && snap.w && (snap.chips.length || snap.labels.length)) {
    found.push({ w: snap.w, labels: snap.labels.slice(0, 2), chips: snap.chips.slice(0, 5) });
  }
  await ev(`(() => {
    const rate = document.querySelector('.vs-rate[data-k="known"]') || document.querySelector('.vs-rate');
    if (rate) { rate.click(); return 'rate'; }
    const next = [...document.querySelectorAll('.vs-btn')].find((b) => b.textContent.indexOf('下一张') >= 0);
    if (next) { next.click(); return 'next'; }
    return 'none';
  })()`);
  await sleep(230);
  if (found.length >= 5) break;
}
console.log(`  ② 走过卡片里带「搭配」的 ${found.length} 个：`);
for (const f of found) console.log(`     ${f.w.padEnd(14)} 标签=${JSON.stringify(f.labels)}  条目=${JSON.stringify(f.chips)}`);
await send('Browser.close', {}, sid).catch(() => {});
chrome.kill();
