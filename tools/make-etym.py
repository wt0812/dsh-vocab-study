#!/usr/bin/env python3
"""生成 core/etym-data.mjs —— 每个词的**真实词源**（英文维基词典的词源段）。

## 数据来源与许可

英文维基词典（https://en.wiktionary.org ）词源章节，许可 **CC BY-SA 4.0**。
因此本生成器产出的 `core/etym-data.mjs` **单独以 CC BY-SA 4.0 授权**，
代码本体仍是 MIT —— 两份许可见 `docs/third-party/README.md` 与 `core/etym-data.mjs` 头部。

## 两种输出，界面上必须分开显示

- `split`  = **构词拆解**（维基模板明确给出前缀/后缀/复合词），例如
            `landfill → {{compound|en|land|fill}}` → `land + fill`
- `origin` = **只能追到来源**，例如 `stamina → {{bor|en|la|stāmina}}` → `来自拉丁语 stāmina`
- 两者都没有 → **不产出条目**（界面上整块不显示，绝不硬编）

「词根词缀」那一行只放 `split`；`origin` 放它自己的「词源」折叠块。
混在一起就是骗人：`来自拉丁语 stāmina` 不是"拆解"。

## 用法

    python tools/make-etym.py                 # 全量（≈1.4 万词，约 5–10 分钟）
    python tools/make-etym.py --limit 300     # 只跑前 300 个（试跑）
    python tools/make-etym.py --refresh       # 忽略缓存重新取

带缓存（`_ecdict/etym-cache.jsonl`），中断后重跑不会从头再来。
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "core" / "etym-data.mjs"
CACHE = ROOT / "_ecdict" / "etym-cache.jsonl"
API = "https://en.wiktionary.org/w/api.php"
UA = ("dsh-vocab-study/1.0 (offline vocabulary plugin; "
      "one-time data build; https://github.com/wt0812/dsh-vocab-study)")

BATCH = 50          # MediaWiki 单次 titles 上限
SLEEP = 0.25        # 对维基客气一点
MAXLAG = 5

# ── 维基模板 ────────────────────────────────────────────────────────────
# 精确构词：能直接拆出词素
SPLIT_TPL = re.compile(
    r"\{\{\s*(prefix|pre|suffix|suf|confix|circumfix|compound|affix|blend)\s*\|([^}]{0,200})\}\}",
    re.I,
)
# 来源：借用 / 派生 / 继承 / 来自
ORIGIN_TPL = re.compile(
    r"\{\{\s*(bor|borrowed|lbor|slbor|inh|inherited|der|derived|uder|from|calque|noncog)\s*\|([^}]{0,200})\}\}",
    re.I,
)
# 原始印欧语 / 原始日耳曼语词根（`{{root|en|ine-pro|*pel-|id=drive}}`）
ROOT_TPL = re.compile(r"\{\{\s*root\s*\|([^}]{0,160})\}\}", re.I)
# 新式紧凑模板：{{ety|en|:af|meteor|-ite|text=+|tree=1}}
ETY_TPL = re.compile(r"\{\{\s*ety\s*\|([^}]{0,240})\}\}", re.I)

# ── 语言代码 → 中文名（只列常见的；查不到就原样显示代码，不编） ────────
LANG = {
    "en": "英语", "enm": "中古英语", "ang": "古英语", "gem-pro": "原始日耳曼语",
    "la": "拉丁语", "LL": "晚期拉丁语", "ML": "中世纪拉丁语", "la-lat": "拉丁语",
    "grc": "古希腊语", "el": "希腊语", "ine-pro": "原始印欧语",
    "fr": "法语", "frm": "中古法语", "fro": "古法语", "fro-old": "古法语",
    "xno": "盎格鲁-诺曼语", "nrf": "诺曼语", "pro": "古奥克语",
    "it": "意大利语", "es": "西班牙语", "pt": "葡萄牙语", "ca": "加泰罗尼亚语",
    "de": "德语", "goh": "古高地德语", "gmh": "中古高地德语", "gml": "中古低地德语",
    "nl": "荷兰语", "dum": "中古荷兰语", "odt": "古荷兰语",
    "non": "古诺尔斯语", "is": "冰岛语", "sv": "瑞典语", "da": "丹麦语", "no": "挪威语",
    "ru": "俄语", "pl": "波兰语", "cs": "捷克语", "uk": "乌克兰语",
    "ar": "阿拉伯语", "fa": "波斯语", "he": "希伯来语", "tr": "土耳其语",
    "hi": "印地语", "sa": "梵语", "zh": "汉语", "ja": "日语", "ko": "朝鲜语",
    "ga": "爱尔兰语", "cy": "威尔士语", "gd": "苏格兰盖尔语", "cel-pro": "原始凯尔特语",
    "sla-pro": "原始斯拉夫语", "gem": "日耳曼语", "roa": "罗曼语",
    "mul": "多语", "und": "来源不明", "onom": "拟声",
}
# 这些"来源"其实是语言内部演变，说出来等于没说
WEAK_SOURCE = {"en", "enm", "ang"}   # 英语自身链条仍有用，单独处理（见 origin_text）


def english_etymology(wikitext: str) -> str:
    """截出 `==English==` 下的第一个 `===Etymology ...===` 段。"""
    m = re.search(r"^==\s*English\s*==\s*$", wikitext, re.M)
    if not m:
        return ""
    rest = wikitext[m.end():]
    nxt = re.search(r"^==\s*[^=]+\s*==\s*$", rest, re.M)
    body = rest[: nxt.start()] if nxt else rest
    e = re.search(r"^===\s*Etymology[^=]*===\s*$", body, re.M)
    if not e:
        return ""
    rest2 = body[e.end():]
    nxt2 = re.search(r"^===\s*[^=]+\s*===\s*$", rest2, re.M)
    return rest2[: nxt2.start()] if nxt2 else rest2


def clean(s: str) -> str:
    """去掉模板里常见的花活：注释、链接、粗体、标签。"""
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"\[\[([^\]|]*\|)?([^\]]*)\]\]", r"\2", s)   # [[a|b]] → b
    s = re.sub(r"'{2,}", "", s)                              # 粗斜体
    s = re.sub(r"<[^>]*>", "", s)                            # <t:…> <pos:…> <ref:…>
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)                     # 嵌套模板整块删掉
    s = re.sub(r"\s+", " ", s)
    return s.strip()


# 只接受"像个词素/单词"的东西。模板残留（`la-cla:cynicus`、`etydate=1590`、
# `{{glossary`）里全是这些字符，一旦漏进卡片就是给用户看垃圾。
MORPHEME_RE = re.compile(r"^[A-Za-z][A-Za-z'\- ]{0,24}$")
# 数据文本里**绝对不能**出现的东西。花括号尤其要挡：
# 它们会打乱构建脚本的括号深度计数，害得后面声明的常量被当成"不存在"。
FORBIDDEN_RE = re.compile(r"[{}<>|=\[\]]")


def gloss_of(param: str) -> str:
    """从 `<t:cut, shorten>` / `<gloss:…>` 里取出释义，其它标签（pos/id/ref）丢掉。"""
    for m in re.finditer(r"<(t|gloss)\s*:\s*([^<>]*?)>", param):
        g = clean(m.group(2))
        if g:
            return g
    return ""


def split_params(raw: str):
    """把模板参数按 `|` 切开，跳过 `t1=`/`gloss1=` 这类命名参数。"""
    out = []
    for p in raw.split("|"):
        p = p.strip()
        if not p:
            continue
        if "=" in p and re.match(r"^[a-z0-9_]+\s*=", p, re.I):
            continue
        out.append(clean(p))
    return out


def split_text(raw: str, tpl: str) -> str:
    """把构词模板翻成 `dis- + tribute` 这种人能读的形式。

    每个词素后面如果带 `<t:释义>` 就补成 `dis-(分开)`。
    只要有一个词素不像词素，整条丢掉 —— 宁可这词退回「只给来源」，也不给用户看半截模板。
    """
    parts = split_params(raw)
    if len(parts) < 2:
        return ""
    lang = parts[0].lower() if re.match(r"^[a-z\-]{2,8}$", parts[0]) else ""
    morphemes = parts[1:] if lang else parts
    # 第一个参数经常是语言代码，去掉
    if morphemes and morphemes[0].lower() in LANG:
        morphemes = morphemes[1:]
    if len(morphemes) < 2:
        return ""
    out = []
    for m in morphemes:
        g = gloss_of(m)
        bare = re.sub(r"<[^>]*>", "", m)            # 去掉标签
        bare = re.sub(r"^\s*\d+=.*$", "", bare)      # 去掉 t1=… 这种命名参数
        bare = clean(bare).strip()
        bare = re.sub(r"^-+|-+$", "", bare)
        if not MORPHEME_RE.match(bare):
            return ""
        out.append(bare + (f"({g})" if g else ""))
    low = tpl.lower()
    if low in ("prefix", "pre"):
        out[0] = out[0] + "-"
    elif low in ("suffix", "suf"):
        out[-1] = "-" + out[-1]
    text = " + ".join(out)
    if FORBIDDEN_RE.search(text):
        return ""
    prefix = "" if lang in ("", "en") else f"{LANG.get(lang, lang)} "
    return f"{prefix}{text}"


def origin_text(ety: str) -> str:
    """追来源链：`中古英语 peny ← 古英语 peniġ` 或 `来自拉丁语 stāmina`。

    模板参数结构是 `{{inh|当前语|来源语|词|释义}}` —— 注意 **params[1] 才是来源语言**，
    params[0] 是词条自己的语言（几乎总是 en）。第一版把 params[0] 当来源，
    结果满屏「英语 enm」，试跑 150 词时抓到。
    """
    hops = []
    for m in ORIGIN_TPL.finditer(ety):
        params = split_params(m.group(2))
        if len(params) < 3:
            continue
        src_lang = params[1].lower()
        word = re.sub(r"<[^>]*>", "", params[2])     # 标签先剥掉
        word = clean(word)
        if src_lang not in LANG:
            continue
        if FORBIDDEN_RE.search(word):
            continue
        # 只收「像单词」的来源词：带音标/希腊字母/星号的词根都合法，
        # 但带 = | [ ] 的一定是模板残留。
        if not re.match(r"^[A-Za-z\u00c0-\u024f\u0370-\u03ff*][A-Za-z\u00c0-\u024f"
                        r"\u0370-\u03ff*'\- ]{0,29}$", word):
            continue
        hops.append((src_lang, word))
        if len(hops) >= 2:    # 两跳够了，再多就成了语言学年表
            break
    if not hops:
        # 没有来源模板，但可能有原始印欧/日耳曼词根
        rm = ROOT_TPL.search(ety)
        if rm:
            params = split_params(rm.group(1))
            if len(params) >= 3:
                lang, rootword = params[1].lower(), params[2]
                if lang in LANG:
                    return f"{LANG[lang]}词根 {rootword}"
        return ""
    if len(hops) == 1:
        lang, word = hops[0]
        return f"来自{LANG[lang]} {word}"
    lang1, w1 = hops[0]
    lang2, w2 = hops[1]
    return f"{LANG[lang1]} {w1} ← {LANG[lang2]} {w2}"


def parse_ety(ety: str):
    """返回 (kind, text)；解析不出来返回 None。"""
    # 1) 精确构词模板
    for m in SPLIT_TPL.finditer(ety):
        t = split_text(m.group(2), m.group(1))
        if t:
            return ("split", t)
    # 2) 新式 {{ety|...|:af|...}} 里的 affix
    for m in ETY_TPL.finditer(ety):
        params = [p.strip() for p in m.group(1).split("|")]
        if ":af" in params or ":affix" in params:
            idx = params.index(":af") if ":af" in params else params.index(":affix")
            parts = [p for p in params[idx + 1:]
                     if p and not p.startswith(("text=", "tree=", "nocat="))]
            parts = [clean(re.sub(r"<[^>]*>", "", p)).strip("-") for p in parts]
            parts = [p for p in parts if p and not p.startswith(":")]
            # 模板嵌套会把 `la-cla:cynicus` 这种碎片混进来 —— 全部按词素规格筛一遍
            if len(parts) >= 2 and all(MORPHEME_RE.match(p) for p in parts):
                text = " + ".join(parts)
                if not FORBIDDEN_RE.search(text):
                    return ("split", text)
    # 3) 来源链
    t = origin_text(ety)
    if t:
        return ("origin", t)
    return None


def fetch_batch(titles):
    params = {
        "action": "query", "prop": "revisions", "rvprop": "content",
        "rvslots": "main", "format": "json", "formatversion": "2",
        "maxlag": str(MAXLAG), "redirects": "1",
        "titles": "|".join(titles),
    }
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


def load_cache():
    cache = {}
    if CACHE.exists():
        with CACHE.open(encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                cache[rec["w"]] = rec
    return cache


def word_list(limit=None):
    import subprocess
    res = subprocess.run(["node", str(ROOT / "tools" / "list-words.mjs")],
                         capture_output=True, check=True)
    words = [w["word"] for w in json.loads(res.stdout.decode("utf-8"))]
    return words[:limit] if limit else words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--workers", type=int, default=4,
                    help="并发批次数（默认 4；对维基别超过 8）")
    args = ap.parse_args()

    words = word_list(args.limit or None)
    if args.refresh and CACHE.exists():
        # 重抓就别往旧缓存后面追加 —— 同一词会出现多行，
        # 虽然读的时候后写的赢，但文件会越用越脏（第一版跑到 26k 行）。
        CACHE.unlink()
    cache = {} if args.refresh else load_cache()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    todo = [w for w in words if w not in cache]
    print(f"  词表 {len(words)}，已有缓存 {len(words) - len(todo)}，待取 {len(todo)}"
          f"（{args.workers} 并发）", flush=True)

    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    t0 = time.time()
    done = 0
    import concurrent.futures as cf

    def work(batch):
        time.sleep(SLEEP)
        try:
            data = fetch_batch(batch)
        except Exception as exc:
            return batch, {w: None for w in batch}, str(exc)
        by_title = {}
        for page in data.get("query", {}).get("pages", []):
            title = page.get("title", "").lower()
            if page.get("missing"):
                by_title[title] = None
                continue
            try:
                by_title[title] = page["revisions"][0]["slots"]["main"]["content"]
            except Exception:
                by_title[title] = None
        return batch, by_title, None

    with CACHE.open("a", encoding="utf-8") as cachefile:
        with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(work, b) for b in batches]
            for fut in cf.as_completed(futures):
                batch, by_title, err = fut.result()
                if err:
                    print(f"  ! 批次失败：{err}", file=sys.stderr)
                    continue
                for w in batch:
                    text = by_title.get(w.lower())
                    parsed = None
                    if text:
                        ety = english_etymology(text)
                        if ety:
                            parsed = parse_ety(ety)
                    rec = {"w": w, "r": parsed[0] if parsed else None,
                           "t": parsed[1] if parsed else None}
                    cache[w] = rec
                    cachefile.write(json.dumps(rec, ensure_ascii=False) + "\n")
                done += len(batch)
                cachefile.flush()
                if done % 1000 < BATCH:
                    el = time.time() - t0
                    print(f"    {done}/{len(todo)}  已用 {el:.0f}s", flush=True)

    # 兜底过滤：文本里只要出现 `{ } < > | = [ ]` 就整条丢掉。
    # 花括号不只是难看 —— 它会把构建脚本的括号深度计数带歪，
    # 导致后面声明的常量被误判成"源码里不存在"（第一版就是这么崩的）。
    raw_entries = [(r["w"], r["r"], r["t"]) for r in cache.values() if r["r"]]
    entries = sorted(e for e in raw_entries if e[2] and not FORBIDDEN_RE.search(e[2]))
    dropped = len(raw_entries) - len(entries)
    split = [e for e in entries if e[1] == "split"]
    origin = [e for e in entries if e[1] == "origin"]
    none = len(cache) - len(entries)
    print(f"  完成：拆解 {len(split)}，来源 {len(origin)}，无 {none}（其中 {dropped} 条因模板残留被丢）")
    lines = [
        "// vocab-study / core / etym-data.mjs",
        "//",
        "// ⚠️ **这个文件是生成的，不要手改。**",
        "//    生成命令：python tools/make-etym.py",
        "//",
        "// 每个词的**真实词源**，补「我们手写词根表拆不出来」的那一半。",
        "// 两种类型，界面上必须分开显示：",
        "//   split  构词拆解（维基模板明确给出前缀/后缀/复合词）→ 进「词根词缀」那一行",
        "//   origin 只能追到来源（来自拉丁语 stāmina）→ 进单独的「词源」折叠块",
        "// 两者都没有的词不产出条目 —— 界面上整块不显示，不硬编。",
        "//",
        "// **许可**：数据来自英文维基词典（CC BY-SA 4.0），本文件因此单独以",
        "// CC BY-SA 4.0 授权；代码本体仍是 MIT。详见 docs/third-party/README.md。",
        "//",
        "// 格式：{ 词: [类型, 文本] }",
        "",
        "export const ETYM = {",
    ]
    for w, kind, text in entries:
        lines.append(f"  {json.dumps(w, ensure_ascii=False)}: "
                     f"[{json.dumps(kind, ensure_ascii=False)}, {json.dumps(text, ensure_ascii=False)}],")
    lines.append("};")
    lines.append("")
    lines.append("export const ETYM_COVERAGE = {")
    lines.append(f"  words: {len(words)},")
    lines.append(f"  split: {len(split)},")
    lines.append(f"  origin: {len(origin)},")
    lines.append(f"  none: {none},")
    lines.append("  source: 'Wiktionary (CC BY-SA 4.0)',")
    lines.append("};")
    lines.append("")
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"  写出 {OUT}  {OUT.stat().st_size/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
