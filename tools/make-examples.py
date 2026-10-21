#!/usr/bin/env python3
r"""生成 core/examples-data.mjs —— 每个词一句「真实例句」，能配到译文就一起带上。

## 数据来源

Tatoeba 语料（https://tatoeba.org ，CC BY 2.0，只需署名）。用到三个导出文件：
  - cmn_sentences.tsv.bz2    中文句子
  - eng_sentences.tsv.bz2    英文句子（**190 万句**，比对照语料大得多）
  - cmn-eng_links.tsv.bz2    中文句 ↔ 英文句 的配对

## 两轮筛选

**第一轮：中英对照**（有译文，卡片上中英各一行，最理想）
按下面的规则从配对里给每个词挑一句最短的。

**第二轮：英文单语**（只给英文，**不给**翻译）
第一轮没捞到的词，去 190 万句英文里找。为什么值得做：很多词
（criterion / phenomenon / mortgage 之类）在中英对照里就是没有，
但英文语料里到处都是。**宁可只给英文，也不编一句中文译文** ——
编了就是假数据，用户背下去是错的。

## 一套关键的匹配规则：词形变形

Tatoeba 里的句子用的是**变过形的词**（consultants / consulted / abolishing），
只按原形匹配会漏掉一大片。所以每个词都展开成常见变体
（+s / +es / +ed / +ing / y→ies / 去 e 加 ing / 双写辅音 / 一小张不规则表），
命中任意变体都算这个词的例句。

## 中文的繁简与地区用词

统一走 OpenCC 的 **tw2sp**（台版繁体 → 简体，带词表替换），不是 t2s。
差别很实在：t2s 只换字形，"義大利" → "義大利"（还是台版），
tw2sp 会换成"意大利"、"軟體"→"软件"、"網路"→"网络"、"檔案"→"文件"、
"腳踏車"→"自行车"。译文的用词是译者写的，我们**不改写句子**，
只做繁简与地区词的标准化。

## 这是一次性生成器

产物 `core/examples-data.mjs` **要提交进仓库**；运行时不下载、不联网。
需要：Python 3 + `opencc-python-reimplemented` + 网络（首次下载语料）。

## 用法

    pip install opencc-python-reimplemented
    python tools/make-examples.py                    # 默认语料目录 .\_tatoeba
    TATOEBA_DIR=D:\tatoeba python tools/make-examples.py
"""

import bz2
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "core" / "examples-data.mjs"
BASE = Path(os.environ.get("TATOEBA_DIR", str(ROOT.parent / "_tatoeba")))

FILES = {
    "cmn-eng_links.tsv.bz2": "https://downloads.tatoeba.org/exports/per_language/cmn/cmn-eng_links.tsv.bz2",
    "cmn_sentences.tsv.bz2": "https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2",
    "eng_sentences.tsv.bz2": "https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2",
}

# 词边界：**必须**把弯引号 ’ 也算进词内。
# 否则 `haven’t` 会被切成 `haven` + `t`，于是 `haven` 白捡一句
# “I haven’t saved the file yet.”（真实踩到，测试当场抓住）。
TOKEN_RE = re.compile(r"[a-z][a-z'’\-]*")
BAD_EN = re.compile(r"https?://|www\.|<|>|\{|\}|\||\\")
MIN_EN, MAX_EN = 10, 100
MAX_EN_WORDS = 14
# 少于 3 个词的不算句子（`Approximately.` 这种背了等于没背），
# 句末必须有真标点，否则语料里会混进标题片段。
MIN_EN_WORDS = 3
MIN_ZH, MAX_ZH = 2, 40
HAN_RE = re.compile(r"[\u4e00-\u9fff]")

# 不规则变体（够用就行，不求全）：只收考试词里高频的几十个
IRREGULAR = {
    "child": ["children"], "man": ["men"], "woman": ["women"], "foot": ["feet"],
    "tooth": ["teeth"], "mouse": ["mice"], "goose": ["geese"], "person": ["people"],
    "analysis": ["analyses"], "crisis": ["crises"], "phenomenon": ["phenomena"],
    "criterion": ["criteria"], "datum": ["data"], "medium": ["media"],
    "thesis": ["theses"], "hypothesis": ["hypotheses"], "basis": ["bases"],
    "index": ["indices", "indexes"], "appendix": ["appendices"],
    "matrix": ["matrices"], "vertex": ["vertices"], "axis": ["axes"],
    "go": ["went", "gone", "goes"], "do": ["did", "done", "does"],
    "be": ["was", "were", "been", "is", "are", "am"], "have": ["had", "has"],
    "make": ["made"], "take": ["took", "taken"], "give": ["gave", "given"],
    "get": ["got", "gotten"], "come": ["came"], "see": ["saw", "seen"],
    "know": ["knew", "known"], "think": ["thought"], "say": ["said"],
    "tell": ["told"], "find": ["found"], "feel": ["felt"], "leave": ["left"],
    "bring": ["brought"], "buy": ["bought"], "catch": ["caught"], "teach": ["taught"],
    "fight": ["fought"], "seek": ["sought"], "hold": ["held"], "keep": ["kept"],
    "sleep": ["slept"], "stand": ["stood"], "understand": ["understood"],
    "write": ["wrote", "written"], "speak": ["spoke", "spoken"],
    "break": ["broke", "broken"], "choose": ["chose", "chosen"],
    "drive": ["drove", "driven"], "eat": ["ate", "eaten"], "fall": ["fell", "fallen"],
    "forget": ["forgot", "forgotten"], "grow": ["grew", "grown"],
    "hide": ["hid", "hidden"], "lie": ["lay", "lain"], "rise": ["rose", "risen"],
    "run": ["ran"], "sell": ["sold"], "send": ["sent"], "sing": ["sang", "sung"],
    "sit": ["sat"], "spend": ["spent"], "steal": ["stole", "stolen"],
    "swim": ["swam", "swum"], "throw": ["threw", "thrown"], "wear": ["wore", "worn"],
    "win": ["won"], "begin": ["began", "begun"], "bear": ["bore", "borne"],
}


def variants(word):
    """一个词在语料里可能出现的形态（原形 + 常见变形）。"""
    w = word.lower()
    out = {w}
    out |= set(IRREGULAR.get(w, ()))
    if len(w) < 3:
        return out
    if w.endswith("y") and len(w) > 3 and w[-2] not in "aeiou":
        out |= {w[:-1] + "ies", w[:-1] + "ied"}
    if w.endswith(("s", "x", "z", "ch", "sh")):
        out.add(w + "es")
    else:
        out.add(w + "s")
    out.add(w + "ed")
    out.add(w + "d")
    if w.endswith("e"):
        out.add(w[:-1] + "ing")
    elif w.endswith("ie"):
        out.add(w[:-2] + "ying")
    else:
        out.add(w + "ing")
    # 双写末尾辅音：stop → stopped / stopping
    if len(w) >= 3 and w[-1] not in "aeiouwy" and w[-2] in "aeiou" and w[-3] not in "aeiou":
        out |= {w + w[-1] + "ed", w + w[-1] + "ing"}
    # 比较级/最高级：big → bigger / biggest
    if len(w) >= 3 and w[-1] not in "aeiouwy":
        out |= {w + "er", w + "est"}
    return out


def ensure_corpus():
    BASE.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        p = BASE / name
        if p.exists() and p.stat().st_size > 1000:
            print(f"  语料已有: {name}  {p.stat().st_size/1048576:.1f} MB")
            continue
        print(f"  下载 {name} …")
        urllib.request.urlretrieve(url, p)
        print(f"    完成 {p.stat().st_size/1048576:.1f} MB")


def load_sentences(name, want_lang):
    out = {}
    with bz2.open(BASE / name, "rt", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t", 2)
            if len(parts) < 3 or parts[1] != want_lang:
                continue
            out[int(parts[0])] = parts[2]
    return out


def iter_sentences(name, want_lang):
    """流式读（英文语料 24 MB 压缩，全读进字典不值得）。"""
    with bz2.open(BASE / name, "rt", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t", 2)
            if len(parts) < 3 or parts[1] != want_lang:
                continue
            yield parts[2]


def word_list():
    res = subprocess.run(
        ["node", str(ROOT / "tools" / "list-words.mjs")],
        capture_output=True,
        check=True,
    )
    return [w["word"] for w in json.loads(res.stdout.decode("utf-8"))]


def ok_english(en):
    """英文句子的通用筛选（两轮共用）。"""
    if BAD_EN.search(en):
        return False
    if not (MIN_EN <= len(en) <= MAX_EN):
        return False
    words = en.split()
    if not (MIN_EN_WORDS <= len(words) <= MAX_EN_WORDS):
        return False
    return en.rstrip()[-1:] in ".!?"


def main():
    try:
        import opencc
        # tw2sp = 台版繁体 → 简体（含地区词替换：義大利→意大利、軟體→软件）
        cc = opencc.OpenCC("tw2sp")
    except ImportError:
        print("✗ 缺 opencc：pip install opencc-python-reimplemented", file=sys.stderr)
        return 1

    ensure_corpus()
    words = word_list()
    target = {w.lower() for w in words}
    print(f"  词表: {len(target)} 个词（去重）")

    print("  读英文句子 …")
    eng = load_sentences("eng_sentences.tsv.bz2", "eng")
    print(f"    {len(eng)} 句")
    print("  读中文句子 …")
    cmn = load_sentences("cmn_sentences.tsv.bz2", "cmn")
    print(f"    {len(cmn)} 句")

    print("  读配对 …")
    pairs = []
    with bz2.open(BASE / "cmn-eng_links.tsv.bz2", "rt", encoding="utf-8") as f:
        for line in f:
            a, b = line.split()
            a, b = int(a), int(b)
            zh = cmn.get(a) or cmn.get(b)
            en = eng.get(b) or eng.get(a)
            if zh and en:
                pairs.append((en, zh))
    print(f"    {len(pairs)} 对")

    # ── 第一轮：中英对照（有译文）────────────────────────────────
    best = {}       # 词 → (en, zh)
    hits = {}
    for en, zh_raw in pairs:
        if not ok_english(en):
            continue
        low = en.lower()
        toks = set(TOKEN_RE.findall(low))
        if not toks:
            continue
        zh = cc.convert(zh_raw)
        if not (MIN_ZH <= len(zh) <= MAX_ZH):
            continue
        # Tatoeba 的"中文"里混着英文片段（实测抓到一条 `percent: 100%。`，
        # 一个汉字都没有）。要求：至少 2 个汉字，且汉字占比 ≥ 50%。
        han = len(HAN_RE.findall(zh))
        if han < 2 or han / len(zh) < 0.5:
            continue
        for t in toks & target:
            hits[t] = hits.get(t, 0) + 1
            cur = best.get(t)
            if cur is None or len(en) < len(cur[0]):
                best[t] = (en, zh)
    print(f"  第一轮（有译文）: {len(best)} 个词（{len(best)/len(target)*100:.1f}%）")

    # ── 第二轮：英文单语（没译文，只给英文）──────────────────────
    #
    # 为什么值得多跑一遍：criterion / phenomenon / mortgage 这类词在中英
    # 对照里就是没有，但英文语料里到处都是。**只给英文，不给翻译** ——
    # 编一句中文译文就是假数据。
    missing = target - set(best)
    print(f"  第二轮：给剩下 {len(missing)} 个词找英文单语例句 …")
    # 变体 → 原形（一个变体可能对应多个原形，如 axes → axis/axe，都记）
    var_map = {}
    for w in missing:
        for v in variants(w):
            var_map.setdefault(v, []).append(w)
    exact_best = {}   # 原形命中（形态一致）
    variant_best = {}  # 变体命中
    scanned = 0
    for en in iter_sentences("eng_sentences.tsv.bz2", "eng"):
        scanned += 1
        if not ok_english(en):
            continue
        toks = TOKEN_RE.findall(en.lower())
        if not toks:
            continue
        for t in toks:
            owners = var_map.get(t)
            if not owners:
                continue
            for w in owners:
                bucket = exact_best if t == w else variant_best
                cur = bucket.get(w)
                if cur is None or len(en) < len(cur):
                    bucket[w] = en
    print(f"    扫了 {scanned} 句：原形命中 {len(exact_best)}，仅变体命中 {len(variant_best)}")
    for w in missing:
        en = exact_best.get(w) or variant_best.get(w)
        if en:
            best[w] = (en, None)

    entries = sorted(best.items())
    with_zh = sum(1 for _, (_, zh) in entries if zh)
    print(f"  最终: {len(entries)} 个词有例句（{len(entries)/len(target)*100:.1f}%），"
          f"其中带译文 {with_zh} 个（{with_zh/len(target)*100:.1f}%）")

    lines = [
        "// vocab-study / core / examples-data.mjs",
        "//",
        "// ⚠️ **这个文件是生成的，不要手改。**",
        "//    生成命令：python tools/make-examples.py",
        "//",
        "// 每个词一句真实例句，能配到中文译文就一起带上。补 ECDICT 没有例句的空白。",
        "// 数据来源：Tatoeba <https://tatoeba.org>（CC BY 2.0），",
        "// 中文经 OpenCC `tw2sp` 转成简体（含台版用词替换：義大利→意大利）。",
        "// 署名与许可全文见 docs/third-party/README.md。",
        "//",
        "// 格式：{ 词: [英文例句, 中文翻译或 null] }",
        "// 译文为 null = 这个词只有英文单语例句（语料里没配对译文），",
        "// 界面上只显示英文那一行 —— **不要**给它编一句中文。",
        "",
        "export const EXAMPLES = {",
    ]
    for w, (en, zh) in entries:
        lines.append(f"  {json.dumps(w, ensure_ascii=False)}: "
                     f"[{json.dumps(en, ensure_ascii=False)}, {json.dumps(zh, ensure_ascii=False)}],")
    lines.append("};")
    lines.append("")
    lines.append("export const EXAMPLES_COVERAGE = {")
    lines.append(f"  words: {len(target)},")
    lines.append(f"  withExample: {len(entries)},")
    lines.append(f"  withZh: {with_zh},")
    lines.append(f"  pairs: {len(pairs)},")
    lines.append("  source: 'Tatoeba (CC BY 2.0)',")
    lines.append("};")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"  写出 {OUT}  {OUT.stat().st_size/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
