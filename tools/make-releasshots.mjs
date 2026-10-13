/** 出「发布素材\01-效果截图」那 4 张图（真 Chrome 渲染，未修图）。
 *
 *  用法: node tools/make-releasshots.mjs [outDir]
 *
 *  为什么单独写一个、不动 make-screenshots.mjs：
 *  那个出的是 README 用的两张（整屏胶囊 + 面板），尺寸和参考素材夹里的 4 张
 *  本来就不是一套。这个脚本专门出那 4 张统一规格的。
 *
 *  关键点（都是实测出来的，不是猜的）：
 *  · 面板 max-height 是 min(72vh, 680px)，**视口调多高都突破不了 680**。
 *    而「进度」页内容 716px、「设置」页 902px —— 一屏固定拍不完，
 *    硬拍就是"设置只到一半"那种图（素材夹里那张 3198x1168 就是这么来的）。
 *  · 所以出图时**临时把面板的高度上限解除**，让它按内容自然展开。
 *    面板在真实产品里是 680 封顶 + 内部滚动，所以这一步只影响截图高度，
 *    页面上任何一个字都没变（脚本会读回面板高度和内容高度做闸门校验）。
 *  · 2x 渲染（和素材夹里那 4 张同倍率），左右留 10px 边、上下留 16px 边。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire('C:/Users/21653/.dsh/profiles/desktop/');
const sharp = req('sharp');

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9371;
const SCALE = 2;

// 出图视口：面板实测 487 宽，左右各留 10
const VIEW_W = 508;
// 面板内容高 / 视口高
const PAD_X = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 10;

const outDir = resolve(process.argv[2] ?? resolve(ROOT, '_shots'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 演示数据：半个月的使用密度（和 make-screenshots.mjs 同口径）── */
const DAY_COUNTS = [11, 17, 0, 21, 14, 19, 23, 12, 25, 16, 13, 20, 15, 22, 18];
const STREAK_DAYS = 7;

const seedScript = `
(function () {
  var KEY = 'vocab-study-demo';
  var COUNT = ${JSON.stringify(DAY_COUNTS)};
  var DAY = 86400000;
  var words = ['cet4:abandon','cet4:adapt','cet4:affect','cet4:adopt','cet4:effect'];
  function dk(ts) {
    var d = new Date(ts - 4 * 3600000);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  var now = Date.now();
  var records = [];
  var days = [];
  for (var i = 0; i < COUNT.length; i++) {
    var back = COUNT.length - i;
    var n = COUNT[i];
    var base = now - back * DAY;
    var key = dk(base);
    if (n > 0) days.push({ key: key, done: true });
    for (var k = 0; k < n; k++) {
      var wrong = k % 4 === 0;
      records.push({
        ts: base - k * 60000, dayKey: key, wordId: words[k % words.length],
        mode: k % 5 === 0 ? 'quiz' : 'recognize',
        selfRating: wrong ? 'forgot' : (k % 7 === 0 ? 'fuzzy' : 'known'),
        correct: !wrong, incorrect: wrong, fakeMastery: k % 9 === 0,
        reactionMs: 1800 + k * 70, hintUsed: false,
        confusedWith: wrong ? 'cet4:abundant' : null,
        cardId: 'shot' + back + '-' + k, sessionId: 'shots' + back,
        queueSnapshotId: 'shot', tier: k % 3 === 0 ? 3 : 1, schemaVersion: 1,
      });
    }
  }
  var doneKeys = days.map(function (d) { return d.key; });
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
  window.__SEED_INFO = 'seeded ' + records.length + ' records / ' + doneKeys.length + ' days';
  document.title = 'SEEDED|' + records.length + '|' + doneKeys.length;
})();
`;

/* ── 生词本页面要有真实内容（这轮刚修好的能力，图里必须看得见）──
 * 存进 localStorage 的 personal 字段：词对象 + 自动查到的释义。
 * 三个词覆盖三种情况：词库查得到 / 查得到且有词性 / 手填的。
 */
const PERSONAL = [
  { id: 'gre:sentinel', word: 'sentinel', ipa: "'sentinl", pos: 'n.',
    meaning: '哨兵, 标记；vt. 警戒, 守卫；[计] 标记', collection: 'gre',
    meaningSource: 'lookup', addedTs: 0, source: '对话里收藏', context: null, state: 'new' },
  { id: 'cet6:exhibit', word: 'exhibit', ipa: "ig'zibit", pos: 'vt.',
    meaning: '展出, 陈列；n. 展览品', collection: 'cet6',
    meaningSource: 'lookup', addedTs: 0, source: '对话里收藏', context: null, state: 'new' },
  { id: 'custom:deadpan', word: 'deadpan', ipa: '', pos: '',
    meaning: '面无表情的（我自己填的）', collection: null,
    meaningSource: 'manual', addedTs: 0, source: '批量导入', context: null, state: 'new' },
];

// 把生词本内容也种进去：在 seedScript 之后执行，避免和它抢同一个 key
const personalScript = `
(function () {
  var KEY = 'vocab-study-demo';
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var now = Date.now();
  var list = ${JSON.stringify(PERSONAL)}.map(function (p, i) {
    return Object.assign({}, p, { addedTs: now - (10 - i) * 3600000 });
  });
  // 保留已有的 state / records，只加生词本
  var s = saved.state || {};
  s.personal = list;
  saved.state = s;
  localStorage.setItem(KEY, JSON.stringify(saved));
  window.__PERSONAL_INFO = 'personal ' + list.length + ' 词';
})();
`;

/* ── CDP ─────────────────────────────────────────────────── */
async function newTab() {
  const profile = resolve(process.env.TEMP ?? '.', 'vs-rel-' + Math.random().toString(36).slice(2, 8));
  if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    '--allow-file-access-from-files', 'about:blank',
  ], { stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { ok = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!ok) throw new Error('CDP 没起来');
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
  return { send, ev, close: () => { try { ws.close(); } catch { /* */ } try { chrome.kill(); } catch { /* */ } } };
}

/* 注入顺序：种子 → 生词本 → 页面脚本（都在任何页面脚本之前跑） */
async function installSeeds(t) {
  await t.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScript });
  await t.send('Page.addScriptToEvaluateOnNewDocument', { source: personalScript });
}

/* 解除面板高度上限：直接改样式表里的那条规则。
 * 为什么不用内联 style：内联要重设 height/boxSizing/maxHeight 等等，
 * 面板还有 floating 定位和别的规则，重设容易漏；改规则只动高度上限一处。 */
const UNCAP = `(() => {
  let hit = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    if (!rules) continue;
    for (const r of Array.from(rules)) {
      if (r.selectorText && r.selectorText.indexOf('.vs-panel.floating') >= 0 && r.style.maxHeight) {
        r.style.maxHeight = 'none';
        r.style.height = 'auto';
        hit++;
      }
    }
  }
  return hit;
})()`;

/* 把外壳的 UI 藏起来，只留页面底色。
 *
 * 为什么不用"铺一层遮罩去盖"：试过两版都会被外壳的层盖住 ——
 * 巨大 border 当洞的版本 `elementFromPoint` 命中的仍是外壳元素，
 * 四块矩形 + z-index:39 也一样。与其继续和层叠顺序缠斗，
 * 不如把那些元素直接 `visibility: hidden`（保留布局，不渲染），
 * 底色由 body/html 自己给。结果确定，不依赖 z-index。
 *
 * 只藏 demo 外壳自己的节点（.dsh-*），插件那棵子树（.vs-*）一个不碰。 */
const HIDE_SHELL = `(() => {
  document.documentElement.style.background = '#14120F';
  document.body.style.background = '#14120F';
  const hidden = [];
  for (const n of document.querySelectorAll('.dsh-demo, .dsh-top, .dsh-msgs, .dsh-msg, .dsh-composer, .dsh-input, .dsh-bottom, .dsh-side, textarea')) {
    n.style.visibility = 'hidden';
    hidden.push(n.tagName + '.' + String(n.className).split(' ')[0]);
  }
  // 面板那棵子树必须照常显示（万一它挂在被藏的节点里面）
  const P = document.querySelector('.vs-panel');
  if (P) {
    P.style.visibility = 'visible';
    for (const n of P.querySelectorAll('*')) n.style.visibility = 'visible';
  }
  return { hidden: hidden.length, sample: hidden.slice(0, 6) };
})()`;
/* 把面板钉到视口左上角。
 * 必须做：面板原本是 `position: absolute` 且**居中**定位的，它的包含块是
 * demo 外壳里的某个容器，不是视口。实测只改 top/bottom 无效 ——
 * 面板在静止状态下就变了形（483 宽 → 309 宽、还掉到 y=584），
 * 因为它是被外壳容器约束的。
 * 所以改用 position: fixed 完全脱离嵌套，并显式写死宽度，让它与父容器无关。 */
const PIN_TOP = `(() => {
  const P = document.querySelector('.vs-panel');
  if (!P) return null;
  const w = Math.round(P.getBoundingClientRect().width);
  P.style.position = 'fixed';
  P.style.top = '${PAD_TOP}px';  P.style.left = '${PAD_X}px';
  P.style.right = 'auto';
  P.style.bottom = 'auto';
  P.style.transform = 'none';
  P.style.margin = '0';
  P.style.width = w + 'px';
  const r = P.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), lockedW: w };
})()`;

/* 拍一个标签页。
 * 先按内容测出需要多高，再把视口设成"刚好装下面板"，最后裁出面板 + 边距。 */
async function shotTab(t, label, tag) {
  await t.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: 1200, deviceScaleFactor: SCALE, mobile: false });
  await installSeeds(t);
  await t.send('Page.navigate', { url: pathToFileURL(resolve(ROOT, 'demo/index.html')).href + '?vsSeed=off' });
  await sleep(2800);

  // 等面板真的开出来（和 make-screenshots.mjs 同一条等待链）
  const opened = await t.ev(`(async () => {
    for (let i = 0; i < 300; i++) {
      if (!window.__vsDemo) { await new Promise(r => setTimeout(r, 20)); continue; }
      if (!document.querySelector('.vs-panel')) { window.__vsDemo.openPanel(); await new Promise(r => setTimeout(r, 40)); continue; }
      if (!document.querySelector('.vs-panel .vs-deck')) { await new Promise(r => setTimeout(r, 40)); continue; }
      break;
    }
    await new Promise(r => setTimeout(r, 500));
    return { deck: !!document.querySelector('.vs-panel .vs-deck'), seed: window.__SEED_INFO, personal: window.__PERSONAL_INFO };
  })()`);
  if (!opened.deck) throw new Error(`${tag}: 面板没打开，拒绝出图`);

  // 切标签
  await t.ev(`(() => {
    const P = document.querySelector('.vs-panel');
    const tb = [...P.querySelectorAll('.vs-tab')].find(n => (n.textContent||'').indexOf(${JSON.stringify(label)}) >= 0);
    if (!tb) throw new Error('没有标签 ' + ${JSON.stringify(label)});
    tb.click();
    return true;
  })()`);
  await sleep(800);

  // 解除高度上限
  const uncapped = await t.ev(UNCAP);
  if (!uncapped) throw new Error(`${tag}: 没找到 .vs-panel.floating 的 max-height 规则，拒绝出图`);
  await sleep(400);

  // 量：解除后面板的自然高度
  const m = await t.ev(`(() => {
    const P = document.querySelector('.vs-panel');
    const B = P.querySelector('.vs-body');
    const pr = P.getBoundingClientRect();
    const br = B.getBoundingClientRect();
    return {
      panelW: Math.round(pr.width),
      panelH: Math.round(pr.height),
      bodyScrollH: Math.round(B.scrollHeight),
      bodyClientH: Math.round(B.clientHeight),
      bodyTopInPanel: Math.round(br.top - pr.top),
      panelMaxH: getComputedStyle(P).maxHeight,
    };
  })()`);
  if (m.panelMaxH !== 'none') throw new Error(`${tag}: max-height 还是 ${m.panelMaxH}，解除失败`);
  // 闸门：解除后必须"内容全部装得下"，否则就是还在截
  const overflow = m.bodyScrollH - m.bodyClientH;
  if (overflow > 2) throw new Error(`${tag}: 解除上限后内容仍溢出 ${overflow}px（面板 ${m.panelH}，内容 ${m.bodyScrollH}），拒绝出图`);

  // 视口给足（不改高度！见下面注释），面板钉在左上角。
  //
  // 这里踩过两次，都是"改视口高"引起的布局漂移：
  //   第一次 视口 1200、面板居中 → 面板顶部落到 y≈270，底部探出视口，拍了外壳；
  //   第二次 视口 = 面板高 + 边距、想把面板顶到 y=0 → 面板在静止状态下就变了形
  //          （483 宽 → 309 宽、掉到 y=584）。
  // 结论：**别动视口**。给一个够大的高度，把面板钉死在左上角，然后只裁
  // 面板那一片 —— 多出来的地方是页面底色，正好就是我们要的那圈背景。
  const VH = Math.max(1200, m.panelH + PAD_TOP + PAD_BOTTOM + 100);
  await t.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VH, deviceScaleFactor: SCALE, mobile: false });
  await sleep(400);
  const pinned = await t.ev(PIN_TOP);
  if (!pinned) throw new Error(`${tag}: 钉不住面板（节点没了？），拒绝出图`);
  await sleep(400);

  // 位置复核（钉完之后先读，遮罩要用它当洞）
  const pos = await t.ev(`(() => {
    const P = document.querySelector('.vs-panel');
    const r = P.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), ih: innerHeight };
  })()`);

  // 藏掉外壳 UI，只留页面底色（见 HIDE_SHELL 的注释）
  const hid = await t.ev(HIDE_SHELL);
  await sleep(350);
  if (!hid || !hid.hidden) throw new Error(`${tag}: 没藏掉任何外壳节点，页面结构变了？拒绝出图`);

  // 藏完复核：面板所在的那块必须还是面板
  const covered = await t.ev(`(() => {
    const P = document.querySelector('.vs-panel');
    const pr = P.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(pr.x + pr.width / 2), Math.round(pr.y + 8));
    return { panelHit: P.contains(hit) ? '面板' : (hit ? hit.tagName + '.' + String(hit.className).slice(0, 30) : 'null') };
  })()`);
  if (covered.panelHit !== '面板') {
    throw new Error(`${tag}: 面板位置命中的是「${covered.panelHit}」而不是面板，拒绝出图`);
  }

  // 裁切区：面板 + 一圈边距
  const clip = {
    x: Math.max(0, pos.x - PAD_X),
    y: Math.max(0, pos.y - PAD_TOP),
    width: 0,
    height: 0,
  };
  clip.width = Math.min(pos.w + PAD_X * 2, VIEW_W - clip.x);
  clip.height = pos.h + PAD_TOP + PAD_BOTTOM;
  console.log(`      [诊断] 面板自然高 m.panelH=${m.panelH}（宽 ${m.panelW}，内容 ${m.bodyScrollH}）→ 视口高 ${VH} → 钉后 pos=${JSON.stringify(pos)} → clip=${JSON.stringify(clip)}`);
  if (clip.height < pos.h) throw new Error(`${tag}: 裁切高度 ${clip.height} 小于面板高 ${pos.h}，面板会被截，拒绝出图`);
  if (clip.width < pos.w) throw new Error(`${tag}: 裁切宽度 ${clip.width} 小于面板宽 ${pos.w}，面板会被截，拒绝出图`);

  // 闸门：裁切区里**实际出现的**只能是面板或铺的那层背景。
  //
  // 判据为什么不是"有没有别的元素在几何上重叠"：demo 外壳的输入框本来就在那里
  // （几何上重叠），是那层不透明背景把它盖住/裁掉的 —— 有重叠不代表拍出来看得见。
  // 所以直接问浏览器"这点的最上层是谁"（elementFromPoint），看的是**实际结果**。
  const sample = await t.ev(`(() => {
    const clip = ${JSON.stringify(clip)};
    const P = document.querySelector('.vs-panel');
    const pts = [
      ['左上', clip.x + 2, clip.y + 2],
      ['右上', clip.x + clip.width - 2, clip.y + 2],
      ['左下', clip.x + 2, clip.y + clip.height - 2],
      ['右下', clip.x + clip.width - 2, clip.y + clip.height - 2],
      ['上中', clip.x + Math.round(clip.width / 2), clip.y + 2],
      ['下中', clip.x + Math.round(clip.width / 2), clip.y + clip.height - 2],
    ];
    return pts.map(([name, x, y]) => {
      const n = document.elementFromPoint(x, y);
      let owner;
      if (!n) owner = 'null';
      else if (P.contains(n)) owner = '面板';
      // 藏起来的节点仍然会参与 elementFromPoint（它只是不渲染），所以要显式放过
      else if (getComputedStyle(n).visibility === 'hidden') owner = '背景（已藏）';
      // 透明容器 = 露出的是页面底色（body 的 #14120F），也算背景
      else if (getComputedStyle(n).backgroundColor === 'rgba(0, 0, 0, 0)') owner = '背景（透明容器）';
      else owner = n.tagName + '.' + String(n.className).slice(0, 30) + '  bg=' + getComputedStyle(n).backgroundColor;
      return { name, x, y, owner };
    });
  })()`);
  const bad = sample.filter((s) => !s.owner.startsWith('面板') && !s.owner.startsWith('背景'));
  if (bad.length) {
    throw new Error(`${tag}: 裁切区里露出了面板和背景以外的东西，拒绝出图：\n` +
      bad.map((b) => `      ${b.name}(${b.x},${b.y}) → ${b.owner}`).join('\n') +
      `\n      裁切区 = ${JSON.stringify(clip)}`);
  }

  const cap = await t.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: true,
  });
  const buf = Buffer.from(cap.data, 'base64');

  /* 最终闸门：在**产出图**上验像素，而不是只验 DOM。
   *
   * 为什么要在图上验：前面每一次翻车（外壳拍进来、面板被压窄、底部露输入框）
   * 在 DOM 层面的读数都是"正常"的，是图本身不对。所以最后一道判据必须在图上：
   *   · 四角必须是背景色 → 说明"一圈背景"真的在，没有外壳漏出来
   *   · 面板区域内必须出现面板底色 → 说明面板真的在框里、没被裁掉
   * 两次采样都取一小块的平均色，避开抗锯齿的单点噪声。
   */
  const probe = async (left, top, size) => {
    const st = await sharp(buf).extract({ left, top, width: size, height: size })
      .resize(1, 1, { fit: 'fill' }).raw().toBuffer();
    return [st[0], st[1], st[2]];
  };
  const near = (a, b, tol = 14) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
  const BG = [0x14, 0x12, 0x0F];   // #14120F，页面底色
  const meta0 = await sharp(buf).metadata();
  const S = 8;
  const corners = [
    ['左上', S, S], ['右上', meta0.width - S * 2, S],
    ['左下', S, meta0.height - S * 2], ['右下', meta0.width - S * 2, meta0.height - S * 2],
  ];
  const cornerColors = [];
  for (const [name, l, tp] of corners) {
    const c = await probe(l, tp, S);
    cornerColors.push({ name, c });
    if (!near(c, BG)) {
      throw new Error(`${tag}: 产出图四角不是背景色，${name} 实测 rgb(${c.join(',')}) 应为 rgb(${BG.join(',')})（#14120F），拒绝出图`);
    }
  }
  // 面板中心必须是面板内容（不是背景色 —— 否则说明面板根本没在框里）
  const center = await probe(Math.round(meta0.width / 2) - S / 2, Math.round(meta0.height / 2) - S / 2, S);
  if (near(center, BG, 6)) {
    throw new Error(`${tag}: 产出图正中是背景色 rgb(${center.join(',')})，面板没在框里，拒绝出图`);
  }

  const meta = meta0;
  return { buf, w: meta.width, h: meta.height, m, pos, clip, opened, cornerColors, center };
}

/* ── 图 1：整屏 + 胶囊（沿用现有脚本的做法，保持 README 那两张的风格）── */
async function shotCapsule() {
  const t = await newTab();
  await t.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 760, deviceScaleFactor: SCALE, mobile: false });
  await installSeeds(t);
  await t.send('Page.navigate', { url: pathToFileURL(resolve(ROOT, 'demo/index.html')).href + '?vsSeed=off' });
  await sleep(2800);
  const m = await t.ev(`(() => {
    const c = document.querySelector('.vs-capsule');
    const b = c ? c.getBoundingClientRect() : null;
    return { capsule: b ? { y: Math.round(b.y), h: Math.round(b.height) } : null,
             detail: document.scrollingElement.scrollHeight, ih: innerHeight,
             seed: window.__SEED_INFO };
  })()`);
  if (!m.capsule) throw new Error('没找到胶囊，拒绝出图');
  const top = Math.max(0, Math.round(m.capsule.y - 130));
  const bottom = Math.round(m.capsule.y + m.capsule.h + 24);
  const cap = await t.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: top, width: 1120, height: bottom - top, scale: SCALE },
    captureBeyondViewport: true,
  });
  const buf = Buffer.from(cap.data, 'base64');
  const meta = await sharp(buf).metadata();
  t.close();
  return { buf, w: meta.width, h: meta.height, m };
}

/* ── 主流程 ─────────────────────────────────────────────── */
mkdirSync(outDir, { recursive: true });

const TABS = [
  ['今日', '1-背词界面'],
  ['进度', '2-进度与热力图'],
  ['生词本', '3-生词本'],
  ['设置', '4-设置'],
];

const out = [];
console.log(`出图到 ${outDir}\n`);

for (const [label, name] of TABS) {
  const t = await newTab();
  try {
    const r = await shotTab(t, label, name);
    console.log(`图 ${name.padEnd(14)} ${String(r.w + 'x' + r.h).padEnd(12)} 面板 ${r.m.panelW}x${r.m.panelH}  内容 ${r.m.bodyScrollH}  裁切 ${JSON.stringify(r.clip)}  ${r.opened.seed ?? ''}`);
    out.push([name, r.buf, r.w, r.h]);
  } finally { t.close(); }
}

console.log('\n写入：');
for (const [name, buf, w, h] of out) {
  const f = resolve(outDir, `${name}.png`);
  writeFileSync(f, buf);
  console.log(`  ${(name + '.png').padEnd(26)} ${String(w + 'x' + h).padEnd(12)} ${(statSync(f).size / 1024).toFixed(0)} KB`);
}
console.log(`\n合计 ${out.length} 张`);
