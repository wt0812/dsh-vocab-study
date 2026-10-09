// vocab-study / core / beckon.mjs
// 情绪胶囊的状态机（规格 §3）。
//
// 三条不可违反的约束：
//   P3 文案永不指责 —— 断签只是空白，没有红字，没有「落后」
//   §3.1 优先级状态机「取第一个命中」
//   §3.2 注意力交接态：任务在流式输出时，胶囊只轻轻说一句，不抢焦点、不跳转、不闪动

/** §3.1 优先级状态机，取第一个命中。 */
export const BECKON = {
  FIRST: 'first', // 🌱 今天第一词
  LONG_GONE: 'longGone', // 💤 好久不见
  DUE: 'due', // ⏳ 陪你补 12 个
  DONE: 'done', // ✨ 今日达成
  STREAK: 'streak', // 🔥 连续 7 天
  SOLID: 'solid', // 🏔️ 稳得很
  // §3.2 注意力交接态
  LEARNING: 'learning', // 📖 学词中
  HANDOFF: 'handoff', // ✅ 5 词收好 · 结果在左边
  PAUSED: 'paused', // 主动休假：胶囊消失
};

/** 色调（§3.3）。珊瑚只用于非文字内容；文字态用深一点的红 —— 见 §14.3。 */
export const TONE = {
  fresh: { key: 'fresh', color: '#1F9D8F', textColor: '#157F73' }, // 青绿
  streak: { key: 'streak', color: '#FF6B5A', textColor: '#C24432' }, // 珊瑚
  due: { key: 'due', color: '#D9A23B', textColor: '#8A6420' }, // 暖黄
  done: { key: 'done', color: '#3FBFAE', textColor: '#157F73', ripple: true }, // 薄荷 + 一次涟漪
  away: { key: 'away', color: '#7C8A9A', textColor: '#5A6774' }, // 灰蓝，零指责
};

/** 关键天数：连续 ≥30 天走「稳得很」，≥3 天未学走「好久不见」。 */
export const LONG_GONE_DAYS = 3;
export const SOLID_DAYS = 30;
export const DUE_THRESHOLD = 1; // 有欠账就温柔提示（但不显示总数之外的任何东西）

/**
 * 算出胶囊此刻该显示什么。
 * 注意：这个函数永远返回「一句话 + 一个色调」，不返回任何数字 KPI。
 */
export function beckonState(ctx = {}) {
  const {
    hasRecords = false,
    streak = {},
    gapDays = 0,
    dueCount = 0,
    deferredCount = 0,
    containerDone = 0,
    containerSize = 0,
    session = null,
    streamActive = false,
    roundJustFinished = false,
    vacationUntil = null,
    now = Date.now(),
  } = ctx;

  // 主动休假：胶囊直接消失（§7.7），不显示倒计时、不劝
  if (vacationUntil && now < vacationUntil) {
    return { state: BECKON.PAUSED, visible: false, label: '', tone: TONE.away, needsAction: false };
  }

  // ── §3.2 注意力交接态优先于一切情绪展示（这是「不打扰」的唯一出口）──
  if (roundJustFinished && streamActive) {
    return {
      state: BECKON.HANDOFF,
      visible: true,
      label: `✅ ${containerDone || ''} 词收好 · 结果在左边`.replace('  ', ' ').trim(),
      tone: TONE.done,
      needsAction: false,
      note: '不抢焦点、不跳转、不闪动、不消失',
    };
  }
  if (streamActive && session && !isSessionFinished(session)) {
    return { state: BECKON.LEARNING, visible: true, label: '📖 学词中', tone: TONE.streak, needsAction: false };
  }
  if (roundJustFinished) {
    return { state: BECKON.DONE, visible: true, label: `✅ ${containerDone} 词收好`, tone: TONE.done, needsAction: false };
  }

  const doneAll = containerSize > 0 && containerDone >= containerSize;

  // ── §3.1 优先级状态机，取第一个命中 ──
  // 1. 首日 / 无记录 → 🌱 今天第一词
  if (!hasRecords && !streak.lastDay) {
    return { state: BECKON.FIRST, visible: true, label: '🌱 今天第一词', tone: TONE.fresh, needsAction: false };
  }
  // 2. 连续 ≥3 天未学 → 💤 好久不见（用旧荣耀接住，零指责）
  if (gapDays >= LONG_GONE_DAYS) {
    const longest = streak.longest || 0;
    const label = longest >= 3 ? `💤 好久不见 · 最长 ${longest} 天` : '💤 好久不见';
    return { state: BECKON.LONG_GONE, visible: true, label, tone: TONE.away, needsAction: false };
  }
  // 3. 到期欠账 > 阈值 → ⏳ 陪你补 N 个（只显示今天切片，绝不显示「待复习总数」）
  if (dueCount > DUE_THRESHOLD) {
    const n = Math.min(containerSize || dueCount, dueCount);
    return {
      state: BECKON.DUE,
      visible: true,
      label: `⏳ 陪你补 ${n} 个`,
      tone: TONE.due,
      needsAction: false,
      // 明确不显示 deferredCount —— 那是「欠你 180 个」的表述，规格 §6.6 禁止
      hidden: { deferred: deferredCount },
    };
  }
  // 4. 今日目标已达成 → ✨ 今日达成
  if (doneAll) {
    return { state: BECKON.DONE, visible: true, label: '✨ 今日达成', tone: TONE.done, needsAction: false };
  }
  // 5. 正常在学中 → 🔥 连续 7 天
  if ((streak.current || 0) >= LONG_GONE_DAYS) {
    // 6. 连续 ≥30 天 → 🏔️ 稳得很
    if ((streak.current || 0) >= SOLID_DAYS) {
      return { state: BECKON.SOLID, visible: true, label: '🏔️ 稳得很', tone: TONE.streak, needsAction: false };
    }
    return { state: BECKON.STREAK, visible: true, label: `🔥 连续 ${streak.current} 天`, tone: TONE.streak, needsAction: false };
  }
  // 兜底：有记录但不到 3 天连续
  if ((streak.current || 0) > 0) {
    return { state: BECKON.STREAK, visible: true, label: `🔥 连续 ${streak.current} 天`, tone: TONE.streak, needsAction: false };
  }
  return { state: BECKON.FIRST, visible: true, label: '🌱 今天第一词', tone: TONE.fresh, needsAction: false };
}

function isSessionFinished(session) {
  return !session || session.cursor >= session.queue.length;
}

/**
 * 断签回来的文案（§3.3）：用旧荣耀接住，而不是提醒损失。
 * 断签不羞辱、不红字、不弹窗催命。
 */
export function comebackLine(gapDays, longest = 0) {
  if (gapDays < LONG_GONE_DAYS) return null;
  if (longest >= 3) return `💤 好久不见 · 最长 ${longest} 天`;
  return '💤 好久不见';
}

/**
 * 达成时的一次轻微涟漪（§3.3）。
 * prefers-reduced-motion 时全部降级为无动画（§14.3）。
 */
export function shouldRipple(prefersReducedMotion) {
  return !prefersReducedMotion;
}
