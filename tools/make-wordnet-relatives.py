"""生成 core/wordnet-data.mjs —— 同族词的第二来源（词形派生关系）。

为什么要它：ECDICT 的 573 个词根家族只能覆盖 24.2% 的词（4,000+ 词在家族里
孤零零一个）。WordNet 记的是**词形派生事实**：
  attract → attraction / attractive / attractor,
  decide  → decision / decisive / deciding
这类关系对背单词最有用（"你这个词其实认识它的亲戚"），而且和词根家族不冲突。

数据来源：WordNet 3.0（Princeton University, WordNet 3.0 License，允许商用，
须保留版权声明 —— 见 docs/third-party/README.md）。

用法：
    python tools/make-wordnet-relatives.py                     # 默认读 ../_extra-corpus/dict
    python tools/make-wordnet-relatives.py --dict <dir>        # 指定 WordNet dict 目录
    python tools/make-wordnet-relatives.py --node <node.exe>   # 指定 node（默认 node）
"""
import io, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DICT = os.path.join(os.path.dirname(ROOT), "_extra-corpus", "dict")
OUT = os.path.join(ROOT, "core", "wordnet-data.mjs")
POS_FILES = {"data.noun": "n", "data.verb": "v", "data.adj": "a", "data.adv": "r"}
WORD_RE = re.compile(r"^[a-z][a-z\-']*$")
CAP_PER_WORD = 8


def parse_line(line):
    parts = line.split("|", 1)[0].split()
    off = parts[0]
    w_cnt = int(parts[3], 16)
    words, i = [], 4
    for _ in range(w_cnt):
        words.append(parts[i])
        i += 2
    p_cnt = int(parts[i], 16)
    i += 1
    ptrs = []
    for _ in range(p_cnt):
        if i + 3 >= len(parts):
            break
        ptrs.append((parts[i], parts[i + 1], parts[i + 2], parts[i + 3]))
        i += 4
    return off, words, ptrs


def clean(lemma):
    """去掉形容词卫星标记：attractive(a) → attractive。"""
    return lemma.split("(")[0].lower()


def main():
    args = sys.argv[1:]
    dict_dir = DEFAULT_DICT
    node = "node"
    i = 0
    while i < len(args):
        if args[i] == "--dict":
            dict_dir = args[i + 1]
            i += 2
        elif args[i] == "--node":
            node = args[i + 1]
            i += 2
        else:
            i += 1
    if not os.path.isdir(dict_dir):
        sys.exit("找不到 WordNet dict 目录：%s（先下载 WNdb-3.0.tar.gz 解包）" % dict_dir)

    # 词表（六库去重）由 Node 吐出，避免 Python 解析 ESM
    r = subprocess.run([node, os.path.join(ROOT, "tools", "list-words.mjs")],
                       capture_output=True, text=True, encoding="utf-8")
    rows = json.loads((r.stdout or "").strip() or "[]")
    ours = {str(x.get("word") or "").strip().lower() for x in rows if x.get("word")}
    print("  词表 %d 词" % len(ours))

    syn, lines = {}, []
    for fn, letter in POS_FILES.items():
        path = os.path.join(dict_dir, fn)
        if not os.path.isfile(path):
            continue
        with io.open(path, encoding="latin-1") as f:
            for line in f:
                if line.startswith("  ") or not line.strip():
                    continue
                off, words, ptrs = parse_line(line)
                syn[(letter, off)] = words
                lines.append((words, ptrs))
    print("  同义词集 %d 个" % len(syn))

    pairs = set()
    for words, ptrs in lines:
        for sym, t_off, pos, lex in ptrs:
            if sym != "+" or len(lex) < 4:
                continue
            # ⚠️ 这里的两个十六进制是「同义词集里第几个词（1-based 序号）」，
            # **不是** lex_id。按 lex_id 解会漏掉绝大多数、还会造出
            # back ←→ cover 这种假关系（吃过这个亏，记在这里）。
            s_idx, t_idx = int(lex[:2], 16), int(lex[2:4], 16)
            if s_idx == 0 or t_idx == 0:
                continue
            tl = "a" if pos == "s" else pos
            tgt = syn.get((tl, t_off)) or []
            if s_idx > len(words) or t_idx > len(tgt):
                continue
            a, b = clean(words[s_idx - 1]), clean(tgt[t_idx - 1])
            if a != b:
                pairs.add((a, b))
    print("  WordNet 原始派生对 %d" % len(pairs))

    rel = {}
    for a, b in pairs:
        if a == b or a not in ours or b not in ours:
            continue
        if not WORD_RE.match(a) or not WORD_RE.match(b):
            continue
        rel.setdefault(a, set()).add(b)
        rel.setdefault(b, set()).add(a)

    # 去掉纯屈折（复数/过去式/进行时）：那不是"另一个词"，是同一个词的变形
    def inflect_of(x, y):
        for suf in ("s", "es", "ed", "ing", "d", "ies", "ied", "ier", "iest"):
            if y == x + suf or (x.endswith("e") and y == x[:-1] + suf):
                return True
        return False

    for w in list(rel):
        rel[w] = {x for x in rel[w] if not inflect_of(w, x) and not inflect_of(x, w)}

    out = {}
    for w in sorted(rel):
        lst = sorted(rel[w])[:CAP_PER_WORD]
        if lst:
            out[w] = lst
    print("  进表的词 %d，关系条目 %d" % (len(out), sum(len(v) for v in out.values())))

    lines_out = [
        "// vocab-study / core / wordnet-data.mjs",
        "//",
        "// 词形派生关系表（「同族词」的第二来源）。生成脚本：tools/make-wordnet-relatives.py",
        "// 数据：WordNet 3.0 © 2006 Princeton University（WordNet 3.0 License，允许商用，",
        "// 须保留版权声明）。许可与署名见 docs/third-party/README.md。",
        "//",
        "// 为什么手工写不行：WordNet 里这类关系是**词条之间标注好的事实**",
        "// （attract ↔ attraction / attractive），不是靠后缀猜的 —— 猜出来的",
        "// 关系会骗用户（比如 nation 和 national 是派生，但 nature 和 native 不是）。",
        "// 只收六库词表内部两端都有的词，所以界面上的每一条都能点开看释义。",
        "",
        "export const WN_DERIVATION = {",
    ]
    for w in sorted(out):
        body = ", ".join("'%s'" % x for x in out[w])
        lines_out.append("  '%s': [%s]," % (w, body))
    lines_out.append("};")
    lines_out.append("")
    lines_out.append("export const WN_COVERAGE = {")
    lines_out.append("  words: %d," % len(ours))
    lines_out.append("  wordsWithDerivation: %d," % len(out))
    lines_out.append("  pairs: %d," % sum(len(v) for v in out.values()))
    lines_out.append("  source: 'WordNet 3.0',")
    lines_out.append("};")
    lines_out.append("")
    io.open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(lines_out))
    print("  ✅ 写入 %s（%.1f KB）" % (OUT, os.path.getsize(OUT) / 1024))

    # 分库覆盖
    per = {}
    for x in rows:
        c = x.get("collection") or x.get("coll") or ""
        w = str(x.get("word") or "").strip().lower()
        if c and w:
            per.setdefault(c, [0, 0])
            per[c][1] += 1
            if w in out:
                per[c][0] += 1
    for c, (a, b) in sorted(per.items()):
        if b:
            print("    %-8s %d / %d = %.1f%%" % (c, a, b, a / b * 100))


if __name__ == "__main__":
    main()
