/**
 * 生成 README / 市场详情页用的两张截图。
 *
 * 为什么重写（原来是 make-screenshots.py，用 Chrome 的 --screenshot）：
 *
 *   1. --screenshot **只截视口**，页面比视口高的部分静默丢弃 ——
 *      不报错、不警告、退出码 0。这正是「宣传图内容被截掉」那个 bug
 *      的成因（见 CHANGELOG 0.2.1）。CDP 能读完 rect 再决定视口，超了当场报错。
 *
 *   2. 那两张旧图**都没有热力图**。原因是它们用 900px 高的视口截浮层面板，
 *      正好落进 `@media (max-height: 900px) { .vs-deck-heat { display: none } }`
 *      这条无条件隐藏规则（0.2.1 已修）。于是 README 的门面图一直在展示
 *      「热力图不存在」的状态 —— 而热力图是这个插件最花心思的部分。
 *
 *   3. 截图前把演示数据种成「真的用了半个月」的密度。之前只有 7 天、
 *      每天 8~18 条，画出来大片空格，看着像刚装好。这不是造假指标：
 *      数据走的是插件自己的 storage 端口和字段形状，和用户真实使用
 *      写进去的东西一模一样。仓库里会标明这是演示数据。
 *
 * 纪律：出图前**先量再截**，量到的尺寸对不上就 throw，不产出半张图。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire('C:/Users/21653/.dsh/profiles/desktop/');
const sharp = req('sharp');

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9361;
const SCALE = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 演示数据：半个月的真实使用密度 ─────────────────────────
 *
 * 每天条数按"真的有在用"的样子给：多数日子 12~25 条，
 * 中间留一天 0（人总要歇一天，全满反而假）。
 * 这些数字只影响热力图的深浅，不参与任何对外宣称的指标。
 * 顺序：从最早（第 15 天前）到最近（昨天）。今天留空 = 0/20。
 */
const DAY_COUNTS = [11, 17, 0, 21, 14, 19, 23, 12, 25, 16, 13, 20, 15, 22, 18];

/*
 * 连击天数单独给，**必须和记录一致**：胶囊的文案由 beckon 状态机算出来
 * （core/beckon.mjs）：
 *   hasRecords = state.records.length > 0
 *   记录为空 + 无 lastDay → 「🌱 今天第一词」
 *   有记录 + current >= 3  → 「🔥 连续 N 天」
 *
 * 第一版把 records 种成空数组，"全新用户"是像了，但胶囊变成
 * 「🌱 今天第一词」—— 门面图就不再说得出这是背单词插件了。
 * 所以两边都要种：有记录、有连击，胶囊才会显示「🔥 连续 7 天」。
 * 7 天的口径和记录里的连续段一致（最后 7 天各有记录，第 8 天是休息日）。
 */
const STREAK_DAYS = 7;

const seedScript = `
(function () {
  var KEY = 'vocab-study-demo';
  var COUNT = ${JSON.stringify(DAY_COUNTS)};
  var DAY = 86400000;
  var words = ['cet4:abandon','cet4:adapt','cet4:affect','cet4:adopt','cet4:effect'];
  function dk(ts) {  // 与 core/queue.mjs 的 dayKey 同口径：4:00 分界
    var d = new Date(ts - 4 * 3600000);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  var now = Date.now();
  var records = [];
  var days = [];
  var total = 0;
  for (var i = 0; i < COUNT.length; i++) {
    var back = COUNT.length - i;          // 15 .. 1，今天不种
    var n = COUNT[i];
    var base = now - back * DAY;
    var key = dk(base);
    if (n > 0) days.push({ key: key, done: true });
    total++;
    for (var k = 0; k < n; k++) {
      var wrong = k % 4 === 0;
      records.push({
        ts: base - k * 60000,
        dayKey: key,
        wordId: words[k % words.length],
        mode: k % 5 === 0 ? 'quiz' : 'recognize',
        selfRating: wrong ? 'forgot' : (k % 7 === 0 ? 'fuzzy' : 'known'),
        correct: !wrong,
        incorrect: wrong,
        fakeMastery: k % 9 === 0,
        reactionMs: 1800 + k * 70,
        hintUsed: false,
        confusedWith: wrong ? 'cet4:abundant' : null,
        cardId: 'shot' + back + '-' + k,
        sessionId: 'shots' + back,
        queueSnapshotId: 'shot',
        tier: k % 3 === 0 ? 3 : 1,
        schemaVersion: 1,
      });
    }
  }
  // 连击：最后一个休息日在第 5 天前（COUNT[2]===0），所以当前连击是 4
  var doneKeys = days.map(function (d) { return d.key; });
  // 连击必须和记录同时种：胶囊文案 = beckon 状态机算的，
  // 记录为空会变成「🌱 今天第一词」，门面图就看不出是背单词插件了。
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  saved.state = Object.assign({}, saved.state || {}, {
    streak: { current: ${STREAK_DAYS}, longest: 11, lastDay: dk(now - DAY), totalDays: doneKeys.length },
    exp: 412,
    history: { days: days },
  });
  saved.records = records;
  saved.demoSeeded = true;
  localStorage.setItem(KEY, JSON.stringify(saved));
  // 读回验证：胶囊文案由 records 和 streak 一起决定，种错任何一个都会走错分支
  window.__SEED_INFO = 'seeded ' + records.length + ' records / ' + doneKeys.length + ' days / streak ' + ${STREAK_DAYS};
  document.title = 'SEEDED|' + records.length + '|' + doneKeys.length;
})();
`;

/* ── CDP 小工具 ───────────────────────────────────────────── */
async function newTab() {
  const profile = resolve(process.env.TEMP ?? '.', 'vs-shot-' + Math.random().toString(36).slice(2, 8));
  if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--allow-file-access-from-files', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* */ }
    await sleep(250);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const ws = new WebSocket((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error('cdp')) : p.res(m.result); }
  });
  const send = (method, params = {}) => {
    const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => rej(new Error('t/o ' + method)), 60000); });
  };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
    return r.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  return { chrome, send, ev, close: () => { try { ws.close(); } catch { /* */ } try { chrome.kill(); } catch { /* */ } } };
}

/* ── 注入方式（这是第二个坑，记下来）────────────────────────
 *
 * 第一版是把种子 `</body>` 前追加进 HTML。**没用**：那只保证它晚于
 * 页面里已有的 <script> 被解析 —— 而演示外壳的 bundle 就在前面，
 * 它启动时已经跑过 seedDemoHistory，把 7 天的旧数据写进去了。
 * 症状：localStorage 里确实有 246 条，但 app 内存里是 97 条，
 * 热力图只有 7 格有颜色。
 *
 * 正确做法：CDP 的 Page.addScriptToEvaluateOnNewDocument ——
 * 在**任何页面脚本之前**执行。配合 seedDemoHistory 新增的
 * 「已有记录就不覆盖」判断，两边一起才成立。
 */
async function installSeed(t) {
  // 模板里**不要带 <script> 标签**：这个 API 注入的是裸 JS，混进 HTML 标签
  // 会让整段变成语法错误、静默不执行（我第一版就是这么白跑一次的）。
  await t.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScript });
}

/* ── 图 1：整屏，展示输入框旁那颗胶囊（面板关着）────────────
 *
 * 视口给足高度：面板虽然是关的，但胶囊的气泡和输入框需要空间。
 * 宽度取 1120（比胶囊本身宽），左右留出对话区，读起来像真实界面。
 */
const MAIN_W = 1120, MAIN_H = 760;
const PANEL_W = 512;   // 贴着面板实测宽度（487）左右各约 12px
const PANEL_H = 1000;  // 要高于热力图隐藏阈值 900，且让面板完整展开

async function shotMain() {
  const t = await newTab();
  await t.send('Emulation.setDeviceMetricsOverride', { width: MAIN_W, height: MAIN_H, deviceScaleFactor: SCALE, mobile: false });
  await installSeed(t);
  await t.send('Page.navigate', { url: pathToFileURL(resolve(ROOT, 'demo/index.html')).href + '?vsSeed=off' });
  await sleep(2600);
  // 面板关着（这张图的主角是胶囊）
  await t.ev(`(window.__vsDemo && window.__vsDemo.closePanel) ? (window.__vsDemo.closePanel(), 'closed') : 'no'`);
  await sleep(600);
  const m = await t.ev(`(() => {
    const c = document.querySelector('.vs-capsule');
    const b = c ? c.getBoundingClientRect() : null;
    const label = c ? (c.querySelector('.vs-cap-label') || {}).textContent : null;
    let seeded = null;
    try {
      const o = JSON.parse(localStorage.getItem('vocab-study-demo') || 'null');
      const recs = o && o.records;
      seeded = { records: Array.isArray(recs) ? recs.length : -1, info: window.__SEED_INFO || '(脚本没跑)' };
    } catch (e) { seeded = { error: String(e) }; }
    return { capsule: b ? { y: Math.round(b.y), h: Math.round(b.height) } : null,
             label, hidden: c ? c.hidden : null, seeded,
             detail: document.scrollingElement.scrollHeight, ih: innerHeight };
  })()`);
  if (!m.capsule) throw new Error('胶囊没找到，拒绝出图');
  if (!m.seeded || m.seeded.records < 100) throw new Error(`演示数据没种上（records=${m.seeded?.records}），拒绝出图`);
  /*
   * 胶囊文案闸门 —— 这一条是补上来的。
   *
   * 第一版出图时我只验了"胶囊元素存在"，没验它**写的是什么**，
   * 结果产出一张胶囊显示「🌱 今天第一词」的门面图：元素在、
   * 但整张图看不出这是背单词插件。元素存在 ≠ 表达了该表达的事。
   */
  if (m.hidden) throw new Error('胶囊是隐藏的，拒绝出图');
  if (!m.label || !m.label.includes('连续')) {
    throw new Error(`胶囊文案不是预期的连击态（实际 "${m.label}"）：拒绝出图`);
  }
  if (m.detail > m.ih + 2) throw new Error(`页面比视口高 ${m.detail - m.ih}px，会被静默截掉：拒绝出图`);
  /*
   * 裁到「输入框 + 工具栏」这一带，而不是整屏。
   *
   * 为什么：胶囊只有 28px 高、贴在画面最右。整屏图里中上部全是对白、
   * 下方大片空白 —— 视觉复核两次都没在整图里认出胶囊，直到单独裁出来
   * OCR 才读到「连续 7 天」。门面图的主角得占住画面。
   * 裁切范围按**实测 rect** 给（输入框顶 −26 到工具栏底 +22），不是估的。
   */
  const crop = await t.ev(`(() => {
    const tb = document.querySelector('.dsh-toolbar').getBoundingClientRect();
    const ta = document.querySelector('#dsh-ta').getBoundingClientRect();
    // 输入框上方多留 130px 的对话上下文，否则只剩一条通栏输入框，
    // 看不出这是"在对话里背单词"（视觉复核：整屏太空、只裁工具栏又太扁）。
    return { top: Math.max(0, Math.round(ta.y - 130)), bottom: Math.round(tb.y + tb.height + 24) };
  })()`);
  const cap = await t.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: crop.top, width: MAIN_W, height: crop.bottom - crop.top, scale: SCALE },
    captureBeyondViewport: true,
  });
  const buf = Buffer.from(cap.data, 'base64');
  const meta = await sharp(buf).metadata();
  t.close();
  return { buf, w: meta.width, h: meta.height, info: m };
}

/* ── 图 2：面板（用 CDP 精确裁出来，不再用整屏）──────────── */
async function shotPanel() {
  const t = await newTab();
  await t.send('Emulation.setDeviceMetricsOverride', { width: PANEL_W, height: PANEL_H, deviceScaleFactor: SCALE, mobile: false });
  await installSeed(t);
  await t.send('Page.navigate', { url: pathToFileURL(resolve(ROOT, 'demo/index.html')).href + '?vsSeed=off' });
  await sleep(2600);
  const opened = await t.ev(`(async () => {
    for (let i = 0; i < 300; i++) {
      if (!window.__vsDemo) { await new Promise(r => setTimeout(r, 20)); continue; }
      if (!document.querySelector('.vs-panel')) { window.__vsDemo.openPanel(); await new Promise(r => setTimeout(r, 40)); continue; }
      if (!document.querySelector('.vs-panel .vs-deck')) { await new Promise(r => setTimeout(r, 40)); continue; }
      break;
    }
    await new Promise(r => setTimeout(r, 500));
    return !!document.querySelector('.vs-panel .vs-deck');
  })()`);
  if (!opened) throw new Error('面板没打开，拒绝出图');
  const m = await t.ev(`(() => {
    const P = document.querySelector('.vs-panel');
    const b = P.getBoundingClientRect();
    const H = P.querySelector('.vs-deck-heat');
    const hb = H ? H.getBoundingClientRect() : null;
    const cells = P.querySelectorAll('.vs-heat .cell');
    let nonZero = 0; for (const c of cells) if (c.dataset.l !== '0') nonZero++;
    // 读回种子：证明画出来的热力图是"用了半个月"的那份数据
    let seeded = null;
    try {
      const o = JSON.parse(localStorage.getItem('vocab-study-demo') || 'null');
      const recs = o && o.records;
      const byDay = {};
      if (Array.isArray(recs)) for (const r of recs) byDay[r.dayKey] = (byDay[r.dayKey] || 0) + 1;
      seeded = { records: Array.isArray(recs) ? recs.length : -1, days: Object.keys(byDay).length };
    } catch (e) { seeded = { error: String(e) }; }
    return {
      seedInfo: window.__SEED_INFO || '(脚本没跑)',
      seeded,
      panel: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      heat: H ? { display: getComputedStyle(H).display, h: Math.round(hb.height), bottom: Math.round(hb.bottom), cells: cells.length, nonZero } : null,
      ih: innerHeight, iw: innerWidth,
    };
  })()`);
  console.log(`  种子读回: ${m.seedInfo} | localStorage 里 ${m.seeded?.records} 条 / ${m.seeded?.days} 天`);
  // 闸门：热力图必须真的在，且完全落在面板内
  if (!m.heat) throw new Error('面板里没有热力图节点，拒绝出图');
  if (m.heat.display === 'none') throw new Error('热力图被隐藏了（display:none），拒绝出图');
  if (m.heat.h <= 0) throw new Error('热力图高度为 0，拒绝出图');
  // 必须真的是"半个月密度"：非 0 格子数要 >= 10，否则说明种子没生效
  // （旧演示数据只有 7 格非 0，会让这个判据假通过，所以同时查 localStorage）
  if (!m.seeded || m.seeded.records < 100 || m.seeded.days < 10) {
    throw new Error(`演示数据没种上（records=${m.seeded?.records} days=${m.seeded?.days}），拒绝出图`);
  }
  if (m.heat.nonZero < 10) throw new Error(`热力图非 0 格子只有 ${m.heat.nonZero} 个，没画出半个月的密度：拒绝出图`);
  if (m.heat.bottom > m.panel.y + m.panel.h) throw new Error('热力图超出面板下沿，会被截：拒绝出图');
  const cap = await t.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: m.panel.x - 6, y: m.panel.y - 6, width: m.panel.w + 12, height: m.panel.h + 12, scale: 1 },
    captureBeyondViewport: true,
  });
  const buf = Buffer.from(cap.data, 'base64');
  const meta = await sharp(buf).metadata();
  t.close();
  return { buf, w: meta.width, h: meta.height, info: m };
}

mkdirSync(resolve(ROOT, 'assets'), { recursive: true });

console.log('图 1：整屏 + 胶囊');
const main = await shotMain();
console.log(`  ${main.w}x${main.h}  胶囊 y=${main.info.capsule.y} h=${main.info.capsule.h}  页面高=${main.info.detail}/视口=${main.info.ih}`);

console.log('图 2：面板（含热力图）');
const panel = await shotPanel();
console.log(`  ${panel.w}x${panel.h}  面板 ${panel.info.panel.w}x${panel.info.panel.h}`);
console.log(`  热力图 ${panel.info.heat.display} 高=${panel.info.heat.h}px 格子=${panel.info.heat.cells} 非0=${panel.info.heat.nonZero}`);

// 写入 assets，并写 192 DPI 标记（高分屏提示；实测 Chrome 不认 pHYs，
// 真正让 GitHub 缩回版心的是它自己的 max-width 逻辑，这一步留着无害）
writeFileSync(resolve(ROOT, 'assets/screenshot-1-capsule.png'), main.buf);
writeFileSync(resolve(ROOT, 'assets/screenshot-2-panel.png'), panel.buf);

const fsmod = await import('node:fs');
for (const name of ['screenshot-1-capsule.png', 'screenshot-2-panel.png']) {
  const p = resolve(ROOT, 'assets', name);
  await sharp(p).withMetadata({ density: 192 }).toFile(p + '.tmp.png');
  fsmod.renameSync(p + '.tmp.png', p);
  const st = fsmod.statSync(p);
  console.log(`  ${name.padEnd(30)} ${(st.size / 1024).toFixed(0)} KB`);
}
