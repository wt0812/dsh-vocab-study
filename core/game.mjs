// vocab-study / core / game.mjs
// 轻游戏化：连击 Combo / 连续打卡 Streak / 词力值 EXP。
// 三条克制点（规格 §8）：只在面板内动效、不用红点催、不做排行榜。

/** 连击倍率阶梯：连对 3/5/10 → ×2/×3/×5。 */
export const COMBO_STEPS = [
  { at: 10, mult: 5 },
  { at: 5, mult: 3 },
  { at: 3, mult: 2 },
];

export function comboMult(combo) {
  for (const s of COMBO_STEPS) if (combo >= s.at) return s.mult;
  return 1;
}

/** 连击冻结窗口：中途离开 5 分钟内回来继续，不清零（§5.1）。 */
export const COMBO_FREEZE_MS = 5 * 60 * 1000;

export function newCombo(now = Date.now()) {
  return { combo: 0, best: 0, mult: 1, frozenAt: null, lastTs: now };
}

/** 一次作答后推进连击。不弹动画、不打断；纯状态。 */
export function stepCombo(state, correct, now = Date.now()) {
  const s = { ...state, lastTs: now };
  if (correct) {
    s.combo = state.combo + 1;
    s.mult = comboMult(s.combo);
    s.best = Math.max(state.best || 0, s.combo);
    s.frozenAt = null;
  } else {
    s.combo = 0;
    s.mult = 1;
    s.frozenAt = null;
  }
  return s;
}

/** 面板收起 → 冻结而不是清零。 */
export function freezeCombo(state, now = Date.now()) {
  if (state.combo === 0) return state;
  return { ...state, frozenAt: now };
}

/** 重新打开面板：5 分钟内回来，连击还在；超过就静默归零（不提示、不指责）。 */
export function resumeCombo(state, now = Date.now()) {
  if (!state.frozenAt) return state;
  if (now - state.frozenAt <= COMBO_FREEZE_MS) return { ...state, frozenAt: null };
  return { ...newCombo(now), best: state.best };
}

// ─────────────────────────────────────────────────────────────
// 词力值：掌握度换算 EXP，攒够升级。纯个人成长，不做排行榜。
// ─────────────────────────────────────────────────────────────

/** 等级名走趣味路线（不叫 Lv.7，叫「词力值 7 级 · 拾穗人」）。 */
export const LEVELS = [
  { at: 0, name: '初拾' },
  { at: 60, name: '备忘录' },
  { at: 160, name: '拾穗人' },
  { at: 320, name: '小词典' },
  { at: 560, name: '活字架' },
  { at: 900, name: '咬文者' },
  { at: 1400, name: '掌灯人' },
  { at: 2100, name: '藏书阁' },
  { at: 3200, name: '词林圣手' },
  { at: 5000, name: '百科之友' },
];

export function levelFor(exp) {
  let cur = LEVELS[0];
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (exp >= LEVELS[i].at) {
      cur = LEVELS[i];
      idx = i;
    }
  }
  const next = LEVELS[idx + 1] || null;
  const span = next ? next.at - cur.at : 1;
  const progress = next ? Math.min(1, (exp - cur.at) / span) : 1;
  return { level: idx + 1, name: cur.name, exp, nextAt: next ? next.at : null, progress };
}

/**
 * 一次作答产出的 EXP。
 * 刻意与「学会」挂钩，不与「时长」挂钩 —— 挂机刷时长与学会背道而驰（§13）。
 */
export function expFor({ rating, correct, mult = 1, isReview = false }) {
  let base = 0;
  if (correct && rating === 'known') base = 4;
  else if (rating === 'fuzzy') base = 2;
  else base = 1; // 答错也给 1：来过就算数，不惩罚（P3）
  if (isReview) base += 1; // 复习旧词同样有价值
  return Math.round(base * mult);
}

/** 已收服数：只增不减的计数（判定在 memory.isConquered，必须硬）。 */
export function conqueredCount(words, mem, isConquered) {
  let n = 0;
  for (const w of words) {
    const m = mem[w.id];
    if (m && isConquered(m)) n++;
  }
  return n;
}
