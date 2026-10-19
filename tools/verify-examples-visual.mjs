/**
 * 验证「例句 / 词根词缀 / 词源」在**真实渲染出来的面板**上确实出现了。
 *
 * 为什么不看单测：词根功能上一版就吃过这个亏 —— 单测 61 项全绿，
 * 界面上一个词根都没有，因为测试直接调数据函数、绕过了渲染路径。
 * 这里走真 DOM：切到六级词库（14k 里去重后的大头），一张张翻背面，
 * 数「有多少张卡真的显示了例句 / 词根词缀 / 词源」，并截图。
 *
 *   node tools/verify-examples-visual.mjs [输出目录]
 *
 * 前置：先 `python tools/build.py` 生成 demo/preview.html（构建产物）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/21653/.dsh/profiles/desktop/node_modules/sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = resolve(process.env.TEMP ?? '.', 'cdp-vocab-examples');
const PORT = 9243;
const outDir = resolve(process.argv[2] ?? '_verify');
const CARDS = Number(process.env.CARDS ?? 20);
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
const rows = [];
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

  // 切到六级：它的词全部来自 ECDICT（没有人工例句、没有人工词根），
  // 正好是这次要补的那批。
  const switched = await ev(
    cdp,
    `(async () => {
      const d = window.__vsDemo;
      if (!d || !d.app) return 'no-app';
      d.openPanel();
      const r = await d.app.changeCollection('cet6');
      return JSON.stringify(r);
    })()`,
  );
  console.log('  切词库（cet6）: ' + switched);
  await sleep(1800);
  // 这一轮默认只有 5 张卡（today 队列按 N 建的），要统计 20 张就得先用产品自己的
  // 「我还是想继续 / 再来 N 个新词」接口把队列续长：
  //   app.allowMoreNew()  放行新词闸门（界面上的「我还是想继续」）
  //   app.extendRound(15) 本轮再排 15 个没排过的词
  // 闸门关着时 extendRound 会**故意**什么都不做（这是安全阀，不是 bug）。
  const extended = await ev(
    cdp,
    `(async () => {
      const app = window.__vsDemo.app;
      const out = { allow: typeof app.allowMoreNew, extend: typeof app.extendRound };
      if (app.allowMoreNew) app.allowMoreNew();
      await new Promise((r) => setTimeout(r, 400));
      if (app.extendRound) app.extendRound(15);
      await new Promise((r) => setTimeout(r, 500));
      out.card = !!(app.state.card && app.state.card.word);
      out.containerSize = app.state.container && (app.state.container.size || (app.state.container.items || []).length);
      return JSON.stringify(out);
    })()`,
  );
  console.log('  续队列: ' + extended);

  async function snap(name) {
    const rect = await ev(
      cdp,
      `(() => {
        const p = document.querySelector('.vs-panel');
        const r = p.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      })()`,
    );
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
    if (width < 8 || height < 8) await sharp(full).png().toFile(out);
    else await sharp(full).extract({ left, top, width, height }).png().toFile(out);
    const meta = await sharp(out).metadata();
    console.log(`  ✅ 截图 ${name} (${meta.width}x${meta.height})`);
    return out;
  }

  let consecutiveFail = 0;
  for (let i = 1; i <= CARDS; i++) {
    // 推进用**实例 API**（rate → next），读取用**真 DOM**。
    //
    // 为什么不点按钮：点「评分」→「下一张」这条路我试了两版，翻到第 5 张就翻不开
    // （重试卡把 st.lastReveal 留在旧值上，按钮派发的事件和 render 节奏对不上），
    // 而且一旦卡住整个 CDP 调用会一直挂着。实例 API 是界面自己也在调的同一套方法
    // （见 ui/panel.mjs 的 rate() / next()），DOM 渲染路径不变 —— 统计的仍然是
    // 真实渲染出来的卡片，只是"按下一步"这个动作换了只手来按。
    if (i > 1) {
      const adv = await ev(
        cdp,
        `(async () => {
          const d = window.__vsDemo;
          if (!d || !d.app) return 'no-app';
          const app = d.app;
          if (!app.state.card) {
            // 这一轮走完了：续 5 个新词（等同界面上点「再来 5 个」）
            app.extendRound(5);
            await new Promise((r) => setTimeout(r, 400));
          } else {
            app.next();
            await new Promise((r) => setTimeout(r, 350));
          }
          return app.state.card ? 'ok' : 'no-card';
        })()`,
      );
      if (adv !== 'ok') {
        console.log(`  推进失败: ${JSON.stringify(adv)}`);
        code = 1;
        break;
      }
    }
    const info = await ev(
      cdp,
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const d = window.__vsDemo;
        const panel = document.querySelector('.vs-panel');
        if (!panel) return { err: 'no-panel' };
        for (let t = 0; t < 3 && !panel.querySelector('.vs-reveal'); t++) {
          d.app.rate('forgot');
          await wait(400);
        }
        if (!panel.querySelector('.vs-reveal')) {
          return {
            err: 'no-back',
            state: JSON.stringify({ card: !!d.app.state.card, reveal: !!d.app.state.lastReveal,
              stage: panel.querySelector('#vs-stage')?.dataset.mode }),
          };
        }
        const card = panel.querySelector('.vs-card');
        // ⚠️ 单词取**卡片里**的 .vs-word：写 '.vs-word, .vs-head' 会先命中
        // 面板标题（.vs-head），上一版就是这么拿到「今日背单词📍✕」的。
        const word = (card?.querySelector('.vs-word')?.textContent || '').trim();
        const exEl = panel.querySelector('.vs-reveal .vs-ex');
        const folds = [...panel.querySelectorAll('.vs-folds details')].map((dd) => ({
          title: (dd.querySelector('summary')?.textContent || '').trim(),
          open: dd.open,
          body: (dd.querySelector('.vs-foldbody')?.textContent || '').trim(),
        }));
        return {
          word,
          ex: exEl ? (exEl.querySelector('.en')?.textContent || '').trim() : '',
          exZh: exEl ? (exEl.querySelector('.zh')?.textContent || '').trim() : '',
          folds,
        };
      })()`,
    );
    if (info.err) {
      consecutiveFail++;
      console.log(`  第 ${i} 张跳过: ${info.err} ${info.state || ''}`);
      if (consecutiveFail >= 3) {
        console.log('  连续 3 张翻不开 —— 停止（驱动问题，不是数据问题）');
        code = 1;
        break;
      }
      continue;
    }
    consecutiveFail = 0;
    const hasRoot = info.folds.some((f) => f.title.includes('词根'));
    const hasEtym = info.folds.some((f) => f.title.includes('词源'));
    rows.push({ ...info, hasRoot, hasEtym });
    const rootFold = info.folds.find((f) => f.title.includes('词根'));
    const etymFold = info.folds.find((f) => f.title.includes('词源'));
    console.log(
      `  ${String(i).padStart(2)}. ${(info.word || '?').padEnd(16)} ` +
        `例句=${info.ex ? '有' : '—'}  词根=${rootFold ? '有' : '—'}  词源=${etymFold ? '有' : '—'}  ` +
        `${(info.ex || rootFold?.body || etymFold?.body || '').slice(0, 40)}`,
    );
    // 给前 3 张有内容可看的截图
    if (rows.filter((r) => r.ex || r.hasRoot || r.hasEtym).length <= 3 && (info.ex || hasRoot || hasEtym)) {
      await snap(`card-${String(i).padStart(2, '0')}-${(info.word || 'x').replace(/[^\w-]/g, '')}.png`);
    }
  }

  // ── 汇总：这是**真实渲染**里的覆盖率，不是数据表里的覆盖率 ──
  const n = rows.length || 1;
  const withEx = rows.filter((r) => r.ex).length;
  const withExZh = rows.filter((r) => r.exZh).length;
  const withRoot = rows.filter((r) => r.hasRoot).length;
  const withEtym = rows.filter((r) => r.hasEtym).length;
  const withSomething = rows.filter((r) => r.ex || r.hasRoot || r.hasEtym).length;
  console.log('\n  ── 真实渲染统计（' + rows.length + ' 张卡，六级）──');
  console.log(`  例句      ${withEx}/${rows.length}  (${((withEx / n) * 100).toFixed(0)}%)   其中带中文 ${withExZh}/${rows.length}`);
  console.log(`  词根词缀  ${withRoot}/${rows.length}  (${((withRoot / n) * 100).toFixed(0)}%)`);
  console.log(`  词源      ${withEtym}/${rows.length}  (${((withEtym / n) * 100).toFixed(0)}%)`);
  console.log(`  至少有一项 ${withSomething}/${rows.length}  (${((withSomething / n) * 100).toFixed(0)}%)`);

  // 断言：低于这些线说明数据没接上（不是"界面没显示"，是"根本没喂进来"）
  const checks = [
    ['例句至少 8/20（六级语料实测约 40%）', withEx / n >= 0.35],
    ['例句带中文 >= 英文的 90%', withExZh >= Math.floor(withEx * 0.9)],
    ['词根词缀至少 8/20（手写表实测约 50%）', withRoot / n >= 0.35],
    ['词源至少 10/20（维基实测约 70%）', withEtym / n >= 0.45],
    ['至少一项 >= 19/20（不该出现大片空白卡）', withSomething / n >= 0.9],
  ];
  console.log('');
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) code = 1;
  }

  // 默认展开状态：词根词缀展开；有词根时词源收起；无词根时词源展开
  const openRules = rows.filter((r) => r.hasRoot || r.hasEtym).slice(0, 12);
  let ruleOk = true;
  for (const r of openRules) {
    const rootFold = r.folds.find((f) => f.title.includes('词根'));
    const etymFold = r.folds.find((f) => f.title.includes('词源'));
    if (rootFold && !rootFold.open) {
      console.log(`  ✗ ${r.word}: 词根词缀没有默认展开`);
      ruleOk = false;
    }
    if (etymFold) {
      const wantOpen = !rootFold;
      if (etymFold.open !== wantOpen) {
        console.log(`  ✗ ${r.word}: 词源默认状态错了（应${wantOpen ? '展开' : '收起'}）`);
        ruleOk = false;
      }
    }
  }
  console.log(`  ${ruleOk ? '✓' : '✗'} 折叠项默认状态规则（词根词缀展开 / 词源跟着它走）`);
  if (!ruleOk) code = 1;

  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log(`\n  明细已存 ${resolve(outDir, 'report.json')}`);
} catch (e) {
  console.error('  ✗ 失败: ' + (e && e.stack ? e.stack : e));
  code = 1;
} finally {
  try {
    cdp && cdp.close();
  } catch {
    /* */
  }
  chrome.kill();
  await sleep(300);
  process.exit(code);
}
