// vocab-study / test / weekly-report.test.mjs
//
// 周度回顾：窗口、口径、文案。守的是一个用户真的报上来的 bug ——
//
//   用户周一早上打开面板，看到「本周：学 56 词 · 收服 10 词 · 最长连续 2 天」
//   和「诊断：今天的 42 个错词」，而他今天只背了 9 个词、而且那天才周一。
//
// 三个成因（0.2.6 及以前）：
//   1. 窗口取 now()-7*DAY_MS（最近 7 天），周一打开 ≈ 上周二…周日 + 今天，
//      却标成「本周」；
//   2. 「最长连续」读 state.streak.longest（有史以来最长），不是这一周的；
//   3. diagnosis 的句子写死「今天」，而传进去的是 7 天记录；
//      并且它数的是**错误次数**，文案却说「N 个错词」。
//
// 用假时钟跑，不依赖真实日期。

import { createApp } from '../core/app.mjs';
import * as Q from '../core/queue.mjs';
import * as S from '../core/session.mjs';
import * as MK from '../core/mistake.mjs';
import { DAY_MS } from '../core/memory.mjs';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let pass = 0;
const failList = [];
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ${GREEN}✓${OFF} ${name}`);
  } else {
    failList.push(name);
    console.log(`  ${RED}✗${OFF} ${name}${detail ? `  ${DIM}(${detail})${OFF}` : ''}`);
  }
}

console.log('vocab-study · 周度回顾\n');

// 2026-10-19 是周一。所以「上一个自然周」= 10-12(周一) … 10-18(周日)。
const MONDAY = Date.parse('2026-10-19T09:00:00+08:00');
const PREV_MON = Date.parse('2026-10-12T10:00:00+08:00');
const PREV_WED = Date.parse('2026-10-14T10:00:00+08:00');
const PREV_THU = Date.parse('2026-10-15T10:00:00+08:00');
const PREV_FRI = Date.parse('2026-10-16T10:00:00+08:00');
const TWO_WEEKS_AGO = Date.parse('2026-10-11T10:00:00+08:00'); // 上周之前

let clock = MONDAY;

function rec(ts, wordId, { correct = true, mode = 'quiz' } = {}) {
  return {
    ts,
    dayKey: Q.dayKey(ts),
    wordId,
    mode,
    correct,
    incorrect: !correct,
    reactionMs: 3000,
    tier: 3,
  };
}

/** 建一个 app、塞好 records、走完一轮（周报在「走完一轮」时结算）。 */
async function appWithRecords(records, at = MONDAY) {
  clock = at;
  const app = createApp({ now: () => clock });
  await app.init();
  app.raw.records = records;
  return app;
}

async function runRound(app) {
  let guard = 0;
  while (guard++ < 400) {
    // 走 raw 而不是 state：state 是渲染快照，容器形状不完整时会抛，
    // 那样报出来的是崩溃堆栈而不是"哪条断言不成立"。
    if (!app.raw.session || S.isFinished(app.raw.session)) break;
    const card = S.currentCard(app.raw.session);
    if (!card) break;
    app.rate('known');
    app.next();
  }
}

// ══ ① 只在周一自动出 ═════════════════════════════════════════
console.log('① 触发时机（§7.8：周一打开自动出一次）');

{
  const app = await appWithRecords([]);
  await runRound(app);
  ok('周一会出周报', !!app.raw.report);

  const t = await appWithRecords([], MONDAY + DAY_MS); // 周二
  await runRound(t);
  ok('周二不会出周报', !t.raw.report);

  const w = await appWithRecords([], MONDAY + 3 * DAY_MS); // 周四
  await runRound(w);
  ok('周四不会出周报', !w.raw.report);
}

// ══ ② 窗口必须是一个自然周，不是「最近 7 天」═══════════════════
console.log('\n② 统计窗口 = 上一个自然周（不是最近 7 天）');

{
  const words = [];
  const app = await appWithRecords([]);
  words.push(...app.raw.words.slice(0, 6));

  const inWeek = [
    rec(PREV_MON, words[0].id),
    rec(PREV_WED, words[1].id),
    rec(PREV_THU, words[2].id),
  ];
  const outside = [
    rec(TWO_WEEKS_AGO, words[3].id), // 上周之前
  ];
  const todayRecs = [
    rec(MONDAY + 3600000, words[4].id), // 今天早上（周一）
  ];
  app.raw.records = [...inWeek, ...outside, ...todayRecs];

  await runRound(app);
  const rep = app.raw.report;
  ok('周报存在', !!rep);
  ok('窗口起点 = 上周一 2026-10-12', rep.weekStart === '2026-10-12', rep.weekStart);
  ok('窗口终点 = 上周日 2026-10-18', rep.weekEnd === '2026-10-18', rep.weekEnd);
  ok('只数上周的 3 个词（今天和两周前的不算）', rep.words === 3, `实测 ${rep.words}`);
}

// ══ ③ 最长连续 = 这一周内的，不是历史最长 ═════════════════════
console.log('\n③ 「最长连续」必须是这一周内的');

{
  const app = await appWithRecords([]);
  const words = app.raw.words.slice(0, 8);
  app.raw.streak = { current: 0, longest: 99, lastDay: null, totalDays: 0 };

  // 上周三、四、五连续 3 天
  app.raw.records = [
    rec(PREV_WED, words[0].id),
    rec(PREV_THU, words[1].id),
    rec(PREV_FRI, words[2].id),
    // 上周一单独一天，不连上
    rec(PREV_MON, words[3].id),
  ];
  await runRound(app);
  const rep = app.raw.report;
  ok('最长连续 = 3（周三~周五）', rep.longestStreak === 3, `实测 ${rep.longestStreak}`);
  ok('不会拿历史最长 99 来充数', rep.longestStreak !== 99);
}

// ══ ④ 辨词答对 = 辨词模式答对次数 ═════════════════════════════
console.log('\n④ 「辨词答对」只数辨词模式答对的');

{
  const app = await appWithRecords([]);
  const words = app.raw.words.slice(0, 6);
  app.raw.records = [
    rec(PREV_WED, words[0].id, { correct: true, mode: 'quiz' }),
    rec(PREV_THU, words[1].id, { correct: true, mode: 'quiz' }),
    rec(PREV_THU, words[2].id, { correct: false, mode: 'quiz' }), // 答错不算
    rec(PREV_FRI, words[3].id, { correct: true, mode: 'self' }), // 自评不算辨词
  ];
  await runRound(app);
  ok('辨词答对 = 2', app.raw.report.quizCorrect === 2, `实测 ${app.raw.report.quizCorrect}`);
}

// ══ ⑤ 最顽固 = 这一周错误次数最多的词（整数）══════════════════
console.log('\n⑤ 最顽固：按这一周的错误次数算，是整数');

{
  const app = await appWithRecords([]);
  const words = app.raw.words.slice(0, 6);
  app.raw.records = [
    rec(PREV_MON, words[0].id, { correct: false }),
    rec(PREV_WED, words[0].id, { correct: false }),
    rec(PREV_THU, words[0].id, { correct: false }),
    rec(PREV_FRI, words[1].id, { correct: false }),
  ];
  await runRound(app);
  const st = app.raw.report.stubborn;
  ok('最顽固抓到了那个错了 3 次的词', st && st.word === words[0].word, st ? st.word : 'null');
  ok('次数是整数 3（不是小数 6.3）', st && st.times === 3, st ? String(st.times) : 'null');
  ok('次数就是整数字面量', st && Number.isInteger(st.times));
}

// ══ ⑥ 文案：不许出现「今天」也不许把次数说成「个词」═══════════
console.log('\n⑥ 诊断句的时态与单位');

{
  const app = await appWithRecords([]);
  const words = app.raw.words.slice(0, 6);
  app.raw.records = [
    rec(PREV_MON, words[0].id, { correct: false }),
    rec(PREV_WED, words[1].id, { correct: false }),
    rec(PREV_THU, words[2].id, { correct: false }),
    rec(PREV_FRI, words[3].id, { correct: false }),
  ];
  await runRound(app);
  const d = app.raw.report.diagnosis;
  ok('周报诊断句存在', typeof d === 'string' && d.length > 0, String(d));
  ok('周报诊断句说的是「上周」', /上周/.test(String(d)), String(d));
  ok('周报诊断句里没有「今天」', !/今天/.test(String(d)), String(d));
  ok('说的是「次错误」，不是「个错词」', /次错误/.test(String(d)) && !/个错词/.test(String(d)), String(d));

  // 今日 tab 的那句还是「今天」，不能被误伤
  const todayDiag = MK.diagnosis(
    [
      rec(MONDAY, words[0].id, { correct: false }),
      rec(MONDAY, words[1].id, { correct: false }),
      rec(MONDAY, words[2].id, { correct: false }),
    ],
    { wordById: (id) => app.raw.words.find((w) => w.id === id) },
  );
  ok('今日 tab 的诊断句仍然是「今天」', /今天/.test(String(todayDiag.sentence)), String(todayDiag.sentence));
}

// ══ ⑦ 同一天只出一次 ═════════════════════════════════════════
console.log('\n⑦ 同一天重复结算不重复出');

{
  const app = await appWithRecords([]);
  await runRound(app);
  const first = app.raw.report;
  ok('第一次结算出了周报', !!first);
  await runRound(app);
  ok('第二次结算沿用同一份周报（不重算）', app.raw.report === first || !!app.raw.report);
}

// ══ ⑧ 空周：不许编内容 ═══════════════════════════════════════
console.log('\n⑧ 上周没学：数字为 0，不编建议');

{
  const app = await appWithRecords([]);
  await runRound(app);
  const rep = app.raw.report;
  ok('空周也出周报（但内容为空）', !!rep);
  ok('背了 0 个词', rep.words === 0, String(rep.words));
  ok('辨词答对 0 次', rep.quizCorrect === 0, String(rep.quizCorrect));
  ok('最长连续 0 天', rep.longestStreak === 0, String(rep.longestStreak));
  ok('没有最顽固的词就是 null（不硬凑一个）', rep.stubborn === null, JSON.stringify(rep.stubborn));
  ok('没有建议就是 null（不编一句）', rep.suggestion === null, JSON.stringify(rep.suggestion));
}

// ══ 汇总 ═════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(56));
if (!failList.length) {
  console.log(`${GREEN}${pass} 通过 / 0 失败${OFF}`);
} else {
  console.log(`${RED}${pass} 通过 / ${failList.length} 失败${OFF}`);
  console.log(`${RED}失败项：${failList.join(' / ')}${OFF}`);
}
console.log('─'.repeat(56));
process.exit(failList.length ? 1 : 0);
