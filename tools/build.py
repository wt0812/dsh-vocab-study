#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
vocab-study / tools / build.py

把 core/ + ui/ 拼成一个自包含的单文件 demo（demo/index.html + demo/app.js）。

为什么需要它：
  1. 浏览器在 file:// 下不允许 import 模块（CORS），所以「双击就能玩」的
     demo 必须把逻辑摊平进一个 <script>；
  2. 单文件 demo 不该手抄 core 的逻辑 —— 手抄必然分叉。

同一份源码有两种消费方式：
  · ESM 形态：DSH 插件直接 import（core/*.mjs 与 ui/*.mjs 都在，写法是标准 ESM）
  · 单文件形态：本脚本按依赖顺序把 core 摊进同一个作用域（于是跨模块引用天然成立），
    再把 ui 每个文件包一层作用域并接上 core 命名空间。

用法：python tools/build.py
"""

import io
import os
import re
import sys
import datetime

# Windows 控制台默认 GBK，直接打 ✓ 会炸；这里统一成 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def write(rel, text):
    p = os.path.join(ROOT, rel)
    d = os.path.dirname(p)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


# ── core：按依赖顺序摊进同一个作用域 ──────────────────────────
# 顺序即依赖顺序：后面的文件可以引用前面声明的东西。
CORE_ORDER = [
    ("M", "core/memory.mjs"),
    ("MK", "core/mistake.mjs"),
    ("SEED", "core/seed-cet4.mjs"),
    ("L", "core/library.mjs"),
    ("SP", "core/speech.mjs"),
    ("HK", "core/hook.mjs"),
    ("Q", "core/queue.mjs"),
    ("G", "core/game.mjs"),
    ("B", "core/beckon.mjs"),
    ("S", "core/session.mjs"),
    ("A", "core/app.mjs"),
]

# 每个模块暴露哪些符号（也就是它的公开面）
CORE_EXPORTS = {
    "M": ["DEFAULT_THETA", "DAY_MS", "newMemory", "features", "halfLifeDays", "recallProb",
          "strength", "isConquered", "dueAt", "isDue", "isWeak", "WEAK_THRESHOLD",
          "encode", "markQuizCorrect", "retentionCurve", "estimateMinutes"],
    "MK": ["errorDelta", "applyError", "pairKey", "noteConfusion", "flagConfusion",
           "pairsNeedingDrill", "activePairs", "blacklistedPartners", "similarity",
           "ERROR_KIND", "classifyError", "diagnosis", "pickDistractors"],
    "SEED": ["SEED_CET4_RAW", "SEED_COLLECTIONS"],
    "L": ["COLLECTIONS", "SOURCES", "FIRST_CHUNK", "parseWordlist", "loadCollection",
          "seedFor", "seedMemories", "extractWordsFromText", "isPureEnglish",
          "contextSentence", "SEED_CET4"],
    "SP": ["speechAvailable", "speak", "stopSpeaking", "speechSupportedLanguages"],
    "HK": ["HOOK_SOURCE", "HOOK_MAX_CHARS", "buildHook", "buildHooks", "createHookCache"],
    "Q": ["DAY_START_HOUR", "dayKey", "dayStartTs", "daysBetweenKeys", "priorDayKey",
          "containerSize", "comebackCopy", "buildDailyContainer", "explain", "badgesFor",
          "emptyState", "CHECKIN_RATIO", "isCheckedIn", "bumpStreak", "isPaused",
          "effectiveBaseN", "TIER", "seededRandom", "seededShuffle", "shouldBlockNew"],
    "G": ["COMBO_STEPS", "comboMult", "COMBO_FREEZE_MS", "newCombo", "stepCombo",
          "freezeCombo", "resumeCombo", "LEVELS", "levelFor", "expFor", "conqueredCount"],
    "B": ["BECKON", "TONE", "LONG_GONE_DAYS", "SOLID_DAYS", "beckonState",
          "comebackLine", "shouldRipple"],
    "S": ["RETRY_GAP_MIN", "RETRY_GAP_MAX", "MODE", "RATING", "MAX_CONSECUTIVE_NEW",
          "UNDO_WINDOW_MS", "QUIZ_ERROR_THRESHOLD", "createSession", "currentCard",
          "isFinished", "coveredCount", "submitRating", "revealFor", "planRetry", "insertRetry",
          "advance", "ensureNewWordCap", "undoLast", "buildQuiz", "submitQuiz",
          "humanizeConfusion", "reportFakeMastery", "pauseSession", "resumeSession",
          "snapshot", "restore"],
    # ── 这份清单和"模块导出了什么"不是一回事，两种符号要分开看 ──
    #  · 顶层 function 声明（如 queue.mjs 的 shouldBlockNew）：
    #      摊平后确实是顶层绑定，**必须**列在这里，否则命名空间对象里
    #      没有这个属性（`Q.shouldBlockNew is not a function`）。
    #  · 工厂内部的闭包函数（如 app.mjs 里 createApp 内的 restartRound /
    #      extendRound / allowMoreNew）：顶层根本没有绑定。列进来会生成
    #      `const A = { createApp, restartRound, ... }` → ReferenceError，
    #      整个包一加载就崩。界面用 `app.restartRound()` 走实例，不需要裸名。
    # 两种情况我都写错过一次，各自被两个不同测试抓到：
    #   漏列 shouldBlockNew → demo-boot 报 Q.shouldBlockNew is not a function
    #   多列 restartRound   → demo-boot 报 restartRound is not defined
    "A": ["createApp"],
}

# core 内部的两个重名符号：分别收进各自命名空间
CORE_ALIASES = {"SEED.SEED_CET4_RAW": "SEED_CET4_RAW", "SEED.SEED_COLLECTIONS": "SEED_COLLECTIONS"}

# ── ui：每个文件包一层作用域 ─────────────────────────────────
UI = [
    ("UI_CORE_REF", "ui/core-ref.mjs", ["setCore", "getCore"]),
    ("UI_DOM", "ui/dom.mjs",
     ["el", "h", "clear", "mount", "setText", "setClass", "toggle",
      "focusSelf", "prefersReducedMotion"]),
    ("UI_PAGES", "ui/pages.mjs",
     ["injectCore", "renderProgress", "renderVocab", "renderSettings",
      "renderWeeklyReport", "heatmap", "collectionLabel"]),
    ("UI_PANEL", "ui/panel.mjs", ["createPanel"]),
    ("UI_CAPSULE", "ui/capsule.mjs", ["createCapsule"]),
    ("UI_SHELL", "ui/shell.mjs", ["boot"]),
]

# ui 文件的 import 符号 → 它在 VOCAB_CORE 里的位置
SYMBOL_HOME = {
    "createApp": "A", "dayKey": "Q", "DAY_START_HOUR": "Q", "speak": "SP",
    "speechAvailable": "SP", "newMemory": "M", "strength": "M", "recallProb": "M",
    "isPureEnglish": "L", "SEED_CET4": "L",
    "coveredCount": "S",
    "injectCore": "UI_PAGES", "renderProgress": "UI_PAGES", "renderVocab": "UI_PAGES",
    "renderSettings": "UI_PAGES", "renderWeeklyReport": "UI_PAGES", "heatmap": "UI_PAGES",
    "collectionLabel": "UI_PAGES",
    "setCore": "UI_CORE_REF", "getCore": "UI_CORE_REF",
    "createPanel": "UI_PANEL", "createCapsule": "UI_CAPSULE",
    "el": "UI_DOM", "h": "UI_DOM", "clear": "UI_DOM", "mount": "UI_DOM",
    "setText": "UI_DOM", "setClass": "UI_DOM", "toggle": "UI_DOM",
    "focusSelf": "UI_DOM", "prefersReducedMotion": "UI_DOM",
}

# 具名导入、命名空间导入、默认导入 —— 三种都要在拼接时剥掉
IMPORT_NAMED_RE = re.compile(r"(?m)^\s*import\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"];?\s*$")
IMPORT_NS_RE = re.compile(r"(?m)^\s*import\s*(?:\*\s*as\s*)?[A-Za-z_$][\w$]*\s*from\s*['\"][^'\"]+['\"];?\s*$")
EXPORT_LIST_RE = re.compile(r"(?m)^\s*export\s*\{([^}]*)\}\s*;?\s*$")
# 某个符号在源码里有没有声明
DECL_RE = r"(?:^|\n)\s*(?:const|let|var|function|class|async\s+function)\s+%s\b"


def strip_comments(src):
    return re.sub(r"(?m)^\s*//.*$", "", src)


# ui 文件里 ESM 形态的自注册行（ui/pages.mjs 用它填 ui/core-ref.mjs 的注册表）。
# 摊平形态由构建脚本统一注册（见文件末尾「登记命名空间」那两处），
# 这里必须整行剥掉：留着会引用产物里不存在的 M_/Q_ 等别名。
# 跨行匹配是必须的，`[^}]*` 那种单行写法会静默漏掉折行版本。
UI_SELF_REGISTER_RE = re.compile(r"(?m)^[ \t]*setCore\([\s\S]*?\);[ \t]*$")


def prepare_core(src, label):
    """剥掉 import / export 语法；core 各模块共享一个作用域。"""
    src = IMPORT_NAMED_RE.sub("", src)
    src = IMPORT_NS_RE.sub("", src)
    src = EXPORT_LIST_RE.sub("", src)
    src = re.sub(r"^\s*export\s+async\s+function\b", "async function", src, flags=re.M)
    src = re.sub(r"^\s*export\s+(const|let|var|function|class)\b", r"\1", src, flags=re.M)
    left = re.search(r"(?m)^\s*import\s", strip_comments(src))
    if left:
        raise SystemExit("[%s] 还剩没处理的 import" % label)
    return src


def prepare_ui(src, label):
    """把 ui 文件的 import 改写成读取 VOCAB_CORE 的局部绑定。"""
    bindings = []
    seen = set()

    def repl(m):
        inner, frm = m.group(1), m.group(2)
        for part in inner.split(","):
            seg = part.strip()
            if not seg:
                continue
            mm = re.match(r"^(\S+)\s+as\s+(\S+)$", seg)
            imported = mm.group(1) if mm else seg
            local = mm.group(2) if mm else seg
            home = SYMBOL_HOME.get(imported)
            if not home:
                raise SystemExit("[%s] 认不出导入符号「%s」（from '%s'）—— 请在 tools/build.py 的 SYMBOL_HOME 里登记"
                                 % (label, imported, frm))
            if local not in seen:
                seen.add(local)
                bindings.append("const %s = VOCAB_CORE.%s.%s;" % (local, home, imported))
        return ""

    # 命名空间导入（import * as X）在摊平形态下没有意义：ESM 绑定不存在，
    # 命名空间改由 ui/core-ref.mjs 的注册表提供。直接剥掉，不要留残渣 ——
    # 之前漏了这一步，页面里残留的 import 行会成为语法错误。
    stripped = IMPORT_NS_RE.sub("", IMPORT_NAMED_RE.sub(repl, src))
    left = re.search(r"(?m)^\s*import\s", strip_comments(stripped))
    if left:
        raise SystemExit("[%s] 有构建脚本认不出的 import 写法：%s" % (label, left.group(0)))
    stripped = EXPORT_LIST_RE.sub("", stripped)
    stripped = re.sub(r"^\s*export\s+async\s+function\b", "async function", stripped, flags=re.M)
    stripped = re.sub(r"^\s*export\s+(const|let|var|function|class)\b", r"\1", stripped, flags=re.M)
    # 剥掉 ESM 自注册；摊平形态的注册在产物里统一做
    stripped = UI_SELF_REGISTER_RE.sub("", stripped)
    leak = re.search(r"(?<![\w.$])(M_|MK_|G_|Q_|L_|B_|SP_)(?![\w$])", stripped)
    if leak:
        raise SystemExit("[%s] 产物里残留 ESM 别名 `%s` —— 剥离漏了" % (label, leak.group(1)))
    return "\n".join(bindings) + "\n" + stripped


def assert_available(src, symbols, label):
    missing = [s for s in symbols if not re.search(DECL_RE % re.escape(s), src)]
    if missing:
        raise SystemExit("[%s] 清单里的符号在源码里找不到：%s" % (label, ", ".join(missing)))


# getCore() 的键名只有全名。单字母只允许作为**别名**出现：
#   const { queue: Q } = getCore();   ✅
#   const { Q } = getCore();          ❌ 解构出来是 undefined
# 后者在设置页炸过：previewBalance 里 Q 拿不到，报
# “Cannot read properties of undefined (reading 'buildDailyContainer')”。
# 这是个只要看代码就能发现的错，没必要留到运行时。
CORE_GET_SHORT_KEY_RE = re.compile(
    r"(?m)^[ \t]*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*getCore\s*\(\s*\)"
)


def assert_core_keys(src, label):
    """检查 getCore() 的解构只用了全名键（单字母只能当别名）。"""
    for m in CORE_GET_SHORT_KEY_RE.finditer(src):
        for seg in m.group(1).split(","):
            seg = seg.strip()
            if not seg:
                continue
            if ":" in seg:
                continue  # 有别名，形如 queue: Q，肯定是从全名取的
            if seg in ("M", "MK", "G", "Q", "L", "B", "SP", "S", "A", "SEED", "HK"):
                line_no = src[: m.start()].count("\n") + 1
                raise SystemExit(
                    "[%s] 第 %d 行 `const { %s } = getCore()` —— getCore() 的键名只有全名，"
                    "单字母是 undefined。请写成 `const { %s: %s } = getCore()`。"
                    % (label, line_no, seg, NS_KEY_FOR_SHORT.get(seg, "?"), seg)
                )


# 单字母 → 全名，仅用于上面的报错信息
NS_KEY_FOR_SHORT = {
    "M": "memory", "MK": "mistake", "G": "game", "Q": "queue",
    "L": "library", "B": "beckon", "SP": "speech", "S": "session", "A": "app",
    "SEED": "seed", "HK": "hook",
}


# ── 插件样式表不许有全局选择器 ─────────────────────────────────────────
# 插件产物是注入到 DSH 真实页面里的（<style> 进 document.head），
# 所以 ui/styles.css 里任何一条不带 .vs / [data-vs / --vs 限定的选择器
# 都会作用到宿主界面元素上。
#
# 这不是理论风险，是真炸过的：把 demo 外壳样式留在 ui/styles.css 里，
# 其中 `body { margin: 0; background: #14120F; }` 覆盖了宿主的 body，
# 结果是「界面上很多按钮都没有用」。根因是样式与外壳同处一个文件，
# 而构建脚本把整个文件都注入了。
#
# 演示外壳样式现在住在 demo/shell.css，只由 build.py 拼进 demo HTML。
GLOBAL_CSS_SELECTOR_DENY = (
    "*", "html", "body", "html,body",
    "button", "input", "textarea", "select", "a", "img", "div", "span",
    "p", "ul", "ol", "li", "table", "h1", "h2", "h3", "form", "label",
)


def assert_plugin_css(css, label="ui/styles.css"):
    """确保插件样式表里没有会污染宿主界面的全局选择器。"""
    # 去掉注释与 @keyframes/@media 里嵌套的规则体，只留顶层选择器
    src = re.sub(r"/\*[\s\S]*?\*/", "", css)
    depth = 0
    buf = ""
    problems = []
    line_no = 1
    at_rule_stack = []
    for ch in src:
        if ch == "\n":
            line_no += 1
        if ch == "{":
            sel = buf.strip()
            if depth == 0:
                if sel.startswith("@"):
                    at_rule_stack.append(sel)
                elif sel:
                    for part in sel.split(","):
                        p = part.strip()
                        if not p:
                            continue
                        if re.search(r"\.vs|\[data-vs|--vs", p):
                            continue
                        problems.append((line_no, sel))
                        break
            else:
                at_rule_stack.append("")
            depth += 1
            buf = ""
        elif ch == "}":
            depth = max(0, depth - 1)
            if at_rule_stack:
                at_rule_stack.pop()
            buf = ""
        elif depth == 0:
            buf += ch
    if problems:
        line, sel = problems[0]
        raise SystemExit(
            "[%s] 第 %d 行有全局选择器 `%s` —— 插件样式会注入 DSH 真实页面，"
            "这条规则会作用到宿主界面元素上，把界面搞坏。\n"
            "只允许 .vs-* / [data-vs*] / --vs-* 限定的选择器。\n"
            "演示外壳样式请放到 demo/shell.css（只由 build.py 拼进 demo HTML）。"
            % (label, line, sel[:80])
        )
    return css

# 浏览器里可跑的核心自检。规格 §14.6 P0 要求「core/ 全量单测通过」，
# 这一段是它在页面上的现场版本（Node 版见 test/core.test.mjs）。
CORE_SELFTEST = u"""
// ═══════════════════════════════════════════════════════════
// core 自检 —— 规格 §14.6 P0 的机器可读版本
// ═══════════════════════════════════════════════════════════
window.__vsCoreSelfTest = function () {
  const out = [];
  const DAY = 86400000;
  let pass = 0, fail = 0;
  const details = [];
  const ok = (cond, label, extra) => {
    if (cond) { pass++; out.push('PASS  ' + label); }
    else {
      fail++;
      out.push('FAIL  ' + label);
      if (extra) details.push('【' + label + '】\\n' + String(extra));
    }
  };
  const day = 20260214;

  // ① 日容器铁律：词数 ≤ N，且到期词不可被挤占过多
  (() => {
    const words = L.seedFor('cet4');
    const mem = L.seedMemories(words, {}, day);
    // 造 60 个到期词
    for (let i = 0; i < 60; i++) {
      const id = words[i].id;
      mem[id] = Object.assign({}, mem[id], { lastSeenTs: day - 30 * DAY, encodeCount: 3, correct: 3, e: 1 });
    }
    const c = Q.buildDailyContainer(words, mem, { N: 20, gapDays: 0, balance: 0.5, now: day, collections: ['cet4'] });
    ok(c.items.length <= 20, '日容器不超过 20 词', '实际 ' + c.items.length);
    ok(c.stats.containerSize === 20, '容器大小 = 20');
    ok(c.stats.reviewCount + c.stats.personalCount + c.stats.newCount === c.items.length, '三层配比自洽');
    ok(c.stats.dueTotal > 20, '内部知道到期总数（' + c.stats.dueTotal + '）');
  })();

  // ② 断签越久，容器越小（§6.6 / §7.7）
  ok(Q.containerSize(0, 20) === 20, '断签 0 天 → 20 词');
  ok(Q.containerSize(3, 20) === 20, '断签 1–3 天 → 20 词');
  ok(Q.containerSize(7, 20) === 12, '断签 4–14 天 → 12 词');
  ok(Q.containerSize(20, 20) === 8, '断签 >14 天 → 8 词');

  // ③ 一天分界点是凌晨 4:00（§7.3）
  (() => {
    const t3 = new Date(2026, 1, 14, 3, 30, 0).getTime();
    const t5 = new Date(2026, 1, 14, 5, 0, 0).getTime();
    ok(Q.dayKey(t3) === '2026-02-13', '3:30 算前一天', Q.dayKey(t3));
    ok(Q.dayKey(t5) === '2026-02-14', '5:00 算当天', Q.dayKey(t5));
  })();

  // ④ 连续天数：同日不 +1、不可补签（§7.3）
  (() => {
    let s = Q.bumpStreak({ current: 0, longest: 0, lastDay: null }, '2026-02-10');
    s = Q.bumpStreak(s, '2026-02-10');
    ok(s.current === 1, '同日第二次不 +1', 'current=' + s.current);
    s = Q.bumpStreak(s, '2026-02-11');
    ok(s.current === 2, '隔天 +1');
    s = Q.bumpStreak(s, '2026-02-14');
    ok(s.current === 1, '断签后从 1 重来（不补签）', 'current=' + s.current);
    ok(s.longest === 2, '历史最长保留', 'longest=' + s.longest);
  })();

  // ⑤ 打卡口径：完成容器 ≥60% 即算（§7.3）
  ok(Q.isCheckedIn(12, 20) === true, '12/20 算打卡');
  ok(Q.isCheckedIn(11, 20) === false, '11/20 不算打卡');

  // ⑥ 错误计数：忘了 +1，假掌握 +2（§5.4）
  ok(MK.errorDelta({ rating: 'forgot' }) === 1, '自评「忘了」+1');
  ok(MK.errorDelta({ rating: 'known', fakeMastery: true }) === 2, '假掌握 +2');
  ok(MK.errorDelta({ rating: 'known', fakeMastery: false }) === 0, '真会了不加错频');

  // ⑦ 同轮重训：绝不立刻重问，间隔必须落在 3–8 张（§5.5）
  (() => {
    const words = L.seedFor('cet4').slice(0, 20);
    const mem = L.seedMemories(words, {}, day);
    const items = words.map((w, i) => ({ word: w, mem: mem[w.id], tier: i % 3 === 0 ? 3 : 1, reason: null }));
    const s = S.createSession({ items, stats: { containerSize: 20 }, dayKey: '2026-02-14' }, { words, mem, now: day });
    const card = S.currentCard(s);
    const plan = S.planRetry(s, card, 'forgot', day);
    ok(plan.action === 'retry', '「忘了」触发同轮重训');
    ok(plan.gap >= 3 && plan.gap <= 8, '重训间隔在 3–8 张内（' + plan.gap + '）');
    const at = s.queue.findIndex((c) => c.isRetry && c.word.id === card.word.id);
    ok(at > s.cursor + 1, '重训卡不是紧挨着下一张', '插入位置 ' + at + '，当前 ' + s.cursor);
  })();

  // ⑧ 连续新词守卫（§5.2）—— 分三个用例：机制、可调上限、以及「拆不动时不撒谎」
  (() => {
    const mk = (spec) => {
      const words = L.seedFor('cet4').slice(0, spec.length);
      const mem = L.seedMemories(words, {}, day);
      const items = spec.map((tier, i) => ({ word: words[i], mem: mem[words[i].id], tier, reason: null }));
      return S.createSession({ items, stats: { containerSize: spec.length }, dayKey: '2026-02-14' },
        { words, mem, now: day });
    };
    const runOf = (s) => {
      let run = 0, max = 0;
      for (const c of s.queue) {
        if (c.tier === 3 && !c.isRetry) { run++; max = Math.max(max, run); }
        else run = 0;
      }
      return max;
    };
    // 把守卫的判定函数暴露给测试，避免测试自己重写一遍逻辑（重写就测不到真东西）
    const isNewCard = globalThis.__VS_isNewCard;

    const mark = (s) => s.queue.map((c) => (isNewCard(c) ? 'N' : 'R')).join('');
    const readout = (s) => s.queue.map((c) => (isNewCard(c) ? '新' : '复')).join(' ');

    // 用例 A：2 个复习词 + 4 个新词，上限 2 → 需要 1 个间隔，够用。
    // 注意：createSession 自己就会跑一次守卫，所以这里拿到的队列已经整理过了。
    const sA = mk([1, 1, 3, 3, 3, 3]);
    ok(sA.queue.length === 6, '队列长度正确（' + sA.queue.length + '）');
    ok(/(N{3,})/.test(mark(sA)) === false, '开局守卫已把连续新词压到 ≤2（' + mark(sA) + '）');
    ok((mark(sA).match(/R/g) || []).length === 2, '复习词一张不多一张不少（' + mark(sA) + '）');
    const rA = S.ensureNewWordCap(sA, 2);
    ok(runOf(sA) <= 2, '再跑一次守卫仍然 ≤2（实测 ' + runOf(sA) + '）', '结果 ' + readout(sA));
    ok(sA.queue.length === 6, '拆卡是重排而不是丢失卡片（仍 ' + sA.queue.length + ' 张）');
    ok(new Set(sA.queue).size === 6, '拆卡不产生重复卡片（' + new Set(sA.queue).size + ' 张唯一）');

    // 用例 B：上限参数生效 —— 收到 1 就不许出现两个连续新词
    // （4 个复习词 + 4 个新词，上限 1 需要 3 个间隔，刚好够）
    const sB = mk([1, 1, 1, 1, 3, 3, 3, 3]);
    const rB = S.ensureNewWordCap(sB, 1);
    ok(rB.applied === true, '上限=1 时守卫确实动了队列（实插 ' + rB.moved + ' 张）', '结果 ' + readout(sB));
    ok(runOf(sB) <= 1, '上限=1 → 连续新词 ≤1（实测 ' + runOf(sB) + '）', '结果 ' + readout(sB));
    ok(new Set(sB.queue).size === 8, '上限=1 也不产生重复卡片（' + new Set(sB.queue).size + ' 张唯一）');

    // 用例 D：已走过的部分不许被改动（用户看过的历史不能变）
    (() => {
      const sD = mk([1, 3, 3, 3, 3, 3, 1, 3]);
      sD.cursor = 3; // 假装已经答完前 3 张
      const head = sD.queue.slice(0, 3);
      S.ensureNewWordCap(sD, 2);
      const headAfter = sD.queue.slice(0, 3);
      ok(headAfter.every((c, i) => c === head[i]), '已走过的 3 张卡一字未动');
      ok(sD.queue.length === 8, '重塑后总数不变（' + sD.queue.length + ' 张）');
      ok(new Set(sD.queue).size === 8, '重塑后无重复卡（' + new Set(sD.queue).size + ' 张唯一）');
      // 统计 cursor 之后的最大连续新词
      let run = 0, max = 0;
      for (let i = 3; i < sD.queue.length; i++) {
        if (isNewCard(sD.queue[i])) { run++; max = Math.max(max, run); } else run = 0;
      }
      ok(max <= 2, 'cursor 之后连续新词 ≤2（实测 ' + max + '）');
    })();

    // 用例 C：全是新词时不许撒谎 —— 没有复习词可插，就该如实报告未生效
    const sC = mk([3, 3, 3, 3, 3, 3, 3, 3]);
    const rC = S.ensureNewWordCap(sC, 2);
    ok(rC.applied === false, '队列里全是新词 → 如实报告「拆不动」');
    ok(runOf(sC) === 8, '拆不动时不篡改队列（仍为 ' + runOf(sC) + '）');
  })();

  // ⑨ 假掌握：错误计数净增 +2（种子词库会预置 e=0.3，所以只断言增量）
  (() => {
    const words = L.seedFor('cet4').slice(0, 20);
    const mem = L.seedMemories(words, {}, day);
    const items = words.map((w) => ({ word: w, mem: mem[w.id], tier: 1, reason: null }));
    const s = S.createSession({ items, stats: { containerSize: 20 }, dayKey: '2026-02-14' }, { words, mem, now: day });
    const card = S.currentCard(s);
    const e0 = s.mem[card.word.id].e;
    S.reportFakeMastery(s, card, 'x', { now: day });
    const e1 = s.mem[card.word.id].e;
    ok(Math.abs((e1 - e0) - 2) < 1e-9, '假掌握后错误计数净增 +2', e0.toFixed(1) + ' → ' + e1.toFixed(1));
  })();

  // ⑩ 「收服」判定必须硬：没在辨词里答对过就不算（§7.5）
  (() => {
    const w = L.seedFor('cet4')[0];
    let m = M.newMemory({ e: 0 }, day);
    m = Object.assign(m, { encodeCount: 9, correct: 9, stability: 20, difficulty: 0, lastSeenTs: day, reactionMs: 1200 });
    ok(M.isConquered(m, day) === false, '强度高但没辨词答对 → 不算收服');
    const m2 = M.markQuizCorrect(m, day);
    ok(M.isConquered(m2, day) === true, '辨词答对后 → 算收服');
    void w;
  })();

  // ⑪ 辨词干扰项必须「真难」（§5.3）
  (() => {
    const words = L.seedFor('cet4');
    const target = words.find((w) => w.word === 'adapt');
    const picks = MK.pickDistractors(target, words, { count: 3, rand: () => 0.5 });
    ok(picks.length === 3, '给出 3 个干扰项', '实际 ' + picks.length);
    const sims = picks.map((p) => MK.similarity(target.word, p.word));
    ok(Math.max.apply(null, sims) >= 0.6, '干扰项里至少有一个形近（最高相似度 ' + Math.max.apply(null, sims).toFixed(2) + '）');
    ok(picks.every((p) => p.id !== target.id), '不把自己当干扰项');
  })();

  // ⑫ 安全阀：同一对被 ⚑ ≥2 次 → 永久拉黑（§5.3）
  (() => {
    let c = {};
    c = MK.flagConfusion(c, 'a', 'b');
    ok(c[MK.pairKey('a', 'b')].blacklisted === false, '标 1 次还不拉黑');
    c = MK.flagConfusion(c, 'a', 'b');
    ok(c[MK.pairKey('a', 'b')].blacklisted === true, '标 2 次永久拉黑');
    const words = L.seedFor('cet4');
    const target = words.find((w) => w.word === 'adapt');
    const partner = words.find((w) => w.word === 'adopt');
    const picks = MK.pickDistractors(target, words, { count: 3, confusions: MK.flagConfusion(MK.flagConfusion({}, target.id, partner.id), target.id, partner.id) });
    ok(!picks.some((p) => p.id === partner.id), '被拉黑的干扰项不再出现');
  })();

  // ⑬ 记忆模型：错得越多，半衰期越短、复现越密
  (() => {
    const good = Object.assign(M.newMemory({ e: 0 }, day), { encodeCount: 6, correct: 6, stability: 4, difficulty: 0.1 });
    const bad = Object.assign(M.newMemory({ e: 6 }, day), { encodeCount: 6, correct: 0, stability: 0, difficulty: 0.9 });
    ok(M.halfLifeDays(good) > M.halfLifeDays(bad), '真会了的半衰期更长',
      M.halfLifeDays(good).toFixed(2) + ' vs ' + M.halfLifeDays(bad).toFixed(2));
    ok(M.recallProb(good, 3) > M.recallProb(bad, 3), '3 天后「会了」的词记得更牢');
  })();

  // ⑭ 保持曲线：按排期走必须优于不管它（§7.5 证据②）
  (() => {
    const words = L.seedFor('cet4').slice(0, 20);
    const mems = words.map((w) => M.newMemory({ e: 1 }, day));
    const cur = M.retentionCurve(mems, { days: 30, now: day });
    const s30 = cur.scheduled[cur.scheduled.length - 1].recall;
    const p30 = cur.passive[cur.passive.length - 1].recall;
    ok(s30 > p30, '30 天后：按排期 > 不管它', s30.toFixed(2) + ' vs ' + p30.toFixed(2));
  })();

  // ⑮ 情绪胶囊：优先级取第一个命中 + 零指责文案（§3.1）
  (() => {
    const first = B.beckonState({ hasRecords: false, streak: {}, gapDays: 0, dueCount: 0 });
    ok(first.state === 'first', '无记录 → 今天第一词', first.state);
    const gone = B.beckonState({ hasRecords: true, streak: { current: 0, longest: 23 }, gapDays: 5, dueCount: 180, containerSize: 12 });
    ok(gone.state === 'longGone', '断签 → 好久不见（优先于欠账）', gone.state);
    ok(gone.label.indexOf('23') >= 0, '用旧荣耀接住：' + gone.label);
    ok(!/落后|欠|还剩|未完成/.test(gone.label), '断签文案零指责');
    const handoff = B.beckonState({ hasRecords: true, streak: { current: 7 }, gapDays: 0, containerSize: 20, containerDone: 5, roundJustFinished: true, streamActive: true });
    ok(handoff.state === 'handoff', '任务在输出 + 刚答完 → 交接态', handoff.state);
    ok(handoff.needsAction === false, '胶囊不要求任何动作');
    const learning = B.beckonState({ hasRecords: true, streak: { current: 7 }, gapDays: 0, session: { cursor: 1, queue: [1, 2, 3] }, streamActive: true });
    ok(learning.state === 'learning', '任务在输出且没答完 → 学词中', learning.state);
  })();

  // ⑯ 词库降级：拉取失败要有种子库顶上，且不阻塞（§4.2）
  ok(L.seedFor('cet4').length > 100, '内置种子词库可用（' + L.seedFor('cet4').length + ' 词）');
  ok(L.seedFor('cet4').every((w) => w.word && w.ipa && w.meaning), '种子词条字段完整');
  ok(L.isPureEnglish('abandon') === true, '纯英文可收藏');
  ok(L.isPureEnglish('这是一个词') === false, '中文不触发收藏');

  // ⑰ 时间只作参考显示，不参与约束（§6.1.1）
  ok(M.estimateMinutes(20) >= 5 && M.estimateMinutes(20) <= 12, '20 词预估约 ' + M.estimateMinutes(20) + ' 分钟');

  // ⑱ UI 层要用的 core API 必须真的挂上了（这类缺失只在切到某个标签页时才炸）
  (() => {
    const need = {
      Q: ['buildDailyContainer', 'containerSize', 'dayKey', 'bumpStreak', 'isCheckedIn'],
      M: ['recallProb', 'strength', 'retentionCurve', 'estimateMinutes', 'isConquered'],
      MK: ['diagnosis', 'pickDistractors', 'similarity', 'activePairs'],
      G: ['levelFor', 'expFor', 'conqueredCount'],
      L: ['seedFor', 'seedMemories', 'extractWordsFromText'],
      B: ['beckonState'],
    };
    const missing = [];
    for (const ns of Object.keys(need)) {
      const bag = VOCAB_CORE[ns];
      if (!bag) { missing.push(ns + '（整个命名空间缺失）'); continue; }
      for (const fn of need[ns]) {
        if (typeof bag[fn] !== 'function') missing.push(ns + '.' + fn);
      }
    }
    ok(missing.length === 0, 'UI 需要的 core API 全部就位', '缺失：' + missing.join(', '));
  })();

  out.unshift('core 自检：' + pass + ' 通过 / ' + fail + ' 失败');
  if (details.length) {
    out.push('');
    out.push('── 失败详情 ──');
    for (const d of details) out.push(d);
  }
  return out;
};
"""


def top_level_decls(src):
    """抓出真正的顶层（花括号层深为 0）声明标识符。

    单文件构建时 core 各模块共享一个作用域，两个模块在顶层声明同名 const/function
    会让整个 <script> 解析失败 —— 页面直接一片黑，且没有任何报错可见。
    所以在构建时就把它拦下来。

    注意：不能只看行首缩进 —— 函数体里的 `const next = ...` 也是顶格的。
    必须按花括号层深判断。

    例外：`const X = M.X;` 这种「自别处取来的别名」不算新实体 —— 但在共享作用域里
    它仍然与 M.X 的原始声明同名，依然会报重复声明，所以这种写法本身就该避免。
    检测器一律报出来，由人改成「直接用，别声明」。
    """
    names = []
    depth = 0
    for raw in src.split("\n"):
        line = raw.strip()
        # 先看这一行是不是在层深 0 上声明东西
        if depth == 0:
            m = re.match(r"^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)", line)
            if m:
                names.append(m.group(1))
        # 再更新层深（用最小 JS 词法：去字符串、去行注释后数花括号）
        code = re.sub(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|`(?:[^`\\]|\\.)*`", "", line)
        code = re.sub(r"//.*$", "", code)
        depth += code.count("{") - code.count("}")
        if depth < 0:
            depth = 0
    return names


def check_collisions(chunks):
    """chunks: [(ns, path, src)]；同名顶层声明直接报错并给出解法。"""
    seen = {}
    dupes = []
    for ns, path, src in chunks:
        for name in top_level_decls(src):
            if name in seen and seen[name][0] != ns:
                dupes.append((name, "%s (%s)" % (seen[name][1], seen[name][0]), "%s (%s)" % (path, ns)))
            else:
                seen[name] = (ns, path)
    if dupes:
        lines = ["单文件构建时顶层标识符撞名，会让整个 <script> 解析失败（页面直接一片黑）："]
        for name, a, b in dupes:
            lines.append("  · %s   出现在 %s 与 %s" % (name, a, b))
        lines.append("解法：只保留一处声明，另一处改成引用，例如 const DAY_MS = M.DAY_MS;")
        raise SystemExit("\n".join(lines))


# 自检页脚本：跑一遍外壳检查 + core 内核断言，把结果画在页面上。
# 关键点：捕获到的错误要连「出错那一行的源码」一起打出来 ——
# 否则单文件产物里只能看到一个行号，等于没有信息。
SMOKE_SCRIPT = u"""
(function () {
  var problems = [];

  function lineOf(stack) {
    // 从 stack 里找 file:///...#:行:列
    var m = /(\\d+):\\d+/.exec(stack || '');
    return m ? parseInt(m[1], 10) : 0;
  }
  function sourceAt(line) {
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.src) continue;
      var n = s.textContent.split('\\n').length;
      if (line <= n) {
        var lines = s.textContent.split('\\n');
        var from = Math.max(0, line - 4), to = Math.min(lines.length, line + 2);
        var buf = [];
        for (var j = from; j < to; j++) {
          buf.push((j + 1 === line ? '>> ' : '   ') + (j + 1) + ' | ' + lines[j]);
        }
        return buf.join('\\n');
      }
      line -= n;
    }
    return '(找不到源码行)';
  }
  function note(kind, msg, stack) {
    var line = lineOf(stack);
    problems.push(kind + ': ' + msg + '\\n    位置: 第 ' + line + ' 行\\n' + sourceAt(line));
  }

  // 同步执行一段代码并把异常连同源码行一起记下来 —— 比 window.onerror 的行号可靠
  window.__vsTry = function (label, fn) {
    try {
      return fn();
    } catch (err) {
      var stack = (err && err.stack) || '';
      problems.push('THROW @ ' + label + ': ' + (err && err.message) + '\\n' + stack.split('\\n').slice(0, 4).join('\\n'));
      paint();
      return undefined;
    }
  };

  window.addEventListener('error', function (e) {
    note('ERROR', e.message || e.type, e.error && e.error.stack ? e.error.stack : '');
    paint();
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    note('REJECT', (r && (r.message || r)) + '', r && r.stack ? r.stack : '');
    paint();
  });

  function paint() {
    var box = document.getElementById('vs-smoke');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'vs-smoke';
      box.style.cssText = 'position:fixed;left:0;top:0;right:0;max-height:70vh;overflow:auto;margin:0;' +
        'padding:10px 14px;background:#3A1414;color:#FFD9D4;font:12px/1.5 Consolas,monospace;z-index:99999;' +
        'white-space:pre-wrap;';
      document.body.appendChild(box);
    }
    box.textContent = '启动期问题 ' + problems.length + ' 个\\n\\n' + problems.join('\\n\\n');
  }

  window.__vsSmoke = function () {
    var out = [];
    var pass = 0, fail = 0;
    function has(sel, label) {
      var ok = !!document.querySelector(sel);
      if (ok) pass++; else fail++;
      out.push((ok ? 'PASS' : 'FAIL') + '  ' + label + '   ' + sel);
      return ok;
    }

    // ① 外壳
    has('.dsh-demo', '外壳渲染');
    has('.vs-capsule', '胶囊在工具栏');
    has('#seat-perm', '权限选择器');

    // ② 胶囊位置：必须在「权限」与「模型」之间
    var toolbar = document.querySelector('.dsh-toolbar');
    var order = toolbar ? Array.prototype.map.call(toolbar.querySelectorAll('.dsh-seat, .vs-capsule'), function (n) {
      return n.id === 'seat-perm' ? 'permission'
        : (n.classList.contains('vs-capsule') ? 'vocab'
        : (n.textContent.indexOf('模型') >= 0 ? 'model' : n.textContent.trim()));
    }) : [];
    out.push('INFO  工具栏顺序: ' + order.join(' → '));
    var between = order.indexOf('permission') < order.indexOf('vocab') && order.indexOf('vocab') < order.indexOf('model');
    if (between) pass++; else fail++;
    out.push((between ? 'PASS' : 'FAIL') + '  胶囊在权限与模型之间');

    // ③ 点开面板（显式 try/catch：单文件产物里的抛错行号不可靠）
    var cap = document.querySelector('.vs-capsule');
    var openErr = '';
    if (cap) {
      try {
        cap.click();
      } catch (err) {
        openErr = (err && err.message) + '\\n' + ((err && err.stack) || '').split('\\n').slice(0, 6).join('\\n');
      }
    }
    if (openErr) {
      out.push('THROW  点开面板时抛错：');
      out.push(openErr);
      out.push('');
    }
    has('.vs-panel', '面板打开');
    has('.vs-word', '词卡出现');
    has('.vs-ratings .vs-rate[data-k="forgot"]', '三个自评按钮');
    has('.vs-card', '卡片容器');
    has('#vs-stage', '卡片正文区');

    // ④ 焦点纪律：焦点在输入框时按 1 绝不动卡片
    var ta = document.getElementById('dsh-ta');
    var before = document.querySelector('.vs-word') ? document.querySelector('.vs-word').textContent : '';
    var revealedBefore = !!document.querySelector('.vs-meaning');
    if (ta) {
      ta.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      var after = document.querySelector('.vs-word') ? document.querySelector('.vs-word').textContent : '';
      var revealedAfter = !!document.querySelector('.vs-meaning');
      var ok1 = after === before && revealedAfter === revealedBefore;
      if (ok1) pass++; else fail++;
      out.push((ok1 ? 'PASS' : 'FAIL') + '  焦点在输入框时按 1 不动卡片（' + before + '，揭晓态 ' + revealedBefore + ' → ' + revealedAfter + '）');
    }

    // ⑤ 快捷键接管：焦点在面板时按 1 应揭晓
    var panel = document.querySelector('.vs-panel');
    if (panel) {
      panel.focus();
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      has('.vs-meaning', '焦点在面板时按 1 揭晓答案');
      has('.vs-actions .vs-btn.primary', '揭晓后有「下一张」');
    }

    // ⑥ 连击动效只在面板内；答对后底部应出现连击
    out.push('INFO  ' + (problems.length ? '启动期有 ' + problems.length + ' 个错误' : '启动期无错误'));

    // ⑦ core 内核断言
    out.push('');
    out.push('core 内核断言：');
    out = out.concat(window.__vsCoreSelfTest ? window.__vsCoreSelfTest() : ['SKIP  core 自检未注入']);

    out.unshift('外壳检查：' + pass + ' 通过 / ' + fail + ' 失败');
    if (problems.length) {
      out.splice(1, 0, '', '启动期问题：');
      for (var i = 0; i < problems.length; i++) out.splice(2 + i, 0, problems[i]);
      out.splice(2 + problems.length, 0, '');
    }

    var text = out.join('\\n');
    document.body.innerHTML = '';
    var pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:16px;background:#101010;color:#D8F0D0;font:12px/1.6 Consolas,monospace;white-space:pre-wrap;';
    pre.textContent = text;
    document.body.appendChild(pre);
    return text;
  };

  setTimeout(function () { window.__vsSmoke(); }, 700);
})();
"""


def check_selftest_symbols():
    """自检脚本里用的 API 必须真实存在。

    内联自检是拼进产物里的字符串，写错一个方法名（比如 S.isNewCardForTest）
    只有打开页面才炸，而且报错淹没在满屏结果里。这里在构建期就拦住。
    """
    ns_exports = {ns: set(syms) for ns, syms in CORE_EXPORTS.items()}
    ui_exports = {key: set(symbols) for key, _path, symbols in UI}
    ns_exports.update(ui_exports)

    bad = []
    for m in re.finditer(r"\b([A-Z][A-Z_]*|UI_[A-Z]+)\.([A-Za-z_$][\w$]*)", CORE_SELFTEST):
        ns, member = m.group(1), m.group(2)
        if ns not in ns_exports:
            continue  # 不是我们的命名空间
        if member not in ns_exports[ns]:
            bad.append("%s.%s" % (ns, member))
    if bad:
        raise SystemExit(
            "自检脚本里用到了不存在的 API：%s\n"
            "先把它加进 build.py 的 CORE_EXPORTS（或从自检里去掉）。" % ", ".join(sorted(set(bad)))
        )


# 预览页脚本：启动后自动点开面板，可选切到某个标签页或揭晓答案。
# 真装进 DSH 之后面板绝不会自己打开（§P1）——这里只是演示/截图需要。
# 里面的 %s 由 build() 替换成模式名（card / reveal / progress / settings / vocab）。
PREVIEW_SCRIPT = u"""
(function () {
  var MODE = '%s';
  setTimeout(function () {
    function show(msg) {
      var b = document.getElementById('vs-preview-err') || document.createElement('pre');
      b.id = 'vs-preview-err';
      b.style.cssText = 'position:fixed;left:0;top:0;right:0;max-height:40vh;overflow:auto;margin:0;padding:10px;' +
        'background:#3A1414;color:#FFD9D4;font:12px/1.5 Consolas,monospace;z-index:99999;white-space:pre-wrap;';
      b.textContent = msg;
      document.body.appendChild(b);
    }
    window.addEventListener('error', function (e) {
      show('ERROR: ' + e.message + '\\n' + ((e.error && e.error.stack) || ''));
    });
    try {
      var cap = document.querySelector('.vs-capsule');
      if (!cap) { show('找不到胶囊：外壳没渲染出来。body 长度=' + document.body.innerHTML.length); return; }
      cap.click();

      function clickTab(text) {
        var tab = Array.prototype.find.call(document.querySelectorAll('.vs-tab'), function (t) {
          return t.textContent.indexOf(text) >= 0;
        });
        if (tab) tab.click();
        else show('找不到标签页「' + text + '」');
      }

      if (MODE === 'reveal' || MODE === 'hook') {
        clickTab('今日');
        setTimeout(function () {
          var rate = document.querySelector('.vs-rate[data-k="known"]');
          if (rate) rate.click();
          else show('找不到「会了」按钮');
          if (MODE === 'hook') {
            // 再点「✨ 让我记住它」，把记忆钩子截进图里（§9）
            setTimeout(function () {
              var ai = document.querySelector('.vs-ai-btn');
              if (ai) ai.click();
              else show('找不到「让我记住它」按钮');
            }, 900);
          }
        }, 900);
      } else if (MODE === 'progress') {
        clickTab('进度');
      } else if (MODE === 'settings') {
        clickTab('设置');
      } else if (MODE === 'vocab') {
        clickTab('生词本');
      }
    } catch (err) {
      show('THROW: ' + err.message + '\\n' + (err.stack || ''));
    }
  }, 500);
  // 预览是给截图/肉眼看的：链式点击要留够时间，否则截到的是中间态。
  // （截图工具在页面 load 后不久就抓，所以这里的延时必须宽裕。）
})();
"""


def build():
    check_selftest_symbols()
    core_chunks = []
    for ns, path in CORE_ORDER:
        src = prepare_core(read(path), path)
        assert_available(src, CORE_EXPORTS[ns], path)
        core_chunks.append((ns, path, src))
    # 共享作用域 → 必须保证没有顶层重名
    check_collisions(core_chunks)
    core_text = "".join(u"\n// ═══════════ %s → %s ═══════════\n%s\n" % (path, ns, src)
                        for ns, path, src in core_chunks)

    # core 是同一个作用域，跨模块引用（M.xxx / Q.yyy）天然成立。
    # 最后再把每个模块的公开面收成命名空间对象。
    ns_lines = []
    for ns, path in CORE_ORDER:
        names = []
        for sym in CORE_EXPORTS[ns]:
            alias = CORE_ALIASES.get("%s.%s" % (ns, sym))
            names.append("%s: %s" % (sym, alias) if alias else sym)
        ns_lines.append("const %s = { %s };" % (ns, ", ".join(names)))

    out = []
    stamp = datetime.datetime.now().isoformat(timespec="seconds")
    out.append(u"""/*
 * vocab-study · 自包含构建产物 —— 请勿直接编辑
 * 源码在 core/ 与 ui/，改动后重跑：python tools/build.py
 * 构建时间：%s
 */
'use strict';
""" % stamp)

    out.append(u"\n// ╔══════════════════════════════════════════════════════════╗\n"
               u"// ║  core/ —— 纯逻辑，零宿主依赖（跨模块共享一个作用域）        ║\n"
               u"// ╚══════════════════════════════════════════════════════════╝\n")
    out.extend([core_text])
    out.append(u"\n// ── 收成命名空间（供 UI 层与外部使用）──\n" + "\n".join(ns_lines) + "\n")

    out.append(u"\nconst VOCAB_CORE = { %s };\n" % ", ".join(ns for ns, _ in CORE_ORDER))

    # 注入一段浏览器里可跑的核心自检（P0 验收里「core 全量单测通过」的现场版）。
    # 注意它必须在**所有命名空间建好之后**才执行：CORE_SELFTEST 只定义了
    # window.__vsCoreSelfTest 这个函数，真正的调用放在下面的启动段里。
    out.append(CORE_SELFTEST)

    for key, path, symbols in UI:
        src = prepare_ui(read(path), path)
        assert_available(src, symbols, path)
        assert_core_keys(src, path)
        out.append(u"\n// ═══════════ %s → %s ═══════════\nVOCAB_CORE.%s = (() => {\n%s\nreturn { %s };\n})();\n"
                   % (path, key, key, src, ", ".join(symbols)))

    out.append(u"""
// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════
(function () {
  // 顺序有讲究，三个步骤谁都别抢在谁前面：
  //   ① 登记命名空间（依赖 UI_CORE_REF 已建好）
  //   ② 跑 core 自检（要读 ① 的结果，验证界面层真的拿到了命名空间）
  //   ③ 启动外壳
  // 曾经把 ① 塞进自检函数体里，结果自检在 UI_CORE_REF 之前执行，
  // 直接抛 “无法读取 undefined 的 setCore”，把 ③ 一起带走 ——
  // 症状就是外壳 11 项全 FAIL、页面什么都没有。
  VOCAB_CORE.UI_CORE_REF.setCore(VOCAB_CORE);

  const probe = VOCAB_CORE.UI_CORE_REF.getCore();
  window.__vsCoreSelfTest = (function (original) {
    return function () {
      const report = original.apply(this, arguments);
      try {
        const passed = !!probe && !!probe.queue && typeof probe.queue.buildDailyContainer === 'function';
        report.push((passed ? 'PASS ' : 'FAIL ') + '界面层已拿到 core 命名空间（Q.buildDailyContainer 可见）');
      } catch (err) {
        report.push('FAIL 界面层命名空间探针抛错: ' + err.message);
      }
      return report;
    };
  })(window.__vsCoreSelfTest);

  const root = document.getElementById('dsh-root');
  if (root) VOCAB_CORE.UI_SHELL.boot(root);

  // 把命名空间挂一份到 window：浏览器控制台里可以直接敲
  // VOCAB_CORE.queue.dayKey(Date.now()) 查状态，自动化测试也能读到它。
  // （顶层 `const` 在浏览器里是词法绑定，外面的脚本看不见，
  //   所以这里必须显式暴露，不能指望它自己出现。）
  window.VOCAB_CORE = VOCAB_CORE;
})();
""")

    bundle = "".join(out)
    write("demo/app.js", bundle)

    # ── 样式分两步走：插件样式 + 演示外壳样式 ──────────────────────────
    # 两者必须物理分开。外壳样式里有全局 `body` 选择器，只对 demo 无害；
    # 一旦混进插件产物，注入 DSH 真实页面就会覆盖宿主的 body 样式，
    # 把界面搞坏（实测：界面上很多按钮失效）。
    plugin_css = assert_plugin_css(read("ui/styles.css"))
    shell_css = read("demo/shell.css")
    css = plugin_css + "\n" + shell_css
    html = u"""<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日词汇 · Vocab Study（DSH 插件预览）</title>
<style>
%s
</style>
</head>
<body>
<div id="dsh-root"></div>
<script>
%s
</script>
<script>
/* ── 演示外壳的启动期错误捕获 ────────────────────────────────
   构建产物若在启动时抛错，页面会是一片黑，看不出原因。
   这里把错误与自检结果画到页面上，方便（也让截图工具能）直接看到。 */
(function () {
  var problems = [];
  window.addEventListener('error', function (e) {
    problems.push('ERROR: ' + (e.message || e.type) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
    paint();
  });
  window.addEventListener('unhandledrejection', function (e) {
    problems.push('REJECT: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
    paint();
  });

  function paint() {
    var box = document.getElementById('vs-smoke');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'vs-smoke';
      box.style.cssText = 'position:fixed;left:0;top:0;right:0;max-height:60vh;overflow:auto;margin:0;' +
        'padding:10px 14px;background:#3A1414;color:#FFD9D4;font:12px/1.5 Consolas,monospace;z-index:99999;' +
        'white-space:pre-wrap;';
      document.body.appendChild(box);
    }
    box.textContent = '启动期问题 ' + problems.length + ' 个\\n\\n' + problems.join('\\n\\n');
  }

  window.__vsSmoke = function () {
    var out = [];
    function has(sel, label) {
      var ok = !!document.querySelector(sel);
      out.push((ok ? 'PASS' : 'FAIL') + '  ' + label + '   ' + sel);
      return ok;
    }
    has('.dsh-demo', '外壳渲染');
    has('.vs-capsule', '胶囊在工具栏');
    has('#seat-perm', '权限选择器');
    has('#dsh-right-group .dsh-seat', '模型选择器');

    // 胶囊是否真的落在「权限 ↔ 模型」之间
    var toolbar = document.querySelector('.dsh-toolbar');
    var order = toolbar ? Array.prototype.map.call(toolbar.querySelectorAll('.dsh-seat, .vs-capsule'), function (n) {
      return n.id === 'seat-perm' ? 'permission' : (n.classList.contains('vs-capsule') ? 'vocab' : (n.textContent.indexOf('模型') >= 0 ? 'model' : n.textContent.trim()));
    }) : [];
    out.push('INFO  工具栏顺序: ' + order.join(' → '));
    var between = order.indexOf('permission') < order.indexOf('vocab') && order.indexOf('vocab') < order.indexOf('model');
    out.push((between ? 'PASS' : 'FAIL') + '  胶囊在权限与模型之间');

    // 点开面板
    var cap = document.querySelector('.vs-capsule');
    if (cap) { cap.click(); }
    has('.vs-panel', '面板打开');
    has('.vs-word', '词卡出现');
    has('.vs-ratings .vs-rate[data-k="forgot"]', '三个自评按钮');

    // 快捷键隔离：焦点在输入框时按 1 不应改卡片
    var ta = document.getElementById('dsh-ta');
    var before = document.querySelector('.vs-word') ? document.querySelector('.vs-word').textContent : '';
    if (ta) {
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      var after = document.querySelector('.vs-word') ? document.querySelector('.vs-word').textContent : '';
      var revealed = !!document.querySelector('.vs-meaning');
      out.push((after === before && !revealed ? 'PASS' : 'FAIL') + '  焦点在输入框时按 1 不改卡片（' + before + ' → ' + after + '）');
    }

    // 快捷键接管：焦点在面板时按 1 应揭晓
    var panel = document.querySelector('.vs-panel');
    if (panel) {
      panel.focus();
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      has('.vs-meaning', '焦点在面板时按 1 揭晓答案');
    }

    if (problems.length) {
      out.push('');
      out.push('启动期问题：');
      out = out.concat(problems);
    }

    // 启动探测：外壳没出现时，这几行能直接指出是哪一步断的。
    // （这一轮排查没有它就只剩猜，代价太大，索性常驻。）
    (function () {
      var rootEl = document.getElementById('dsh-root');
      out.push('');
      out.push('启动探测：');
      out.push('  #dsh-root 存在 = ' + !!rootEl + '，子节点 = ' + (rootEl ? rootEl.children.length : 'n/a'));
      out.push('  document.body 子节点 = ' + document.body.children.length);
      out.push('  VOCAB_CORE 存在 = ' + (typeof VOCAB_CORE !== 'undefined'));
      if (typeof VOCAB_CORE !== 'undefined') {
        out.push('  VOCAB_CORE 键 = ' + Object.keys(VOCAB_CORE).join(','));
        out.push('    UI_SHELL.boot 类型 = ' + typeof (VOCAB_CORE.UI_SHELL && VOCAB_CORE.UI_SHELL.boot));
        out.push('    UI_CORE_REF.getCore 类型 = ' + typeof (VOCAB_CORE.UI_CORE_REF && VOCAB_CORE.UI_CORE_REF.getCore));
        var g = VOCAB_CORE.UI_CORE_REF && VOCAB_CORE.UI_CORE_REF.getCore
          ? VOCAB_CORE.UI_CORE_REF.getCore() : null;
        out.push('    getCore().queue.dayKey 类型 = ' + typeof (g && g.queue && g.queue.dayKey));
      }
      var bootBox = document.getElementById('vs-boot-error');
      out.push('  启动失败提示框存在 = ' + !!bootBox);
    })();

    out.push('');
    out.push('核心自检：');
    out = out.concat(window.__vsCoreSelfTest ? window.__vsCoreSelfTest() : ['SKIP  core 自检未注入']);

    var text = out.join('\\n');
    document.body.innerHTML = '';
    var pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:16px;background:#101010;color:#D8F0D0;font:12px/1.6 Consolas,monospace;white-space:pre-wrap;';
    pre.textContent = text;
    document.body.appendChild(pre);
    return text;
  };

  if (location.search.indexOf('smoke') >= 0) setTimeout(function () { window.__vsSmoke(); }, 900);
})();
</script>
</body>
</html>
""" % (css, bundle)
    write("demo/index.html", html)

    # 自检页：启动后立刻跑「外壳检查 + core 内核断言」，把结果画在页面上。
    # 单独一个文件是因为截图工具不认 ?query。
    write("demo/smoke.html", html.replace(
        u"<div id=\"dsh-root\"></div>",
        u"<div id=\"dsh-root\"></div>\n<script>\n%s\n</script>" % SMOKE_SCRIPT
    ).replace(u"<title>", u"<title>[自检] "))

    # 预览页：启动后自动点开面板，用于截图与肉眼检查。
    # 真装进 DSH 之后面板绝不会自己打开（§P1）——这里只是演示/截图需要。
    # 截图工具不认 ?query 与 #hash，所以每种状态单独出一个文件。
    for name, mode in [("preview", "card"), ("preview-reveal", "reveal"),
                       ("preview-hook", "hook"),
                       ("preview-progress", "progress"), ("preview-settings", "settings"),
                       ("preview-vocab", "vocab")]:
        write("demo/%s.html" % name, html.replace(
            u"<div id=\"dsh-root\"></div>",
            u"<div id=\"dsh-root\"></div>\n<script>\n%s\n</script>" % (PREVIEW_SCRIPT % mode)
        ).replace(u"<title>", u"<title>[预览·%s] " % mode))

    print(u"✓ demo/app.js  (%.1f KB)" % (len(bundle) / 1024.0))
    print(u"✓ demo/index.html  —— 双击即可打开")
    print(u"✓ demo/smoke.html  —— 自检页")
    for ns, path in CORE_ORDER:
        print(u"   core %-5s %s" % (ns, path))
    for key, path, _ in UI:
        print(u"   ui   %-10s %s" % (key, path))


if __name__ == "__main__":
    build()
