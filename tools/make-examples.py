#!/usr/bin/env python3
"""生成 core/examples-data.mjs —— 每个词一句「真实英文例句 + 中文翻译」。

## 数据来源

Tatoeba 中英对照语料（https://tatoeba.org ，CC BY 2.0，只需署名）。
用到的三个导出文件（per_language 目录下的 bz2）：
  - cmn_sentences.tsv.bz2    中文句子
  - eng_sentences.tsv.bz2    英文句子
  - cmn-eng_links.tsv.bz2    中文句 ↔ 英文句 的配对

## 这是一次性生成器（跟 make-seeds.mjs 同类）

产物 `core/examples-data.mjs` **要提交进仓库**；运行时不下载、不联网。
生成需要：Python 3 + `opencc-python-reimplemented`（繁转简）+ 网络（首次下载语料）。

## 用法

    pip install opencc-python-reimplemented
    python tools/make-examples.py                    # 默认语料目录 .\_tatoeba
    TATOEBA_DIR=D:\\tatoeba python tools/make-examples.py

语料文件不存在会自动下载（约 25 MB）。

## 挑选规则（宁可少，不要烂）

1. 句子必须含目标词，且是**独立单词**（不能是 longer 词的子串）
2. 英文 10–100 字符、不超过 14 个词
3. 中文 2–40 字，转简体
4. 同一句里只给**最短**的那条（短句更好背）
5. 丢掉带 URL、脚本、异常标点的句子
6. 每个词**只要 1 句** —— 卡片背面一行就够，多了是噪音
"""

import bz2
import json
import os
import re
import subprocess
import sys
import urllib.request
from collections import defaultdict
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


def word_list():
    res = subprocess.run(
        ["node", str(ROOT / "tools" / "list-words.mjs")],
        capture_output=True,
        check=True,
    )
    return [w["word"] for w in json.loads(res.stdout.decode("utf-8"))]


def main():
    try:
        import opencc
        cc = opencc.OpenCC("t2s")
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

    # 每个词收集候选；只留最短的那条
    best = {}
    hits = defaultdict(int)
    for en, zh_raw in pairs:
        if BAD_EN.search(en):
            continue
        if not (MIN_EN <= len(en) <= MAX_EN):
            continue
        if len(en.split()) > MAX_EN_WORDS:
            continue
        if len(en.split()) < MIN_EN_WORDS:
            continue
        if not en.rstrip()[-1:] in ".!?":
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
            hits[t] += 1
            cur = best.get(t)
            if cur is None or len(en) < len(cur[0]):
                best[t] = (en, zh)

    # 丢掉长得完全一样的例句（同一句话被塞给太多词时反而不值钱，保留）
    entries = sorted(best.items())
    print(f"  最终: {len(entries)} 个词有例句（{len(entries)/len(target)*100:.1f}%）")

    lines = [
        "// vocab-study / core / examples-data.mjs",
        "//",
        "// ⚠️ **这个文件是生成的，不要手改。**",
        "//    生成命令：python tools/make-examples.py",
        "//",
        "// 每个词一句真实例句 + 中文翻译，补 ECDICT 没有例句的空白。",
        "// 数据来源：Tatoeba 中英对照语料 <https://tatoeba.org>（CC BY 2.0），",
        "// 中文经 OpenCC 统一转简体。署名与许可全文见 docs/third-party/README.md。",
        "//",
        "// 格式：{ 词: [英文例句, 中文翻译] }",
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
    lines.append(f"  pairs: {len(pairs)},")
    lines.append("  source: 'Tatoeba (CC BY 2.0)',")
    lines.append("};")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"  写出 {OUT}  {OUT.stat().st_size/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
