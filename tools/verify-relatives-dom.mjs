/** 真 DOM 验证：真的点着 demo 走卡片，看「同族词」块渲染成什么样。
 *  用法: node tools/verify-relatives-dom.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = resolve(process.env.TEMP ?? '.', 'cdp-rel-dom');
const PORT = 9241;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

async function cdpWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 没起来');
}

const ws = new WebSocket(await cdpWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
});
const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
const { result: att } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const sid = att.sessionId;
await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send('Page.navigate', { url: pathToFileURL(resolve('demo/preview-reveal.html')).href }, sid);
await sleep(2200);

const probe = await evalJs(`(() => {
  const c = window.VOCAB_CORE || {};
  const R = c.RT, L = c.L;
  return {
    happy: (R.relativesOf('happy') || []).map((x) => x.word + '/' + x.kind),
    invite: (R.relativesOf('invite') || []).map((x) => x.word + '/' + x.kind),
    attract: (L.familyOf('attract', 3) || []).map((f) => f.word + ':' + (f.root || 'null')),
  };
})()`);
console.log('  ① 页面内查数据（构建产物里）:', JSON.stringify(probe));

const seen = [];
const relSeen = [];
for (let i = 0; i < 70; i++) {
  const snap = await evalJs(`(() => {
    const w = (document.querySelector('#vs-word')?.textContent || '').trim();
    const folds = [...document.querySelectorAll('.vs-fold')].map((f) => ({
      title: (f.querySelector('summary')?.textContent || '').trim(),
      items: [...f.querySelectorAll('li')].map((li) => li.textContent.trim()).slice(0, 4),
    }));
    return { w, folds };
  })()`);
  if (snap && !snap.__err && snap.w) {
    if (!seen.includes(snap.w)) seen.push(snap.w);
    const rel = (snap.folds || []).find((f) => f.title.indexOf('同族词') >= 0);
    if (rel && !relSeen.some((x) => x.w === snap.w)) relSeen.push({ w: snap.w, ...rel });
  }
  // 卡片有两种状态：
  //  · 正面：只有「忘了/模糊/会了」三个评分键 —— 点一下进入背面
  //  · 背面：底部是「下一张 ␣」—— 点它换下一个词
  // 一开始我只点了评分键，结果背面没有评分键，循环空转 70 次只走过 1 个词。
  await evalJs(`(() => {
    const rate = document.querySelector('.vs-rate[data-k="known"]') || document.querySelector('.vs-rate');
    if (rate) { rate.click(); return 'rate'; }
    const next = [...document.querySelectorAll('.vs-btn')].find((b) => b.textContent.indexOf('下一张') >= 0);
    if (next) { next.click(); return 'next'; }
    return 'none';
  })()`);
  await sleep(240);
  if (relSeen.length >= 5 && seen.length >= 14) break;
}

console.log(`  ② 走过 ${seen.length} 个词，其中 ${relSeen.length} 个有「同族词」块：`);
for (const r of relSeen.slice(0, 5)) {
  console.log(`     ${r.w} → 标题「${r.title}」  条目: ${r.items.join(' | ')}`);
}
const derivTitle = relSeen.some((r) => r.title.indexOf('词形派生') >= 0);
const rootTitle = relSeen.some((r) => /^同族词 · /.test(r.title) && r.title.indexOf('词形派生') < 0);
console.log(`  ③ 标题形态：词根家族式 ${rootTitle ? '✓' : '✗'}  词形派生式 ${derivTitle ? '✓' : '（本轮随机没抽到）'}`);

writeFileSync(resolve('_rel-dom.json'), JSON.stringify({ probe, relSeen }, null, 2), 'utf8');
await send('Browser.close', {}, sid).catch(() => {});
chrome.kill();
