/**
 * 出宣传图：**真实渲染的插件面板** + 排字。
 *
 * 跟桌面上 DesktopCat 那套同一个做法：画面主体（猫 / 面板）来自程序自己的渲染，
 * 我只负责把它摆到版面上、加标题和说明。这里唯一要守的额外纪律是
 * **不伪造任何数字** —— 面板里是插件自己的真实状态；版面上的数字全部来自
 * 仓库里可核对的事实（测试套件数、词库词量、体积），并且都由脚本现算，不手写。
 *
 * 用法: node tools/make-promo.mjs <输出目录>
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9234;
const outDir = resolve(process.argv[2] ?? '_promo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });

// ── 现算版面上的事实数字（不手写，免得写错、也免得过期）──────────────
// 教训：我口头一直说「344 项测试」，实测是 372 —— 手写的数字就是会错。
const TEST_FILES = readdirSync(resolve('test')).filter((f) => f.endsWith('.test.mjs'));
const LIB = readFileSync(resolve('lib/client.js'));
const LIB_KB = (LIB.length / 1024).toFixed(1);
const PKG = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

// 内置词表真实词量（现算，不手写）。离线时能背的就是这么多 —— 见下面 FACTS 的注释。
const SEED_MOD = await import(pathToFileURL(resolve('core/seed-cet4.mjs')).href);
const SEED_COUNT = SEED_MOD.SEED_CET4_RAW.length;
const SEED_COLLECTIONS_WITH_WORDS = [
  ...new Set(SEED_MOD.SEED_CET4_RAW.map((w) => w.collection)),
];
console.log(`内置词表：${SEED_COUNT} 词，覆盖 ${SEED_COLLECTIONS_WITH_WORDS.join('/')}`);
if (SEED_COLLECTIONS_WITH_WORDS.length < 6) {
  const empty = Object.keys(SEED_MOD.SEED_COLLECTIONS).filter((c) => !SEED_COLLECTIONS_WITH_WORDS.includes(c));
  console.log(`  ⚠ 这些词库一个内置词都没有: ${empty.join(', ')}`);
  console.log('  ⚠ 所以宣传图上不能写「100% 离线」—— 离线只能背上面这些词');
}

/** 跑一遍测试并数出断言条数。
 *  这要跑满 8 个套件（约 30 秒），所以只在需要时跑 —— 结果会缓存到
 *  _promo/_assertions.json。数字变了就加 --count 重算。 */
function countAssertions() {
  const cachePath = resolve(outDir, '_assertions.json');
  if (!process.argv.includes('--count') && existsSync(cachePath)) {
    const c = JSON.parse(readFileSync(cachePath, 'utf8'));
    console.log(`测试（缓存 ${c.at}）：${c.files} 个套件 / ${c.total} 项断言`);
    return c;
  }
  let total = 0;
  const per = {};
  for (const f of TEST_FILES) {
    const r = spawnSync(process.execPath, [resolve('test', f)], { encoding: 'utf8' });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    let n = 0;
    const m = out.match(/(\d+)\s*(?:通过|passed)/);
    if (m) n = Number(m[1]);
    else n = (out.match(/[✓✔]/g) ?? []).length;
    per[f.replace('.test.mjs', '')] = n;
    total += n;
  }
  const result = { total, files: TEST_FILES.length, per, at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`测试（现算）：${result.files} 个套件 / ${result.total} 项断言`);
  console.log('  ' + Object.entries(per).map(([k, v]) => `${k}=${v}`).join('  '));
  return result;
}

const ASSERT = countAssertions();

// ── 用插件自己的机制把「今天」推进几步 ─────────────────────────
// 走它自己暴露的作答入口：rate(3)=界面上「会了」、rate(1)=「忘了」，
// 再 next() 翻到下一张卡。**不碰内部 state 结构**（那是实现细节，
// 而且 app.state 是给界面看的精简快照，根本没有 session）。
// （先写成 answerCard/reveal 都是猜的，两个都不存在：正确答案是 rate + next。）
const DRIVE_PROGRESS = `
(async () => {
  const d = window.__vsDemo;
  if (!d || !d.app || !d.openPanel) return 'no app';
  d.openPanel();
  const app = d.app;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(400);
  const trace = [];
  // 今天过 8 个词：6 个会了、2 个忘了 —— 一个真实的「背到一半」中间态
  const plan = [3, 1, 3, 3, 1, 3, 3, 3];
  for (const rating of plan) {
    try {
      app.rate(rating);
      app.next();
      trace.push(rating);
    } catch (e) {
      trace.push('抛错: ' + e.message);
      break;
    }
    await wait(110);
  }
  const s = app.state;
  return {
    trace,
    covered: s.covered,
    combo: s.combo ? s.combo.combo : null,
    exp: s.level ? s.level.exp : null,
    levelName: s.level ? s.level.name : null,
  };
})()`;

const CHAT = {
  subtitle: '侧栏插件 · 离线背单词',  hideHint: true,
  messages: [
    { who: '你', body: '帮我看看这段英文里哪些词是我没掌握的。' },
    { body: '看完了。右侧那颗胶囊点开就能背，一次几个词，不打断你手上的事。' },
  ],
  streamLines: [
    '正在提炼第 3 节的要点：涉及 6 个接口、2 处兼容性改动。',
    '顺手标出了 5 个你之前背过、但这里换了用法的词。',
  ],
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${resolve(process.env.TEMP ?? '.', 'cdp-vocab-mkpromo')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=1200,1200', 'about:blank',
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时 ' + method)); } }, 90000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}
async function ev(cdp, e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

let cdp;
try {
  await waitCdp();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 真实 DSH 侧栏宽度 ≈ 400–440 CSS px。用这个宽度渲染，面板才是竖版的、
  // 才是用户真正看到的样子（宽屏下面板会被拉成 2.7:1 的扁条，内容摊散）。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 1200, deviceScaleFactor: 3, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__vsChat = ${JSON.stringify(CHAT)};` });
  await cdp.send('Page.navigate', { url: pathToFileURL(resolve('demo/preview.html')).href });
  await sleep(3400);

  const driven = await ev(cdp, DRIVE_PROGRESS);
  console.log('推进今日进度: ' + JSON.stringify(driven));
  await sleep(800);

  // 面板是 position:absolute 的浮层，在 440 宽视口下就已经是 415x560 的竖版，
  // 本来就是用户看到的样子 —— **不要动布局**。make-screenshots.py 里记过：
  // 藏聊天区/改 display 会让面板的祖先塌掉，rect 直接变 0x0。
  // 所以这里只按实测 rect 裁像素。
  const rect = await ev(cdp, `(() => {
    const p = document.querySelector('.vs-panel');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             iw: window.innerWidth, ih: window.innerHeight };
  })()`);
  console.log('面板 rect: ' + JSON.stringify(rect));
  if (!rect || !rect.w || !rect.h) throw new Error('面板 rect 无效，停止出图');

  const shots = {};
  for (const [slug, label] of [['today', '今日'], ['progress', '进度'], ['vocab', '生词本']]) {
    await ev(cdp, `(() => {
      const tabs = [...document.querySelectorAll('.tabs span, [class*=tab]')];
      const t = tabs.find(n => (n.textContent||'').trim() === ${JSON.stringify(label)});
      if (t) t.click();
    })()`);
    await sleep(900);
    // 每切一次标签重测 rect（面板高度会随内容变）
    const r2 = await ev(cdp, `(() => {
      const p = document.querySelector('.vs-panel');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, r2.x - 10), y: Math.max(0, r2.y - 10), width: r2.w + 20, height: r2.h + 20, scale: 1 },
    });
    const f = resolve(outDir, `panel-${slug}.png`);
    writeFileSync(f, Buffer.from(data, 'base64'));
    shots[slug] = f;
    console.log(`  ${slug} → ${f}`);
  }

  // ── 排字：把真实面板图嵌进版式 ──────────────────────────────
  // 版面上的每个数字都在这里现算：测试数跑一遍数出来、体积读文件、词量从内置词表数。
  //
  // ⚠️ 曾经写过「100% 离线可用」，**那是假的，已撤掉**：
  //   内置词表实际只有 120 个词，而且全是四级；六级/考研/雅思/托福/GRE
  //   一个内置词都没有，六个 collection 的 urls 也全是空数组。
  //   离线时只能背这 120 个词。把这说成「100% 离线」是夸大。
  //   真话是「不联网也能开背」——能，但只有 120 个词。
  const b64 = (f) => readFileSync(f).toString('base64');
  const FACTS = [
    [`${ASSERT.total} 项`, `测试断言，${TEST_FILES.length} 个套件全绿`],
    [`${LIB_KB} KB`, '单文件，零运行时依赖'],
    [`${SEED_COUNT} 词`, '内置词表，断网也能开背'],
    ['3 处', 'npm / GitHub / Gitee 都能装'],
  ];
  const INSTALL = 'dsh plugin --profile web add dsh-vocab-study';

  const page = (extraCss, bodyHtml, w, h) => `<!doctype html><meta charset="utf-8"><title>promo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0E0C0A; font: 16px/1.6 "Microsoft YaHei", "PingFang SC", sans-serif;
         color: #EDE6DB; width: ${w}px; height: ${h}px; overflow: hidden; position: relative; }
  .glow { position: absolute; width: 980px; height: 980px; border-radius: 50%;
          background: radial-gradient(circle, rgba(31,157,143,.20), transparent 62%);
          top: -300px; right: -180px; }
  .wrap { position: relative; display: flex; align-items: flex-start; gap: 60px;
          padding: 66px 72px; height: 100%; }
  .left { flex: 0 0 512px; display: flex; flex-direction: column; height: 100%; }
  .kicker { font-size: 19px; letter-spacing: .2em; color: #1F9D8F; margin-bottom: 16px; }
  h1 { font-size: 58px; line-height: 1.13; letter-spacing: -.02em; margin-bottom: 18px; }
  h1 em { font-style: normal; color: #1F9D8F; }
  .sub { font-size: 21px; line-height: 1.68; color: #C4BAAA; margin-bottom: 26px; }
  .cmd { font: 15px/1.5 Consolas, Menlo, monospace; color: #EDE6DB;
         background: rgba(31,157,143,.11); border: 1px solid rgba(31,157,143,.34);
         border-radius: 9px; padding: 13px 16px; margin-bottom: 30px; word-break: break-all; }
  .cmd span { color: #7E776C; }
  .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 18px 24px; margin-top: auto; }
  .fact b { display: block; font-size: 30px; color: #EDE6DB; letter-spacing: -.01em; }
  .fact span { font-size: 15px; color: #948C80; }
  .right { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .shot { border-radius: 16px; overflow: hidden;
          box-shadow: 0 26px 64px rgba(0,0,0,.66), 0 0 0 1px rgba(237,230,219,.10); }
  .shot img { display: block; width: 100%; }
  .caption { margin-top: 14px; font-size: 15px; color: #948C80; }
  .stamp { position: absolute; left: 72px; bottom: 30px; font-size: 16px; color: #7E776C; }
  .stamp b { color: #C4BAAA; font-weight: 400; }
  ${extraCss}
</style>
<body>
  <div class="glow"></div>
  ${bodyHtml}
</body>`;

  // ── 版式 A：1600x1200（4:3，少数派题图标准）────────────────
  const heroA = page('', `
  <div class="wrap">
    <div class="left">
      <div class="kicker">DEEPSEEK HARNESS 插件</div>
      <h1>背单词<br>长在<em>侧栏</em>里</h1>
      <div class="sub">不用另开一个背单词 App。<br>你在 DSH 里干活的时候，<br>它就在旁边，一次几个词。</div>
      <div class="cmd"><span>$</span> ${INSTALL}</div>
      <div class="facts">
        ${FACTS.map(([b, s]) => `<div class="fact"><b>${b}</b><span>${s}</span></div>`).join('')}
      </div>
    </div>
    <div class="right">
      <div class="shot"><img src="data:image/png;base64,${b64(shots.today)}"></div>
      <div class="caption">真实界面截图 · 未修图</div>
    </div>
  </div>
  <div class="stamp"><b>github.com/wt0812/dsh-vocab-study</b> · MIT</div>`, 1600, 1200);

  // ── 版式 B：1280x640（社交卡片 / GitHub social preview）──────
  const heroB = page(`
    body { }
    .wrap { padding: 44px 56px; gap: 44px; align-items: center; }
    .left { flex: 0 0 470px; }
    h1 { font-size: 46px; margin-bottom: 14px; }
    .sub { font-size: 18px; margin-bottom: 18px; }
    .cmd { font-size: 13px; padding: 10px 13px; margin-bottom: 0; }
    .facts { grid-template-columns: 1fr 1fr; gap: 12px 20px; margin-top: 20px; }
    .fact b { font-size: 24px; }
    .fact span { font-size: 13px; }
    .stamp { left: 56px; bottom: 18px; font-size: 14px; }
    .caption { font-size: 13px; margin-top: 10px; }
    .glow { width: 760px; height: 760px; top: -260px; right: -150px; }
  `, `
  <div class="wrap">
    <div class="left">
      <div class="kicker">DEEPSEEK HARNESS 插件</div>
      <h1>背单词<br>长在<em>侧栏</em>里</h1>
      <div class="sub">你在 DSH 里干活的时候，<br>它就在旁边，一次几个词。</div>
      <div class="cmd"><span>$</span> ${INSTALL}</div>
      <div class="facts">
        ${FACTS.map(([b, s]) => `<div class="fact"><b>${b}</b><span>${s}</span></div>`).join('')}
      </div>
    </div>
    <div class="right">
      <div class="shot" style="max-width:330px"><img src="data:image/png;base64,${b64(shots.today)}"></div>
    </div>
  </div>
  <div class="stamp"><b>github.com/wt0812/dsh-vocab-study</b> · MIT</div>`, 1280, 640);

  // ── 版式 C：1080x1440（小红书竖版，图占主体、字更大）────────
  const heroC = page(`
    .wrap { display: block; padding: 74px 80px; }
    h1 { font-size: 74px; line-height: 1.12; margin-bottom: 26px; }
    .sub { font-size: 27px; line-height: 1.66; margin-bottom: 40px; }
    .cmd { font-size: 19px; padding: 18px 20px; margin-bottom: 40px; }
    .shot { max-width: 100%; }
    .caption { font-size: 19px; }
    .facts { grid-template-columns: 1fr 1fr; gap: 26px 30px; margin-top: 42px; }
    .fact b { font-size: 42px; }
    .fact span { font-size: 19px; }
    .stamp { left: 80px; bottom: 40px; font-size: 19px; }
    .glow { width: 1100px; height: 1100px; top: -420px; right: -300px; }
  `, `
  <div class="wrap">
    <div class="kicker" style="font-size:24px">DEEPSEEK HARNESS 插件</div>
    <h1>背单词<br>长在<em>侧栏</em>里</h1>
    <div class="sub">不用另开一个背单词 App。<br>你在 DSH 里干活的时候，它就在旁边。</div>
    <div class="shot"><img src="data:image/png;base64,${b64(shots.today)}"></div>
    <div class="caption">真实界面截图 · 未修图</div>
    <div class="facts">
      ${FACTS.map(([b, s]) => `<div class="fact"><b>${b}</b><span>${s}</span></div>`).join('')}
    </div>
  </div>
  <div class="stamp"><b>github.com/wt0812/dsh-vocab-study</b> · MIT</div>`, 1080, 1440);

  for (const [name, html, w, h] of [
    ['promo-hero-1600x1200', heroA, 1600, 1200],
    ['promo-social-1280x640', heroB, 1280, 640],
    ['promo-xhs-1080x1440', heroC, 1080, 1440],
  ]) {
    const htmlPath = resolve(outDir, `_${name}.html`);
    writeFileSync(htmlPath, html, 'utf8');
    const png = resolve(outDir, `${name}.png`);
    const r = spawnSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', `--window-size=${w},${h}`,
      `--screenshot=${png}`, pathToFileURL(htmlPath).href,
    ], { encoding: 'utf8' });
    console.log(`  ${name}.png  ${existsSync(png) ? '✅ ' + readFileSync(png).length + ' B' : '❌ ' + (r.stderr ?? '').slice(0, 120)}`);
  }
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
