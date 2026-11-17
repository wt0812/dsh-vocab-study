// vocab-study / core / appearance.mjs
//
// 「外观」设置（2026-11-15 用户反馈新增：「他想自定义背景色和字体大小」）。
//
// 设计上的三条硬约束：
//   1. **不放大版面**。面板钉在右侧栏里只有 340–415px 宽，如果把字号靠整体缩放
//      来做，字一大就被侧栏横向切掉。所以只有 font-size 走倍率，
//      内外边距不动 —— 字号变大时占用的是「本来空着的行内空间」，不是版面宽度。
//   2. **不允许调成看不见**。背景色是用户随便填的，文字颜色必须跟着自动翻深/翻浅，
//      并且按 WCAG 相对亮度算对比度；实在调不到 4.5:1 的（比如 50% 灰）就往
//      纯黑/纯白那一档顶，宁可难看也不让字消失。
//   3. **这个模块不碰 DOM**。纯函数，能在 node 里直接测（对比度、倍率、颜色合法性
//      都写成了断言，见 test/core.test.mjs 的「外观」一节）。
//      真正把 var 写到面板根节点上的是 ui/panel.mjs 的 applyAppearance()。

/** 字号档位：label 给人看，scale 给 CSS 用（font-size: calc(Npx * scale)）。 */
export const FONT_SCALES = [
  ['sm', '小', 0.9],
  ['md', '标准', 1],
  ['lg', '大', 1.15],
  ['xl', '特大', 1.3],
];

export const FONT_MIN = 0.85;
export const FONT_MAX = 1.4;

/**
 * 背景预设。`paper` 为 null 表示「跟随主题」（不覆盖任何颜色，交给 data-theme）。
 * 这些都是实测过对比度的搭配（见 test 里的 ≥ 4.5:1 断言）。
 */
export const PAPER_PRESETS = [
  ['auto', '跟随主题', null],
  ['paper', '米白', '#FBF7F0'],
  ['gray', '浅灰', '#F2F2EF'],
  ['green', '护眼绿', '#E8F0E3'],
  ['warm', '暖黄', '#FBF0D9'],
  ['night', '深夜', '#1C1A18'],
];

/** 两套配色（和 styles.css 里的 light / dark 两档保持一致，别各写一份）。 */
const INK_LIGHT = {
  ink: '#2E2A26',
  inkSoft: '#6B6259',
  inkFaint: '#9A9089',
  coralText: '#C24432',
  jadeText: '#157F73',
  warmText: '#8A6420',
  awayText: '#5A6774',
  scheme: 'light',
  shadow: '0 10px 30px rgba(60, 48, 34, .13), 0 2px 6px rgba(60, 48, 34, .07)',
};

const INK_DARK = {
  ink: '#EDE6DB',
  inkSoft: '#B3A99C',
  inkFaint: '#7E756A',
  coralText: '#FF8E80',
  jadeText: '#5ED0BE',
  warmText: '#E8BE6A',
  awayText: '#A5B2BE',
  scheme: 'dark',
  shadow: '0 14px 36px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .35)',
};

/** 极端档：自定义色卡在中间灰的时候，用纯黑/纯白把对比度顶上去。 */
const INK_EXTREME_DARK = { ...INK_LIGHT, ink: '#141210', inkSoft: '#3A3531', inkFaint: '#5C554E' };
const INK_EXTREME_LIGHT = { ...INK_DARK, ink: '#FFFFFF', inkSoft: '#D8D2C8', inkFaint: '#B3ACA2' };

const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;

/** 把用户输入的颜色收拾成 `#RRGGBB`；不合法返回 null（调用方回落到「跟随主题」）。 */
export function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m6 = s.match(HEX6);
  if (m6) return `#${m6[1].toUpperCase()}`;
  const m3 = s.match(HEX3);
  if (m3) {
    const [r, g, b] = m3[1].toUpperCase().split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

/** `#RRGGBB` → [r, g, b]（0–255）。 */
export function rgbOf(hex) {
  const h = normalizeHex(hex);
  if (!h) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** WCAG 相对亮度（0 = 黑，1 = 白）。 */
export function relativeLuminance(hex) {
  const rgb = rgbOf(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两色对比度（WCAG），1–21。 */
export function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** 把 ink 混进纸色一点点，做出「第二层纸」（卡片底）—— 和主题里 paper/paper-2 的关系一致。 */
function mix(hexA, hexB, t) {
  const a = rgbOf(hexA);
  const b = rgbOf(hexB);
  if (!a || !b) return hexA;
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function inkSetToVars(set, paper) {
  const rgb = rgbOf(set.ink) || [46, 42, 38];
  const [r, g, b] = rgb;
  return {
    '--vs-paper': paper,
    // 卡片/输入框的底色：纸色里掺 5%（浅色纸）或 6%（深色纸）的墨，肉眼刚好能分层
    '--vs-paper-2': mix(paper, set.ink, set.scheme === 'light' ? 0.05 : 0.08),
    '--vs-ink': set.ink,
    '--vs-ink-soft': set.inkSoft,
    '--vs-ink-faint': set.inkFaint,
    '--vs-line': `rgba(${r}, ${g}, ${b}, .10)`,
    '--vs-line-soft': `rgba(${r}, ${g}, ${b}, .06)`,
    '--vs-hover': `rgba(${r}, ${g}, ${b}, .05)`,
    '--vs-chip': `rgba(${r}, ${g}, ${b}, .055)`,
    '--vs-shadow': set.shadow,
    '--vs-coral-text': set.coralText,
    '--vs-jade-text': set.jadeText,
    '--vs-warm-text': set.warmText,
    '--vs-away-text': set.awayText,
    'color-scheme': set.scheme,
  };
}

/**
 * 给任意背景色配一套能看的字色。
 *
 * 顺序：先在两套标准配色里挑对比度高的，不够 4.5:1 再往纯黑/纯白顶。
 * 返回的 key 直接就是 CSS 自定义属性名，写盘/快照里都只存「用户选了什么」，
 * 具体颜色每次算 —— 这样以后改配色不用迁移数据。
 */
export function paletteFor(paperHex) {
  const paper = normalizeHex(paperHex) || '#FBF7F0';
  const candidates = [INK_LIGHT, INK_DARK, INK_EXTREME_DARK, INK_EXTREME_LIGHT];
  let best = candidates[0];
  let bestRatio = 0;
  for (const set of candidates) {
    const ratio = contrastRatio(set.ink, paper);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = set;
    }
  }
  return { vars: inkSetToVars(best, paper), contrast: bestRatio, scheme: best.scheme };
}

/** 字号倍率（非法值回落到 1 = 标准）。 */
export function fontScaleOf(key) {
  const hit = FONT_SCALES.find(([k]) => k === key);
  if (!hit) return 1;
  const s = hit[2];
  return Math.min(FONT_MAX, Math.max(FONT_MIN, s));
}

/** 外观设置的归一化：存盘/快照前都过这一道，坏数据不许进 state。 */
export function normalizeAppearance(a = {}) {
  const ap = a && typeof a === 'object' ? a : {};
  const font = FONT_SCALES.some(([k]) => k === ap.font) ? ap.font : 'md';
  const hex = normalizeHex(ap.paper);
  return {
    font,
    // 'auto' = 跟随主题；其余一律是 `#RRGGBB`
    paper: hex || 'auto',
  };
}

/** 把外观算成一组 CSS 自定义属性（panel 直接逐个 setProperty，别字符串拼 style）。 */
export function cssVarsFor(appearance) {
  const ap = normalizeAppearance(appearance);
  const vars = { '--vs-fs': String(fontScaleOf(ap.font)) };
  if (ap.paper !== 'auto') {
    const pal = paletteFor(ap.paper);
    Object.assign(vars, pal.vars);
  }
  return vars;
}

/** 用户自定义了背景色时，需要被覆盖的那批属性名（切回「跟随主题」时要逐个清掉）。 */
export const APPEARANCE_PROPS = Object.keys(inkSetToVars(INK_LIGHT, '#FFFFFF'));

/** 这个外观会不会改颜色（`auto` 时只改字号）。 */
export function hasCustomPaper(appearance) {
  return normalizeAppearance(appearance).paper !== 'auto';
}

// ── 跟随主题：从宿主（DSH）真实渲染出来的值里取 ─────────────────────────
//
// 2026-11-15 实测翻车：原来的「跟随主题」是读 `document.documentElement.dataset.theme`，
// 而 DSH 的主题运行时根本不写这个属性 —— 它做的是：
//     document.documentElement.style.colorScheme = scheme   // 'light' | 'dark'
//     document.body.setAttribute('data-ds-dark-theme', '')   // 深色时才有
//     把 --dsw-* token 变量铺到文档上
// 于是 `dataset.theme` 永远是 undefined → 回落 'dark' → 面板永远是深色：
// 用户挑完白底再点「跟随主题」就变回黑，主题插件更是完全跟不上。

/**
 * CSS 里读回来的颜色字符串 → `#RRGGBB`。
 *
 * `getComputedStyle().backgroundColor` 给的是 `rgb(33, 30, 27)` / `rgba(0,0,0,0)`，
 * 不是 hex，所以不能直接喂给 normalizeHex。半透明（alpha < 0.6）返回 null ——
 * 下面还压着别的层，拿它当纸色会算错对比度。
 */
export function cssColorToHex(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const direct = normalizeHex(s);
  if (direct) return direct;
  const m = s.toLowerCase().match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p));
  const rgb = parts.slice(0, 3).map(num);
  const alpha = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
  if (rgb.some((v) => !Number.isFinite(v)) || !Number.isFinite(alpha)) return null;
  if (alpha < 0.6) return null;
  return `#${rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/**
 * 宿主现在是深色还是浅色。信号从强到弱：
 *   1. `data-ds-dark-theme` 属性（DSH 自己打的标，最可靠）
 *   2. 计算出来的 `color-scheme`（'dark' / 'light' / 'light dark' 之类）
 *   3. `data-theme` 属性（0.3.5 及以前的探测方式，演示页也用它）
 *   4. 系统偏好 `prefers-color-scheme`（宿主设成 system 时就是它在决定）
 *   5. 都不给就按底色亮度反推（主题插件换了深/浅底也认得出）
 */
export function schemeFromSignals(signals = {}) {
  const s = signals && typeof signals === 'object' ? signals : {};
  if (s.darkMarker === true) return 'dark';
  const cs = typeof s.colorScheme === 'string' ? s.colorScheme.toLowerCase() : '';
  // color-scheme 可能是「light dark」这种组合值，取**先出现**的那个（CSS 规定第一个是首选）
  const first = cs.split(/\s+/).find((t) => t === 'dark' || t === 'light');
  if (first) return first;
  const dt = typeof s.datasetTheme === 'string' ? s.datasetTheme.toLowerCase() : '';
  if (dt === 'dark' || dt === 'light') return dt;
  if (s.prefersDark === true) return 'dark';
  if (s.prefersDark === false) return 'light';
  const paper = normalizeHex(s.paper);
  if (paper) {
    // 「这个底色离白近还是离黑近」—— 比拍一个亮度阈值稳
    return contrastRatio(paper, '#FFFFFF') > contrastRatio(paper, '#000000') ? 'dark' : 'light';
  }
  return 'dark';
}

/**
 * 结合宿主真实底色算 CSS 变量。
 *
 * `跟随主题`（paper = 'auto'）时把宿主**画布底色**接过来当纸色 —— 主题插件把
 * 底色换成淡蓝/米黄，面板也跟着变色，而不是只认「深/浅」两档。
 *
 * 但不是直接照抄画布色：面板要像「压在画布上的一张纸」，所以往白里提 5%
 * （深色画布提亮、浅色画布更白，和 0.3.5 之前 #211E1B / #FBF7F0 的手调关系一致）。
 * 提亮之后字色照样由 paletteFor 现算，对比度仍然 ≥ 4.5:1。
 *
 * 拿不到宿主底色（透明、读不到）时退回 cssVarsFor：只写字号，
 * 颜色交给 `.vs[data-theme]` 那套静态配色。
 */
export function cssVarsForHost(appearance, hostCanvasHex) {
  const ap = normalizeAppearance(appearance);
  const base = cssVarsFor(ap);
  if (ap.paper !== 'auto') return base;
  const canvas = normalizeHex(hostCanvasHex);
  if (!canvas) return base;
  const paper = mix(canvas, '#FFFFFF', 0.05);
  return { ...base, ...paletteFor(paper).vars };
}
