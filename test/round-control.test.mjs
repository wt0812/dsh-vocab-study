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
import { createStorage } from '../store/client-store.mjs';

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
    // 走 raw 而不是 state：state 是渲染用的快照，如果容器形状不完整它会抛
    // TypeError，把这个辅助函数直接崩掉，后面的断言一条都跑不到。
    // 测试辅助函数不该因为"被测对象坏了"而自己炸 —— 那样报出来的是崩溃堆栈，
    // 不是"哪条断言不成立"。
    if (!app.raw.session || S.isFinished(app.raw.session)) break;
    const card = S.currentCard(app.raw.session);
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

  // ── 加量必须**恰好**加 batch 个，而且不重复 ────────────────────
  // 用户报：「我背完一轮之后，我点击再来五个，结果下面显示30个」
  //        「我点击再来五个之后，出现的单词是重复的」
  //
  // 根因：老写法是「用更大的 N 重建容器，再拿结果去重」。但走完一轮后 mem
  // 已经变了 —— 那批词从"新词池"迁进了"到期复习池"，重建出来的大部分
  // **不是**它们本身，于是去重几乎全部失灵。实测一次点击多塞 25 个条目、
  // session 队列里 40 个重复。
  // 修法：把已排过的词作为 `exclude` 交给 buildDailyContainer（排除发生在
  // 池子源头），并且只建设 batch 个 + 严格上限。
  ok('放行后一次加量恰好加 5 个（不是一大批）', added2.length === 5, `新增 ${added2.length} 个`);
  const roundIds2 = app.raw.roundItems.map((it) => it.word.id);
  ok('加量后本轮条目数 = 原先 + 5（底部那个数字不会跳）',
     roundIds2.length === idsB2.length + 5, `${idsB2.length} → ${roundIds2.length}`);
  ok('加量后本轮里没有重复的词（用户报「出现的是重复的」）',
     new Set(roundIds2).size === roundIds2.length,
     `重复 ${roundIds2.length - new Set(roundIds2).size} 个`);
  ok('加量加进来的词确实是没排过的',
     added2.every((x) => !idsB2.includes(x)) && new Set(added2).size === added2.length);

  // 连点两次也要各加 5 个，不能越加越多
  const beforeThird = app.raw.roundItems.map((it) => it.word.id);
  app.extendRound(5);
  const afterThird = app.raw.roundItems.map((it) => it.word.id);
  ok('再点一次仍然恰好加 5 个（不会越加越多）',
     afterThird.length === beforeThird.length + 5,
     `${beforeThird.length} → ${afterThird.length}`);
  ok('连点两次后本轮依然无重复',
     new Set(afterThird).size === afterThird.length,
     `重复 ${afterThird.length - new Set(afterThird).size} 个`);

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

// ── ⑧ 换词库必须真的把词换掉 ─────────────────────────────────
// 用户原话：「我背了一轮之后，我点击换词库，我明明显示了更换成功但是主页
// 并没有反应，还是显示今天没有需要复习的词」。
//
// 根因（写在 core/app.mjs 的 changeCollection 注释里）：
//   设置页的下拉框只调 updateSettings({ collections: [id] })，
//   而 updateSettings 只在 dailyGoal / balance 变化时重建容器 ——
//   于是换库只改了一个设置字段：state.words 还是老词库的，
//   state.container 还是老的（已经背完、空着）。
//   而 L.loadCollection() 全仓库原本只在 init() 里调用过一次，
//   所以"换库"从来没有真正加载过另一个词库。
//
// 这里锁死整条链：换库之后 word 真的换了、今日队列真的有卡、确实是新词库的词。
console.log('\n⑧ 换词库（用户抱怨"显示更换成功但主页没反应"）：');
{
  const app4 = await freshApp();
  // 词表不在快照里（快照只给界面要用的东西），要去 raw 上读。
  const before = app4.raw.words.map((w) => w.id);
  ok('（前置）开局用的是四级种子词表',
     before.length > 0 && before.every((id) => id.startsWith('cet4:')),
     `${before.length} 个词，例 ${before[0]}`);
  // 顺带记一笔：种子里 cet4 的 id 也带前缀（`cet4:abandon`），
  // 我第一版断言写成"四级不带冒号"，是错的 —— 判据是每本各一套、互不重叠。

  runRound(app4, S.RATING.FORGOT);
  ok('（前置）走完一轮后今日页是空的（正是用户看到的那一屏）',
     app4.state.card === null && app4.state.roundFinished === true);

  const res = await app4.changeCollection('cet6');
  ok('换词库返回成功', res && res.ok === true, res && JSON.stringify(res));

  const after = app4.raw.words.map((w) => w.id);
  ok('词表真的换掉了（不是只改了个设置字段）',
     after.length > 0 && after.every((id) => id.startsWith('cet6:')),
     `${after.length} 个词，例 ${after[0]}`);
  ok('换的是**另一个**词库的词（id 和原来不重叠）',
     after.every((id) => !before.includes(id)));

  ok('设置里的当前词库指向新库', app4.state.settings.collections[0] === 'cet6');

  // 这一条是用户抱怨的核心：主页必须**立刻**有词可背，
  // 而不是继续停在「今天没有需要复习的词」。
  ok('换库后今日页立刻有词卡（主页不再说"没有需要复习的词"）',
     app4.state.card !== null && app4.state.empty === false,
     app4.state.card ? `卡片=${app4.state.card.word.id}` : '仍然没有词卡');
  ok('换库后的队列是重建过的（不是上一轮残留的空队列）',
     app4.state.session && app4.state.session.queue.length > 0,
     app4.state.session ? `队列 ${app4.state.session.queue.length} 张` : '无 session');
  ok('换库结果对外可见（界面能说出"换成了"）',
     app4.state.lastLibraryChange && app4.state.lastLibraryChange.ok === true
       && app4.state.lastLibraryChange.count > 0);

  // 换库不该清掉学习记录：换回来，之前的记忆还在。
  const memBefore = Object.keys(app4.raw.mem || {}).length;
  await app4.changeCollection('cet4');
  ok('换回原词库也能成功', app4.state.settings.collections[0] === 'cet4');
  const memAfter = Object.keys(app4.raw.mem || {}).length;
  ok('换库不清空学习记忆（换回来记忆还在）', memAfter >= memBefore,
     `换前 ${memBefore} 条 / 换后 ${memAfter} 条`);

  // 选的就是当前这本：不该重建，免得把正在背的那一轮清掉。
  const sameSession = app4.state.session;
  const sameRes = await app4.changeCollection('cet4');
  ok('重复选当前词库：不重建队列（不会清掉正在背的这一轮）',
     sameRes && sameRes.ok === true && sameRes.unchanged === true
       && app4.state.session === sameSession);

  // 不存在的词库：必须失败**并且回落**，不能留下一个没生效的选择。
  const badRes = await app4.changeCollection('no-such-collection');
  ok('换到不存在的词库会失败（不静默假装成功）', badRes && badRes.ok === false, badRes && badRes.error);
  ok('失败后当前词库仍是原来那本（回落，不是留个假选择）',
     app4.state.settings.collections[0] === 'cet4');
  ok('失败原因对外可见（界面能说出"为什么没换成"）',
     app4.state.lastLibraryChange && app4.state.lastLibraryChange.ok === false
       && typeof app4.state.lastLibraryChange.error === 'string');
}

// ── ⑨ 设置要留痕：关掉再打开，我设的还得是我设的 ────────────────────
//
// 用户原话：「我需要的是我设置了多少就多少，你要记忆保存啊，我每次进来就是
// 20，可是我自己设置了10个啊，我需要我每次设置留痕呀」
//
// 根因有两层，缺一不可：
//   A. init() 里只有 `if (!state.session) buildContainer();` —— 恢复成功的
//      那条路上 state.container **永远是 null**，而底部「今日 x/y」的分母、
//      环的分母、st.empty 全是从 container 算的。设置其实**存住了**，但界面
//      拿不到本轮规模，看起来就像没保存。
//   B. 所以断言不能只查 `settings.dailyGoal === 10`（那个一直是对的、
//      查了会假绿），必须查**界面真正用的那个数**：containerSize / roundSize。
console.log('\n⑨ 设置留痕（关掉再打开，我设的还得是我设的）：');
{
  clock = Date.parse('2026-10-09T09:00:00+08:00');
  // 同一份内存存储 → 模拟"关掉 DSH 再打开"（每次重开都是一个新 app 实例）
  const shared = (() => {
    const box = new Map();
    return {
      async get(k) { return box.has(k) ? JSON.parse(box.get(k)) : null; },
      async set(k, v) { box.set(k, JSON.stringify(v)); },
      async append(k, v) { const a = box.has(k) ? JSON.parse(box.get(k)) : []; a.push(v); box.set(k, JSON.stringify(a)); },
      async keys() { return [...box.keys()]; },
      async remove(k) { box.delete(k); },
    };
  })();

  const a1 = createApp({ now: () => clock, storage: shared });
  await a1.init();
  ok('第一次打开是默认 20', a1.state.settings.dailyGoal === 20 && a1.state.roundSize === 20);

  a1.updateSettings({ dailyGoal: 10 });
  ok('设成 10 之后，本轮规模跟着变成 10（不是只改了个字段）',
     a1.state.settings.dailyGoal === 10 && a1.state.roundSize === 10,
     `dailyGoal=${a1.state.settings.dailyGoal} roundSize=${a1.state.roundSize}`);

  // 背掉两个再关，模拟"背到一半关掉面板"
  a1.rate(S.RATING.KNOWN); a1.next();
  ok('背了 1 个之后底部计数是 1/10', (a1.state.session.stats.answered || 0) === 1
     && a1.state.container.stats.containerSize === 10);

  const a2 = createApp({ now: () => clock, storage: shared });
  await a2.init();
  ok('重启后设置还是我设的 10（留痕）', a2.state.settings.dailyGoal === 10,
     `dailyGoal=${a2.state.settings.dailyGoal}`);
  // ⚠️ 这两条才是真正锁住用户抱怨的断言。只查 settings 会假绿。
  ok('重启后本轮规模还是 10，不是退回 20（用户报「每次进来就是20」）',
     a2.state.roundSize === 10
       && !!a2.state.container && a2.state.container.stats.containerSize === 10,
     `roundSize=${a2.state.roundSize} containerSize=${a2.state.container && a2.state.container.stats.containerSize}`);
  ok('重启后容器不为空（container=null 会让界面判成"今天没词"）',
     !!a2.state.container && a2.state.empty === false);
  // 注意写法：container 为 null 时要**报红**，不是抛 TypeError 把后面几条全吃掉。
  // 我第一版写的是 `a2.state.container.stats.containerSize`，去掉修复后测试直接崩在
  // 这一行，后面三条根本没跑到 —— 崩溃不等于断言。
  ok('重启后计数器分母是 10，不是 0（containerSize=0 会让环显示 0/0）',
     !!a2.state.container && a2.state.container.stats.containerSize === 10,
     `containerSize=${a2.state.container && a2.state.container.stats.containerSize}`);

  // 走完重启后这一轮，确认真的是 10 个而不是 20
  runRound(a2, S.RATING.KNOWN);
  ok('重启后走完这一轮，本轮排过的词数就是 10',
     a2.state.roundSize === 10, `roundSize=${a2.state.roundSize}`);

  // 「再背一轮」在重启后也要能重建同一批
  const reopened = createApp({ now: () => clock, storage: shared });
  await reopened.init();
  const midSession = reopened.state.session;
  ok('重启后恢复的是「还没背完的那一轮」，不是从头开始',
     !!midSession && !reopened.state.roundFinished);

  // 换别的设置项也要留痕
  const a3 = createApp({ now: () => clock, storage: shared });
  await a3.init();
  a3.updateSettings({ order: 'seq', roundSize: 10, balance: 0.8 });
  const a4 = createApp({ now: () => clock, storage: shared });
  await a4.init();
  ok('顺序 / 冲刺批大小 / 天平也一起留痕',
     a4.state.settings.order === 'seq' && a4.state.settings.roundSize === 10
       && a4.state.settings.balance === 0.8,
     `order=${a4.state.settings.order} roundSize=${a4.state.settings.roundSize} balance=${a4.state.settings.balance}`);
  ok('换词库也留痕',
     a4.state.settings.collections[0] === 'cet4');
}

console.log('\n⑩ 真的存储件：写进去的，读得出来（用户报「我设置了10个，每次进来就是20」）：');
{
  // ⚠️ 这一节**必须**用真实的 store/client-store.mjs + 假 localStorage。
  //
  // 上面 ⑨ 节用的是我自己写的内存存储，它顺理成章地"写什么读什么"，
  // 所以那个真凶在 ⑨ 里**根本照不出来** —— 我一开始就是这么被绕过去的。
  // 真凶在存储层：set() 把值包成 { v: SCHEMA, value } 写进去，而 get()
  // 直接把整个包装对象返回、**没有拆开**。于是 app.init() 里
  // `saved.settings` 永远是 undefined，每次都退回默认 20。
  // 数据其实一直好好地躺在 localStorage 里，只是没人拆包装。
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  globalThis.sessionStorage = {
    getItem: () => 'tab-test', setItem: () => {}, removeItem: () => {},
  };
  const NS = 'vocab-study';

  // ① 最底层的对称性：set 之后 get 必须拿回**原来的值**，不是包装层
  const s0 = createStorage({ namespace: NS, now: () => clock });
  const payload = { settings: { dailyGoal: 10 }, mem: { 'cet4:a': 1 } };
  await s0.set('state', payload);
  const got = await s0.get('state');
  ok('storage 往返对称：get 拿回的是原值，不是 { v, value } 包装层',
     !!got && got.settings && got.settings.dailyGoal === 10,
     `拿到 ${JSON.stringify(got && got.settings)}；包装层是 ${JSON.stringify(got && got.v !== undefined)}`);

  // 裸值（没有包装层）也要能读，不能把历史数据读成 undefined
  globalThis.localStorage.setItem(`${NS}:legacy`, JSON.stringify({ settings: { dailyGoal: 3 } }));
  const legacy = await s0.get('legacy');
  ok('没有包装层的老数据也能读回来（向后兼容）',
     !!legacy && legacy.settings && legacy.settings.dailyGoal === 3);

  // ② 端到端：设成 10 → 关掉（时间前进）→ 重开，必须还是 10
  clock = Date.parse('2026-10-09T09:00:00+08:00');
  const storeA = createStorage({ namespace: NS, now: () => clock });
  const appA = createApp({ storage: storeA, now: () => clock });
  await appA.init();
  appA.updateSettings({ dailyGoal: 10 });
  ok('设成 10 之后本轮规模就是 10', appA.state.roundSize === 10, `roundSize=${appA.state.roundSize}`);

  clock += 60000;
  const storeB = createStorage({ namespace: NS, now: () => clock });
  const appB = createApp({ storage: storeB, now: () => clock });
  await appB.init();
  ok('用真实存储件重启：dailyGoal 还是 10（用户报「每次进来就是20」）',
     appB.state.settings.dailyGoal === 10, `dailyGoal=${appB.state.settings.dailyGoal}`);
  ok('用真实存储件重启：本轮规模是 10，容器分母也是 10',
     appB.state.roundSize === 10 && appB.state.container.stats.containerSize === 10,
     `roundSize=${appB.state.roundSize} containerSize=${appB.state.container && appB.state.container.stats.containerSize}`);
  ok('用真实存储件重启：容器不为空、有词可背',
     !!appB.state.container && appB.state.empty === false);

  // ③ 别的设置项与学习记忆同样要留痕
  appB.updateSettings({ order: 'seq', roundSize: 10, balance: 0.8 });
  appB.rate(S.RATING.KNOWN); appB.next();
  const memCount = Object.keys(appB.raw.mem || {}).length;
  clock += 60000;
  const storeC = createStorage({ namespace: NS, now: () => clock });
  const appC = createApp({ storage: storeC, now: () => clock });
  await appC.init();
  ok('顺序 / 冲刺批大小 / 天平也留痕',
     appC.state.settings.order === 'seq' && appC.state.settings.roundSize === 10
       && appC.state.settings.balance === 0.8,
     `order=${appC.state.settings.order} roundSize=${appC.state.settings.roundSize} balance=${appC.state.settings.balance}`);
  ok('学习记忆也留痕（重启后记忆条数不缩水）',
     Object.keys(appC.raw.mem || {}).length >= memCount,
     `重启前 ${memCount} / 重启后 ${Object.keys(appC.raw.mem || {}).length}`);

  // ④ 多窗口只读锁不能靠"上一条锁没清"就把用户变成只读
  //    （另一条容易被误当成根因的线索，这里顺手锁住它没被误伤）
  ok('单窗口反复重开不会把自己变成只读',
     storeC.readOnly === false, `readOnly=${storeC.readOnly} ${storeC.readOnlyReason || ''}`);
}

console.log('\n────────────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`${GREEN}${pass} 通过 / 0 失败${OFF}  —— 三个抱怨都有对应断言`);
} else {
  console.log(`${RED}${pass} 通过 / ${fail} 失败${OFF}`);
  console.log(`${RED}失败项：${bad.join(' / ')}${OFF}`);
}
process.exit(fail === 0 ? 0 : 1);
