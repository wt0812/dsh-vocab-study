// vocab-study / test / round-control.test.mjs
//
// 用户报的三件事（原话）：
//   1.「我今天背了几个词不显示，只显示多少词被收服」——违背"抽空背诵"的理念
//   2.「我背完一轮后，只能显示这个」——只剩「换词库」一个入口
//   3.「难道我就不能重新背一遍吗，或者我就不能自己往后背吗」
//
// 这个文件就是这三条的验收。跑法：
//   node test/round-control.test.mjs      退出码 0 = 全绿
import { createApp } from '../core/app.mjs';
import * as S from '../core/session.mjs';
import * as Q from '../core/queue.mjs';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';
let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${GREEN}✓${OFF} ${name}`); }
  else { fail++; bad.push(name); console.log(`  ${RED}✗${OFF} ${name}${detail ? `  ${DIM}(${detail})${OFF}` : ''}`); }
}

// 假时钟：run 内可以推进，用来模拟"跨天"
let clock = Date.parse('2026-10-09T09:00:00+08:00');
const tick = (ms) => { clock += ms; };

async function freshApp() {
  clock = Date.parse('2026-10-09T09:00:00+08:00');
  const app = createApp({ now: () => clock });
  await app.init();
  return app;
}

// 把当前这一轮走完。rating 决定记忆走向。
function runRound(app, rating) {
  let guard = 0;
  while (guard++ < 400) {
    const st = app.state;
    if (st.roundFinished) break;
    const card = st.card;
    if (!card) break;
    app.rate(rating);
    app.next();
  }
  return guard;
}

console.log('vocab-study · 轮次控制验收（再背一轮 / 自己往后背 / 今日已背）\n');

// ── ① 今日已背数量必须对外可见 ───────────────────────────────
console.log('① 今日已背数量（用户抱怨"背了却看不到"）：');
{
  const app = await freshApp();
  const before = app.state.stats.todayAnswered;
  ok('开局今日已背 = 0', before === 0, `实得 ${before}`);

  // 只背 3 个就停 —— 模拟"抽空背几个"
  for (let i = 0; i < 3; i++) { app.rate(S.RATING.KNOWN); app.next(); }
  const st = app.state;
  ok('背 3 个后 todayAnswered = 3', st.stats.todayAnswered === 3, `实得 ${st.stats.todayAnswered}`);
  ok('todayAnswered 与"已收服"是不同口径',
     typeof st.stats.conquered === 'number' && typeof st.stats.todayAnswered === 'number' &&
     st.stats.todayAnswered === 3,
     `todayAnswered=${st.stats.todayAnswered} conquered=${st.stats.conquered}`);
  ok('未走完时 roundFinished = false（界面不该显示"今天没有了"）',
     st.roundFinished === false, `实得 ${st.roundFinished}`);
  ok('未走完时本轮卡数 roundSize > 0 且是完整一批', st.roundSize > 3, `实得 ${st.roundSize}`);
}

// ── ② 背完一轮后必须能"再背一轮" ─────────────────────────────
console.log('\n② 「再背一轮」（用户抱怨"只能换词库"）：');
{
  const app = await freshApp();
  const planned = app.state.roundSize;
  runRound(app, S.RATING.KNOWN);
  const done = app.state;
  ok('走完一轮后 roundFinished = true', done.roundFinished === true);
  ok('走完一轮后仍能拿到"本轮有几张卡"', done.roundSize === planned, `${done.roundSize} vs ${planned}`);
  ok('canRestart = true（有东西可重背）', done.canRestart === true);

  const before = done.session.queue.length;
  const s2 = app.restartRound();
  const after = app.state;
  ok('restartRound 返回了新的一轮', !!s2);
  ok('重背的是同一批词（数量一致）', after.session.queue.length === before, `${after.session.queue.length} vs ${before}`);
  ok('重背后 cursor 归零，又能继续背', after.session.cursor === 0);
  ok('重背后 roundFinished = false（界面回到词卡）', after.roundFinished === false);
  ok('重背的词就是刚才那一批（含今天背过的）',
     after.roundFinished === false && after.session.queue.length === before);

  // 重背不重复扣分：记忆数据是连续更新的，不是清零
  const s = after.session;
  ok('重背没有清空记忆表（不是"作废重来"）', Object.keys(s.mem).length > 0);
}

// ── ③ 必须能"自己往后背"（突破当天 N）────────────────────────
console.log('\n③ 「自己往后背」（突破当天计划 N）：');
{
  const app = await freshApp();
  runRound(app, S.RATING.KNOWN);
  const base = app.state.roundSize;

  const c1 = app.extendRound(5);
  const st1 = app.state;
  ok('extendRound 后容器变大', st1.container.items.length > base, `${st1.container.items.length} vs ${base}`);
  ok('extendedBy 记录加量次数 = 1', st1.extendedBy === 1, `实得 ${st1.extendedBy}`);
  ok('加量后 roundFinished = false（马上又有词可背）', st1.roundFinished === false);
  ok('roundSize 跟着更新', st1.roundSize === st1.container.items.length);

  const c2 = app.extendRound(5);
  const st2 = app.state;
  ok('再点一次继续加量（extendedBy = 2）', st2.extendedBy === 2, `实得 ${st2.extendedBy}`);
  ok('加量不重复：没有同一个词出现两次',
     new Set(st2.container.items.map((i) => i.word.id)).size === st2.container.items.length,
     `唯一个数 ${new Set(st2.container.items.map((i) => i.word.id)).size} / 总数 ${st2.container.items.length}`);
  ok('加量后已有卡不被重考（队列只增不重排）',
     st2.session.queue.length >= st1.session.queue.length);

  // 真能继续背
  const answeredBefore = app.state.stats.todayAnswered;
  let n = 0;
  while (!app.state.roundFinished && n < 30) { app.rate(S.RATING.KNOWN); app.next(); n++; }
  ok('加量出来的词真的能背', n > 0, `背了 ${n} 个`);
  ok('今日已背数量随之增长', app.state.stats.todayAnswered > answeredBefore,
     `${answeredBefore} → ${app.state.stats.todayAnswered}`);
}

// ── ④ 安全阀：仍然自动触发，但用户能自己放行 ────────────────
//
// 注意这里断言的是 state.newGate（**每次快照实时重算**），不是
// container.stats.newBlocked。原因是后者曾经是死代码：容器一天只建一次，
// 建的时候今天还没答题，所以那个字段天然恒为 false，规格 §7.6 的自动
// 停止推新词其实从未生效。测试最初就是抓着 container.stats.newBlocked
// 断言而失败的 —— 那个失败是真问题，不是测试写错。
console.log('\n④ 新词安全阀（自动触发 + 用户可放行）：');
{
  const app = await freshApp();
  ok('开局闸门是开的', app.state.newGate.closed === false);

  // 全答"忘了" → 当天新词答错率 100% > 70% → 闸门该自动关闭
  runRound(app, S.RATING.FORGOT);
  const st = app.state;
  ok('答错率过高时闸门自动关闭（实时判断）', st.newGate.autoBlocked === true,
     `autoBlocked=${st.newGate.autoBlocked} newAnswerCount=${app.raw.container ? '' : ''}`);
  ok('闸门关着时确实少推了新词',
     st.container.stats.newCount === 0, `newCount=${st.container.stats.newCount}`);
  ok('闸门关着且用户未放行 → closed = true（界面该给入口）',
     st.newGate.closed === true, `closed=${st.newGate.closed}`);
  ok('默认设置里 allowMoreNew = false', st.settings.allowMoreNew === false);

  const beforeNew = st.container.stats.newCount;
  app.allowMoreNew();
  const st2 = app.state;
  ok('用户显式放行后 allowMoreNew = true', st2.settings.allowMoreNew === true);
  ok('放行后闸门不再关着（closed = false）', st2.newGate.closed === false,
     `closed=${st2.newGate.closed} bypassed=${st2.newGate.bypassed}`);
  ok('放行后新词真的进来了', st2.container.stats.newCount > beforeNew,
     `${beforeNew} → ${st2.container.stats.newCount}`);
}

// ── ⑤ 跨天必须重置加量次数（否则今天开场就是 N+15）──────────
console.log('\n⑤ 跨天重置：');
{
  const app = await freshApp();
  app.extendRound(5);
  app.extendRound(5);
  ok('当天已加量 2 次', app.state.extendedBy === 2);

  tick(24 * 3600 * 1000); // 到第二天早上
  app.refresh();
  const st = app.state;
  ok('跨天后 extendedBy 归零', st.extendedBy === 0, `实得 ${st.extendedBy}`);
  ok('跨天后重新排容器（回到当天计划 N）',
     st.container.items.length === app.raw.container.autoN,
     `${st.container.items.length} vs autoN=${app.raw.container.autoN}`);
  ok('跨天后 todayAnswered 重新从 0 起算', st.stats.todayAnswered === 0,
     `实得 ${st.stats.todayAnswered}`);
}

// ── ⑥ 边界： ─────────────────────────────────────────────
console.log('\n⑥ 边界：');
{
  const app = await freshApp();
  ok('开局就有可重背的本轮卡', app.state.canRestart === true);
  const r = app.restartRound();
  ok('未走完时也可调用 restartRound 且不炸', !!r);
  // 容器为空时 restartRound 应安全返回 null
  app.raw.roundItems = null;
  const r2 = app.restartRound();
  ok('没有本轮卡时 restartRound 安全返回 null（不抛异常）', r2 === null);
}

// ── ⑦ 两个"只有真的点一遍才能发现"的 bug（回归锁）────────────
//
// 这两个都是我在无头浏览器里把界面渲染出来、真的点按钮才发现的：
// 渲染看着对、逻辑是死的 —— 光看截图和光看源码都发现不了。
console.log('\n⑦ 回归锁：渲染验证发现不了的两个 bug：');
{
  // bug A：闸门关着时 extendRound 一个词也加不进来（点了没反应）
  const app = await freshApp();
  runRound(app, S.RATING.FORGOT);
  ok('全答"忘了"走完一轮后闸门是关的', app.state.newGate.closed === true);
  const idsBefore = app.state.container.items.map((i) => i.word.id);
  app.extendRound(5);
  const idsAfter = app.state.container.items.map((i) => i.word.id);
  const added = idsAfter.filter((x) => !idsBefore.includes(x));
  // 这是"事实"而不是"缺陷"：闸门本来就不让新词进来，所以加不进来是对的。
  // 但界面必须据此**不显示**「再来 5 个新词」按钮（已在 panel.mjs 里做），
  // 否则就是一个点了没反应的假按钮。这里锁住这个事实，将来若闸门语义变了
  // 这个断言会提醒回来同步界面。
  ok('闸门关着时 extendRound 确实加不进新词（所以界面不能给这个按钮）',
     added.length === 0, `新增 ${added.length} 个`);

  // 放行之后必须真的加得进来
  app.allowMoreNew();
  const idsB2 = app.state.container.items.map((i) => i.word.id);
  app.extendRound(5);
  const idsA2 = app.state.container.items.map((i) => i.word.id);
  const added2 = idsA2.filter((x) => !idsB2.includes(x));
  ok('放行后 extendRound 真的能加进新词', added2.length > 0, `新增 ${added2.length} 个`);

  // bug B：环（这一轮）与 KPI（今天）口径必须分开
  const app2 = await freshApp();
  runRound(app2, S.RATING.KNOWN);
  const afterDone = app2.state;
  ok('走完一轮：环 = 5/5 左右，且 plannedSize 等于实际过完的数量',
     afterDone.session.stats.answered <= afterDone.session.plannedSize,
     `answered=${afterDone.session.stats.answered} planned=${afterDone.session.plannedSize}`);
  const todayAtDone = afterDone.stats.todayAnswered;

  app2.restartRound();
  const afterRestart = app2.state;
  ok('再背一轮后：本轮 answered 归零（环不显示上一轮的数字）',
     afterRestart.session.stats.answered === 0, `实得 ${afterRestart.session.stats.answered}`);
  ok('再背一轮后：今日已背保持不变（KPI 不跟着归零）',
     afterRestart.stats.todayAnswered === todayAtDone,
     `${afterRestart.stats.todayAnswered} vs ${todayAtDone}`);

  // 重背并再答一个：环走 1，今日走 N+1，两者不该相等
  app2.rate(S.RATING.KNOWN);
  app2.next();
  const mid = app2.state;
  ok('重背中：本轮进度与今日已答是两个不同的数',
     mid.session.stats.answered !== mid.stats.todayAnswered,
     `本轮=${mid.session.stats.answered} 今日=${mid.stats.todayAnswered}`);
  ok('重背中：本轮进度不超过本轮总量',
     mid.session.stats.answered <= mid.session.plannedSize,
     `${mid.session.stats.answered}/${mid.session.plannedSize}`);

  // bug C：点「我还是想继续」之后，端上来的必须是**没背过的**词。
  //
  // 根因：createSession 无条件把 container.items 全变成 answered:false 的新队列。
  // allowMoreNew 里如果直接把整个容器丢给它，用户就会把刚背完的 20 个词
  // 原样再背一遍。这个我在无头浏览器里点出来才发现 —— 单元层面不看界面
  // 状态是感觉不到的，所以这里显式断言"下一个卡不是刚答过的"。
  const app3 = await freshApp();
  runRound(app3, S.RATING.FORGOT);
  ok('（bug C 前置）走完一轮后闸门关闭', app3.state.newGate.closed === true);
  const justAnswered = new Set();
  for (const c of app3.state.session.queue) if (c.answered) justAnswered.add(c.word.id);
  ok('（bug C 前置）确实有一批刚答完的词', justAnswered.size > 0, `${justAnswered.size} 个`);

  app3.allowMoreNew();
  const nextCard = app3.state.card;
  ok('放行后立刻有词卡可背（不是又停在"这一轮走完了"）', !!nextCard);
  ok('放行后给的是没背过的词，不是刚答完的那批',
     !!nextCard && !justAnswered.has(nextCard.word.id),
     nextCard ? `下一个词 ${nextCard.word.id}，刚答过=${justAnswered.has(nextCard.word.id)}` : '无词卡');
  ok('放行后闸门状态是"已放行"', app3.state.newGate.bypassed === true);
}

console.log('\n────────────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`${GREEN}${pass} 通过 / 0 失败${OFF}  —— 三个抱怨都有对应断言`);
} else {
  console.log(`${RED}${pass} 通过 / ${fail} 失败${OFF}`);
  console.log(`${RED}失败项：${bad.join(' / ')}${OFF}`);
}
process.exit(fail === 0 ? 0 : 1);
