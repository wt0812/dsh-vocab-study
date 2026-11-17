// tools/verify-appearance.mjs
//
// 在**真 Chrome**（headless + CDP）里把「外观」功能端到端验一遍：
// 打开 demo 页 → 点胶囊开面板 → 设置页拨字号 / 点背景色块 → 回今日页量真实计算值。
//
//   node tools/verify-appearance.mjs
//
// 为什么需要它：字号是靠 69 条 `calc(Npx * var(--vs-fs))` 撑起来的，纯单测只能证明
// 「算出 1.3」，证明不了「浏览器里真的变大了、而且没把 340px 的窄栏撑破」。
// 断言分三块：字号倍率、深浅反色（含 WCAG 对比度）、窄屏 380px 不横向溢出。
// 另外顺手截三张图到 _verify/（该目录不进仓库），人工复核排版用。
//
// 跑不起来的最常见原因：Chrome 不在默认路径，改下面的 CHROME 常量。
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';

const PORT = 18765;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('CDP 超时: ' + method));
        }
      }, 60000);
    });
  }
}

// 每次用干净的 profile：否则上一轮存的「特大 + 深夜」会被 localStorage 带进来，
// 第一次测量拿到的就不是默认态（实测被这个坑过一次，第一屏直接是 16.9px）。
const profileDir = resolve(os.tmpdir(), 'cdp-vs-appearance');
rmSync(profileDir, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--window-size=1400,900',
  'about:blank',
], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 80 && !version; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) version = await r.json();
  } catch {
    /* 还没起来 */
  }
  if (!version) await sleep(250);
}
if (!version) {
  chrome.kill();
  throw new Error('Chrome CDP 没起来');
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

const ev = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面抛错: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
};

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

mkdirSync('_verify', { recursive: true });
const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve('_verify', name), Buffer.from(r.data, 'base64'));
};

const url = pathToFileURL(resolve('demo/index.html')).href;
await cdp.send('Page.navigate', { url });
await sleep(3500);

// 每一步都在页面里做，返回一个可断言的快照
const result = await ev(`
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const tabOf = (name) => [...document.querySelectorAll('.vs-tabs button')].find((b) => b.textContent.includes(name));

  // 打开面板
  document.querySelector('.vs-capsule')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(400);
  const panel = document.querySelector('.vs-panel');
  if (!panel) return { fatal: '面板没打开' };

  const fs9 = (n) => (n ? getComputedStyle(n).fontSize : null);
  out.base = {
    // .vs-title 是顶栏标题（13px 基准，永远存在）；
    // .vs-word 用的是 clamp(..vh..) 随面板高度放大，本来就**不跟**字号倍率走，
    // 所以别拿它当判据 —— 这里只记一下数值，好让报告能自证。
    titleFont: fs9(panel.querySelector('.vs-title')),
    meaningFont: fs9(panel.querySelector('.vs-meaning')),
    wordFont: fs9(panel.querySelector('.vs-word')),
    paper: getComputedStyle(panel).getPropertyValue('--vs-paper').trim(),
    fsVar: getComputedStyle(panel).getPropertyValue('--vs-fs').trim(),
    width: panel.getBoundingClientRect().width,
  };

  // 设置页
  tabOf('设置')?.click();
  await wait(250);
  const sel = document.querySelector('#vs-font');
  out.ui = {
    hasFontSelect: !!sel,
    fontOptions: sel ? [...sel.options].map((o) => o.value + ':' + o.textContent) : [],
    swatches: [...document.querySelectorAll('.vs-swatch')].map((b) => b.getAttribute('aria-label')),
    hasColorPick: !!document.querySelector('.vs-colorpick'),
  };

  // 特大
  sel.value = 'xl';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(350);
  tabOf('今日')?.click();
  await wait(250);
  const p2 = document.querySelector('.vs-panel');
  out.xl = {
    titleFont: fs9(p2.querySelector('.vs-title')),
    meaningFont: fs9(p2.querySelector('.vs-meaning')),
    wordFont: fs9(p2.querySelector('.vs-word')),
    fsVar: getComputedStyle(p2).getPropertyValue('--vs-fs').trim(),
    width: p2.getBoundingClientRect().width,
    overflowX: p2.scrollWidth - p2.clientWidth,
  };

  // 深夜背景
  tabOf('设置')?.click();
  await wait(250);
  [...document.querySelectorAll('.vs-swatch')].find((b) => b.getAttribute('aria-label') === '深夜')?.click();
  await wait(350);
  const p3 = document.querySelector('.vs-panel');
  out.night = {
    paper: getComputedStyle(p3).getPropertyValue('--vs-paper').trim(),
    paper2: getComputedStyle(p3).getPropertyValue('--vs-paper-2').trim(),
    ink: getComputedStyle(p3).getPropertyValue('--vs-ink').trim(),
    scheme: getComputedStyle(p3).colorScheme,
  };

  // 米白背景（浅色，字必须变深）
  [...document.querySelectorAll('.vs-swatch')].find((b) => b.getAttribute('aria-label') === '米白')?.click();
  await wait(350);
  const p4 = document.querySelector('.vs-panel');
  out.paper = {
    paper: getComputedStyle(p4).getPropertyValue('--vs-paper').trim(),
    ink: getComputedStyle(p4).getPropertyValue('--vs-ink').trim(),
    scheme: getComputedStyle(p4).colorScheme,
  };

  // 回到跟随主题：自定义色必须被清掉，主题色要能回来
  [...document.querySelectorAll('.vs-swatch')].find((b) => b.getAttribute('aria-label') === '跟随主题')?.click();
  await wait(350);
  const p5 = document.querySelector('.vs-panel');
  out.auto = {
    paper: getComputedStyle(p5).getPropertyValue('--vs-paper').trim(),
    ink: getComputedStyle(p5).getPropertyValue('--vs-ink').trim(),
    fsVar: getComputedStyle(p5).getPropertyValue('--vs-fs').trim(),
  };

  // 设置有没有真的存住：回到设置页读控件状态（demo 用的是预览存储，
  // 写不进 localStorage，所以这里验 state 回读，不验盘上 key）
  tabOf('设置')?.click();
  await wait(300);
  const selBack = document.querySelector('#vs-font');
  out.saved = {
    fontSelect: selBack ? selBack.value : null,
    nightPressed: [...document.querySelectorAll('.vs-swatch')]
      .find((b) => b.getAttribute('aria-label') === '深夜')?.getAttribute('aria-pressed') ?? null,
    autoPressed: [...document.querySelectorAll('.vs-swatch')]
      .find((b) => b.getAttribute('aria-label') === '跟随主题')?.getAttribute('aria-pressed') ?? null,
  };
  // 顺带把上面那步「跟随主题」之后的状态也留在快照里
  out.autoNow = {
    paper: getComputedStyle(document.querySelector('.vs-panel')).getPropertyValue('--vs-paper').trim(),
  };
  return out;
})()
`);

await shot('appearance-xl-night.png');

// 再截一张：换成特大 + 深夜，看排版有没有溢出
await ev(`
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabOf = (name) => [...document.querySelectorAll('.vs-tabs button')].find((b) => b.textContent.includes(name));
  tabOf('设置')?.click();
  await wait(250);
  [...document.querySelectorAll('.vs-swatch')].find((b) => b.getAttribute('aria-label') === '深夜')?.click();
  await wait(300);
  tabOf('今日')?.click();
  await wait(300);
  return true;
})()
`);
await shot('appearance-xl-night-today.png');
const overflow = await ev(`
(() => {
  const p = document.querySelector('.vs-panel');
  return { width: p.getBoundingClientRect().width, scrollWidth: p.scrollWidth, clientWidth: p.clientWidth,
           bodyOverflow: document.querySelector('.vs-body').scrollWidth - document.querySelector('.vs-body').clientWidth };
})()
`);

// 窄屏复验：真宿主里面板只有 340–415px 宽，这才是「特大字号会不会撑爆」的现场
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 800, deviceScaleFactor: 2, mobile: false });
await cdp.send('Page.navigate', { url });
await sleep(3500);
const narrow = await ev(`
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabOf = (name) => [...document.querySelectorAll('.vs-tabs button')].find((b) => b.textContent.includes(name));
  document.querySelector('.vs-capsule')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(400);
  tabOf('设置')?.click();
  await wait(250);
  const sel = document.querySelector('#vs-font');
  sel.value = 'xl';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(300);
  [...document.querySelectorAll('.vs-swatch')].find((b) => b.getAttribute('aria-label') === '深夜')?.click();
  await wait(300);
  tabOf('今日')?.click();
  await wait(300);
  const p = document.querySelector('.vs-panel');
  const body = document.querySelector('.vs-body');
  return {
    panelWidth: Math.round(p.getBoundingClientRect().width),
    panelOverflow: p.scrollWidth - p.clientWidth,
    bodyOverflow: body ? body.scrollWidth - body.clientWidth : null,
    fsVar: getComputedStyle(p).getPropertyValue('--vs-fs').trim(),
    titleFont: getComputedStyle(p.querySelector('.vs-title')).fontSize,
  };
})()
`);
await shot('appearance-narrow-380.png');

// ── 真宿主模拟：DSH 的主题到底写在哪 ────────────────────────────────
// 后台实情（读 app.asar 里的 theme-runtime 得到）：DSH **不写** data-theme，
// 它写 documentElement.style.colorScheme + body[data-ds-dark-theme] + --dsw-* token。
// 上一版「跟随主题」读的是 data-theme，永远 undefined → 面板永远深色。
// 以下三块分别回归：浅色宿主、主题插件换底色、运行中切主题。
const openAndRead = `
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabOf = (n) => [...document.querySelectorAll('.vs-tabs button')].find((b) => b.textContent.includes(n));
  document.querySelector('.vs-capsule')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(500);
  // 前面的用例把外观改成了「深夜」，浏览器 profile 会记住 —— 先复位成跟随主题，
  // 否则量到的是用户自定义色，跟「跟随主题」这条逻辑没关系（假绿/假红都出现过）。
  tabOf('设置')?.click();
  await wait(300);
  [...document.querySelectorAll('.vs-swatch')].find((b) => b.getAttribute('aria-label') === '跟随主题')?.click();
  await wait(300);
  tabOf('今日')?.click();
  await wait(300);
  const p = document.querySelector('.vs-panel');
  if (!p) return { fatal: '面板没打开' };
  const cs = getComputedStyle(p);
  return {
    themeAttr: p.dataset.theme,
    paper: cs.getPropertyValue('--vs-paper').trim(),
    ink: cs.getPropertyValue('--vs-ink').trim(),
    scheme: cs.colorScheme,
    hostBg: getComputedStyle(document.body).backgroundColor,
    htmlColorScheme: document.documentElement.style.colorScheme,
  };
})()
`;

// ① 浅色宿主（用户在 DSH 设置里切「浅色」）
await cdp.send('Page.navigate', { url: `${url}?theme=light` });
await sleep(3500);
const hostLight = await ev(openAndRead);
await shot('appearance-follow-light.png');

// ② 主题插件把画布换成蓝黑（深浅仍是深色，但色相不是默认那套）
await cdp.send('Page.navigate', { url: `${url}?theme=dark&bg=1B2430` });
await sleep(3500);
const hostPlugin = await ev(openAndRead);
await shot('appearance-follow-plugin.png');

// ③ 运行中切主题：面板要自己跟上，不能等重开
await cdp.send('Page.navigate', { url });
await sleep(3500);
const liveSwitch = await ev(`
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabOf = (n) => [...document.querySelectorAll('.vs-tabs button')].find((b) => b.textContent.includes(n));
  document.querySelector('.vs-capsule')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(500);
  // 同样先复位成「跟随主题」，否则量的是上一轮存下的自定义色
  tabOf('设置')?.click();
  await wait(300);
  [...document.querySelectorAll('.vs-swatch')].find((b) => b.getAttribute('aria-label') === '跟随主题')?.click();
  await wait(300);
  tabOf('今日')?.click();
  await wait(300);
  const read = () => {
    const p = document.querySelector('.vs-panel');
    const cs = getComputedStyle(p);
    return { themeAttr: p.dataset.theme, paper: cs.getPropertyValue('--vs-paper').trim(), ink: cs.getPropertyValue('--vs-ink').trim() };
  };
  const before = read();
  // 模拟宿主切成浅色主题（theme-runtime 干的那三件事）
  document.body.removeAttribute('data-ds-dark-theme');
  document.documentElement.style.colorScheme = 'light';
  document.body.style.background = '#F7F4EE';
  await wait(600);
  const afterLight = read();
  // 再切回深色
  document.body.setAttribute('data-ds-dark-theme', '');
  document.documentElement.style.colorScheme = 'dark';
  document.body.style.background = '#211E1B';
  await wait(600);
  const backDark = read();
  return { before, afterLight, backDark };
})()
`);

cdp.ws.close();
chrome.kill();

const lum = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const checks = [];
const ck = (name, ok, detail = '') => checks.push([name, ok, detail]);
// 纸色是「宿主画布色提亮 5%」算出来的，不是写死的 #211E1B —— 比较时分通道容差
const near = (a, b, tol = 6) => {
  const pa = /^#?([0-9a-f]{6})$/i.exec((a || '').trim());
  const pb = /^#?([0-9a-f]{6})$/i.exec((b || '').trim());
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const va = parseInt(pa[1].slice(i * 2, i * 2 + 2), 16);
    const vb = parseInt(pb[1].slice(i * 2, i * 2 + 2), 16);
    if (Math.abs(va - vb) > tol) return false;
  }
  return true;
};

ck('默认字号：顶栏标题 13px（改动前的老样子）', result.base?.titleFont === '13px', result.base?.titleFont);
ck('跟随主题：深色宿主下面板纸色 ≈ 设计值 #211E1B', near(result.base?.paper, '#211E1B'), result.base?.paper);
ck('设置页有字号下拉、6 个背景色块、一个取色器', result.ui?.hasFontSelect && result.ui?.swatches?.length === 6 && result.ui?.hasColorPick, JSON.stringify(result.ui));
ck('字号四档齐全', JSON.stringify(result.ui?.fontOptions) === JSON.stringify(['sm:小', 'md:标准', 'lg:大', 'xl:特大']), JSON.stringify(result.ui?.fontOptions));
ck('选「特大」后标题 13px → 16.9px（13×1.3）', result.xl?.titleFont === '16.9px', `${result.base?.titleFont} → ${result.xl?.titleFont}`);
ck('字号倍率真的写进面板（--vs-fs = 1.3）', result.xl?.fsVar === '1.3', result.xl?.fsVar);
ck('放大只动字号、不动版面宽度', Math.abs((result.xl?.width ?? 0) - (result.base?.width ?? 0)) < 1.5, `${result.base?.width} → ${result.xl?.width}`);
ck('面板没有横向溢出', (result.xl?.overflowX ?? 1) <= 0, `overflowX=${result.xl?.overflowX}`);
ck('选「深夜」后纸色真的变了', result.night?.paper === '#1C1A18', result.night?.paper);
ck('深色底 → 字自动变浅', (lum(result.night?.ink) ?? 0) > 0.55, result.night?.ink);
ck('深夜底的字色对比度 ≥ 4.5:1', (ratio(result.night?.paper, result.night?.ink) ?? 0) >= 4.5, (ratio(result.night?.paper, result.night?.ink) ?? 0).toFixed(2));
ck('深色底 color-scheme=dark（滚动条/输入框跟着变）', result.night?.scheme === 'dark', result.night?.scheme);
ck('选「米白」后纸色变浅', result.paper?.paper === '#FBF7F0', result.paper?.paper);
ck('浅色底 → 字自动变深', (lum(result.paper?.ink) ?? 1) < 0.2, result.paper?.ink);
ck('米白底的字色对比度 ≥ 4.5:1', (ratio(result.paper?.paper, result.paper?.ink) ?? 0) >= 4.5, (ratio(result.paper?.paper, result.paper?.ink) ?? 0).toFixed(2));
ck('切回「跟随主题」后主题纸色回来了（内联色已清）', near(result.auto?.paper, '#211E1B'), result.auto?.paper);
ck('字号选择被记进设置（回设置页仍是「特大」）', result.saved?.fontSelect === 'xl', result.saved?.fontSelect);
ck('背景色选择被记进设置（回设置页「跟随主题」是选中态）', result.saved?.autoPressed === 'true', JSON.stringify(result.saved));
ck('截完第二张图时版面仍不横向溢出', (overflow?.bodyOverflow ?? 1) <= 0, JSON.stringify(overflow));
ck('窄屏 380px + 特大 + 深夜：面板不横向溢出', (narrow?.panelOverflow ?? 1) <= 0, JSON.stringify(narrow));
ck('窄屏下正文字区不横向溢出（文字是换行不是被切）', (narrow?.bodyOverflow ?? 1) <= 0, `bodyOverflow=${narrow?.bodyOverflow}`);
ck('窄屏下字号倍率同样生效', narrow?.fsVar === '1.3', `${narrow?.fsVar} / 标题 ${narrow?.titleFont}`);

// ── 跟随主题（用户实测报的那个 bug 的回归）──────────────────────────
ck('浅色宿主：面板认得出是浅色（data-theme=light）', hostLight?.themeAttr === 'light', hostLight?.themeAttr);
ck('浅色宿主：纸色是浅的（不再永远黑）', (lum(hostLight?.paper) ?? 0) > 0.6, hostLight?.paper);
ck('浅色宿主：字自动变深', (lum(hostLight?.ink) ?? 1) < 0.2, hostLight?.ink);
ck('浅色宿主：对比度 ≥ 4.5:1', (ratio(hostLight?.paper, hostLight?.ink) ?? 0) >= 4.5, (ratio(hostLight?.paper, hostLight?.ink) ?? 0).toFixed(2));
ck('浅色宿主：color-scheme=light', hostLight?.scheme === 'light', hostLight?.scheme);
ck('主题插件换蓝黑画布：面板跟着变色（不是默认那套）', !!hostPlugin?.paper && !near(hostPlugin.paper, '#211E1B', 4), `${hostPlugin?.hostBg} → ${hostPlugin?.paper}`);
ck('主题插件换蓝黑画布：字仍看得清（≥ 4.5:1）', (ratio(hostPlugin?.paper, hostPlugin?.ink) ?? 0) >= 4.5, (ratio(hostPlugin?.paper, hostPlugin?.ink) ?? 0).toFixed(2));
ck('运行中切浅色：面板自己跟上（不用重开）', liveSwitch?.afterLight?.themeAttr === 'light' && (lum(liveSwitch?.afterLight?.paper) ?? 0) > 0.6, `${liveSwitch?.before?.paper} → ${liveSwitch?.afterLight?.paper}`);
ck('运行中切浅色：字也跟着反成深色', (lum(liveSwitch?.afterLight?.ink) ?? 1) < 0.2, liveSwitch?.afterLight?.ink);
ck('运行中切回深色：也跟得上', liveSwitch?.backDark?.themeAttr === 'dark' && (lum(liveSwitch?.backDark?.paper) ?? 1) < 0.35, `${liveSwitch?.afterLight?.paper} → ${liveSwitch?.backDark?.paper}`);

let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  [${detail}]` : ''}`);
}
console.log('');
console.log(`原始快照: ${JSON.stringify(result, null, 2)}`);
console.log(`截图: _verify/appearance-xl-night.png, _verify/appearance-xl-night-today.png`);
console.log(bad ? `\n✗ ${bad} 条不通过` : '\n✓ 外观功能在真浏览器里全部通过');
process.exit(bad ? 1 : 0);
