#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从英文语料里挖「常见搭配」，生成 core/colloc-data.mjs。

两个语料源（都可离线，产物里分段标注）
----------------------------------------------------------------------------
  · Tatoeba 英文句 204 万句（CC BY 2.0）—— 口语化、短句多
  · Simple English Wikipedia 全量（CC BY-SA 4.0）—— 校对人写的事实句，词更正式
两库的计数是**合并**的：同一个组合出现次数够多才放行，所以第二库主要帮
那些「在 Tatoeba 里只出现七八次、样本不够」的词过关。

为什么要重写
----------------------------------------------------------------------------
上一版直接数二元组词频，结果是这样的垃圾：

    consult → better consult / to consult / consult the
    fish    → a fish / fish is / this fish

因为「相邻」不等于「搭配」。这一版只认**闭类词结构**，也就是语法上
几乎不可能凑错的那几种：

  1. 词 + 介词       consult **with** / access **to** / responsible **for**
  2. be + 形容词 + 介词   be interested **in** / be good **at**
  3. 动词 + 小品词      give **up** / take **off** / put **on**

介词和小品词是封闭集合（几十个词），所以这些组合的可信度远高于裸词频；
像 "better consult" 这种（副词 + 动词）根本进不了候选。

为什么要 corpus 计数 ≥ 3
----------------------------------------------------------------------------
只出现 1 次的组合多半是偶然搭配或断句噪声。要求同一个组合在不同句子
出现 ≥ 3 次，等于要求它真的是这个语料里的稳定用法。

用法
----------------------------------------------------------------------------
    python tools/make-collocations.py                 # 全量（约 4~6 分钟）
    python tools/make-collocations.py --limit 200000  # 只扫前 N 句，调参用
    python tools/make-collocations.py --no-wiki       # 只用 Tatoeba（快，旧口径）
    python tools/make-collocations.py --audit         # 只看产物统计，不重挖
"""

import argparse
import bz2
import io
import json
import math
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TATOEBA = os.environ.get('TATOEBA_DIR') or os.path.join(os.path.dirname(ROOT), '_tatoeba')
# Simple English Wikipedia 全量 dump（CC BY-SA 4.0）。不进仓库；
# 生成器跑之前要先下载（约 342 MB bz2）。
WIKI = os.environ.get('SIMPLEWIKI_DUMP') or os.path.join(
    os.path.dirname(ROOT), '_extra-corpus', 'simplewiki.xml.bz2')
OUT = os.path.join(ROOT, 'core', 'colloc-data.mjs')

# 介词：只收真正构成搭配的（排除 like/near/than 这类比较、近似词，噪声大）
PREPS = {
    'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around',
    'as', 'at', 'before', 'behind', 'below', 'beneath', 'beside', 'between',
    'beyond', 'by', 'despite', 'during', 'except', 'for', 'from', 'in', 'inside',
    'into', 'of', 'off', 'on', 'onto', 'out', 'outside', 'over', 'past',
    'through', 'throughout', 'to', 'toward', 'towards', 'under', 'until', 'upon',
    'with', 'within', 'without',
}
# 小品词（构成短语动词）：只收动词后能独立成义的
PARTICLES = {
    'up', 'down', 'off', 'on', 'in', 'out', 'over', 'back', 'away', 'through',
    'around', 'about', 'along', 'aside', 'apart', 'behind', 'by', 'forward',
    'together', 'across', 'ahead', 'over', 'under',
}
DETS = {'a', 'an', 'the', 'this', 'that', 'these', 'those',
        'his', 'her', 'its', 'their', 'our', 'my', 'your'}
# 代词：窗口规则里夹在动词与介词之间的"宾语"最常见就是这些
# 动词槽位判据：这些词前面出现的词，说明后面那个词很可能在当动词用。
VERB_LEAD = {'i', 'you', 'we', 'they', 'he', 'she', 'it', 'who', 'that', 'which', 'people',
             'to', 'will', 'would', 'can', 'could', 'may', 'might', 'should', 'must', 'shall',
             'do', 'does', 'did', 'not', 'never', 'always', 'often', 'usually', 'sometimes',
             'just', 'also', 'then', 'please', 'lets', 'dont', 'doesnt', 'didnt', 'cant',
             'wont', 'couldnt', 'shouldnt', 'wouldnt', 'youll', 'well', 'ill', 'theyre',
             'youre', 'weve', 'ive', 'had', 'has', 'have', 'was', 'were', 'is', 'are'}
# 宾格代词：紧跟在这些词后面，前面的词基本就是动词。
# 限定词/量词。它们在词典释义里挂着名词义（most = 大多数、few = 少数），
# 但真用起来是限定词 —— "unlike most" 这么收进来是个断头短语（most 后面还有别的词）。
# 名词类结构（形容词+名词 / 动词+宾语 / 名词+of+名词）都不拿它们当落点。
DET_LIKE = {'most', 'many', 'much', 'some', 'all', 'both', 'few', 'several', 'other',
            'another', 'each', 'every', 'either', 'neither', 'any', 'no', 'such',
            'more', 'less', 'least', 'enough', 'every', 'whatever', 'whichever'}

OBJ_PRON = {'me', 'you', 'him', 'her', 'it', 'us', 'them', 'myself', 'yourself', 'himself',
            'herself', 'itself', 'ourselves', 'themselves'}

PRON = {'me', 'you', 'him', 'her', 'it', 'us', 'them',
        'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves', 'themselves',
        'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything',
        'everyone', 'everybody', 'everything', 'nobody', 'nothing', 'who', 'what',
        'this', 'that', 'these', 'those'}
# 动词与介词之间最多隔几个词（宾语通常 1 个词，冠词+名词是 2 个）
PREP_WINDOW = 3
BE = {'be', 'am', 'is', 'are', 'was', 'were', 'been',
      # 缩写形式：不加这些，"I'm interested in" 里的 be 就抓不到，
      # "be interested in" 这种整块搭配会漏掉一半
      "i'm", "you're", "he's", "she's", "it's", "we're", "they're", "that's"}

# 一个英文句子最多处理多少 token（超长句子多为杂讯，且拖慢速度）
MAX_TOKENS = 60
MIN_COUNT = 3          # 同一组合至少出现在 3 个句子里
MIN_COUNT_VERB_PREP = 6  # 动词+介词：抬到 6 次，靠频次挡偶然相邻（下面占比放宽了）
MIN_RATIO = 0.04       # 占比门槛。10% 会把 protect from(3%) / compare with(5%) 这种真搭配误杀；
                       # 放宽到 5% 后由更高的频次门槛（见 MIN_COUNT_VERB_PREP）挡住噪声
MIN_COUNT_ADJ_BARE = 5  # 形容词裸配介词（不带 be）要求更高，噪声大
MIN_COUNT_ADJ_NOUN = 4  # 形容词 + 名词 / 动词 + 宾语
MIN_COUNT_PARTICLE = 4  # 动词 + 小品词：结构极可靠，只看频次（"give up" 在 give 的
                        # 全部用法里占比很小，用占比会误杀高频词的好搭配）
MIN_COUNT_BE_ADJ = 4    # be + 形容词 + 介词：同理
MIN_WORD_LEN = 2

# 选择排序用的结构权重（配合 log(频次) 相乘）：
# 权重只用来在**量级相近**时偏向更可信/更好记的结构，不能让低频项靠结构翻盘。
#   4 = be+形容词+介词（"be interested in" 整块最好记）
#   2 = 词+介词，3 = 动词+小品词（短语动词）
#   3.5 = 名词+of+名词，1.5 = 动词+冠词+名词，1 = 形容词+名词
STRUCT_WEIGHT = {4: 2.0, 3: 1.5, 2: 1.5, 3.5: 1.2, 1.5: 0.8, 1: 0.6}

# ⚠️ 连字符词必须算**一个** token：原来 `[-a-z]+` 会把 mother-in-law 切成
# mother / in / law，于是凭空产出 "mother in" 这种搭配（实测抽到了）。
TOKEN_RE = re.compile(r"[a-z]+(?:['\-][a-z]+)*")
# 释义里的词性标记（ECDICT 的中文释义格式：`n. 关心；vt. 涉及`）
POS_RE = re.compile(r'\b(n|v|vt|vi|adj|a|adv|ad|prep|conj|pron|num|art)\.')
POS_MAP = {'n': 'n', 'v': 'v', 'vt': 'v', 'vi': 'v', 'adj': 'adj', 'a': 'adj',
           'adv': 'adv', 'ad': 'adv', 'prep': 'prep', 'conj': 'conj',
           'pron': 'pron', 'num': 'num', 'art': 'art'}
# 词条自带的 pos 字段格式：`v.` / `a./n.` / `n./v.` / `ad.`
POS_FIELD_RE = re.compile(r'(vt|vi|adj|adv|ad|n|v|a|prep|conj|pron|num|art)\b')
CONTENT_POS = {'n', 'v', 'adj'}   # 能构成搭配的实词词性


def parse_pos(row):
    """词性 = 词条自带字段 ∪ 中文释义里的标记。

    为什么要求并集而不是"字段优先、空了才看释义"：
    ECDICT 的 pos 字段只记**第一个义项**的词性 —— give 的首义是名词
    （"弹性"），字段就是 `n.`，可它明明还有 `vt. 给`。只看字段会把 give
    判成纯名词，于是 give up / give in 这些最该有的搭配全挖不出来。
    """
    got = set()
    field = (row.get('pos') or '').strip()
    if field:
        got |= {POS_MAP[m] for m in POS_FIELD_RE.findall(field.lower()) if m in POS_MAP}
    meaning = row.get('meaning') or ''
    got |= {POS_MAP[m] for m in POS_RE.findall(meaning) if m in POS_MAP}
    return got


def load_words():
    """用 Node 把内置词库吐成 JSON（含释义与词性）。"""
    out = subprocess.run(
        ['node', os.path.join(HERE, 'list-words.mjs')],
        cwd=ROOT, capture_output=True, check=True,
    )
    rows = json.loads(out.stdout.decode('utf-8'))
    words = {}
    for r in rows:
        w = (r.get('word') or '').strip().lower()
        if not w or not re.fullmatch(r"[a-z][a-z'-]*", w):
            continue
        words[w] = {'pos': parse_pos(r), 'meaning': (r.get('meaning') or '')[:40]}
    return words


def iter_sentences(path, limit=None):
    """流式读 Tatoeba 英文句表：`id<TAB>eng<TAB>句子`。"""
    n = 0
    with bz2.open(path, 'rb') as f:
        for raw in f:
            n += 1
            if limit and n > limit:
                break
            try:
                parts = raw.decode('utf-8', 'ignore').rstrip('\n').split('\t')
            except Exception:
                continue
            if len(parts) < 3:
                continue
            yield parts[2]



WIKI_TEXT_RE = re.compile(r'<text[^>]*>(.*?)</text>', re.S)
WIKI_LINK_RE = re.compile(r'\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]')     # [[目标|显示]] → 显示
WIKI_EXT_RE = re.compile(r'\[https?://[^\]]*\]')                     # 外链整条丢掉
WIKI_TMPL_RE = re.compile(r'\{\{[^{}]*\}\}')                        # 模板（可能嵌套）
WIKI_REF_RE = re.compile(r'<ref[^>]*>.*?</ref>|<ref[^>]*/>', re.S)      # 引用
WIKI_TAG_RE = re.compile(r'<[^>]+>')                                    # 其它标签
SENT_SPLIT_RE = re.compile(r'(?<=[.!?])\s+')


def strip_wiki(text):
    """把维基标记剥成纯文本（只求能数搭配，不追求完美还原）。"""
    text = WIKI_LINK_RE.sub(r'\1', text)
    text = WIKI_EXT_RE.sub('', text)
    for _ in range(3):           # 模板会嵌套，多剥两遍
        text = WIKI_TMPL_RE.sub(' ', text)
    text = WIKI_REF_RE.sub(' ', text)
    text = WIKI_TAG_RE.sub(' ', text)
    text = text.replace(chr(39) * 5, '').replace(chr(39) * 3, '').replace(chr(39) * 2, '')
    for a, b in (('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'),
                 ('&#39;', chr(39)), ('&nbsp;', ' ')):
        text = text.replace(a, b)
    return text


def iter_wiki_sentences(path, limit=None):
    """流式读 Wikipedia XML dump，逐句 yield。不整包读进内存。"""
    n = 0
    with bz2.open(path, 'rb') as f:
        buf = ''
        for raw in f:
            buf += raw.decode('utf-8', 'ignore')
            last = buf.rfind('</text>')
            if last < 0:
                if len(buf) > 8 * 1024 * 1024:      # 防御：某页异常长就丢前缀
                    buf = buf[-1024:]
                continue
            # ⚠️ 切分必须**把 </text> 一起留下当结尾**，否则 chunk 里没有闭合标签，
            # 正则一个都匹配不上 —— 第一版就是这么写的，小样本立刻抓出来 0 句。
            # 缓存里只留还没收尾的部分。
            chunk = buf[:last + 7]
            buf = buf[last + 7:]
            for m in WIKI_TEXT_RE.finditer(chunk):
                for sent in SENT_SPLIT_RE.split(strip_wiki(m.group(1))):
                    sent = sent.strip()
                    if not sent:
                        continue
                    n += 1
                    if limit and n > limit:
                        return
                    yield sent


def iter_corpus(eng_path, wiki_path, limit=None):
    """先 Tatoeba 后 Wikipedia，拼成一个句子流。返回 (生成器, 句数统计)。"""
    stats = {'tatoeba': 0, 'wiki': 0}

    def gen():
        for text in (iter_sentences(eng_path, limit) if eng_path else ()):
            stats['tatoeba'] += 1
            yield text
        if wiki_path:
            for text in iter_wiki_sentences(wiki_path, limit):
                stats['wiki'] += 1
                yield text

    return gen(), stats

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=None, help='只扫前 N 句（调参用）')
    ap.add_argument('--audit', action='store_true', help='只看已生成产物的统计')
    ap.add_argument('--min-count', type=int, default=MIN_COUNT)
    ap.add_argument('--no-wiki', action='store_true', help='只用 Tatoeba（快，旧口径）')
    ap.add_argument('--wiki', default=WIKI, help='Simple English Wikipedia dump 路径')
    ap.add_argument('--wiki-only', action='store_true', help='只挖 Wikipedia（配合合并用）')
    ap.add_argument('--out', default=OUT, help='产物路径（默认 core/colloc-data.mjs）')
    ap.add_argument('--dump-counts', default=None,
                    help='把原始计数导成 JSON（合并时做两库交叉验证用）')
    args = ap.parse_args()

    if args.audit:
        audit()
        return

    t0 = time.time()
    words = load_words()
    print(f'  词表 {len(words)} 个词（含词性解析）')

    eng = os.path.join(TATOEBA, 'eng_sentences.tsv.bz2')
    if not os.path.exists(eng):
        sys.exit(f'  ✗ 找不到语料：{eng}（用 TATOEBA_DIR 环境变量指过去）')

    # 计数器：key 用元组，最后再降级成大写键
    prep_cnt = {}      # (word, prep)          → 词 + 介词
    noun_prep_cnt = {}     # (noun, prep)          → 名词 + 介词（access to / reason for）
    noun_prep_det = {}     # (noun, prep)          → 同上，但前面紧跟着冠词/限定词
    verb_noun_cnt = {}     # (verb, noun)          → 动词 + 裸名词（achieve success）
    # 动词槽位证据：这个词到底在句子里当过动词没有。
    # 词典释义里"顺便带一个罕见动词义"的词很多（rabbit / rifle / butter / party 都有），
    # 只看 pos 里有没有 v 会把它们当动词，"rabbit on"、"rifle at" 这种就漏出来了。
    verb_slot_cnt = {}
    be_adj_cnt = {}    # (word, prep)  be + 形容词 + 介词
    adj_prep_cnt = {}  # (adj, prep)   形容词 + 介词（不带 be：similar to / relevant to）
    particle_cnt = {}  # (word, particle)      → 动词 + 小品词
    adj_noun_cnt = {}  # (adj, noun)           → be 之外的形容词+名词
    noun_of_cnt = {}   # (noun, noun)          → 名词 + of + 名词
    verb_obj_cnt = {}  # (verb, 'det noun')      → 动词 + 冠词 + 名词
    base_cnt = {}      # word                  → 出现次数（算占比用）

    if args.wiki_only:
        wiki = args.wiki
        if not os.path.exists(wiki):
            sys.exit('  ✗ --wiki-only 但找不到 dump：%s' % wiki)
        print('  语料：只用 Simple English Wikipedia（%.0f MB）' % (os.path.getsize(wiki) / 1048576))
    elif args.no_wiki:
        wiki = None
        print('  语料：Tatoeba（不加 Wikipedia）')
    elif os.path.exists(args.wiki):
        wiki = args.wiki
        print('  语料：Tatoeba + Simple English Wikipedia（%.0f MB）' % (os.path.getsize(args.wiki) / 1048576))
    else:
        wiki = None
        print('  ⚠ 没找到 Wikipedia dump（%s），这次只用 Tatoeba' % args.wiki)

    total_sent = 0
    total_tok = 0
    stream, src_stats = iter_corpus(None, wiki, args.limit) if args.wiki_only else iter_corpus(eng, wiki, args.limit)
    for text in stream:
        total_sent += 1
        toks = TOKEN_RE.findall(text.lower())
        if len(toks) < 2 or len(toks) > MAX_TOKENS:
            continue
        total_tok += len(toks)
        for i, w in enumerate(toks):
            info = words.get(w)
            if info is None or len(w) < MIN_WORD_LEN:
                continue
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            prv = toks[i - 1] if i > 0 else None
            if nxt is None:
                continue
            poses = info['pos']
            base_cnt[w] = base_cnt.get(w, 0) + 1
            # 只有动词/形容词才产出「词+介词」。名词单独撞上介词不算搭配
            # （"gun at" 的真相是 "point a gun at"，介词是动词要求的），
            # 名词改走下面的「名词 + of + 名词」结构。
            verbish = 'v' in poses
            adjish = 'adj' in poses or not poses

            # ① 动词 + 介词
            if nxt in PREPS and verbish:
                k = (w, nxt)
                prep_cnt[k] = prep_cnt.get(k, 0) + 1

            # ①b0 动词槽位证据：前面是主语代词 / 情态助动词 / to / not，
            #     或者后面紧跟冠词、宾格代词（动词后面接宾语）。
            if prv in VERB_LEAD or nxt in DETS or nxt in OBJ_PRON:
                verb_slot_cnt[w] = verb_slot_cnt.get(w, 0) + 1

            # ①c 名词 + 介词（"access to" / "reason for" / "solution to"）
            # 名词选介词是学习者最需要的搭配之一（"什么介词接在这个名词后面"），
            # 但名词撞介词的噪声远大于动词 —— 所以后面选择时要求两条之一：
            #   · 这个名词**前面有冠词/限定词**（"the access to"）出现占多数
            #   · 或者该组合在该词全部出现里占比 ≥ 15% 且有 8 次以上
            # 名词 + of 走下面的 ⑤（名词 + of + 名词），这里排除 of，避免重复。
            if 'n' in poses and nxt in PREPS and nxt != 'of':
                k = (w, nxt)
                noun_prep_cnt[k] = noun_prep_cnt.get(k, 0) + 1
                if prv in DETS:
                    noun_prep_det[k] = noun_prep_det.get(k, 0) + 1

            # ①d 动词 + 裸名词（"achieve success" / "abandon hope"）
            # ③b 只收"动词 + 冠词 + 名词"，漏掉了不带冠词的固定搭配。
            if verbish and nxt not in DETS and nxt not in PREPS and nxt not in PARTICLES:
                ninfo = words.get(nxt)
                if ninfo is not None and 'n' in ninfo['pos']:
                    k = (w, nxt)
                    verb_noun_cnt[k] = verb_noun_cnt.get(k, 0) + 1

            # ①b 动词 + [宾语] + 介词（窗口）
            # 相邻统计抓不到 "protect sb from" / "accuse sb of" / "spend sth on" ——
            # 介词前面还隔着一个宾语。这里允许跨 2~3 个词，但中间那些词必须是
            # 代词/冠词/词表里的名词（否则 "protect and from" 这种也会被算进来）。
            if verbish:
                for gap in range(2, PREP_WINDOW + 1):
                    j = i + gap
                    if j >= len(toks):
                        break
                    mid = toks[i + 1:j]
                    if not all(
                        t in PRON or t in DETS
                        or (t in words and 'n' in words[t]['pos'])
                        for t in mid
                    ):
                        continue
                    if toks[j] in PREPS:
                        k = (w, toks[j])
                        prep_cnt[k] = prep_cnt.get(k, 0) + 1
                        break

            # ② be + 形容词 + 介词 —— "be interested in" 整块更好记
            if nxt in PREPS and adjish and prv in BE:
                k = (w, nxt)
                be_adj_cnt[k] = be_adj_cnt.get(k, 0) + 1
                prep_cnt[k] = prep_cnt.get(k, 0) + 1

            # ③ 动词 + 小品词：给 up/off 这类短语动词
            #    （不要求后面不是介词："give up on" 也是好搭配）
            if nxt in PARTICLES and verbish:
                k = (w, nxt)
                particle_cnt[k] = particle_cnt.get(k, 0) + 1

            # ③b 动词 + 冠词 + 名词 → "abandon a plan"。语法上不会错，
            #     而且是学习者最需要的"这个词怎么用"的样本。
            if verbish and nxt in DETS and i + 2 < len(toks):
                n2 = toks[i + 2]
                n2info = words.get(n2)
                if n2info is not None and 'n' in n2info['pos'] and n2 not in PREPS:
                    obj = f'{nxt} {n2}'
                    # 名词后若还跟一个名词（"the death penalty"），一起收进来，
                    # 否则会出现 "abolish the death" 这种断头短语
                    if i + 3 < len(toks):
                        n3 = toks[i + 3]
                        n3info = words.get(n3)
                        if n3info is not None and 'n' in n3info['pos'] and n3 not in PREPS and n3 != 'of':
                            obj = f'{obj} {n3}'
                    k = (w, obj)
                    verb_obj_cnt[k] = verb_obj_cnt.get(k, 0) + 1

            # ③c 形容词 + 介词（不带 be）：similar to / relevant to / afraid of
            # 这类短语在语料里多数会以 "be + adj + prep" 出现（be_adj 渠道已经收），
            # 但定语位置也会出现：a problem similar to this / matters relevant to us。
            if adjish and nxt in PREPS and nxt != 'of':
                k = (w, nxt)
                adj_prep_cnt[k] = adj_prep_cnt.get(k, 0) + 1

            # ④ 形容词 + 名词（"sole concern"）：邻词的词性已知是名词才收
            if adjish and i + 1 < len(toks):
                ninfo = words.get(nxt)
                if ninfo is not None and 'n' in ninfo['pos'] and nxt not in DET_LIKE:
                    k = (w, nxt)
                    adj_noun_cnt[k] = adj_noun_cnt.get(k, 0) + 1

            # ⑤ 名词 + of + 名词（"abolition of slavery"）：两端都是我们的词，
            #    随机撞上的概率极低，是名词唯一靠谱的结构
            if 'n' in poses and nxt == 'of' and i + 2 < len(toks):
                n2 = toks[i + 2]
                n2info = words.get(n2)
                if n2info is not None and 'n' in n2info['pos'] and n2 not in PREPS:
                    k = (w, n2)
                    noun_of_cnt[k] = noun_of_cnt.get(k, 0) + 1

    print(f'  扫了 {total_sent} 句 / {total_tok} 个词，用时 {time.time() - t0:.0f}s')

    def keep(k, c, floor):
        """频次 + 占比双闸门：既要有一定出现次数，也要占该词用法的足够份额。"""
        base = base_cnt.get(k[0], 0) or 1
        return c >= floor and c / base >= MIN_RATIO

    # ── 汇总：每个词最多 3 条，按「结构可信度 → 频次」排序 ──────────
    per_word = {}
    for k, c in prep_cnt.items():
        # 动词槽位证据不足 → 这个词的"动词搭配"不算（rabbit on / rifle at 就是这么进来的）
        if verb_slot_cnt.get(k[0], 0) < 3:
            continue
        if keep(k, c, MIN_COUNT_VERB_PREP):
            floor = MIN_COUNT if ('n' in words[k[0]]['pos'] or 'v' in words[k[0]]['pos']) else MIN_COUNT_ADJ_BARE
            if c >= floor:
                per_word.setdefault(k[0], []).append((2, c, f'{k[0]} {k[1]}'))
    # 名词 + 介词：还要看「这个名词自己更爱哪个介词」。
    # 只出现 8 次、前面又刚好有冠词是不够的 —— "go to the gym in the morning" 里
    # gym 后面也跟 in，但那不是 gym 的搭配。真搭配的表现是：在该名词所有"后接介词"
    # 的出现里，某一个介词占绝对多数（access → to、appetite → for、reason → for）。
    prep_total_for = {}
    for (w2, _p), c2 in noun_prep_cnt.items():
        prep_total_for[w2] = prep_total_for.get(w2, 0) + c2
    for k, c in noun_prep_cnt.items():
        base = base_cnt.get(k[0], 0) or 1
        pref = c / (prep_total_for.get(k[0], c) or 1)
        # 还要看**名词前有没有冠词**：
        #   抽象名词接补语时常常裸用（"access to education" / "emphasis on safety"），
        #   具体名词基本都带冠词（"the rabbit in the hat" / "the butter in the pan"）。
        # 只靠偏好度会放出 rabbit in / squirrel on / butter in 这类地点短语假搭配，
        # 抽样时被抓住了；加这条"裸用占多数"才收得干净。
        det_share = noun_prep_det.get(k, 0) / c
        # 两条路收一个：(a) 裸用占多数（抽象名词接补语）(b) 介词偏好度极高（≥85%）
        # —— "the solution to" 这种带冠词的也必须收，它是真搭配。
        ok_noun_prep = (pref >= 0.6 and det_share <= 0.45) or (pref >= 0.85) or (pref >= 0.75 and c >= 15)
        if c >= 10 and ok_noun_prep and c / base >= 0.10:
            per_word.setdefault(k[0], []).append((2.2, c, f'{k[0]} {k[1]}'))
    for k, c in verb_noun_cnt.items():
        # 动词槽位证据不足 → 这个词的"动词搭配"不算（rabbit on / rifle at 就是这么进来的）
        if verb_slot_cnt.get(k[0], 0) < 3:
            continue
        base = base_cnt.get(k[0], 0) or 1
        if c >= 6 and c / base >= 0.06:
            per_word.setdefault(k[0], []).append((1.2, c, f'{k[0]} {k[1]}'))
    for k, c in adj_prep_cnt.items():
        base = base_cnt.get(k[0], 0) or 1
        # 不带 be 的证据更弱，所以要求次数更高、占比更大
        if c >= 6 and c / base >= 0.06:
            per_word.setdefault(k[0], []).append((1.5, c, f'{k[0]} {k[1]}'))
    for k, c in be_adj_cnt.items():
        if c >= MIN_COUNT_BE_ADJ:
            per_word.setdefault(k[0], []).append((4, c, f'be {k[0]} {k[1]}'))
    for k, c in particle_cnt.items():
        # 动词槽位证据不足 → 这个词的"动词搭配"不算（rabbit on / rifle at 就是这么进来的）
        if verb_slot_cnt.get(k[0], 0) < 3:
            continue
        if c >= MIN_COUNT_PARTICLE:
            per_word.setdefault(k[0], []).append((3, c, f'{k[0]} {k[1]}'))
    for k, c in adj_noun_cnt.items():
        if keep(k, c, MIN_COUNT_ADJ_NOUN):
            per_word.setdefault(k[0], []).append((1, c, f'{k[0]} {k[1]}'))
    for k, c in verb_obj_cnt.items():
        if keep(k, c, MIN_COUNT_ADJ_NOUN):
            per_word.setdefault(k[0], []).append((1.5, c, f'{k[0]} {k[1]}'))
    for k, c in noun_of_cnt.items():
        if keep(k, c, MIN_COUNT_ADJ_NOUN):
            per_word.setdefault(k[0], []).append((3.5, c, f'{k[0]} of {k[1]}'))

    result = {}
    for w, items in per_word.items():
        # 同一个短语可能从两条结构里各计一次：
        # "vote in" 既是「动词+介词」也是「动词+小品词」。不合并的话重复项会白占名额。
        # 这正是真实 bug 的来源：vote 最终只剩 in/on/by（各 8~30 次），
        # 而出现 234 次、占比 48% 的 "vote for" 被挤掉了。
        merged = {}
        for prio, c, phrase in items:
            cur = merged.get(phrase)
            if cur is None or c > cur[1]:
                merged[phrase] = (prio, c)

        # 排序改成 log(频次) × 结构权重，而不是"先按结构分档、同档再按频次"。
        # 分档排序的副作用：结构可靠但只有 8 次的 "vote by" 压掉 234 次的 "vote for"。
        # 用 log 是为了让结构权重还起作用（be interested in 优先于 interested×N 的零碎），
        # 但不会让低频项靠"结构高级"翻盘。
        scored = sorted(
            merged.items(),
            key=lambda kv: -(math.log(1 + kv[1][1]) * STRUCT_WEIGHT.get(kv[1][0], 1.0)),
        )
        seen_phrase = set()
        picked = []
        for phrase, (_prio, _c) in scored:
            # 同一词组形式优先：be interested in 与 interested in 同时出现时只留 be 式
            short = phrase.split(' ', 1)[1] if phrase.startswith('be ') else phrase
            if short in seen_phrase:
                continue
            seen_phrase.add(short)
            picked.append(phrase)
            if len(picked) >= 3:
                break
        if picked:
            result[w] = picked

    if args.dump_counts:
        dump_counts(args.dump_counts, locals())
    write(result, len(words), total_sent, args.min_count, src_stats, bool(wiki), args.out)
    report(result, words)


def dump_counts(path, sc):
    """把各结构计数器拍平成 {短语: 次数}，合并时用来做两库交叉验证。

    短语形态必须和 select 里生成的一致，否则两边对不上。
    """
    out = {}
    for k, c in sc['prep_cnt'].items():
        p = f'{k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['particle_cnt'].items():
        p = f'{k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['be_adj_cnt'].items():
        p = f'be {k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['adj_prep_cnt'].items():
        p = f'{k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['adj_noun_cnt'].items():
        p = f'{k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['verb_noun_cnt'].items():
        p = f'{k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['verb_obj_cnt'].items():
        p = f'{k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['noun_prep_cnt'].items():
        p = f'{k[0]} {k[1]}'
        out[p] = max(out.get(p, 0), c)
    for k, c in sc['noun_of_cnt'].items():
        p = f'{k[0]} of {k[1]}'
        out[p] = max(out.get(p, 0), c)
    # 顺便把词性一起存下来：合并时要用它区分「名词+介词」（"airport in" 这种位置
    # 短语噪声）和真正的补语搭配。
    pos = {}
    for w in out:
        head = w.split(' ', 2)[1] if w.startswith('be ') else w.split(' ', 1)[0]
        info = sc['words'].get(head)
        if info is not None:
            pos[head] = ''.join(sorted(info['pos']))
    out['__pos__'] = pos
    # 词频也存一份：合并时要算「这条搭配占该词用法的多少」，
    # 只出现几次的偶然相邻（accept ... of）占比极低，会被这道闸门挡掉。
    out['__base__'] = {w: c for w, c in sc['base_cnt'].items() if w in pos}
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, sort_keys=True)
    print(f'  导出原始计数 {path}（{len(out) - 1} 条短语 + {len(pos)} 个词的词性）')


def write(result, total_words, total_sent, min_count, src_stats=None, with_wiki=False, out=None):
    out = out or OUT
    src_stats = src_stats or {'tatoeba': total_sent, 'wiki': 0}
    lines = [
        '// vocab-study / core / colloc-data.mjs',
        '// ⚠️ 生成产物，不要手改：python tools/make-collocations.py',
        '//',
        '// 数据来源：Tatoeba 英文语料（CC BY 2.0）' + (
            ' + Simple English Wikipedia（CC BY-SA 4.0）' if with_wiki else ''), 
        '// 按「闭类词结构」统计出的搭配；两库计数合并。',
        '// 只收三种结构：词+介词 / be+形容词+介词 / 动词+小品词，每个组合必须在',
        f'// 语料里出现 ≥ {min_count} 次才算数（避免偶然相邻）。',
        '//',
        '// 这不是词典里的"标准搭配"，是**这个语料里稳定出现的搭配**。',
        '// 查不到的词就完全留空，界面上不出现「常见搭配」这一项。',
        '',
        'export const COLLOCATIONS = {',
    ]
    for w in sorted(result):
        arr = ', '.join("'" + p.replace("'", "\\'") + "'" for p in result[w])
        lines.append(f"  '{w}': [{arr}],")
    lines.append('};')
    lines.append('')
    cov = {
        'words': total_words,
        'withColloc': len(result),
        'sentences': total_sent,
        'minCount': min_count,
        'source': ('Tatoeba (CC BY 2.0) + Simple English Wikipedia (CC BY-SA 4.0)'
                   if with_wiki else 'Tatoeba (CC BY 2.0)'),
        'sentencesTatoeba': src_stats['tatoeba'],
        'sentencesWiki': src_stats['wiki'],
    }
    lines.append('export const COLLOC_COVERAGE = ' + json.dumps(cov, ensure_ascii=False) + ';')
    lines.append('')
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    print(f'  写出 {out}  {os.path.getsize(out) / 1024:.0f} KB')


def report(result, words):
    total = len(words)
    have = len(result)
    print('')
    print(f'  有搭配 {have} / {total} = {have / total * 100:.2f}%')
    # 分库覆盖
    import itertools
    for coll in ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre']:
        out = subprocess.run(['node', os.path.join(HERE, 'list-words.mjs'), coll],
                             cwd=ROOT, capture_output=True, check=True)
        ws = [r['word'].lower() for r in json.loads(out.stdout.decode('utf-8'))]
        hit = sum(1 for w in ws if w in result)
        print(f'    {coll:8s} {hit:5d} / {len(ws):5d} = {hit / len(ws) * 100:5.1f}%')
    print('')
    print('  抽样 15 个词：')
    for w in list(itertools.islice(sorted(result), 15)):
        print(f'    {w:14s} {result[w]}')
    print('')
    print('  上一次的垃圾样本现在是什么样（关键回归检查）：')
    for w in ['consult', 'fish', 'access', 'interested', 'give', 'rely', 'responsible']:
        print(f'    {w:14s} {result.get(w, "（无）")}')


def audit():
    if not os.path.exists(OUT):
        sys.exit(f'  ✗ 产物不存在：{OUT}')
    src = io.open(OUT, encoding='utf-8').read()
    m = re.search(r'export const COLLOC_COVERAGE = (\{.*?\});', src, re.S)
    print('  ' + (m.group(1) if m else '（找不到覆盖率元数据）'))
    words = re.findall(r"^  '([a-z'-]+)':", src, re.M)
    print(f'  条目数 {len(words)}')


if __name__ == '__main__':
    main()
