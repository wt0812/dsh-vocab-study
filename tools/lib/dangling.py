"""悬空命名空间前缀检查用的「代码/非代码」分离器（**唯一实现**，构建期守卫与验证脚本共用）。

为什么需要单独一层
------------------
摊平后的产物里，`Q.shouldBlockNew(...)` 这种引用只要漏登记就会在运行时
ReferenceError（界面上表现为面板整个不出现）。检查手段是文本扫描，但文本里有
三类东西**不是代码**，扫到就是误报：

1. 注释
2. 字符串 / 模板串 —— 真实踩过：例句数据里有一条 `A.I. won't reach singularity.`，
   检查器盯着 `A.I` 判定"残留了命名空间 A 的成员 I"，构建直接失败
3. **正则字面量** —— 2026-10-21 的真实 CI 事故：第一版屏蔽器不认正则，
   `/^[a-z][a-z'-]*$/` 里那个 `'` 被当成字符串开头，一路吞掉 2,700 多字符
   （把后面的代码、包括测试注入的坏引用一起屏蔽了），于是
   `tools/verify-dangling-guard.mjs` 判定"断言失效"。构建期守卫因为
   **少报不报错**，这个洞一直没被发现（它能漏掉真实的悬空引用）。

判据：把非代码部分替换成**等长空格**（保留换行与下标），再扫代码。
"""

# 出现在这些字符之后的 `/` 是正则字面量的开头，不是除号
_REGEX_PREV_CHARS = set("(,=:[!&|?{};+-*%^~<>")
# 出现在这些关键字之后的 `/` 同样是正则开头（如 `return /x/`）
_REGEX_PREV_WORDS = {
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "case", "do", "else", "yield", "await", "throw",
}


def _mask_string(src, out, i, quote):
    """从 i（引号位置）起屏蔽一个普通字符串，返回结束下标。"""
    n = len(src)
    out[i] = " "
    i += 1
    while i < n:
        c = src[i]
        if c == "\\":
            out[i] = " "
            if i + 1 < n and src[i + 1] != "\n":
                out[i + 1] = " "
            i += 2
            continue
        if c == quote:
            out[i] = " "
            return i + 1
        if c == "\n":  # 未闭合的单行字符串，交给别处报错
            return i
        out[i] = " "
        i += 1
    return i


def _mask_template(src, out, i):
    """屏蔽模板串。

    简化：`${...}` 里的表达式也一并屏蔽。代价是模板表达式里如果真的出现
    `Q.xxx` 这类悬空引用会漏报 —— 实测这种写法在本仓库不存在，而正确解析
    嵌套花括号的复杂度不值得（错了反而会吞代码）。这里写清楚，将来要改先看这句。
    """
    n = len(src)
    out[i] = " "
    i += 1
    while i < n:
        c = src[i]
        if c == "\\":
            out[i] = " "
            if i + 1 < n and src[i + 1] != "\n":
                out[i + 1] = " "
            i += 2
            continue
        if c == "`":
            out[i] = " "
            return i + 1
        if c != "\n":
            out[i] = " "
        i += 1
    return i


def _mask_regex(src, out, i):
    """从 i（开头 `/`）起屏蔽一个正则字面量（含结尾 `/` 与 flags）。"""
    n = len(src)
    out[i] = " "
    i += 1
    in_class = False
    while i < n:
        c = src[i]
        if c == "\\":
            out[i] = " "
            if i + 1 < n and src[i + 1] != "\n":
                out[i + 1] = " "
            i += 2
            continue
        if c == "\n":  # 不可能是正则，退回去当除号处理（不屏蔽）
            return i
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            out[i] = " "
            i += 1
            break
        out[i] = " "
        i += 1
    # flags
    while i < n and (src[i].isalpha() and src[i].isascii()):
        out[i] = " "
        i += 1
    return i


def _regex_allowed(prev_char, prev_word):
    if prev_word in _REGEX_PREV_WORDS:
        return True
    if prev_char == "":
        return True
    return prev_char in _REGEX_PREV_CHARS


def mask_non_code(src):
    """把注释 / 字符串 / 模板串 / 正则字面量替换成等长空格，保留换行与下标。"""
    out = list(src)
    n = len(src)
    i = 0
    prev_char = ""
    prev_word = ""
    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        if ch == "/" and nxt == "/":
            while i < n and src[i] != "\n":
                out[i] = " "
                i += 1
            continue
        if ch == "/" and nxt == "*":
            out[i] = " "
            out[i + 1] = " "
            i += 2
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                if src[i] != "\n":
                    out[i] = " "
                i += 1
            if i < n:
                out[i] = " "
                out[i + 1] = " "
                i += 2
            continue
        if ch in ('"', "'"):
            i = _mask_string(src, out, i, ch)
            prev_char, prev_word = "0", ""
            continue
        if ch == "`":
            i = _mask_template(src, out, i)
            prev_char, prev_word = "0", ""
            continue
        if ch == "/" and _regex_allowed(prev_char, prev_word):
            i = _mask_regex(src, out, i)
            prev_char, prev_word = "0", ""
            continue

        if not ch.isspace():
            prev_char = ch
            if ch.isalnum() or ch in "_$":
                prev_word = prev_word + ch if prev_word or ch.isalpha() or ch in "_$" else ch
            else:
                prev_word = ""
        i += 1
    return "".join(out)


def find_dangling(src, prefixes):
    """返回 [(full_member, line_no), ...]：代码里出现、但前缀没被声明过的引用。"""
    import re

    code = mask_non_code(src)
    hits = []
    for prefix in prefixes:
        declared = re.search(
            r"(?:^|[\s,;({\[])(?:const|let|var|function|class)\s+%s\b" % prefix
            + r"|\b%s\s*[:=]" % prefix
            + r"|\(\s*%s\b" % prefix,
            code,
            re.M,
        )
        if declared:
            continue
        for m in re.finditer(r"\b%s\.([A-Za-z_$][\w$]*)" % prefix, code):
            hits.append((m.group(0), code[: m.start()].count("\n") + 1))
    return hits


def main(argv):
    """CLI：python tools/lib/dangling.py <产物文件>，打印 COUNT 与命中明细。

    前缀清单与 tools/verify-dangling-guard.mjs 的 PREFIXES 保持一致。
    """
    import sys

    if len(argv) < 2:
        print("用法: python tools/lib/dangling.py <file>")
        return 2
    prefixes = ["M", "MK", "SEED", "L", "SP", "HK", "Q", "G", "B", "S", "A"]
    src = open(argv[1], encoding="utf-8").read()
    hits = find_dangling(src, prefixes)
    uniq = {}
    for full, line in hits:
        uniq.setdefault(full, line)
    print("COUNT %d" % len(uniq))
    for full, line in sorted(uniq.items()):
        print("HIT %s @%d" % (full, line))
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main(sys.argv))
