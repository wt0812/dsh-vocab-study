"""盯住 vocab-study 上架社区市场。

盯三个可验证的信号，任一变化就写一行、并明确标出：

  1. pr_merged  —— PR 被合并（merged_at 非空）
  2. in_catalog —— 线上 plugins.json 出现 wt0812/dsh-vocab-study
                   （**这才是「市场里能搜到」那一步**，合并不等于立即可搜）
  3. entry.npm  —— 目录条目里的 npm 字段被每日探测填上
                   （填上之前，市场给别人的装法是 github:，不是 npm）

背景（2026-10-12 实测）：
  上游按创建时间从老到新处理 PR；我 #7043 排第 876 位（前面 875 个）。
  日均合并约 9 个，所以这是一个「以周/月计」的等待，不是「以小时计」。
  慢是正常的，脚本不要因为「很久没变化」就当成异常。

用法：
    python tools/pr-watch.py              # 默认每 20 分钟一次
    python tools/pr-watch.py 60           # 每 60 分钟一次
    PR_WATCH_MAX_HOURS=0 python ...       # 0 = 不限时（默认 720 小时 = 30 天）
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
PR_NUMBER = 7043
ENTRY_NAME = 'wt0812/dsh-vocab-study'
CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
STATUS_FILE = os.path.join(os.path.expanduser('~'), '.dsh', 'vocab-study-pr-watch.log')

PROXY = 'http://127.0.0.1:7890'
INTERVAL_MIN = int(sys.argv[1]) if len(sys.argv) > 1 else 20
MAX_HOURS = float(os.environ.get('PR_WATCH_MAX_HOURS', '720'))

GH = r'C:\Program Files\GitHub CLI\gh.exe'

env = dict(os.environ)
env['HTTPS_PROXY'] = PROXY
env['HTTP_PROXY'] = PROXY
OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}))


def stamp() -> str:
    return datetime.now().strftime('%m-%d %H:%M:%S')


def emit(line: str) -> None:
    out = '[%s] %s' % (stamp(), line)
    print(out, flush=True)
    try:
        os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
        with open(STATUS_FILE, 'a', encoding='utf-8') as f:
            f.write(out + '\n')
    except OSError:
        pass


def check_pr():
    """PR 的合并状态；None 表示查询失败（网络/代理问题），不是「没合」。"""
    try:
        r = subprocess.run(
            [GH, 'api', 'repos/%s/pulls/%d' % (UPSTREAM, PR_NUMBER)],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            env=env, timeout=120)
        if r.returncode != 0:
            return None
        d = json.loads(r.stdout)
        return {'state': d.get('state'), 'merged_at': d.get('merged_at'),
                'comments': d.get('comments')}
    except Exception:
        return None


def check_catalog():
    """线上目录里的条目；None 表示拉取失败。"""
    try:
        r = OPENER.open(urllib.request.Request(
            CATALOG_URL, headers={'User-Agent': 'vocab-study-pr-watch/1'}), timeout=60)
        d = json.loads(r.read().decode('utf-8', 'replace'))
        hits = [x for x in d.get('plugins', []) if x.get('name') == ENTRY_NAME]
        return {'count': d.get('count'), 'updated': d.get('updated'),
                'entry': hits[0] if hits else None}
    except Exception:
        return None


def main() -> int:
    emit('=' * 62)
    emit('开始盯 PR #%d（每 %d 分钟，最多 %s 小时）' % (PR_NUMBER, INTERVAL_MIN, MAX_HOURS))
    emit('状态文件: %s' % STATUS_FILE)
    emit('要等的信号: plugins.json 里出现 %s' % ENTRY_NAME)
    emit('参考: 我排第 876/1002 位，日均合并约 9 个 —— 慢是正常的')
    emit('=' * 62)

    start = time.time()
    seen_merged = False
    seen_npm_field = False
    consecutive_failures = 0

    while True:
        elapsed_h = (time.time() - start) / 3600
        if MAX_HOURS > 0 and elapsed_h > MAX_HOURS:
            emit('⏰ 盯满 %s 小时仍未上架，停止。PR 还开着，可随时重跑本脚本。' % MAX_HOURS)
            return 0

        pr = check_pr()
        cat = check_catalog()

        # 任一路查不到就记一笔，但不误报成「状态变化」
        if pr is None or cat is None:
            consecutive_failures += 1
            emit('查询失败（PR=%s 目录=%s），第 %d 次；下一轮再来'
                 % ('ok' if pr else 'FAIL', 'ok' if cat else 'FAIL', consecutive_failures))
            if consecutive_failures >= 12:
                emit('连续 12 次查询失败，停止（可能是网络/代理断了）。')
                return 1
            time.sleep(INTERVAL_MIN * 60)
            continue
        consecutive_failures = 0

        entry = cat['entry']
        merged_at = pr['merged_at']
        npm_field = (entry or {}).get('npm')

        emit('PR=%-6s merged_at=%-21s | 目录 count=%-5s updated=%-11s | 在目录里=%s'
             % (pr['state'], str(merged_at), cat['count'], cat['updated'],
                'YES' if entry else 'no'))

        if merged_at and not seen_merged:
            seen_merged = True
            emit('')
            emit('🎉 PR 被合并了！merged_at = %s' % merged_at)
            emit('   下一步：上游会重建站点（每笔 push 触发），条目随即进 plugins.json')
            emit('')

        if entry and not seen_npm_field:
            emit('')
            emit('✅✅ 上架完成 —— 市场里现在能搜到 %s 了' % ENTRY_NAME)
            emit('     装法  : %s' % entry.get('install'))
            emit('     npm   : %s' % npm_field)
            emit('     版本  : %s' % entry.get('version'))
            emit('')
            if npm_field:
                seen_npm_field = True
                emit('===== 目标达成（npm 字段也已填上），停止盯守 =====')
                return 0
            emit('     （npm 字段还没填，市场暂时给 github: 装法；继续盯到它填上）')
            emit('')

        time.sleep(INTERVAL_MIN * 60)


if __name__ == '__main__':
    sys.exit(main())
