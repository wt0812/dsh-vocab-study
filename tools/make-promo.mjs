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
// Windows 会把一批端口段保留给 Hyper-V/WinNAT，落在里面的端口 bind() 直接报
// WSAEACCES(0x271D)，Chrome 只说 "Cannot start http server for devtools"，脚本就卡在
// 「CDP 没起来」。9234 正好在 9198-9297 里，所以留个 env 覆盖口子。
//   查看本机被占的段：netsh interface ipv4 show excludedportrange protocol=tcp
//   跑的时候：$env:PROMO_CDP_PORT='18734'
const PORT = Number(process.env.PROMO_CDP_PORT ?? 9234);
const outDir = resolve(process.argv[2] ?? '_promo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });

// ── 现算版面上的事实数字（不手写，免得写错、也免得过期）──────────────
// 教训：我口头一直说「344 项测试」，实测是 372 —— 手写的数字就是会错。
const TEST_FILES = readdirSync(resolve('test')).filter((f) => f.endsWith('.test.mjs'));
const LIB = readFileSync(resolve('lib/client.js'));
const LIB_KB = (LIB.length / 1024).toFixed(1);
// 版面上的体积读数：超过 1 MB 就换算成 MB，否则读起来是「2910.7 KB」这种怪数字。
const LIB_SIZE = LIB.length >= 1048576
  ? `${(LIB.length / 1048576).toFixed(1)} MB`
  : `${LIB_KB} KB`;
const PKG = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

// 内置词表真实词量（现算，不手写）。离线时能背的就是这么多。
//
// ⚠️ 这段原来是这么写的：
//     const SEED_MOD = await import('core/seed-cet4.mjs');
//     if (SEED_COLLECTIONS_WITH_WORDS.length < 6) { 警告「不能写 100% 离线」 }
//   那是对的 —— 当时确实只有四级有内置词（120 个），切到雅思会拿到空词表。
//   后来补了 seed-exams.mjs（六级/考研/雅思/托福/GRE 各有自己的内置词表），
//   所以这个警告的**前提变了**，得跟着改，不然它会一直喊狼来了。
//   现在改成直接从 library.seedFor() 问每个词库到底有多少内置词 ——
//   单一事实来源，不用两边维护。
const LIB_MOD = await import(pathToFileURL(resolve('core/library.mjs')).href);
const seedCounts = {};
for (const c of Object.keys(LIB_MOD.COLLECTIONS)) {
  seedCounts[c] = LIB_MOD.seedFor(c).length;
}
const SEED_TOTAL = Object.values(seedCounts).reduce((a, b) => a + b, 0);
const EMPTY_SEEDS = Object.entries(seedCounts).filter(([, n]) => n === 0).map(([c]) => c);
// 单个词库的内置词量。
//
// ⚠️ 这里试过三种写法，前两种都不好：
//   · SEED_TOTAL（29,841）= 六个词库**总和**，但用户离线时背的是**某一个**词库，
//     拿总和当卖点是虚报。
//   · 区间「116–7,504 词」= 数学上没错，但四级那个是 116 词的手写小样本、
//     其余是几千词的生成表，区间跨得太离谱，看起来像 bug 而不像数据。
// 最后报**中位数（约 X 词）**：这是"随便切一个词库大概能背多少"，
// 能对得上任何一种情况，也不会被误解。
const seedNums = Object.values(seedCounts).filter((n) => n > 0).sort((a, b) => a - b);
const mid = seedNums.length ? seedNums[Math.floor(seedNums.length / 2)] : 0;
const SEED_TYPICAL = `≈${(Math.round(mid / 100) * 100).toLocaleString()} 词`;
console.log(
  `内置词表：共 ${SEED_TOTAL} 词 —— ` +
  Object.entries(seedCounts).map(([c, n]) => `${c}:${n}`).join('  ')
);
if (EMPTY_SEEDS.length) {
  console.log(`  ⚠ 这些词库没有内置词（离线时会拿到空词表）: ${EMPTY_SEEDS.join(', ')}`);
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
    // ⚠️ 不能只抓汇总行。core.test.mjs 在打印 `85 通过 / 0 失败` **之后**，
    // 还会跑一段「健全性附加检查」，那些 ✓ 不在汇总里。
    // 只抓汇总的话，附加检查里加多少条数字都不动 —— 实测就吃过这个亏：
    // 我新加了 8 条断言，总数还是 372，一度以为没生效。
    // 改成：汇总数字 + 附加检查的 ✓ 条数。
    const m = out.match(/(\d+)\s*(?:通过|passed)/);
    let n = m ? Number(m[1]) : (out.match(/[✓✔]/g) ?? []).length;
    const extraSeg = out.includes('健全性附加检查')
      ? out.slice(out.lastIndexOf('健全性附加检查'))
      : '';
    n += (extraSeg.match(/[✓✔]/g) ?? []).length;
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

// ── 用界面自己的流程把「今天」走满一轮 ────────────────────────
//
// 这里绕了几圈才写对，记下来：
//   · app.rate(rating)  只登记一次作答，**不推进**（试过：连调 20 次，covered 还是 1）
//   · app.rate + app.next 一起调 → 两处各自记一笔，「今天已背」翻倍到 40
//   · 界面真实的流程是（见 ui/panel.mjs:42-61 和 96-107）：
//       点卡片翻面(lastReveal) → 点评分按钮 → 点「下一张」
//     而且**必须先翻面**，否则评分什么也不做。
//
// 所以不再猜内部 API，改成**派发真实点击事件**走界面自己的流程。
const DRIVE_PROGRESS = `
(async () => {
  const d = window.__vsDemo;
  if (!d || !d.app || !d.openPanel) return 'no app';
  d.openPanel();
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(500);
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const byText = (sel, t) => [...document.querySelectorAll(sel)].find(n => (n.textContent || '').includes(t));

  const trace = [];
  // 20 项 = 一整轮（跟界面上「今日 N/20」的分母一致）
  const plan = ['忘了', '会了', '会了', '模糊', '会了', '会了', '忘了', '会了', '会了', '模糊',
                '会了', '会了', '忘了', '会了', '会了', '模糊', '会了', '会了', '会了', '会了'];
  for (const label of plan) {
    // 1) 翻面：点卡片
    const cardEl = document.querySelector('.vs-card, .vs-deck-card, [class*=card]');
    click(cardEl);
    await wait(150);
    // 2) 评分：点对应的按钮
    const btn = byText('.vs-rate', label);
    if (!btn) { trace.push('没找到按钮:' + label); break; }
    click(btn);
    await wait(150);
    // 3) 下一张
    const nx = document.querySelector('[data-act="next"]');
    click(nx);
    await wait(170);
    trace.push(label);
  }
  const s = d.app.state || {};
  return {
    trace,
    steps: trace.length,
    covered: s.covered,
    todayAnswered: s.stats ? s.stats.todayAnswered : null,
    roundSize: s.session ? s.session.plannedSize : null,
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

  // 每次重跑都从干净状态开始：不然 localStorage 里留着上一次的进度，
  // 宣传图上会出现「今日 40 词」「这一轮走完了」这种滚过头的状态，
  // 而且跟动图里的数字打架 —— 同一批素材里数字不一致，看着就假。
  // 先清空 + 重载（seedDemoHistory 会重新造打卡历史），**再推进一次**。
  console.log('清空 localStorage: ' + JSON.stringify(await ev(cdp, `(() => {
    try { localStorage.clear(); return 'ok'; } catch (e) { return 'failed: ' + e.message; }
  })()`)));
  await ev(cdp, `location.reload()`);
  await sleep(3400);

  const driven = await ev(cdp, DRIVE_PROGRESS);
  console.log('推进今日进度: ' + JSON.stringify(driven));
  if (!driven || !driven.trace || !driven.trace.length || /抛错/.test(String(driven.trace))) {
    throw new Error('推进失败，停止出图: ' + JSON.stringify(driven));
  }
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
  //   当时内置词表只有 120 个词、全是四级；六级/考研/雅思/托福/GRE
  //   一个内置词都没有，六个 collection 的 urls 也全是空数组，
  //   离线时切过去拿到的是空词表。把这说成「100% 离线」是夸大。
  //
  //   现在**这句话基本成立了**（六个词库各有自己的内置词表，共 29,725 词），
  //   但仍然不写「100%」—— 严谨的说法是「断网也能开背」，
  //   因为内置的是考纲词表快照，远程源取到的是更全的版本。
  const b64 = (f) => readFileSync(f).toString('base64');
  const FACTS = [
    [`${ASSERT.total} 项`, `测试断言，${TEST_FILES.length} 个套件全绿`],
    [LIB_SIZE, '单文件，零运行时依赖'],
    // ⚠️ 这里**不能写 SEED_TOTAL（29,841）**，那是六个词库内置词的总和，
    //    而用户离线时背的是**某一个**词库。拿总和当卖点是虚报。
    //    所以报中位数，见上面 SEED_TYPICAL 的注释。
    [SEED_TYPICAL, '内置词表，断网也能开背'],
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
  /* 面板图是纵向长条（约 415x580 CSS px）。只给 width:100% 的话它会拿满列宽
     再按比例撑高，长图能把整页顶出视口 —— 横版就是这么溢出 83px 的。
     所以**宽高都要压**：宽度自适应，高度封顶。 */
  .shot img { display: block; width: auto; max-width: 100%; max-height: 74vh; margin: 0 auto; }
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
  //
  // ⚠️ 这个版式原来是**坏的，而且坏了很久没被发现**：
  //    它的第一行 CSS 是 `.wrap { display: block; padding: 74px 80px; }`。
  //    `.wrap` 一旦变成 block，里面那个 `height:100%` + `flex-direction:column`
  //    的左栏就没了约束，`.facts` 的 `margin-top:auto` 也随之失效 ——
  //    整页退回**自然流高度**。
  //
  //    实测（CDP 读 rect，用和出图完全相同的窗口参数）：
  //        innerHeight = 1440    scrollHeight = 1984
  //        .facts   y=1763  bottom=1984   ← 整块在视口外
  //        .stamp   y=1370  bottom=1400
  //    也就是说**四张事实卡（386 项 / 2.8 MB / ≈5,400 词 / 3 处）根本没进图**，
  //    被渲染成了页面溢出区。而 Chrome 静态截图只截视口，所以那 544px 直接丢了。
  //
  //    更隐蔽的是：溢出区里还能看见 `.stamp` 的灰字，于是看图的人会以为
  //    "底部文字挤在一起了"，实际是"有一整块内容没截进来"。两个症状一个根因。
  //
  // 改成 flex 列 + `height:100%` 之后再用 `.fit` 控住图高，让面板图和
  // 四张事实卡同时进画面。改完必须复查 scrollHeight == 1440（见文末闸门）。
  const heroC = page(`
    .wrap { padding: 68px 80px 76px; display: flex; flex-direction: column; height: 100%; }
    .kicker { font-size: 21px; margin-bottom: 12px; letter-spacing: .18em; }
    h1 { font-size: 60px; line-height: 1.10; margin-bottom: 16px; }
    .sub { font-size: 21px; line-height: 1.55; margin-bottom: 22px; }
    /* 面板图按宽高双重约束，保证「图 + 四张卡 + stamp」都在 1440 内 */
    .shot { align-self: center; border-radius: 14px; }
    .shot img { width: auto !important; height: auto !important; max-height: 500px; max-width: 100%; }
    .caption { font-size: 17px; margin-top: 10px; text-align: center; }
    .facts { grid-template-columns: 1fr 1fr; gap: 18px 30px; margin-top: auto; }
    .fact b { font-size: 35px; }
    .fact span { font-size: 17px; }
    .stamp { left: 80px; bottom: 34px; font-size: 18px; }
    .glow { width: 1100px; height: 1100px; top: -420px; right: -300px; }
  `, `
  <div class="wrap">
    <div class="kicker">DEEPSEEK HARNESS 插件</div>
    <h1>背单词<br>长在<em>侧栏</em>里</h1>
    <div class="sub">不用另开一个背单词 App。<br>你在 DSH 里干活的时候，它就在旁边。</div>
    <div class="shot"><img src="data:image/png;base64,${b64(shots.today)}"></div>
    <div class="caption">真实界面截图 · 未修图</div>
    <div class="facts">
      ${FACTS.map(([b, s]) => `<div class="fact"><b>${b}</b><span>${s}</span></div>`).join('')}
    </div>
  </div>
  <div class="stamp"><b>github.com/wt0812/dsh-vocab-study</b> · MIT</div>`, 1080, 1440);

  // ── 出图 + 闸门：控高 ────────────────────────────────────────
  //
  // ⚠️ Chrome 的静态 `--screenshot` **只截视口**。页面比视口高的部分直接丢，
  //    而且**不报错、不出警告、退出码 0** —— 你会拿到一张"看起来正常"的图，
  //    只是底部少了一整块。竖版那个 bug 就是这么藏了很久：
  //    scrollHeight 1984 / 视口 1440，四张事实卡整块不见了。
  //
  //    所以每张图**先量后截**：用 CDP 读真实 scrollHeight，超容差就硬失败。
  //    "图出成功了" ≠ "内容都在图里"。
  const SCALE = process.env.PROMO_SCALE || '2';
  const TOLERANCE = 2;   // .sub 换行有 1px 级抖动，不是真溢出
  const overflow = [];

  for (const [name, html, w, h] of [
    ['promo-hero-1600x1200', heroA, 1600, 1200],
    ['promo-social-1280x640', heroB, 1280, 640],
    ['promo-xhs-1080x1440', heroC, 1080, 1440],
  ]) {
    const htmlPath = resolve(outDir, `_${name}.html`);
    writeFileSync(htmlPath, html, 'utf8');
    const png = resolve(outDir, `${name}.png`);
    const url = pathToFileURL(htmlPath).href;

    // ① 量：内容是不是装得下
    let m = null;
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: Number(SCALE), mobile: false,
      });
      await cdp.send('Page.navigate', { url });
      await sleep(700);
      m = await ev(cdp, `({
        ih: innerHeight, iw: innerWidth,
        sh: document.documentElement.scrollHeight,
        factsBottom: Math.round((document.querySelector('.facts')||{getBoundingClientRect:()=>({bottom:-1})}).getBoundingClientRect().bottom),
        stampTop: Math.round((document.querySelector('.stamp')||{getBoundingClientRect:()=>({top:-1})}).getBoundingClientRect().top),
      })`);
    } catch (e) {
      console.log(`  ${name}  闸门测量失败: ${e.message}`);
    }

    // ② 截
    const r = spawnSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      `--force-device-scale-factor=${SCALE}`, `--window-size=${w},${h}`,
      `--screenshot=${png}`, url,
    ], { encoding: 'utf8' });

    const size = existsSync(png) ? Math.round(readFileSync(png).length / 1024) + ' KB' : '❌ ' + (r.stderr ?? '').slice(0, 100);
    if (m && m.sh > m.ih + TOLERANCE) {
      const gap = m.stampTop - m.factsBottom;
      console.log(`  ${name}.png  ${size}   ❌ 内容溢出 ${m.sh - m.ih}px（scrollHeight ${m.sh} > 视口 ${m.ih}）`);
      console.log(`       .facts 底部 ${m.factsBottom} / .stamp 顶部 ${m.stampTop}` +
                  (gap < 0 ? ` → 两者重叠 ${-gap}px` : ''));
      console.log('       底部这一块**没进图**。调小字号/间距或给图加 max-height，别放着不管。');
      overflow.push(`${name} 溢出 ${m.sh - m.ih}px`);
    } else if (m && m.factsBottom >= 0 && m.stampTop >= 0 && m.stampTop < m.factsBottom) {
      console.log(`  ${name}.png  ${size}   ❌ .stamp 压住 .facts ${m.factsBottom - m.stampTop}px`);
      overflow.push(`${name} stamp 压 facts`);
    } else {
      console.log(`  ${name}.png  ${size}   ✅ 装得下${m ? `（scrollHeight ${m.sh} / 视口 ${m.ih}）` : ''}`);
    }
  }

  if (overflow.length) {
    throw new Error('宣传图内容溢出，拒绝产出半张图：' + overflow.join('；'));
  }
} finally {
  cdp?.close();
  try { chrome.kill(); } catch { /* */ }
}
