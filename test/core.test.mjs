// vocab-study / test / core.test.mjs
//
// Node 侧单测：直接 import 源码（不经过构建产物），跑 core/spec-cases.mjs 里
// 那套和浏览器自检完全相同的断言。
//
//   node test/core.test.mjs
//
// 退出码 0 = 全绿，1 = 有失败。这是本插件唯一需要联网/浏览器以外环境的验收口。

import { runSpecCases } from '../core/spec-cases.mjs';
import * as M from '../core/memory.mjs';
import * as Q from '../core/queue.mjs';
import * as S from '../core/session.mjs';
import * as L from '../core/library.mjs';
import * as G from '../core/game.mjs';
import * as MK from '../core/mistake.mjs';
import * as HK from '../core/hook.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const report = (msg, kind, detail) => {
  if (kind === 'ok') {
    console.log(`${GREEN}${msg}${OFF}`);
  } else if (kind === 'bad') {
    console.log(`${RED}${msg}${OFF}${detail ? `  ${DIM}(${detail})${OFF}` : ''}`);
  } else {
    console.log(msg);
  }
};

console.log('vocab-study · 核心验收（Node 直跑源码）\n');

const { pass, fail, results } = runSpecCases(report);

const failedCases = results.filter((r) => r.error);

// ── 记忆钩子「✨ 让我记住它」（§9）────────────────────────────
// 这个功能曾经是个**假按钮**：假装加载 900ms 然后写死「暂时没编出来」。
// 下面这组断言就是为了让那种事不可能再发生 —— 按钮必须真的产出东西。
console.log('\n记忆钩子（§9）：');
const hookChecks = [];
{
  const seed = L.seedFor('cet4');
  const hooks = seed.map((w) => HK.buildHook(w));

  hookChecks.push(['每个词都能产出非空钩子', hooks.every((h) => h.text && h.text.length > 0)]);
  hookChecks.push(['钩子不超 40 字（规格 §9）', hooks.every((h) => h.text.length <= HK.HOOK_MAX_CHARS)]);
  hookChecks.push(['每个钩子都标了来源', hooks.every((h) => !!h.source && !!h.sourceLabel)]);
  hookChecks.push([
    '纯函数：同输入同输出',
    seed.every((w) => HK.buildHook(w).text === HK.buildHook(w).text),
  ]);
  hookChecks.push([
    '不编造：来源必须是已知材料之一',
    hooks.every((h) => ['root', 'example', 'collocation', 'contrast', 'spelling', 'meaning'].includes(h.source)),
  ]);
  hookChecks.push([
    '词库里真有材料可用（不是全靠兜底）',
    hooks.filter((h) => h.source === 'root' || h.source === 'example').length >= seed.length * 0.8,
  ]);
  hookChecks.push([
    '词根钩子带上了单词（否则「拿过来」这种记不住是哪个词）',
    seed
      .filter((w) => w.roots && HK.buildHook(w).source === 'root')
      .every((w) => {
        const t = HK.buildHook(w).text;
        return t.length >= 8 || t.includes(w.word);
      }),
  ]);
  hookChecks.push([
    '空词条不抛错',
    (() => {
      try {
        HK.buildHook(null);
        HK.buildHook({});
        return HK.buildHook({}).text.length > 0;
      } catch {
        return false;
      }
    })(),
  ]);

  // 缓存：每词一生只付一次（§9）
  const mem = new Map();
  const fakeStorage = {
    async get(k) { return mem.get(k) ?? null; },
    async set(k, v) { mem.set(k, v); },
  };
  const cache = HK.createHookCache({ storage: fakeStorage });
  const w0 = seed[0];
  const first = await cache.ensure(w0);
  const second = await cache.ensure(w0);
  hookChecks.push(['第一次是新生成了', first.cached === false]);
  hookChecks.push(['第二次命中缓存（零等待）', second.cached === true]);
  hookChecks.push(['两次内容一致', first.hook.text === second.hook.text]);
  hookChecks.push(['缓存已写回本地', !!(await fakeStorage.get('hooks'))[w0.id]]);
  await cache.forget(w0.id);
  hookChecks.push(['forget 之后又算新生成', (await cache.ensure(w0)).cached === false]);
}

let hookFail = 0;
for (const [name, ok] of hookChecks) {
  if (ok) console.log(`${GREEN}  ✓ ${name}${OFF}`);
  else { hookFail++; console.log(`${RED}  ✗ ${name}${OFF}`); }
}
if (hookFail) {
  console.log(`\n${RED}记忆钩子检查失败 ${hookFail} 项${OFF}`);
  process.exit(1);
}

// ── 新词出场顺序：随机 + 同一天稳定（§7.2 / §540）──────────────────
// 以前新词严格按词库顺序（字母序）出，用户每天翻开都是 abandon → abundant
// → abolish…，背了三天还在 a 里。用户明确要求随机。
//
// 但**不能每次重算都重掷**，否则规格 §540 的「08:52 回到面板 → 队列从第 6 词
// 继续」就废了：第 6 个位置会变成另一个词。下面这两组断言同时守住两边。
console.log('\n新词出场顺序（随机 + 当天稳定）：');
const orderChecks = [];
{
  const seed = L.seedFor('cet4');
  const mem = L.seedMemories(seed, {}, 20260214);
  const opts = { N: 20, gapDays: 0, balance: 0.5, now: 20260214, collections: ['cet4'] };
  const idsOf = (c) => c.items.map((i) => i.word.id);

  const day1a = Q.buildDailyContainer(seed, mem, { ...opts, seed: '2026-02-14' });
  const day1b = Q.buildDailyContainer(seed, mem, { ...opts, seed: '2026-02-14' });
  const day2 = Q.buildDailyContainer(seed, mem, { ...opts, seed: '2026-02-15' });

  orderChecks.push([
    '同一天算两次，队列完全一致（「接着背」不会换词）',
    JSON.stringify(idsOf(day1a)) === JSON.stringify(idsOf(day1b)),
  ]);
  orderChecks.push([
    '换一天会换一个排法',
    JSON.stringify(idsOf(day1a)) !== JSON.stringify(idsOf(day2)),
  ]);

  // 真的是乱序，不是碰巧和字母序一样
  const seqOrder = Q.buildDailyContainer(seed, mem, { ...opts, order: 'seq' });
  orderChecks.push([
    '默认顺序 ≠ 字母序（用户要的就是这个）',
    JSON.stringify(idsOf(day1a)) !== JSON.stringify(idsOf(seqOrder)),
  ]);
  orderChecks.push([
    "order:'seq' 时确实回到词库顺序",
    JSON.stringify(idsOf(seqOrder)) ===
      JSON.stringify(idsOf(Q.buildDailyContainer(seed, mem, { ...opts, order: 'seq' }))),
  ]);

  // 预算铁律不能被随机破坏（§6.6）
  orderChecks.push(['随机后容器大小仍是 N', idsOf(day1a).length === 20]);
  orderChecks.push([
    '随机后没有重复词',
    new Set(idsOf(day1a)).size === idsOf(day1a).length,
  ]);
  // 注意这里断言的是**子集**，不是集合相同。
  //
  // 新词池有 116 个而每天只取 20 个，所以两个 20 词的集合本来就会不同 ——
  // 这恰恰是随机的价值：字母序时永远是 a 开头那 20 个（背三天还在 a 里），
  // 洗牌后每天从整个池子里抽。断言集合相同反而是在要求它是坏的。
  const poolIds = new Set(
    seed.filter((w) => !mem[w.id] || mem[w.id].encodeCount === 0).map((w) => w.id),
  );
  orderChecks.push([
    '随机挑出来的词都来自合法新词池',
    idsOf(day1a).every((id) => poolIds.has(id)),
  ]);
  orderChecks.push([
    '随机让每天的选词真正覆盖到字母表后面（不再只在 a/b 里打转）',
    (() => {
      const alpha = new Set(
        ['02-14', '02-15', '02-16', '02-17', '02-18'].flatMap((d) =>
          idsOf(Q.buildDailyContainer(seed, mem, { ...opts, seed: '2026-' + d })),
        ),
      );
      const alphaFirst = new Set(
        ['02-14', '02-15', '02-16', '02-17', '02-18'].flatMap((d) =>
          Q.buildDailyContainer(seed, mem, { ...opts, seed: '2026-' + d, order: 'seq' })
            .items.map((i) => i.word.id),
        ),
      );
      // 保序时每天抽到的是同一批词（所以并集也是 20）；随机时应当明显更广
      return alpha.size > alphaFirst.size;
    })(),
  ]);

  // 洗牌本身的性质
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  orderChecks.push([
    'seededShuffle 不改原数组',
    (() => {
      const before = arr.slice();
      Q.seededShuffle(arr, 'x');
      return JSON.stringify(arr) === JSON.stringify(before);
    })(),
  ]);
  orderChecks.push([
    'seededShuffle 同种子同结果',
    JSON.stringify(Q.seededShuffle(arr, 'k')) === JSON.stringify(Q.seededShuffle(arr, 'k')),
  ]);
  orderChecks.push([
    'seededShuffle 不同种子不同结果',
    JSON.stringify(Q.seededShuffle(arr, 'k1')) !== JSON.stringify(Q.seededShuffle(arr, 'k2')),
  ]);
  orderChecks.push([
    'seededShuffle 不丢不重（洗牌不是抽样）',
    JSON.stringify([...Q.seededShuffle(arr, 'k')].sort((a, b) => a - b)) === JSON.stringify(arr),
  ]);

  // 复习词（第 1 层）的顺序是记忆调度，绝不能被随机打乱。
  // 必须真的造出"到期"的词，否则这条断言是空转（第一次写就踩了这个坑，
  // seedMemories 造出来的都是 encodeCount=0 的新词，一个到期的都没有）。
  const learned = {};
  for (const w of seed.slice(0, 12)) {
    // halfLifeDays 的公式是 log2h = theta.a + stability - …，所以 stability
    // 直接就是半衰期的指数。用 0 + 30 天前看过，保证半衰期只有几小时、
    // 一定过期（上一版设成 stability:1 就永远不到期，断言空转）。
    learned[w.id] = {
      ...M.newMemory({}, opts.now),
      encodeCount: 3,
      stability: 0,
      lastSeenTs: opts.now - 30 * M.DAY_MS,
    };
  }
  const rev = Q.buildDailyContainer(seed, learned, { ...opts, seed: '2026-02-14' });
  const revAgain = Q.buildDailyContainer(seed, learned, { ...opts, seed: '2026-02-15' });
  const reviewIds = (c) => c.items.filter((i) => i.tier === 1).map((i) => i.word.id);
  orderChecks.push(['确实有到期复习词可验（否则这条断言是空转）', reviewIds(rev).length > 0]);
  orderChecks.push([
    '到期复习词的顺序不受随机影响（那是记忆调度）',
    JSON.stringify(reviewIds(rev)) === JSON.stringify(reviewIds(revAgain)),
  ]);
}

let orderFail = 0;
for (const [name, ok] of orderChecks) {
  if (ok) console.log(`${GREEN}  ✓ ${name}${OFF}`);
  else { orderFail++; console.log(`${RED}  ✗ ${name}${OFF}`); }
}
if (orderFail) {
  console.log(`\n${RED}新词顺序检查失败 ${orderFail} 项${OFF}`);
  process.exit(1);
}

console.log('');
console.log('─'.repeat(56));
console.log(`${fail === 0 ? GREEN : RED}${pass} 通过 / ${fail} 失败${OFF}  （${results.length} 组用例）`);
if (failedCases.length) {
  console.log(`${RED}抛错的用例：${OFF}`);
  for (const c of failedCases) console.log(`  · ${c.name} → ${c.error}`);
}
console.log('─'.repeat(56));

if (fail === 0) {
  // 额外做几件「跑源码才能发现」的健全性检查
  const extras = [];
  const seed = L.seedFor('cet4');
  extras.push(['种子词库无重复 id', new Set(seed.map((w) => w.id)).size === seed.length]);
  extras.push(['种子词库无重复拼写', new Set(seed.map((w) => w.word)).size === seed.length]);
  extras.push(['每个词都有例句', seed.every((w) => !!w.example)]);
  extras.push(['每个词都有词性', seed.every((w) => !!w.pos)]);
  extras.push([
    'DAY_MS 只有一处声明（曾被重复声明炸过整包）',
    typeof M.DAY_MS === 'number' && M.DAY_MS === 86400000,
  ]);
  extras.push(['容器统计字段名与 UI 取值一致', (() => {
    const words = L.seedFor('cet4');
    const mem = L.seedMemories(words, {}, 20260214);
    const c = Q.buildDailyContainer(words, mem, { N: 20, gapDays: 0, balance: 0.5, now: 20260214, collections: ['cet4'] });
    return typeof c.stats.containerSize === 'number'
      && typeof c.stats.reviewCount === 'number'
      && typeof c.stats.personalCount === 'number'
      && typeof c.stats.newCount === 'number';
  })()]);

  // ── 词表解析（这里原来**一条测试都没有**，所以坏了很久没人知道）──
  //
  // 背景：parseWordlist 原来只按「制表符 / 2+ 空格」切行。
  // 而 CET6 / 考研 / GRE 的源都是**单空格**格式（`abandon [əˈbændən] v. 放弃`），
  // 切不开 → 整行被当成一个"单词" → 被词形正则判掉。
  // 实测：CET6 一万多字符只出 7 个词、考研出 0 个、GRE 出 1 个，
  // **而且界面不报错**，只是切过去词表是空的。
  //
  // 下面这几条就是钉住修好之后的行为：同一个词，三种分隔风格都要能解析。
  const P_SINGLE = L.parseWordlist('abandon [əˈbændən] v. 抛弃，放弃', 'x', 0);
  const P_MULTI = L.parseWordlist("abandon           [ə'bændən]            vt.  放弃,沉溺n.  放任", 'x', 0);
  const P_TAB = L.parseWordlist('abandon\t[əˈbændən]\tv. 放弃', 'x', 0);
  extras.push(['解析单空格格式（CET6/考研/GRE 的真实格式）', (() => {
    return P_SINGLE.length === 1
      && P_SINGLE[0].word === 'abandon'
      && P_SINGLE[0].ipa === 'əˈbændən'
      && P_SINGLE[0].meaning.includes('放弃');
  })()]);
  extras.push(['解析多空格格式（TOEFL 的真实格式）', (() => {
    return P_MULTI.length === 1 && P_MULTI[0].word === 'abandon' && P_MULTI[0].meaning.includes('放弃');
  })()]);
  extras.push(['解析制表符格式', (() => {
    return P_TAB.length === 1 && P_TAB[0].word === 'abandon' && P_TAB[0].meaning.includes('放弃');
  })()]);
  extras.push(['带连字符的词不被截断', (() => {
    const r = L.parseWordlist("about-turn [ə'bauttə:n] n. 转向", 'x', 0);
    return r.length === 1 && r[0].word === 'about-turn';
  })()]);
  extras.push(['噪声行被丢弃（不产生垃圾词条）', (() => {
    return L.parseWordlist('123 @@ ###', 'x', 0).length === 0
      && L.parseWordlist('!!!', 'x', 0).length === 0;
  })()]);
  extras.push(['JSON 数组格式仍然可用（回归保护）', (() => {
    const r = L.parseWordlist(JSON.stringify([{ word: 'abandon', ipa: 'x', meaning: 'y' }]), 'x', 0);
    return r.length === 1 && r[0].word === 'abandon';
  })()]);

  // ── 每个词库都必须真的有词可背 ──
  //
  // 这条是给「切到六级/雅思拿到的是四级词」那个 bug 上的锁。
  // 当时 seedFor() 对非四级词库是「把四级词换个 id 前缀」，六个词库一模一样。
  extras.push(['每个词库的词条 id 前缀是自己的（不是四级别名）', (() => {
    const ids = {};
    for (const c of Object.keys(L.COLLECTIONS)) {
      const ws = L.seedFor(c);
      ids[c] = new Set(ws.map((w) => w.id.split(':')[0]));
    }
    // 每个词库的种子都只应属于它自己
    return Object.entries(ids).every(([c, set]) => set.size === 1 && set.has(c));
  })()]);
  extras.push(['每个词库都声明了词表源或内置词', (() => {
    // 有内置种子、或者在 SOURCES/COLLECTIONS 里给了 url，二者至少有一个
    const withSeed = Object.keys(L.COLLECTIONS).filter((c) => L.seedFor(c).length > 0);
    const withUrl = Object.keys(L.COLLECTIONS).filter((c) => {
      const meta = L.COLLECTIONS[c] || {};
      return (meta.urls && meta.urls.length) || (L.SOURCES[c] && L.SOURCES[c].length);
    });
    // 目前六级/考研/托福/GRE 走远程源，四级走内置；至少不能有「两样都缺」的
    const none = Object.keys(L.COLLECTIONS).filter((c) => !withSeed.includes(c) && !withUrl.includes(c));
    return none.length === 0;
  })()]);

  // ── CSS 回归保护（2026-10-12）────────────────────────────
  // 用户报"窗口一小，下面的东西就消失"。查出来是这样一条：
  //   @media (max-height: 900px) { .vs-deck-heat { display: none } }
  // 它是**无条件**隐藏，把上面「全 0 才藏」的判断整个盖掉了 ——
  // 结果攒了半个月的记录，窗口一矮就一格都不显示。
  //
  // 这类 bug 的特点是**在源码里看不出错**（两个选择器各自都合理），
  // 只有把它们放在一起读才发现冲突。所以用文本层面的断言守住：
  // 热力图**不允许**被媒体查询无条件藏掉。
  //
  // ⚠️ 解析前必须**先剥掉注释**。第一版忘了剥，结果把注释里
  //    那句"这里原来是 @media ... { display: none }"的**引用文字**
  //    当成了真规则，误报失败。教训：解析源码文本的第一步永远是去注释，
  //    否则你测的是自己的注释。
  const cssRaw = (() => {
    try {
      return readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8');
    } catch { return null; }
  })();
  const cssText = typeof cssRaw === 'string' ? cssRaw.replace(/\/\*[\s\S]*?\*\//g, '') : null;
  extras.push(['能读到 ui/styles.css（读不到就没法守下面两条）', typeof cssText === 'string']);
  extras.push([
    '没有任何媒体查询无条件隐藏热力图（曾被 max-height:900px 整块藏掉）',
    (() => {
      if (typeof cssText !== 'string') return false;
      const blocks = [];
      const re = /@media[^{]*\{/g;
      let m;
      while ((m = re.exec(cssText))) {
        let depth = 1; let i = re.lastIndex;
        while (i < cssText.length && depth > 0) {
          if (cssText[i] === '{') depth++;
          else if (cssText[i] === '}') depth--;
          i++;
        }
        blocks.push(cssText.slice(m.index, i));
      }
      for (const b of blocks) {
        const rules = b.matchAll(/([^{}]+)\{([^{}]*)\}/g);
        for (const r of rules) {
          const sel = r[1];
          const body = r[2];
          // 带 :has(...) 的是"全 0 才藏"，是设计意图，放行
          if (sel.includes('.vs-deck-heat') && /display\s*:\s*none/.test(body) && !sel.includes(':has(')) {
            return false;
          }
        }
      }
      return true;
    })(),
  ]);
  extras.push([
    '矮面板降级用的是缩放不是隐藏（媒体查询里改了 cell 尺寸）',
    (() => {
      if (typeof cssText !== 'string') return false;
      const i = cssText.indexOf('max-height: 900px');
      if (i < 0) return false;
      const seg = cssText.slice(i, i + 700);
      return /\.vs-deck-heat[\s\S]*?\.cell[\s\S]*?width\s*:/.test(seg);
    })(),
  ]);

  console.log('\n健全性附加检查：');
  let extraFail = 0;
  for (const [name, ok] of extras) {
    if (ok) console.log(`${GREEN}  ✓ ${name}${OFF}`);
    else { extraFail++; console.log(`${RED}  ✗ ${name}${OFF}`); }
  }
  if (extraFail) {
    console.log(`\n${RED}附加检查失败 ${extraFail} 项${OFF}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}全部通过。${OFF}`);
  process.exit(0);
}

process.exit(1);
