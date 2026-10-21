#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""vocab-study / tools / make-colloc-titles.py

给「没有固定介词、但有固定名词搭配」的词补搭配 —— 用 Wikipedia 的**文章标题**。

为什么这么做：剩下 1 万多个没搭配的词，一大半是具体名词（zebra / kitchen /
wheat）。它们没有 "zebra to" 这种搭配，但有 "zebra crossing" / "kitchen table" /
"wheat flour" —— 这些正是学习者想知道的组合。现有的闭类词结构通道（词+介词、
be+形容词+介词）根本覆盖不到它们。

为什么信任标题：
  1. 标题是**人写的名字**，不是相邻词统计，"Zebra crossing" 本身就是这个词条的名字；
  2. 还有**第二道闸**：这条组合必须在 Tatoeba 的句子里真的出现过 ≥2 次 ——
     标题 + 语料双证据才收。

规则：
  · 只收「目标词 + 另一个词」的两词标题（三词标题噪声大，先不做）
  · 目标词必须在标题里小写（首字母大写的多半是专有名词：Zebra 品牌、Kitchen 人名）
  · 另一个词必须是名词（词性来自词库释义）
  · 跳过带括号/数字/标点/全大写的标题（"Zebra (disambiguation)" / "ISO 9000"）
  · Tatoeba 交叉验证 ≥2 次

用法：
  node tools/colloc-targets.mjs > _colloc-targets.json
  python tools/make-colloc-titles.py            # 扫标题 + Tatoeba 交叉验证（约 1 分钟）
  python tools/make-colloc-titles.py --audit
"""
import argparse
import bz2
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WIKI = os.environ.get('SIMPLEWIKI_DUMP') or os.path.join(
    os.path.dirname(ROOT), '_extra-corpus', 'simplewiki.xml.bz2')
TATOEBA_DIR = os.environ.get('TATOEBA_DIR') or os.path.join(os.path.dirname(ROOT), '_tatoeba')
ENG = os.environ.get('TATOEBA_ENG') or os.path.join(TATOEBA_DIR, 'eng_sentences.tsv.bz2')
TARGETS = os.path.join(ROOT, '_colloc-targets.json')
OUT = os.path.join(ROOT, '_colloc-titles.mjs')

TITLE_RE = re.compile(r'<title>(.*?)</title>', re.S)
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")
SENT_SPLIT_RE = re.compile(r'(?<=[.!?])\s+')


def load_targets():
    node = os.environ.get('NODE_BIN') or 'node'
    if not (os.path.exists(TARGETS) and os.path.getsize(TARGETS) > 10):
        sys.stderr.write('  现跑 node tools/colloc-targets.mjs …\n')
        r = subprocess.run([node, os.path.join(HERE, 'colloc-targets.mjs')], capture_output=True)
        if r.returncode != 0:
            sys.stderr.write('  ✗ Node 失败: %s\n' % r.stderr.decode('utf-8', 'ignore')[-400:])
            raise SystemExit(1)
        open(TARGETS, 'wb').write(r.stdout)
        sys.stderr.write(r.stderr.decode('utf-8', 'ignore'))
    raw = open(TARGETS, 'rb').read()
    text = raw.decode('utf-16-le') if raw[:2] == b'\xff\xfe' else raw.decode('utf-8-sig')
    data = json.loads(text)
    return set(data['targets']), data.get('pos') or {}, set(data.get('proper') or [])


def iter_titles(path):
    """流式读 dump 里的 <title>。标题在 <page> 最前面，不需要剥正文。"""
    with bz2.open(path, 'rb') as f:
        buf = ''
        for raw in f:
            buf += raw.decode('utf-8', 'ignore')
            last = buf.rfind('</title>')
            if last < 0:
                if len(buf) > 2 * 1024 * 1024:
                    buf = buf[-1024:]
                continue
            chunk = buf[:last + 8]
            buf = buf[last + 8:]
            for m in TITLE_RE.finditer(chunk):
                yield m.group(1)


def title_ok(title):
    if not title or len(title) > 40:
        return False
    if any(c in title for c in '()[]{}|<>/\\,:;=#@*"'):
        return False
    if any(ch.isdigit() for ch in title):
        return False
    if title.isupper():
        return False
    toks = WORD_RE.findall(title)
    if len(toks) != 2:                     # 只做两词标题
        return False
    if any(len(t) < 3 for t in toks):
        return False
    return True


def pick_phrase(title, targets, pos, proper):
    """标题拆成两个词，看哪一侧是目标词；另一侧必须是名词。"""
    toks = WORD_RE.findall(title)
    low = [t.lower() for t in toks]
    if low[0] in proper or low[1] in proper:   # 「south africa」是专名，不是学习搭配
        return []
    out = []
    # 目标词在前：word + X（如 zebra crossing）
    if low[0] in targets and toks[0][:1].islower() and 'n' in pos.get(low[1], ''):
        out.append((low[0], '%s %s' % (low[0], low[1])))
    # 目标词在后：X + word（如 kitchen table 里的 table 是目标词时反过来）
    if low[1] in targets and toks[1][:1].islower() and 'n' in pos.get(low[0], ''):
        out.append((low[1], '%s %s' % (low[0], low[1])))
    return out


def count_tatoeba(pairs):
    """在 Tatoeba 句子里数这些二元组出现了几次（跨句不算，按词序紧邻）。"""
    want = set(pairs)
    counts = {p: 0 for p in pairs}
    n = 0
    with bz2.open(ENG, 'rb') as f:
        for raw in f:
            parts = raw.decode('utf-8', 'ignore').rstrip('\n').split('\t')
            if len(parts) < 3:
                continue
            n += 1
            for sent in SENT_SPLIT_RE.split(parts[2]):
                toks = [t.lower() for t in WORD_RE.findall(sent)]
                for a, b in zip(toks, toks[1:]):
                    key = a + ' ' + b
                    if key in want:
                        counts[key] += 1
    sys.stderr.write('  Tatoeba 扫了 %d 句\n' % n)
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audit', action='store_true')
    ap.add_argument('--min-tatoeba', type=int, default=2)
    ap.add_argument('--max-per-word', type=int, default=2)
    args = ap.parse_args()

    if args.audit:
        s = open(OUT, encoding='utf-8').read()
        m = re.search(r'export const COLLOC_TITLES = (\{.*?\n\});', s, re.S)
        if not m:
            print('  ✗ 产物格式看不懂')
            return 1
        data = json.loads(m.group(1))
        print('  产物: %d 个词' % len(data))
        for w in list(data)[:12]:
            print('    %-14s %s' % (w, ' · '.join(data[w])))
        return 0

    targets, pos, proper = load_targets()
    sys.stderr.write('  目标 %d 个缺搭配的词\n' % len(targets))

    cand = {}   # phrase -> word
    titleCount = 0
    for title in iter_titles(WIKI):
        titleCount += 1
        if not title_ok(title):
            continue
        for word, phrase in pick_phrase(title, targets, pos, proper):
            cand[phrase] = word
    sys.stderr.write('  扫了 %d 个标题，候选两词组合 %d 条\n' % (titleCount, len(cand)))
    if not cand:
        return 0

    counts = count_tatoeba(set(cand))
    kept = {}
    for phrase, word in cand.items():
        if counts.get(phrase, 0) < args.min_tatoeba:
            continue
        kept.setdefault(word, []).append((counts[phrase], phrase))
    for w in kept:
        kept[w].sort(key=lambda x: (-x[0], x[1]))
        del kept[w][args.max_per_word:]
    sys.stderr.write('  交叉验证后 %d 个词 / %d 条搭配\n'
                     % (len(kept), sum(len(v) for v in kept.values())))

    lines = []
    for w in sorted(kept):
        phrases = [p for _, p in kept[w]]
        lines.append('  %s: %s,' % (json.dumps(w), json.dumps(phrases, ensure_ascii=False)))
    header = '''// vocab-study / _colloc-titles.mjs（**中间产物，不进仓库**）
//
// 「名词+名词」搭配的补充来源：Simple English Wikipedia 的**文章标题** +
// Tatoeba 句子交叉验证（同一组合必须真的在句子里出现过 ≥2 次）。
// 由 tools/make-colloc-titles.py 生成，最终由 tools/merge-colloc.mjs 合并进
// core/colloc-data.mjs。许可同 Simple English Wikipedia：CC BY-SA 4.0。
//
//   node tools/colloc-targets.mjs > _colloc-targets.json
//   python tools/make-colloc-titles.py
export const COLLOC_TITLES = {
%s
};

export const COLLOC_TITLES_COVERAGE = {"words": %d, "phrases": %d};
''' % ('\n'.join(lines), len(kept), sum(len(v) for v in kept.values()))

    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(header)
    sys.stderr.write('  ✓ 写出 %s\n' % OUT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
