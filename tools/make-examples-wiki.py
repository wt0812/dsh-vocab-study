#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""vocab-study / tools / make-examples-wiki.py

给「Tatoeba 里一次都没出现」的词，从 Simple English Wikipedia 里捞一句真例句。

为什么要做：例句覆盖 91.93%，剩下的 1,183 个词里有 486 个在 Wikipedia 里出现过
（325 个出现 ≥5 次）。它们不是没有例句，是 Tatoeba 没收录。

规则（宁可不出，不许出假）：
  · 只用**语料里真出现过的整句**，一个字都不改
  · 去重、去表格残留、去带数字/括号/引号的句子（百科表格碎片）
  · 长度 4~14 词（和 Tatoeba 那份一致，卡片排版用）、首选 10 词上下、含常见动词
  · 同一个词只留分数最高的一句
  · **不编中文译文**：这一份只有英文，界面在缺译文时不画译文行

用法：
  node tools/missing-examples.mjs > _missing-examples.json
  python tools/make-examples-wiki.py                    # 挖（约 5 分钟）
  python tools/make-examples-wiki.py --audit            # 只看产物统计
"""
import argparse
import bz2
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WIKI = os.environ.get('SIMPLEWIKI_DUMP') or os.path.join(
    os.path.dirname(ROOT), '_extra-corpus', 'simplewiki.xml.bz2')
OUT = os.path.join(ROOT, 'core', 'examples-wiki-data.mjs')
MISSING = os.path.join(ROOT, '_missing-examples.json')

# ── 维基标记剥离（和 tools/make-collocations.py 同一套规则，刻意复制一份：
#    不要去动已经跑通的挖掘脚本，宁可多几十行） ──
WIKI_TEXT_RE = re.compile(r'<text[^>]*>(.*?)</text>', re.S)
WIKI_LINK_RE = re.compile(r'\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]')
WIKI_EXT_RE = re.compile(r'\[https?://[^\]]*\]')
WIKI_TMPL_RE = re.compile(r'\{\{[^{}]*\}\}')
WIKI_REF_RE = re.compile(r'<ref[^>]*>.*?</ref>|<ref[^>]*/>', re.S)
WIKI_TAG_RE = re.compile(r'<[^>]+>')
SENT_SPLIT_RE = re.compile(r'(?<=[.!?])\s+')
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")

BAD_CHARS = frozenset('()[]{}|<>*=#@/\\"\u201c\u201d\u2018\u2019')
BAD_PHRASES = ('see also', 'references', 'external link', 'category:', 'wikidata',
               'retrieved', 'doi:', 'isbn', 'http', 'www.', 'cite ', 'thumb|')
# 一句"像人话"的例句得有个真动词。光靠长度分不清"标题/参考文献碎片"和句子 ——
# 第一版就混进了 'The evolution of anatomy: a short history …' 这种书目条目。
VERB_WORDS = frozenset('''
is are was were be been being am has have had do does did can could may might will would
shall should must make makes made made use uses used take takes took taken give gives gave given
get gets got gotten go goes went gone come comes came become becomes became call called calls
say says said tell tells told show shows showed shown know knows knew known think thinks thought
see sees saw seen find finds found feel feels felt leave leaves left put puts keep keeps kept
let lets begin begins began start starts started seem seems seemed help helps helped talk talks
talked turn turns turned move moves moved live lives lived believe believes believed hold holds
held bring brings brought happen happens happened write writes wrote written provide provides
provided sit sits sat stand stands stood lose loses lost pay pays paid meet meets met include
includes included continue continues continued set sets learn learns learned change changes
changed lead leads led understand understands understood watch watches watched follow follows
followed stop stops stopped create creates created speak speaks spoke spoken read reads allow
allows allowed add adds added spend spends spent grow grows grew grown open opens opened walk
walks walked win wins won offer offers offered remember remembers remembered consider considers
considered appear appears appeared buy buys bought wait waits waited serve serves served die
dies died send sends sent expect expects expected build builds built stay stays stayed fall
falls fell fallen cut cuts reach reaches reached kill kills killed remain remains remained
mean means meant consist consists consisted contain contains contained comprise comprises
measure measures measured flow flows flowed cover covers covered produce produces produced
form forms formed cause causes caused require requires required affect affects affected
occur occurs occurred increase increases increased reduce reduces reduced represent represents
represented describe describes described explain explains explained define defines defined
refer refers referred relate relates related depend depends depended compare compares compared
'''.split())
# 句尾这些是缩写，不是句子结尾（'… in small letters, e.g.' 就是断在这里的）
ABBREV_TAIL = ('e.g.', 'i.e.', 'etc.', 'vs.', 'al.', 'U.S.', 'Mr.', 'Mrs.', 'Dr.', 'No.', 'St.')



def load_targets():
    """读「缺例句的词」。文件不在/坏了就现跑 Node 生成 —— 顺带绕开 PowerShell
    的 `>` 重定向默认写 UTF-16 这个坑（第一版就是这么挂的）。"""
    node = os.environ.get('NODE_BIN') or 'node'
    need = True
    if os.path.exists(MISSING) and os.path.getsize(MISSING) > 10:
        raw = open(MISSING, 'rb').read()
        try:
            text = raw.decode('utf-16-le') if raw[:2] == b'\xff\xfe' else raw.decode('utf-8-sig')
            json.loads(text)
            need = False
        except Exception:
            need = True
    if need:
        sys.stderr.write('  词表不在，现跑 node tools/missing-examples.mjs …\n')
        r = subprocess.run([node, os.path.join(HERE, 'missing-examples.mjs')],
                           capture_output=True)
        if r.returncode != 0:
            sys.stderr.write('  ✗ Node 失败: %s\n' % r.stderr.decode('utf-8', 'ignore')[-400:])
            raise SystemExit(1)
        open(MISSING, 'wb').write(r.stdout)
        sys.stderr.write(r.stderr.decode('utf-8', 'ignore'))
        text = r.stdout.decode('utf-8')
    return set(json.loads(text))


def strip_wiki(text):
    text = WIKI_LINK_RE.sub(r'\1', text)
    text = WIKI_EXT_RE.sub('', text)
    for _ in range(3):
        text = WIKI_TMPL_RE.sub(' ', text)
    text = WIKI_REF_RE.sub(' ', text)
    text = WIKI_TAG_RE.sub(' ', text)
    text = text.replace(chr(39) * 5, '').replace(chr(39) * 3, '').replace(chr(39) * 2, '')
    for a, b in (('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'),
                 ('&#39;', chr(39)), ('&nbsp;', ' ')):
        text = text.replace(a, b)
    return text


def iter_wiki_sentences(path, limit=None):
    n = 0
    with bz2.open(path, 'rb') as f:
        buf = ''
        for raw in f:
            buf += raw.decode('utf-8', 'ignore')
            last = buf.rfind('</text>')
            if last < 0:
                if len(buf) > 8 * 1024 * 1024:
                    buf = buf[-1024:]
                continue
            chunk = buf[:last + 7]        # 必须把 </text> 一起留下，否则正则一个都匹配不上
            buf = buf[last + 7:]
            for m in WIKI_TEXT_RE.finditer(chunk):
                for sent in SENT_SPLIT_RE.split(strip_wiki(m.group(1))):
                    # 模板剥掉后会留下连续空格（'The sounds     of letters'），
                    # 例句要拿去直接展示，必须把空白压平。
                    sent = re.sub(r'\s+', ' ', sent).strip()
                    if not sent:
                        continue
                    n += 1
                    if limit and n > limit:
                        return
                    yield sent


def score_sentence(sent, tokens, target):
    """给一句话打分；返回 -1 表示直接不要。宁可不出，不许出碎片。"""
    n = len(tokens)
    # 长度必须和 Tatoeba 那份一致（3~14 词、≤100 字符）：卡片排版是按这个宽度设计的，
    # 也免得两套例句在界面上一个一行一个三行。
    if n < 4 or n > 14:
        return -1
    if len(sent) > 100:
        return -1
    if any(c in BAD_CHARS for c in sent):
        return -1
    if any(ch.isdigit() for ch in sent):
        return -1
    if not sent[:1].isupper():
        return -1
    body = sent.rstrip()
    if not body.endswith(('.', '!', '?')):
        return -1
    if body.endswith(ABBREV_TAIL):          # '…, e.g.' / 'U.S.' 这种是断掉的开头
        return -1
    if ':' in sent:                          # 书目/标题形态几乎都带冒号，整句不要
        return -1
    if sent.count(',') > 2:
        return -1
    if any('.' in t for t in tokens):        # U.S. / J Toxicol 这类缩写标记 → 引文
        return -1
    low = ' ' + sent.lower() + ' '
    for bad in BAD_PHRASES:
        if bad in low:
            return -1
    # 句中出现 'etc' 说明这句是从列举里切出来的半截，不要
    if re.search(r'\betc\b', low):
        return -1
    # 必须有一个真动词："像人话"的句子才有。
    toks_low = [t.lower() for t in tokens]
    if not any(t in VERB_WORDS for t in toks_low):
        return -1
    # 标题形态：实词大半首字母大写（'Henry Berger, the Royal Bandmaster.'）
    real = [t for t in tokens if len(t) > 2]
    if real:
        caps = sum(1 for t in real if t[:1].isupper())
        if caps / len(real) > 0.5:
            return -1
    s = 100 - abs(n - 10) * 2
    if ' the ' in low or ' a ' in low:
        s += 4
    s -= sent.count(',') * 3
    s -= max(0, sent.count(' and ') - 1) * 2
    return s


def mine(targets, limit=None, keep=3):
    """扫一遍语料，给每个词留 keep 个最高分候选。返回 {word: [(score, sent), ...]}"""
    best = {}
    t0 = time.time()
    scanned = 0
    for sent in iter_wiki_sentences(WIKI, limit):
        scanned += 1
        if scanned % 500000 == 0:
            sys.stderr.write('    已扫 %d 句，命中 %d 词  %.0fs\n'
                             % (scanned, len(best), time.time() - t0))
        toks = WORD_RE.findall(sent)
        if not toks:
            continue
        low_toks = [t.lower() for t in toks]
        hit = None
        for t in low_toks:
            if t in targets:
                hit = t
                break
            # 复数/过去式也收：zebras → zebra
            for suf in ('s', 'es', 'ed', 'ing', 'd'):
                if t.endswith(suf) and t[:-len(suf)] in targets:
                    hit = t[:-len(suf)]
                    break
            if hit:
                break
        if not hit:
            continue
        sc = score_sentence(sent, toks, hit)
        if sc < 0:
            continue
        arr = best.setdefault(hit, [])
        arr.append((sc, sent))
        if len(arr) > 6:
            arr.sort(key=lambda x: -x[0])
            del arr[keep:]
    for w in best:
        best[w].sort(key=lambda x: -x[0])
        del best[w][keep:]
    sys.stderr.write('  扫了 %d 句，%d 个词找到候选  %.0fs\n'
                     % (scanned, len(best), time.time() - t0))
    return best, scanned


def audit():
    s = open(OUT, encoding='utf-8').read()
    m = re.search(r'export const EXAMPLES_WIKI = (\{.*?\n\});', s, re.S)
    if not m:
        print('  ✗ 产物格式看不懂')
        return 1
    data = json.loads(m.group(1))
    print('  产物: %d 个词' % len(data))
    lens = [len(v[0].split()) for v in data.values()]
    if lens:
        print('  句子长度: 最短 %d / 中位 %d / 最长 %d 词'
              % (min(lens), sorted(lens)[len(lens) // 2], max(lens)))
    for w in list(data)[:12]:
        print('    %-14s %s' % (w, data[w][0]))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=None, help='只扫前 N 句（调试用）')
    ap.add_argument('--audit', action='store_true')
    ap.add_argument('--out', default=OUT)
    args = ap.parse_args()

    if args.audit:
        return audit()

    targets = load_targets()
    sys.stderr.write('  目标 %d 个缺例句的词\n' % len(targets))
    if not targets:
        sys.stderr.write('  没有要补的词，直接退出\n')
        return 0

    best, scanned = mine(targets, args.limit)

    picked = {}
    for w, arr in best.items():
        picked[w] = [arr[0][1]]
    # 键排序，保证重复跑产物一致（确定性构建）
    lines = []
    for w in sorted(picked):
        sent = picked[w][0]
        lines.append('  %s: [%s],' % (json.dumps(w), json.dumps(sent, ensure_ascii=False)))
    body = '\n'.join(lines)

    header = '''// vocab-study / core / examples-wiki-data.mjs
//
// 「例句」的补充来源：Simple English Wikipedia（CC BY-SA 4.0）。
//
// 为什么需要它：Tatoeba 英文句 204 万句覆盖了 13,470 个词，但还差一千多个词
// 一次都没出现（其中近半在 Wikipedia 里出现过）。这批词的卡片背面写着
// 「暂无例句」，而其实语料里是有的 —— 那就补上，但必须**只补真句子**。
//
// 生成方式（可重复，不要手改）：
//   node tools/missing-examples.mjs > _missing-examples.json
//   python tools/make-examples-wiki.py
//
// 条目形状：`{ word: [英文句] }` —— 只有一句英文，**没有中文**。
// 界面在缺译文时不画译文行（ui/panel.mjs），因为语料里没有配对，
// 编一句中文就是假数据。
//
// ⚠️ 许可：句子原文来自 Simple English Wikipedia（CC BY-SA 4.0）。
//    本文件作为派生数据按 CC BY-SA 4.0 分发，署名见
//    docs/third-party/SIMPLEWIKI-NOTICE.txt。
export const EXAMPLES_WIKI = {
%s
};

export const EXAMPLES_WIKI_COVERAGE = {"words": %d, "source": "Simple English Wikipedia (CC BY-SA 4.0)",
  "picked": %d, "sentencesScanned": %d};
''' % (body, len(picked), len(picked), scanned)

    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(header)
    sys.stderr.write('  ✓ 写出 %s（%d 个词）\n' % (args.out, len(picked)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
