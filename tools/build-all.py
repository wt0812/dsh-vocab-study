# 一次把两边都建出来。
#
# 为什么需要它：tools/build.py 只建 **demo**（单文件 HTML），
# tools/build-plugin.py 才建 **真正的插件产物** lib/client.js。
# 我踩过：只跑 build.py，测试全绿、demo 也对，但 lib/client.js 是旧的 ——
# 用户重启 DSH 后看到的还是老界面，而所有检查都"通过"。
import io
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def run(label, script):
    print('── %s ──────────────────────────────' % label)
    t0 = time.time()
    r = subprocess.run([sys.executable, '-X', 'utf8', os.path.join(HERE, script)],
                       cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    dt = time.time() - t0
    tail = [l for l in (r.stdout or '').splitlines() if l.strip()]
    for l in tail[-3:]:
        print('   ' + l)
    if r.returncode != 0:
        print('   ❌ %s 失败（exit %d）' % (script, r.returncode))
        err = (r.stderr or '').strip()
        if err:
            print('   ' + err[-600:])
        return False
    print('   ✓ %s  (%.1fs)' % (script, dt))
    return True


ok = run('demo 产物（单文件 HTML）', 'build.py')
ok = run('插件产物（lib/client.js）', 'build-plugin.py') and ok

# 产物新鲜度自检：源码比产物新就是陈旧，必须点名报出来。
# ⚠️ 这份清单必须**覆盖所有会进产物的源码**。我第一版漏了 shell.mjs / core-ref.mjs，
#    结果 lib/client.js 明明比它们旧，自检却报"通过" —— 一个抓不住问题的检查
#    比没有检查更坏，它给人虚假的安心。
import glob
client = os.path.join(ROOT, 'lib', 'client.js')
if os.path.isfile(client):
    ct = os.path.getmtime(client)
    sources = []
    for pat in ('ui/*.mjs', 'ui/*.css', 'core/*.mjs', 'store/*.mjs', 'adapter/dsh/*'):
        sources.extend(glob.glob(os.path.join(ROOT, *pat.split('/'))))
    stale = []
    for p in sources:
        if os.path.isfile(p) and os.path.getmtime(p) > ct + 1:
            stale.append(os.path.relpath(p, ROOT).replace('\\', '/'))
    # 覆盖性自检：清单本身不能是空的
    if len(sources) < 10:
        print('\n❌ 新鲜度自检只找到 %d 个源文件，清单可能写错了' % len(sources))
        ok = False
    elif stale:
        print('\n❌ lib/client.js 比这些源码旧：%s' % ', '.join(sorted(stale)))
        print('   （插件产物没跟上，用户重启后会看到旧界面）')
        ok = False
    else:
        print('\n✓ 新鲜度自检通过：lib/client.js 不比 %d 个源文件旧' % len(sources))

# 悬空命名空间前缀守卫的**自检**也要在这里跑。
# 为什么加在 build-all 而不是只放 CI：2026-10-21 的教训 —— 这个自检脚本
# （tools/verify-dangling-guard.mjs）自己坏了（误报），而本机从不跑它，
# 于是 CI 从 0.3.0 起连红三天没人发现。本机每次打包前跑一遍，就不会再"只靠 CI"。
if ok:
    print('\n── 守卫自检（verify-dangling-guard）──────────────')
    try:
        r = subprocess.run(['node', os.path.join(HERE, 'verify-dangling-guard.mjs')],
                           cwd=ROOT, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', shell=(os.name == 'nt'))
        for l in [x for x in (r.stdout or '').splitlines() if x.strip()][-4:]:
            print('   ' + l)
        if r.returncode != 0:
            print('   ❌ 守卫自检失败（exit %d）' % r.returncode)
            ok = False
        else:
            print('   ✓ 守卫自检通过')
    except FileNotFoundError:
        print('   ⚠ 找不到 node，跳过守卫自检（CI 里一定会跑）')

print('\n%s' % ('✅ 双构建完成' if ok else '❌ 有失败项'))
sys.exit(0 if ok else 1)
