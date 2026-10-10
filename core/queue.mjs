// vocab-study / core / queue.mjs
// 三层优先级组队 + 日容器切片 + DP 的「预算内最优子集」。
//
// 规格 §6.3 / §6.6 的两条硬约束都落在这个文件里：
//   1. 预算 20 词是铁律（N），没人能挤占；
//   2. 到期词只切片、不汇总 —— 「欠你 200 个」这句话永远不会被构造出来。

import * as M from './memory.mjs';
import { DAY_MS } from './memory.mjs';

// DAY_MS 由 memory.mjs 提供：ESM 形态下经 import 拿到，单文件形态下同处一个作用域。
/** 一天的分界点：凌晨 4:00（规格 §7.3），避免熬夜学习被劈成两天。 */
export const DAY_START_HOUR = 4;

/** 按 4:00 切分的学习日标识，形如 2026-02-14。 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts - DAY_START_HOUR * 3600000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 某天 4:00 的时间戳。 */
export function dayStartTs(ts = Date.now()) {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR, 0, 0, 0).getTime();
  return start > ts ? start - DAY_MS : start;
}

/** 两个 dayKey 之间差几天（只用于「连续多少天没学」这类温和判断）。 */
export function daysBetweenKeys(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((tb - ta) / DAY_MS);
}

export function priorDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - DAY_MS;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// 新词出场顺序：随机，但**同一天内稳定**
// ─────────────────────────────────────────────────────────────
//
// 以前新词严格按词库顺序（也就是字母序）出：abandon → abundant → abolish …
// 结果是每天翻开都是「ab-」开头，背了三天还在 a 里打转，前面记熟的词反复
// 占位、后面 b/c/d… 永远轮不到。用户要的是随机。
//
// 但**不能每次翻开都重掷**，否则违反规格 §7.2 / §540：
//     「08:52 回到面板 → 队列从第 6 词继续（新词保序）」
// 每次重掷的话，第 6 词会变成另一个词，"接着背"就不成立了。
//
// 解法：**带种子的洗牌**。种子固定（默认用 dayKey），于是
//   · 对用户来说顺序是乱的（不是字母序）
//   · 同一天内每次算出来完全一样 → 「从第 6 词继续」照旧成立
//   · 换一天换一个排法
//
// 真正跨天接续靠的是 session 快照恢复（app.init 里的 S.restore），
// 不是靠这个排序，所以这里换序不会让用户丢掉进度。

/** FNV-1a：把种子字符串摊成一个 32 位整数。纯函数，不依赖环境。 */
function hashSeed(seed) {
  const s = String(seed ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而够用的确定性伪随机数发生器。同种子必然同序列。 */
export function seededRandom(seed) {
  let a = hashSeed(seed) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 带种子的 Fisher–Yates 洗牌。**返回新数组，不改原数组。**
 * 同样的 (items, seed) 必然得到同样的顺序 —— 这是「可续」的前提。
 */
export function seededShuffle(items, seed) {
  const out = items.slice();
  const rnd = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 容器大小：唯一允许偏离 N 的合法情形（规格 §6.6）
// ─────────────────────────────────────────────────────────────

/** 断签天数 → 今日容器大小。回归门槛必须比坚持门槛低（P12）。 */
export function containerSize(gapDays, baseN = 20) {
  if (gapDays <= 3) return baseN;
  if (gapDays <= 14) return Math.max(1, Math.round(baseN * 0.6));
  return Math.max(1, Math.round(baseN * 0.4));
}

/** 断签文案。零指责：没有「落后」，没有「还差」。 */
export function comebackCopy(gapDays) {
  if (gapDays <= 0) return null;
  if (gapDays <= 3) return null;
  if (gapDays <= 14) return '先热个身';
  return '好久不见 · 今天轻一点';
}

// ─────────────────────────────────────────────────────────────
// 三层优先级组队
// ─────────────────────────────────────────────────────────────

export const TIER = { REVIEW: 1, PERSONAL: 2, NEW: 3 };

/**
 * 组队：产出今天的容器。
 *
 * @param words    当前词库的全部词条
 * @param mem      记忆表 { wordId: memoryState }
 * @param opts     { N, gapDays, balance ∈ [0,1] (0=先保住会的, 1=多背点新的),
 *                   now, collections(启用的词库标签), personal(生词本 id 集合),
 *                   profile(用户画像/已毕业词库), theta,
 *                   exclude(Set<wordId>：本轮已经排过的词，一律不再出现) }
 */
export function buildDailyContainer(words, mem, opts = {}) {
  const now = opts.now ?? Date.now();
  const N = opts.N ?? 20;
  const balance = clamp01(opts.balance ?? 0.5);
  const items = [];
  // 已在本轮排过的词。**排除要发生在所有池子里**，不能等选出结果再过滤。
  //
  // ⚠️ 为什么必须在这里排除（用户报「点再来 5 个出现重复的词」）：
  // 「再来 5 个新词」原来是用更大的 N 重建一遍、再拿结果去重。但走完一轮后
  // mem 已经变了 —— 那 20 个词从"新词池"进了"到期复习池"，重建出来的
  // 大部分**不是**它们本身，于是去重几乎全部失灵：实测 20 个词的一轮，
  // 点一次「再来 5 个」后容器变成 45 个条目、session 队列里 40 个是重复的。
  // 从池子源头排除，才能保证"多要的 5 个"真的是没排过的。
  const exclude = opts.exclude instanceof Set ? opts.exclude : null;
  const skip = (w) => !!(exclude && exclude.has(w.id));

  // 第 1 层：到期复习词 —— 不可挤占，防遗忘的地基
  const duePool = [];
  for (const w of words) {
    if (skip(w)) continue;
    const m = mem[w.id] || M.newMemory({}, now);
    if (!M.isDue(m, now, opts.theta) && !M.isWeak(m, now, opts.theta)) continue;
    duePool.push({ word: w, mem: m, tier: TIER.REVIEW, overdueDays: (now - M.dueAt(m, now, opts.theta)) / DAY_MS });
  }
  // 最紧急的排前面：逾期越久 / 当前可回忆概率越低，越先上
  duePool.sort(
    (a, b) =>
      b.overdueDays - a.overdueDays ||
      M.strength(a.mem, now, opts.theta) - M.strength(b.mem, now, opts.theta),
  );

  // 第 2 层：用户主动收藏的词（真实遇到的盲点，命中率高于随机推送）
  const personalPool = [];
  for (const w of words) {
    if (!w.personal) continue;
    if (skip(w)) continue;
    const m = mem[w.id] || M.newMemory({}, now);
    if (M.isDue(m, now, opts.theta)) continue; // 已在第 1 层
    personalPool.push({ word: w, mem: m, tier: TIER.PERSONAL });
  }
  personalPool.sort((a, b) => (b.word.addedTs || 0) - (a.word.addedTs || 0));

  // 第 3 层：当前词库的新词
  const newPool = [];
  for (const w of words) {
    if (w.personal) continue;
    if (skip(w)) continue;
    if (opts.collections && !opts.collections.includes(w.collection)) continue;
    const m = mem[w.id];
    if (m && (m.encodeCount > 0 || M.isDue(m, now, opts.theta))) continue; // 学过的不算新
    newPool.push({ word: w, mem: m || M.newMemory({}, now), tier: TIER.NEW });
  }
  // 新词出场顺序。
  //
  // 默认**随机**（种子 = opts.seed，app 传 dayKey），同一天内结果稳定，
  // 所以规格 §7.2 / §540 的「队列从第 6 词继续」照样成立。
  // 想回到按词库/字母序，opts.order 传 'seq'（设置页的那个开关）。
  //
  // 注意：**只随机新词这一层**。上面两层（到期复习 / 收藏）是记忆调度，
  // 乱了会破坏间隔重复 —— 逾期越久越先上，那个次序是有意义的。
  if (opts.order === 'seq') {
    newPool.sort((a, b) => (a.word.seq ?? 0) - (b.word.seq ?? 0));
  } else {
    const shuffled = seededShuffle(newPool, opts.seed ?? 'vocab');
    newPool.length = 0;
    newPool.push(...shuffled);
  }

  // ── 攻守天平：复习与新词的配比，实时可见（§6.5）──
  // balance=0 → 尽量先保住会的；balance=1 → 多推新词
  const reviewCount = duePool.length;
  const totalPool = reviewCount + personalPool.length + newPool.length;
  const fill = Math.min(N, totalPool);
  let reviewQuota = Math.round(fill * (1 - 0.55 * balance)); // 天平右移时给复习留的位置变小
  reviewQuota = Math.max(0, Math.min(reviewQuota, reviewCount));

  const personalCap = Math.max(0, Math.round(N * 0.6)); // 第 2 层最多占预算 60%
  let used = 0;

  // 1) 到期复习词（含旧库维护词）
  for (const it of duePool.slice(0, Math.max(reviewQuota, 0))) {
    if (used >= N) break;
    items.push(it);
    used++;
  }
  // 2) 收藏词，最多 60%，超出顺延次日（不丢、不堆）
  let personalUsed = 0;
  for (const it of personalPool) {
    if (used >= N || personalUsed >= personalCap) break;
    items.push(it);
    used++;
    personalUsed++;
  }
  // 3) 新词填满剩余名额
  //
  // allowMoreNew：用户本人显式按了「我还是想继续」。
  // 安全阀（当天新词答错率 > 70% 自动停推新词）仍然保留并照常自动触发，
  // 但它不再是一堵没有门的墙 —— 门只有用户能开，代码不会替他开。
  // 规格 §7.6 原本写的是"无需询问"，用户的实际意见是"要询问我、但让我决定"。
  const cushion = reserveCushion(words, mem, opts);
  const bypassBlockNew = !!(opts && opts.allowMoreNew);
  for (const it of newPool) {
    if (used >= N) break;
    if (cushion.blockNew && !bypassBlockNew) break;
    items.push(it);
    used++;
  }
  // 4) 如果复习词还没放完但预算有空（收藏/新词都不够），回头补复习词
  for (const it of duePool.slice(reviewQuota)) {
    if (used >= N) break;
    if (items.some((x) => x.word.id === it.word.id)) continue;
    items.push(it);
    used++;
  }
  // 5) 实在凑不满，把 5% 安全垫里最弱的词拉进来轮转（§5.6：绝不宣称「全部掌握」）
  //    注意：安全垫是从**已学过**的词里挑的，所以必须也过一遍 exclude ——
  //    否则「再来 5 个新词」会把刚从"新词池"迁到"复习池"的那批又拉回来。
  if (used < N) {
    for (const it of cushion.weakest) {
      if (used >= N) break;
      if (skip(it.word)) continue;
      if (items.some((x) => x.word.id === it.word.id)) continue;
      items.push(it);
      used++;
    }
  }

  // ── DP 视角的「最优子集」记录：为什么是这 20 个 ──
  const stats = {
    dueTotal: reviewCount, // 只用于内部排序，绝不汇总展示给用户（§6.6）
    deferred: Math.max(0, reviewCount - items.filter((i) => i.tier === TIER.REVIEW).length),
    reviewCount: items.filter((i) => i.tier === TIER.REVIEW).length,
    personalCount: items.filter((i) => i.tier === TIER.PERSONAL).length,
    newCount: items.filter((i) => i.tier === TIER.NEW).length,
    cushionCount: items.filter((i) => i.tier === TIER.REVIEW && i.reason === 'cushion').length,
    size: items.length,
    containerSize: N,
    balance,
    offline: !!opts.offline,
    // 新词闸门：自动触发过、或本次是被用户显式放行。
    // UI 用这两个字段决定"要不要给用户一个『我还是想继续』的入口"——
    // 闸门关着时给入口，用户放行后就不再追着问。
    newBlocked: cushion.blockNew && !bypassBlockNew,
    newBlockBypassed: cushion.blockNew && bypassBlockNew,
  };

  return { items, stats, explanation: explain(items, words, mem, { ...opts, now, N }) };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
}

/**
 * 新词闸门：当天新词答错率 > 70% 且已答满 5 个新词 → 停止推新词（§7.6）。
 *
 * 为什么单独抽成一个函数：原来这段判断写在组队流程里，而组队**一天只跑一次**
 * （开局建容器时），那一刻 todayStats().newAnswerCount 恒为 0，所以闸门
 * 从来没真正关上过 —— 规格 §7.6 是一条实际不生效的死规则。测试
 * test/round-control.test.mjs 把它抓了出来。
 * 现在 UI 每次取快照都用同一个函数重算，保证"界面上看到闸门状态"和
 * "组队时是否推新词"用的是同一口径。
 */
export function shouldBlockNew(todayStats) {
  if (!todayStats) return false;
  return todayStats.newAnswerCount >= 5 && todayStats.newWrongRate > 0.7;
}

/**
 * 安全垫：词库背完后保留 ≥5% 最低强度词永远轮转，绝不宣称「全部掌握」（§5.6）。
 * 同时：新词答错率 > 70% 时当天自动停止推新词，只做复习（§7.6，无需询问）。
 */
function reserveCushion(words, mem, opts) {
  const now = opts.now ?? Date.now();
  const learned = words.filter((w) => (mem[w.id]?.encodeCount || 0) > 0);
  const cushionTarget = Math.max(1, Math.round(words.length * 0.05));
  const weakest = learned
    .map((w) => ({ word: w, mem: mem[w.id], tier: TIER.REVIEW, reason: 'cushion' }))
    .sort((a, b) => M.strength(a.mem, now, opts.theta) - M.strength(b.mem, now, opts.theta))
    .slice(0, cushionTarget);

  const allLearned = learned.length >= words.length * 0.95 && learned.length > 0;
  const blockNew = shouldBlockNew(opts.todayStats);
  return { weakest, allLearned, blockNew };
}

/**
 * 一句话解释 + 每词角标（规格 §6.4）。
 * 不做数字展开：不显示强度 0.32 / 遗忘概率 71%。
 */
export function explain(items, words, mem, opts = {}) {
  const now = opts.now ?? Date.now();
  const soonFuzzy = items.filter((it) => {
    const p = M.recallProb(it.mem, Math.max(0, (now - it.mem.lastSeenTs) / DAY_MS), opts.theta);
    return p < 0.75 && p >= 0.4;
  }).length;
  const top = soonFuzzy > 0 ? `今天重点：${soonFuzzy} 个词明天就会模糊` : '今天这批都是新面孔';
  return { headline: top, sub: null };
}

/** 每个词的角标。 */
export function badgesFor(item, mem, opts = {}) {
  const out = [];
  const now = opts.now ?? Date.now();
  if (item.tier === TIER.PERSONAL) out.push({ icon: '📥', label: '收藏' });
  if (item.tier === TIER.NEW) out.push({ icon: '✨', label: '新词' });
  if ((mem?.e || 0) >= 3) out.push({ icon: '🔥', label: `错过 ${mem.e} 次` });
  else if (mem && mem.encodeCount > 0) {
    const p = M.recallProb(mem, Math.max(0, (now - mem.lastSeenTs) / DAY_MS), opts.theta);
    if (p < 0.6) out.push({ icon: '⏳', label: '明天忘' });
  }
  return out;
}

/** 队列空了怎么办（规格 §6.3 的空状态表）。文案永不指责。 */
export function emptyState(kind) {
  switch (kind) {
    case 'allStable':
      return { text: '今天没有需要复习的词 · 去换本新的？', action: '换词库' };
    case 'noWords':
      return { text: '这个词库里暂时没有可背的词', action: '去设置' };
    default:
      return { text: '今天没有需要复习的词 · 去换本新的？', action: '换词库' };
  }
}

/** 今日进度：完成容器 ≥60% 即算打卡（§7.3），不必 100%。 */
export const CHECKIN_RATIO = 0.6;
export function isCheckedIn(doneCount, containerN) {
  if (!containerN) return false;
  return doneCount / containerN >= CHECKIN_RATIO;
}

/**
 * 连续天数：只在真实完成时 +1；同日多次完成不 +1；不可补签（P7、§7.3）。
 * 返回新的 streak 状态。
 */
export function bumpStreak(streak, key, { count = 1 } = {}) {
  const s = { current: 0, longest: 0, lastDay: null, ...streak };
  if (s.lastDay === key) return s; // 同日多次不 +1
  if (s.lastDay && daysBetweenKeys(s.lastDay, key) === 1) s.current += 1;
  else s.current = 1;
  s.lastDay = key;
  s.longest = Math.max(s.longest || 0, s.current);
  s.totalDays = (s.totalDays || 0) + 1;
  void count;
  return s;
}

/**
 * 主动休假（§7.7）：「暂停到 X 日」—— 暂停期内胶囊消失、不产生到期词。
 * 有钥匙的退出，比偷偷溜走更容易回来。
 */
export function isPaused(pause, now = Date.now()) {
  if (!pause || !pause.until) return false;
  return now < pause.until;
}

/** 恢复：连续 3 天正常完成 → 自动回到 N（不询问）。 */
export function effectiveBaseN(baseN, streak, recentDays) {
  const last3 = (recentDays || []).slice(-3);
  if (last3.length === 3 && last3.every((d) => d.done)) return baseN;
  return null; // 由 containerSize 按断签天数决定
}
