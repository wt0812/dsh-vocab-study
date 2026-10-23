#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
vocab-study / tools / build-plugin.py

把 core/ + store/ + ui/ + adapter/dsh/ 打成**真正的 DSH 客户端插件**产物：

    lib/client.js          经 window.__ModuleLoader__.load 注册的客户端半
    lib/index.js           Host 侧入口（本插件没有 Host 逻辑，但不能少这一个面）

它和 tools/build.py 共用同一批源码文件，只是打包方式不同：
  · build.py        摊平成一个自包含 HTML（demo，能双击打开看效果）
  · build-plugin.py 摊平成 __ModuleLoader__ 工厂（真插件，装进 DSH）

为什么能共用：core/ 与 ui/ 里没有任何 import 是宿主相关的，唯一的运行时
外部依赖是 React，而它只在 adapter/dsh/client.js 里出现 —— 由宿主的
模块加载器解析。

用法：python tools/build-plugin.py
"""

import io
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PKG = os.path.basename(ROOT)
PKG_ID = "dsh-vocab-study"

# 「代码/非代码」分离器只有一份实现（tools/lib/dangling.py），验证脚本
# tools/verify-dangling-guard.mjs 也调它 —— 两边判据必须一致，不能再各写一份。
sys.path.insert(0, os.path.join(HERE, "lib"))
from dangling import mask_non_code  # noqa: E402

# 每个 core 文件对外暴露的符号。摊平后这些都会变成作用域里的裸声明，
# 所以这张表既是「命名空间重组」的依据，也是「漏导出」的检查依据。
# 改动 core 的导出时，这里必须同步 —— 不同步会在构建期报错，不会拖到运行时。
CORE_EXPORTS = [
    ("M", ["DEFAULT_THETA", "DAY_MS", "newMemory", "features", "halfLifeDays", "recallProb",
           "strength", "isConquered", "dueAt", "isDue", "isWeak", "WEAK_THRESHOLD",
           "encode", "markQuizCorrect", "retentionCurve", "estimateMinutes"]),
    ("MK", ["errorDelta", "applyError", "pairKey", "noteConfusion", "flagConfusion",
            "pairsNeedingDrill", "activePairs", "blacklistedPartners", "similarity",
            "ERROR_KIND", "classifyError", "diagnosis", "pickDistractors"]),
    ("SEED", ["SEED_CET4_RAW", "SEED_COLLECTIONS"]),
    # 四级词表补全部分（见 tools/make-cet4-extra.mjs）。手写 116 词之外的考纲词。
    ("C4X", ["SEED_CET4_EXTRA_RAW"]),
    # 各考纲词库的内置词表（生成产物，见 tools/make-seeds.mjs）。
    # ⚠️ 这个注册表有**两份**：这里和 tools/build.py 的 CORE_EXPORTS。
    # 一次只改一份的话，另一条构建路径会报
    # `SEED_CET6 is not defined` —— 包看着构建成功，一加载就崩。
    ("SEEDX", ["SEED_CET6", "SEED_KAOYAN", "SEED_TOEFL", "SEED_GRE", "SEED_IELTS",
               "SEED_EXAM_COUNTS"]),
    # 词根词缀数据表（生成产物，见 tools/make-roots.mjs）与查询层。
    # ⚠️ 顺序要紧：数据表 → 查询层 → library（library 要用它）。
    ("RTD", ["ROOT_FAMILIES", "WORD_ROOTS", "MORPH_TABLE", "WORD_MORPH", "ROOTS_COVERAGE"]),
    # 例句（Tatoeba，CC BY 2.0）与词源（Wiktionary，CC BY-SA 4.0）数据表。
    # 都是生成产物：tools/make-examples.py / tools/make-etym.py。
    # **必须排在 RT 前面**：roots.mjs 的 examplesOf / originOf 要查它们。
    ("EXD", ["EXAMPLES", "EXAMPLES_COVERAGE"]),
    # Wikipedia 补的例句（CC BY-SA 4.0）：Tatoeba 里一次都没出现的词靠它。
    # 和 EXAMPLES 同形（[英文句]），但没有中文译文；roots.mjs 的 examplesOf 会回退查它。
    ("EXWD", ["EXAMPLES_WIKI", "EXAMPLES_WIKI_COVERAGE"]),
    ("ETD", ["ETYM", "ETYM_COVERAGE"]),
    # 词形派生关系（WordNet 3.0，见 tools/make-wordnet-relatives.py）。
    # 「同族词」的第二来源：ECDICT 词根家族覆盖不到的那 4,000+ 词靠它。
    ("WND", ["WN_DERIVATION", "WN_COVERAGE"]),
    # 常见搭配数据表（同样来自 Tatoeba，CC BY 2.0）：tools/make-collocations.py 生成。
    # 也必须排在 RT 前面 —— roots.mjs 的 collocationsOf 要查它。
    ("CLD", ["COLLOCATIONS", "COLLOC_COVERAGE"]),
    ("RT", ["decompose", "morphOf", "relativesOf", "rootFamiliesOf", "rootLine",
           "examplesOf", "originOf", "collocationsOf"]),
    ("L", ["COLLECTIONS", "SOURCES", "FIRST_CHUNK", "parseWordlist", "loadCollection",
           "seedFor", "seedMemories", "extractWordsFromText", "isPureEnglish",
           "contextSentence", "lookupWord", "familyOf", "SEED_CET4"]),
    ("SP", ["speechAvailable", "speak", "stopSpeaking", "speechSupportedLanguages"]),
    ("HK", ["HOOK_SOURCE", "HOOK_MAX_CHARS", "buildHook", "buildHooks", "createHookCache"]),
    ("Q", ["DAY_START_HOUR", "dayKey", "dayStartTs", "daysBetweenKeys", "priorDayKey",
           "containerSize", "comebackCopy", "buildDailyContainer", "explain", "badgesFor",
           "emptyState", "CHECKIN_RATIO", "isCheckedIn", "bumpStreak", "isPaused",
           "effectiveBaseN", "TIER", "seededRandom", "seededShuffle", "shouldBlockNew"]),
    ("G", ["COMBO_STEPS", "comboMult", "COMBO_FREEZE_MS", "newCombo", "stepCombo",
           "freezeCombo", "resumeCombo", "LEVELS", "levelFor", "expFor", "conqueredCount"]),
    ("B", ["BECKON", "TONE", "LONG_GONE_DAYS", "SOLID_DAYS", "beckonState",
           "comebackLine", "shouldRipple"]),
    ("S", ["RETRY_GAP_MIN", "RETRY_GAP_MAX", "MODE", "RATING", "MAX_CONSECUTIVE_NEW",
           "UNDO_WINDOW_MS", "QUIZ_ERROR_THRESHOLD", "createSession", "currentCard",
           "isFinished", "coveredCount", "submitRating", "revealFor", "planRetry", "insertRetry",
           "advance", "ensureNewWordCap", "undoLast", "buildQuiz", "submitQuiz",
           "humanizeConfusion", "reportFakeMastery", "pauseSession", "resumeSession",
           "snapshot", "restore"]),
    ("A", ["createApp"]),
]

# core-ref 注册表的键名（全名，界面层读的是这个）
CORE_NS_KEY = {
    "M": "memory", "MK": "mistake", "SEED": "seed", "C4X": "seedCet4Extra", "SEEDX": "seedExams",
    "RTD": "rootsData", "RT": "roots",
    "EXD": "examplesData", "EXWD": "examplesWikiData", "ETD": "etymData",
    "CLD": "collocData", "WND": "wordnetData",
    "L": "library", "SP": "speech", "HK": "hook",
    "Q": "queue", "G": "game", "B": "beckon", "S": "session", "A": "app",
}

# 摊平顺序 = 依赖顺序。被 import 的先来。
CORE_ORDER = [
    "core/memory.mjs",
    "core/mistake.mjs",
    "core/seed-cet4.mjs",
    # 四级词表补全部分。同样必须在 library.mjs 前。
    "core/seed-cet4-extra.mjs",
    # 各考纲词库的内置词表（生成产物）。**必须在 library.mjs 前** ——
    # 摊平顺序就是依赖顺序，library.mjs 要用它的常量。
    "core/seed-exams.mjs",
    # 词根词缀数据表 + 查询层（生成产物 + 纯查询，见 tools/make-roots.mjs）。
    # **必须在 library.mjs 前**，library.mjs 要用 decompose / relativesOf。
    "core/roots-data.mjs",
    # 例句 / 词源数据表（生成产物）。同样必须在 roots.mjs 之前。
    "core/examples-data.mjs",
    # Wikipedia 补的例句。同样必须在 roots.mjs 之前（examplesOf 要回退查它）。
    "core/examples-wiki-data.mjs",
    "core/etym-data.mjs",
    "core/colloc-data.mjs",
    "core/wordnet-data.mjs",
    "core/roots.mjs",
    "core/library.mjs",
    "core/speech.mjs",
    "core/hook.mjs",
    "core/queue.mjs",
    "core/game.mjs",
    "core/beckon.mjs",
    "core/session.mjs",
    "core/app.mjs",
]
STORE_ORDER = ["store/client-store.mjs"]
UI_ORDER = ["ui/dom.mjs", "ui/styles.css", "ui/eye-candy.mjs", "ui/pages.mjs", "ui/panel.mjs", "ui/capsule.mjs"]
# core-ref 必须排在「登记命名空间」那一步之前，否则会撞上 TDZ：
# 它的 `let CORE = {...}` 还没执行，setCore() 就去写 CORE 了。
CORE_REF = "ui/core-ref.mjs"
ADAPTER_ORDER = ["adapter/dsh/puppet.mjs", "adapter/dsh/client.js"]

# 这些名字必须在产物里存在，否则说明摊平漏了或改名了
REQUIRED_EXPORTS = ["createVocabCore", "createCapsulePuppet", "createPanelPuppet", "apply", "inject"]

# getCore() 的键名只有全名，单字母只能当别名。
# 见 tools/build.py 里 assert_core_keys 的说明（设置页曾经因为这行写法炸过）。
CORE_GET_SHORT_KEY_RE = re.compile(
    r"(?m)^[ \t]*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*getCore\s*\(\s*\)"
)
NS_KEY_FOR_SHORT = {
    "M": "memory", "MK": "mistake", "G": "game", "Q": "queue",
    "L": "library", "B": "beckon", "SP": "speech", "S": "session", "A": "app",
    "SEED": "seed", "C4X": "seedCet4Extra", "SEEDX": "seedExams", "HK": "hook",
}


def assert_core_keys(src, label):
    """插件链与 demo 链共用同一道校验：别让 `const { Q } = getCore()` 溜进产物。"""
    for m in CORE_GET_SHORT_KEY_RE.finditer(src):
        for seg in m.group(1).split(","):
            seg = seg.strip()
            if not seg or ":" in seg:
                continue
            if seg in NS_KEY_FOR_SHORT:
                line_no = src[: m.start()].count("\n") + 1
                raise SystemExit(
                    "[%s] 第 %d 行 `const { %s } = getCore()` —— getCore() 的键名只有全名，"
                    "单字母是 undefined。请写成 `const { %s: %s } = getCore()`。"
                    % (label, line_no, seg, NS_KEY_FOR_SHORT[seg], seg)
                )


IMPORT_NAMED_RE = re.compile(r"^\s*import\s+\{(.*?)\}\s*from\s*['\"][^'\"]+['\"]\s*;?\s*$", re.M)
IMPORT_NS_RE = re.compile(r"^\s*import\s+\*\s+as\s+\w+\s+from\s*['\"][^'\"]+['\"]\s*;?\s*$", re.M)
IMPORT_DEFAULT_RE = re.compile(r"^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s*['\"]([^'\"]+)['\"]\s*;?\s*$", re.M)
EXPORT_LIST_RE = re.compile(r"^\s*export\s*\{[^}]*\}\s*;?\s*$", re.M)

# ESM 形态下各文件自己登记命名空间的那些行。摊平形态没有命名空间对象可登记
# （构建脚本会按 CORE_EXPORTS 统一登记），所以这些行必须整行剥掉 ——
# 不剥的话它们会引用摊平后根本不存在的 `M_`/`Q_` 之类的名字。
#
# 这里必须跨行匹配：写成 `[^}]*` 只能在单行内工作，而源码里这个调用是折行的，
# 结果就是「剥离静默失败 → 产物里留着 M_ is not defined → 整个 bundle 在
# UI_PAGES 那一块就断掉 → 外壳 11 项全 FAIL」。同样的折行坑在 import 上刚踩过一次。
SELF_REGISTER_RE = re.compile(r"^[ \t]*setCore\([\s\S]*?\);[ \t]*$", re.M)

# 摊平后绝不该出现的名字：ESM 侧 import 用的别名（M_、Q_ …）。
# 留一个下来就说明剥离漏了，此刻失败远好过装进 DSH 再白屏。
ESM_ALIAS_RE = re.compile(r"(?<![\w.$])(M_|MK_|G_|Q_|L_|B_|SP_|S_|A_)(?![\w$])")


def read(rel):
    with io.open(os.path.join(ROOT, rel), "r", encoding="utf-8") as f:
        return f.read()


def strip_import_export(src, externals):
    """去掉 ESM 的 import/export 语法，把 'export ' 前缀摘掉。

    `externals` 命中的 import 会被换成一行 require 赋值，交给宿主的模块加载器。
    """
    ext_lines = []
    for m in IMPORT_DEFAULT_RE.finditer(src):
        local, spec = m.group(1), m.group(2)
        if spec in externals:
            ext_lines.append("var %s = require(%r);" % (local, spec))
            src = src.replace(m.group(0), "")
        else:
            raise SystemExit("[%s] 出现了未登记的默认 import：%s（来自 %s）" % (PKG, spec, m.group(0).strip()))
    for m in IMPORT_NAMED_RE.finditer(src):
        spec = re.search(r"from\s*['\"]([^'\"]+)['\"]", m.group(0))
        if spec and spec.group(1) in externals:
            raise SystemExit("[%s] 外部依赖只允许默认导入：%s" % (PKG, spec.group(1)))
    src = IMPORT_NAMED_RE.sub("", src)
    src = IMPORT_NS_RE.sub("", src)
    src = SELF_REGISTER_RE.sub("", src)
    src = EXPORT_LIST_RE.sub("", src)
    # export function / export const / export async function → 去掉 export
    src = re.sub(r"^(\s*)export\s+(async\s+)?(function|const|let|var|class)\s", r"\1\2\3 ", src, flags=re.M)
    return "\n".join(ext_lines), src


# mask_strings_and_comments() 已迁移到 tools/lib/dangling.py（函数名 mask_non_code）。
# 迁移原因：旧实现不认正则字面量，`/^[a-z][a-z'-]*$/` 里那个 `'` 会被当成字符串开头，
# 一口气吞掉 2,700 多字符的代码 —— 检查器于是「少报」，明明是悬空引用也放过。
# 唯一实现由本文件与 tools/verify-dangling-guard.mjs 共用，两边判据不会再漂。


def top_level_decls(src):
    """收集顶层声明名（带大括号深度跟踪，避免把函数体里的局部变量当成重名）。"""
    names = set()
    depth = 0
    for line in src.split("\n"):
        stripped = line.strip()
        if depth == 0 and stripped and not stripped.startswith("//"):
            for pat in (
                r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)",
                r"^class\s+([A-Za-z_$][\w$]*)",
                r"^(?:const|let|var)\s+([A-Za-z_$][\w$]*)",
                r"^var\s+([A-Za-z_$][\w$]*)\s*=\s*require",
            ):
                m = re.match(pat, stripped)
                if m:
                    names.add(m.group(1))
        depth += line.count("{") - line.count("}")
    return names


def check_balanced(src):
    """逐字符扫描查括号平衡，跳过字符串与注释。

    不能直接 count('(')：中文文案和正则里有大量括号，朴素计数必然误报。
    返回第一处不平衡的说明，或 None。
    """
    stack = []
    pairs = {")": "(", "]": "[", "}": "{"}
    i = 0
    n = len(src)
    line = 1
    prev_significant = ""
    while i < n:
        ch = src[i]
        if ch == "\n":
            line += 1
            i += 1
            continue
        # 行注释
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        # 块注释
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                if src[i] == "\n":
                    line += 1
                i += 1
            i += 2
            continue
        # 字符串 / 模板串
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "\n":
                    line += 1
                    if quote != "`":
                        break  # 未闭合的单行字符串，交给平衡检查去报
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            # 刚读完一个字面量：它算一个「值」，不是运算符。
            # 不更新的话，后面的 `/` 会被误判成正则开头，整段括号就错配了。
            prev_significant = "x"
            continue
        # 正则字面量：靠前一个有效字符判断（= ( , : [ ! & | ? { } ; 之后是正则，不是除号）
        if ch == "/" and prev_significant in "=(,:[!&|?{};":
            i += 1
            in_class = False
            while i < n:
                c = src[i]
                if c == "\\":
                    i += 2
                    continue
                if c == "\n":
                    line += 1
                    break
                if c == "[":
                    in_class = True
                elif c == "]":
                    in_class = False
                elif c == "/" and not in_class:
                    i += 1
                    while i < n and src[i].isalpha():  # 标志位 gimsuy
                        i += 1
                    break
                i += 1
            prev_significant = "/"
            continue
        if ch in "([{":
            stack.append((ch, line))
            prev_significant = ch
        elif ch in ")]}":
            if not stack:
                return "第 %d 行多出一个 %s" % (line, ch)
            opener, at = stack.pop()
            if opener != pairs[ch]:
                return "第 %d 行的 %s 与第 %d 行的 %s 不配对" % (line, ch, at, opener)
            prev_significant = ch
        elif not ch.isspace():
            prev_significant = ch
        i += 1
    if stack:
        opener, at = stack[-1]
        return "第 %d 行的 %s 没有闭合（%d 处仍未闭合）" % (at, opener, len(stack))
    return None


GLOBAL_CSS_SELECTOR_DENY = (
    "*", "html", "body", "html,body",
    "button", "input", "textarea", "select", "a", "img", "div", "span",
    "p", "ul", "ol", "li", "table", "h1", "h2", "h3", "form", "label",
)


def assert_plugin_css(css, label):
    """插件样式表里不许出现全局选择器。

    插件产物是被 injectVocabStudyCss() 注入到 **DSH 真实页面** 的
    document.head 里的，所以任何不带 .vs / [data-vs / --vs 限定的选择器
    都会作用到宿主界面元素上。

    这是真炸过的：demo 外壳样式曾和插件样式同处 ui/styles.css，
    其中 `body { margin: 0; background: #14120F; }` 覆盖了宿主的 body，
    现象是「界面上很多按钮都没有用」。外壳样式现在住在 demo/shell.css，
    只由 tools/build.py 拼进 demo HTML，不进这个产物。
    """
    src = re.sub(r"/\*[\s\S]*?\*/", "", css)
    depth = 0
    buf = ""
    line_no = 1
    for ch in src:
        if ch == "\n":
            line_no += 1
        if ch == "{":
            sel = buf.strip()
            if depth == 0 and sel and not sel.startswith("@"):
                for part in sel.split(","):
                    p = part.strip()
                    if p and not re.search(r"\.vs|\[data-vs|--vs", p):
                        raise SystemExit(
                            "[%s] 第 %d 行有全局选择器 `%s` —— 插件样式会注入 DSH 真实页面，"
                            "这条规则会作用到宿主界面元素上，把界面搞坏。\n"
                            "只允许 .vs-* / [data-vs*] / --vs-* 限定的选择器。\n"
                            "演示外壳样式请放到 demo/shell.css（不进插件产物）。"
                            % (label, line_no, sel[:80])
                        )
            depth += 1
            buf = ""
        elif ch == "}":
            depth = max(0, depth - 1)
            buf = ""
        elif depth == 0:
            buf += ch
    return css


def add_css(rel, chunks):
    """样式表：demo 形态直接内联进 <style>，插件形态没有 <style> 可用。

    所以这里把它包成一个字符串常量，由 client.js 在 apply 时注入一次
    （只注入一次，用 data 标记防重复）。CSS 里唯一危险的是反斜杠和反引号，
    两个都转义掉，模板串就安全了。
    """
    css = assert_plugin_css(read(rel), rel)
    # 先吃反斜杠，再吃反引号和 ${ —— 顺序不能反，否则会把刚加的转义又转一遍
    css = css.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    return (
        "\n// ── %s（作为字符串，运行时注入）──\n"
        "var VOCAB_STUDY_CSS = `%s`;\n"
        "\n"
        "/** 样式只注入一次；同一页面里挂多个面板也只会有一份 <style>。 */\n"
        "function injectVocabStudyCss(doc) {\n"
        "  var d = doc || (typeof document !== 'undefined' ? document : null);\n"
        "  if (!d || d.querySelector('style[data-vocab-study]')) return;\n"
        "  var tag = d.createElement('style');\n"
        "  tag.setAttribute('data-vocab-study', '1');\n"
        "  tag.textContent = VOCAB_STUDY_CSS;\n"
        "  (d.head || d.documentElement).appendChild(tag);\n"
        "}\n" % (rel, css)
    )


# 摊平后不存在命名空间对象，只有裸声明。所以 core 源码里的 `Q.dayKey(...)`
# 必须改写成 `dayKey(...)`。
#
# 为什么 demo 链没暴露这个问题：tools/build.py 把每个 core 文件包成 IIFE，
# 并 return { ...符号 } 造出真正的命名空间对象，所以 `Q.dayKey` 在那儿是合法的。
# 插件链是真摊平 —— 这里不改写的话，createApp 一跑就 ReferenceError: Q is not defined，
# 而症状只是「插件装上了但界面不出现」，极难查。
NS_REWRITE_RE = None


def build_ns_rewrite():
    """构造「命名空间成员 → 裸符号名」的映射表。"""
    table = {}
    for ns, symbols in CORE_EXPORTS:
        for sym in symbols:
            table["%s.%s" % (ns, sym)] = sym
    return table


def rewrite_namespaces(src, table):
    """把 core 源码里的 NS.member 换成 member。

    只替换**已知的导出名**：`Q.dayKey` → `dayKey`，但 `Q.somethingElse`
    保持原样（说明表漏登记了，留给构建期的符号检查去报错，而不是这里瞎猜）。
    """
    pattern = re.compile(r"\b(" + "|".join(sorted({k.split(".")[0] for k in table})) + r")\.([A-Za-z_$][\w$]*)")

    def repl(m):
        full = m.group(1) + "." + m.group(2)
        return table.get(full, m.group(0))

    return pattern.sub(repl, src)


def find_node():
    """找 node 可执行文件：先看环境，再看 DSH 自带运行时，最后看 PATH。"""
    import glob
    import shutil

    env = os.environ.get("VS_NODE")
    if env and os.path.isfile(env):
        return env
    pattern = os.path.join(
        os.path.expanduser("~"), ".dsh", "dsh-runtimes", "*", "dependencies", "node", "bin", "node.exe"
    )
    for hit in sorted(glob.glob(pattern)):
        if os.path.isfile(hit):
            return hit
    return shutil.which("node")


def main():
    externals = {"react"}
    chunks = []
    all_decls = {}
    ns_table = build_ns_rewrite()

    def add(rel):
        if rel.endswith(".css"):
            chunks.append(add_css(rel, chunks))
            return
        raw = read(rel)
        ext, body = strip_import_export(raw, externals)
        assert_core_keys(body, rel)
        # core 源码里的 NS.member 在这里落成裸符号名（摊平后没有命名空间对象）
        body = rewrite_namespaces(body, ns_table)
        if ext:
            chunks.append("// —— %s 的外部依赖 ——\n%s" % (rel, ext))
        decls = top_level_decls(body)
        dup = decls & set(all_decls)
        if dup:
            raise SystemExit(
                "[%s] 顶层重名（摊平进同一作用域会直接 SyntaxError）：%s\n"
                "  已被 %s 占用" % (PKG, ", ".join(sorted(dup)), all_decls[sorted(dup)[0]])
            )
        for d in decls:
            all_decls[d] = rel
        chunks.append(
            "\n// ══════════════════════════════════════════════════════════\n"
            "// %s\n"
            "// ══════════════════════════════════════════════════════════\n%s" % (rel, body)
        )

    for rel in CORE_ORDER + STORE_ORDER:
        add(rel)

    add(CORE_REF)  # 先落地注册表本身

    # 摊平之后没有 ESM 绑定，界面拿不到 core 命名空间。这里把作用域里的
    # **裸声明**重新组成命名空间对象登记进 ui/core-ref.mjs 的注册表；
    # ESM 形态下由 ui/pages.mjs 自己登记。两种形态读法一致。
    #
    # 注意：摊平后没有 `Q` 这个对象，只有 `dayKey`、`buildDailyContainer` 这类
    # 裸函数 —— 所以这里必须按清单逐个写出来，不能写 `queue: Q`。
    ns_lines = []
    for ns, symbols in CORE_EXPORTS:
        members = ", ".join(symbols)
        ns_lines.append("  %s: { %s }," % (CORE_NS_KEY[ns], members))
    chunks.append(
        "\n// ── 把 core 命名空间登记给界面层（摊平形态专用）──\n"
        "setCore({\n%s\n});\n" % "\n".join(ns_lines)
    )

    for rel in UI_ORDER + ADAPTER_ORDER:
        add(rel)

    body = "\n".join(chunks)

    # 「命名空间清单」必须和源码真的对得上。对不上就是构建期错误，
    # 而不是等到某个页面读某个函数时才发现它是 undefined。
    missing = []
    for ns, symbols in CORE_EXPORTS:
        for sym in symbols:
            if sym not in all_decls:
                missing.append("%s.%s" % (ns, sym))
    if missing:
        raise SystemExit(
            "[%s] CORE_EXPORTS 里登记了源码中不存在的符号（改名了？漏了？）：\n  %s"
            % (PKG, "\n  ".join(missing))
        )

    # ── 悬空命名空间前缀检查（2026-10-09，真实事故）────────────────
    # rewrite_namespaces() 只替换**登记在 CORE_EXPORTS 里的**成员。
    # 漏登记一个名字，`Q.shouldBlockNew(...)` 就会原样留在产物里；而摊平之后
    # 根本没有 `Q` 这个对象 —— 一执行就是 ReferenceError，而且它发生在
    # snapshotState() 里，也就是**渲染第一帧**：面板整个建不出来，标签页全黑。
    #
    # 上面那段 missing 检查抓不到它：那里查的是「清单里的符号在不在源码里」，
    # 而这里错的是「源码用了清单里没有的符号」—— 方向正好相反。
    #
    # 事故经过：加了「再来 5 个新词」用到 shouldBlockNew，忘了登记，7 个测试
    # 套件全绿（测试直接 import core/app.mjs，不经打包器），真机上黑屏。
    ns_prefixes = sorted({key.split(".")[0] for key in ns_table})
    # 只看**代码**部分：字符串/注释里的文本会误报（见 tools/lib/dangling.py 的 mask_non_code）
    scan_body = mask_non_code(body)
    dangling = []
    for m in re.finditer(r"\b(%s)\.([A-Za-z_$][\w$]*)" % "|".join(ns_prefixes), scan_body):
        full = m.group(1) + "." + m.group(2)
        if full not in ns_table:
            line_no = scan_body[: m.start()].count("\n") + 1
            dangling.append((full, line_no))
    if dangling:
        uniq = sorted({d[0] for d in dangling})
        detail = "\n  ".join(
            "%s（首次出现约第 %d 行）" % (full, line_no) for full, line_no in dangling[:12]
        )
        raise SystemExit(
            "[%s] 产物里残留悬空命名空间前缀，摊平后这些对象都不存在：\n  %s\n"
            "  修法：把 %s 加进 build-plugin.py 的 CORE_EXPORTS 对应清单。\n"
            "  不修的后果：一执行就 ReferenceError —— 界面整个不出现。"
            % (PKG, detail, " / ".join(uniq))
        )

    # ESM 别名泄漏检查
    leak = ESM_ALIAS_RE.search(body)
    if leak:
        line_no = body[: leak.start()].count("\n") + 1
        ctx = body.split("\n")[line_no - 2] if line_no >= 2 else ""
        raise SystemExit(
            "[%s] 产物里残留了 ESM 别名 `%s`（约第 %d 行）：\n  %s\n"
            "  说明剥离漏了 —— 这会让整个 bundle 在那一块断掉，"
            "症状是「界面不出现」。" % (PKG, leak.group(1), line_no, ctx.strip()[:120])
        )

    # 必需符号自检：少一个就说明改名/漏文件，宁可构建失败
    for name in REQUIRED_EXPORTS + ["injectVocabStudyCss"]:
        if not re.search(r"\b(?:function|const|let|var|class)\s+%s\b" % re.escape(name), body):
            raise SystemExit("[%s] 产物里找不到必需符号 %s" % (PKG, name))

    out = []
    out.append("// %s — DSH 客户端插件半（由 tools/build-plugin.py 生成，请勿手改）" % PKG_ID)
    out.append("// 源码：core/ store/ ui/ adapter/dsh/ —— 与 demo 产物同一批文件。")
    out.append("window.__ModuleLoader__.load({")
    out.append("  id: %r," % PKG_ID)
    out.append("  factory(require) {")
    out.append("    var module = { exports: {} };")
    out.append("    var exports = module.exports;")
    out.append("    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });")
    out.append(body)
    out.append("")
    # 摊平后 apply / inject 只是同作用域里的一个函数和一个数组，得显式挂上出口。
    # 写死这两个名字是有意的：它们就是框架认的入口名，改名等于插件不工作，
    # 所以让它在构建期（下面的 REQUIRED_EXPORTS 检查）就失败，而不是装完没反应。
    out.append("    exports.apply = apply;")
    out.append("    exports.inject = inject;")
    out.append("")
    out.append("    return module.exports;")
    out.append("  },")
    out.append("});")
    client = "\n".join(out)

    # ── 构建探针已移除（2026-10-09）────────────────────────────────
    # 曾在这里注入 {{BUILD_STAMP}} → 「构建探针 · MM-DD HH:MM:SS」，显示在数据带里。
    # 它的用途是区分「浏览器跑的是旧产物」和「新产物在跑只是样式没生效」——
    # 当时我在瞎猜是哪一种，而这个时间戳是产物的真实属性（上面那段历史留在
    # git 里）。用户连续两次确认探针时间戳随构建更新，说明部署链路没问题，
    # 于是删除：它不属于产品界面。
    #
    # 但**保留一条兜底**：万一以后有人重新引入占位符却忘了替换，产物里会
    # 原样显示 "{{...}}"，而它是合法字符串，node --check 发现不了。
    # 所以这里继续拒绝任何形如 {{名字}} 的未替换占位符。
    _leftover = re.findall(r"\{\{[A-Z_]+\}\}", client)
    if _leftover:
        raise SystemExit(
            "[%s] 产物里残留未替换的占位符 %s —— 谁注入的谁负责替换" % (PKG, sorted(set(_leftover)))
        )

    # 语法校验交给真正的解析器。
    # 一开始我自己写了个括号平衡扫描器，结果在正则字面量上反复误报
    # （/^[A-Za-z][A-Za-z' -]*$/ 里的 [ 被当成数组括号）—— 手写 JS 词法分析
    # 不值得，构建期本来就有 Node，让 node --check 来判更准也更省事。
    import subprocess
    import tempfile

    tmp = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8", newline="\n")
    try:
        tmp.write(client)
        tmp.close()
        node = find_node()
        if node:
            proc = subprocess.run([node, "--check", tmp.name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            if proc.returncode != 0:
                raise SystemExit(
                    "[%s] 产物语法检查未通过（node --check）：\n%s"
                    % (PKG, proc.stdout.decode("utf-8", "replace"))
                )
        else:
            print("! 找不到 node，跳过产物语法检查（建议装上再构建）")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    lib = os.path.join(ROOT, "lib")
    if not os.path.isdir(lib):
        os.makedirs(lib)

    # newline="\n" 是必须的：默认模式下 Python 在 Windows 上把 \n 翻成 CRLF，
    # 于是同一份源码在不同平台构建出的 lib/client.js 字节数不同（266670 vs 260049），
    # 哈希对不上，"校验产物完整性"就成了假命题。换行符必须与平台无关。
    with io.open(os.path.join(lib, "client.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(client)

    # Host 侧入口：本插件不需要 Host 逻辑，但包要有一个可解析的主入口。
    with io.open(os.path.join(lib, "index.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(
            "// %s — Host 侧入口（由 tools/build-plugin.py 生成）\n"
            "//\n"
            "// 这个插件是纯客户端 UI 插件：数据只存在用户浏览器里，不上报、不联网。\n"
            "// Host 侧刻意什么都不做 —— 没有 Host 逻辑可写，也不该凭空造一个服务出来。\n"
            "// 保留这个入口是因为 package.json 需要一个可解析的主入口；它被加载后\n"
            "// 不做任何事，这是有意为之。\n"
            "\n"
            "export function apply() {}\n"
            "\n"
            "export const name = %r;\n" % (PKG_ID, PKG_ID)
        )

    print(u"✓ lib/client.js   (%.1f KB)" % (len(client.encode("utf-8")) / 1024.0))
    print(u"✓ lib/index.js")
    print(u"  摊平 %d 个文件，顶层声明 %d 个（已查重名）" % (len(CORE_ORDER + STORE_ORDER + UI_ORDER + ADAPTER_ORDER), len(all_decls)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
