#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 dsh-vocab-study 正式安装进 DSH 的 profile。

用法：
    python tools/install.py            # 安装（可重复执行，会修复坏掉的安装）
    python tools/install.py --dry-run  # 只看会做什么，不动任何文件

它做四件事，每件都验证过才算成功：

  1. 在 <profile>/node_modules/dsh-vocab-study 建 **目录联接（junction）**
     指向本仓库。用联接而不是复制，这样以后 `python tools/build.py` 重建后
     刷新页面就生效，不需要重装。
  2. 往 <profile>/package.json 的 dependencies 里登记本包（file: 绝对路径）。
  3. 往 <profile>/package.json 的 dsh.profile.bundles 末尾加 "dsh-vocab-study"。
  4. 在 <profile>/cordis.patch.yml 里补一条启用条目，并**确保没有 disabled: true**。

为什么第 4 步必须写死在脚本里：
    插件管理器把「停用」写成 `disabled: true` 是**持久化**的，而且在管理界面里
    点「启用」并不会删掉那一行。那种状态下 Host 侧看起来是 enabled/active，
    但客户端半身永远不加载 —— 现象就是「装了、重启了、界面上什么都没有」。
    这个坑我踩过，所以让脚本每次都纠正它。

前提：先跑过 `python tools/build.py && python tools/build-plugin.py`（本脚本会检查）。
"""

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

PKG_NAME = "dsh-vocab-study"
ENTRY_ID = "vocab-study"          # cordis.patch.yml 里的 id
SRC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PROFILE = os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "desktop")
STAMP_DIR = os.path.join(SRC_DIR, ".dsh-install-backup")


def say(msg=""):
    print(msg)


def resolve_profile():
    p = os.environ.get("DSH_PROFILE_DIR")
    if p and os.path.isdir(p):
        return os.path.abspath(p)
    return DEFAULT_PROFILE


def need(cond, msg):
    if not cond:
        say("")
        say("✗ 无法继续：" + msg)
        sys.exit(1)


def node_exe():
    """找 DSH 自带的 node，用不了就回落到 PATH 上的 node。"""
    cand = os.path.join(
        os.path.expanduser("~"), ".dsh", "dsh-runtimes",
        "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe",
    )
    if os.path.isfile(cand):
        return cand
    return shutil.which("node")


def is_junction(path):
    """Windows 上 junction 的判定。

    **不要用 os.path.islink()**：它对目录联接返回 False（不是符号链接，
    是重解析点）。PowerShell 的 LinkType 也同样不可靠。
    唯一可信的办法是问 Node 的 lstat()，或者解析 `dir /AL` 输出。
    这里用 Node —— 最准，而且我们本来就要用 Node 做解析验证。
    """
    node = node_exe()
    if not node:
        return None
    code = (
        "const fs=require('fs');const p=process.argv[1];"
        "try{const s=fs.lstatSync(p);"
        "process.stdout.write(s.isSymbolicLink()?'yes':'no')}"
        "catch(e){process.stdout.write('gone')}"
    )
    try:
        out = subprocess.run([node, "-e", code, path], capture_output=True, text=True, timeout=30)
        return out.stdout.strip()
    except Exception:
        return None


def realpath_of(path):
    node = node_exe()
    if not node:
        return os.path.realpath(path)
    code = "const fs=require('fs');process.stdout.write(fs.realpathSync(process.argv[1]))"
    try:
        out = subprocess.run([node, "-e", code, path], capture_output=True, text=True, timeout=30)
        return out.stdout.strip() or os.path.realpath(path)
    except Exception:
        return os.path.realpath(path)


def load_json(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    # newline='' 保住原有换行风格；ensure_ascii=False 让中文保持可读
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def backup(path, tag):
    os.makedirs(STAMP_DIR, exist_ok=True)
    dst = os.path.join(STAMP_DIR, "%s.%s" % (os.path.basename(path), tag))
    shutil.copy2(path, dst)
    return dst


def ensure_junction(target, dry):
    """让 target 成为指向 SRC_DIR 的 junction。已正确就什么都不做。"""
    state = is_junction(target)
    if state == "yes":
        real = realpath_of(target)
        if os.path.normcase(real) == os.path.normcase(SRC_DIR):
            say("  [1/4] 联接已存在且指向正确 → 跳过")
            return "kept"
        say("  [1/4] 联接指向别处（%s）→ 重建" % real)
    elif state == "no":
        say("  [1/4] 是真实副本（不是联接）→ 替换成联接")
    else:
        say("  [1/4] 不存在 → 新建联接")

    if dry:
        return "would-create"

    # 删掉原有目录（无论副本还是错的联接），再建联接
    if os.path.exists(target) or os.path.islink(target):
        shutil.rmtree(target, ignore_errors=True)
    parent = os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    # mklink /J 建的是目录联接，不需要管理员权限（符号链接才需要）
    r = subprocess.run(
        ["cmd", "/c", "mklink", "/J", target, SRC_DIR],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not os.path.exists(target):
        say("      mklink 失败：" + (r.stdout or "") + (r.stderr or ""))
        return "failed"
    return "created"


def ensure_dependency(pkg_path, dry):
    pkg = load_json(pkg_path)
    deps = pkg.setdefault("dependencies", {})
    want = "file:" + SRC_DIR.replace("\\", "/")
    cur = deps.get(PKG_NAME)
    if cur == want:
        say("  [2/4] dependencies 已登记 → 跳过")
        return "kept"
    if dry:
        say("  [2/4] 会写 dependencies[%r] = %r（原值 %r）" % (PKG_NAME, want, cur))
        return "would-set"
    backup(pkg_path, "before-install")
    deps[PKG_NAME] = want
    save_json(pkg_path, pkg)
    say("  [2/4] 已登记 dependencies[%s] = %s" % (PKG_NAME, want))
    return "set"


def ensure_bundle(pkg_path, dry):
    pkg = load_json(pkg_path)
    prof = pkg.setdefault("dsh", {}).setdefault("profile", {})
    bundles = prof.setdefault("bundles", [])
    if PKG_NAME in bundles:
        say("  [3/4] bundles 已包含 %s（第 %d 位）→ 跳过" % (PKG_NAME, bundles.index(PKG_NAME) + 1))
        return "kept"
    if dry:
        say("  [3/4] 会把 %r 追加到 bundles 末尾（当前 %d 项）" % (PKG_NAME, len(bundles)))
        return "would-add"
    backup(pkg_path, "before-install")
    bundles.append(PKG_NAME)
    save_json(pkg_path, pkg)
    say("  [3/4] 已把 %s 追加到 bundles（现 %d 项）" % (PKG_NAME, len(bundles)))
    return "added"


# cordis.patch.yml 里属于我们的那一段：从注释头到条目结束。
# 每次安装都**整段重写**，这样就不会留下历史残留的 disabled: true。
BLOCK_HEAD = "# ── dsh-vocab-study（今日背单词）安装工具维护这一段 ──"

# 历史上还出现过别的注释头（我手工写下的说明）。安装时一并认出来清掉，
# 否则那些旧注释会留在文件里、和新的说明叠在一起。
LEGACY_HEADS = (
    "# vocab-study（今日背单词）：启用。",
    "# 2026-10-08 恢复时改动：vocab-study 暂时停用",
)

BLOCK_BODY = """# ── dsh-vocab-study（今日背单词）安装工具维护这一段 ──
# 由 tools/install.py 生成，不要手动改；卸载请跑 tools/uninstall.py。
#
# 这一条只是让 Loader 认领这个包（本插件没有注册任何 Host 服务）。
# 真正的界面全部来自 lib/client.js（客户端入口 dsh.client.platform=web）。
#
# 注意：**这一行不能有 `disabled: true`。**
# 插件管理器把「停用」写成 disabled: true 是持久化的，在管理界面里点
# 「启用」不会删掉它；那种状态下 Host 侧显示 enabled/active，但客户端
# 半身永远不加载 —— 现象是「装了、重启了、界面上什么都没有」。
- id: %s
""" % ENTRY_ID


def strip_our_block(text):
    """把属于本插件的那一段（注释 + 条目）从 patch 文本里摘掉。

    认三种头：新版标记 + 两种历史注释。摘到下一个顶级条目或文件尾为止。
    """
    for head in (BLOCK_HEAD,) + LEGACY_HEADS:
        if head not in text:
            continue
        i = text.index(head)
        rest = text[i:]
        m = re.search(r"\n- id:\s*\S+", rest[len(head):])
        if m:
            cut = i + len(head) + m.start() + 1
            return text[:i] + text[cut:]
        return text[:i]
    return text


def strip_stray_entries(text):
    """再摘掉任何别的、针对我们 entry id 的条目（例如管理界面加的 disabled）。"""
    for _ in range(5):
        m = re.search(r"(?m)^- id:\s*%s\b.*$" % re.escape(ENTRY_ID), text)
        if not m:
            break
        start = m.start()
        lines = text[start:].split("\n")
        keep_from = 1
        for ln in lines[1:]:
            if ln.startswith("- ") or (ln and not ln.startswith((" ", "\t"))):
                break
            keep_from += 1
        text = text[:start] + "\n".join(lines[keep_from:])
    return text


def ensure_patch(patch_path, dry):
    with io.open(patch_path, encoding="utf-8") as f:
        text = f.read()

    # 先摘掉我们自己维护的那一段，再摘掉任何针对本 id 的野生条目
    cleaned = strip_stray_entries(strip_our_block(text))
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip() + "\n"

    new_text = cleaned + "\n" + BLOCK_BODY

    if new_text == text:
        say("  [4/4] cordis.patch.yml 已正确（无 disabled）→ 跳过")
        return "kept"

    had_disabled = bool(re.search(
        r"(?ms)^- id:\s*%s\b.*?^\s*disabled:\s*true" % re.escape(ENTRY_ID), text
    ))
    if dry:
        say("  [4/4] 会重写 cordis.patch.yml 里我们那一段" + ("（移除 disabled: true）" if had_disabled else ""))
        return "would-fix"

    backup(patch_path, "before-install")
    with io.open(patch_path, "w", encoding="utf-8", newline="") as f:
        f.write(new_text)
    say("  [4/4] cordis.patch.yml 已写入启用条目" + ("（并清掉了 disabled: true）" if had_disabled else ""))
    return "fixed"


def verify(profile, target):
    """用 Node 从 profile 出发做解析验证 —— 复刻 DSH 加载器的查找路径。"""
    node = node_exe()
    need(not (node is None), "找不到 node，无法做解析验证")
    pkg_json = os.path.join(profile, "package.json")
    code = r"""
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(process.argv[1]);
const out = {};
try { out.main = req.resolve('dsh-vocab-study'); } catch (e) { out.mainErr = e.message; }
try { out.client = req.resolve('dsh-vocab-study/client'); } catch (e) { out.clientErr = e.message; }
try {
  const pkg = req('dsh-vocab-study/package.json');
  out.platform = pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform;
} catch (e) { out.pkgErr = e.message; }
process.stdout.write(JSON.stringify(out));
"""
    r = subprocess.run([node, "-e", code, pkg_json], capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"fatal": (r.stdout or "") + (r.stderr or "")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只报告会做什么，不改任何文件")
    args = ap.parse_args()
    dry = args.dry_run

    profile = resolve_profile()
    target = os.path.join(profile, "node_modules", PKG_NAME)
    pkg_path = os.path.join(profile, "package.json")
    patch_path = os.path.join(profile, "cordis.patch.yml")

    say("=" * 64)
    say("dsh-vocab-study 正式安装" + ("（dry-run，不会改任何文件）" if dry else ""))
    say("=" * 64)
    say("  仓库   : " + SRC_DIR)
    say("  profile: " + profile)
    say("  目标   : " + target)
    say()

    # ── 前置检查 ──
    need(os.path.isdir(profile), "profile 目录不存在：" + profile)
    need(os.path.isfile(pkg_path), "找不到 " + pkg_path)
    need(os.path.isfile(patch_path), "找不到 " + patch_path)
    need(os.path.isfile(os.path.join(SRC_DIR, "package.json")), "找不到包根 package.json")

    manifest = load_json(os.path.join(SRC_DIR, "package.json"))
    need(manifest.get("name") == PKG_NAME, "包名不是 %s（实际 %r）" % (PKG_NAME, manifest.get("name")))
    need(
        manifest.get("dsh", {}).get("client", {}).get("platform") == "web",
        "package.json 里 dsh.client.platform 必须是 \"web\"",
    )
    need(manifest.get("exports", {}).get("./client"), "package.json 里缺少 exports[\"./client\"]")

    # 产物必须已构建 —— 否则装进去是个空壳
    client_js = os.path.join(SRC_DIR, "lib", "client.js")
    need(
        os.path.isfile(client_js),
        "客户端产物 lib/client.js 不存在。先跑：\n"
        "    python tools/build.py\n    python tools/build-plugin.py",
    )
    size = os.path.getsize(client_js)
    need(size > 50000, "lib/client.js 只有 %d 字节，看起来没构建完整" % size)
    say("  产物   : lib/client.js  %d 字节 ✓" % size)
    say()

    say("执行：")
    r1 = ensure_junction(target, dry)
    need(r1 != "failed", "建联接失败（可能是权限问题）")
    ensure_dependency(pkg_path, dry)
    ensure_bundle(pkg_path, dry)
    ensure_patch(patch_path, dry)

    if dry:
        say()
        say("dry-run 结束，没有改动任何文件。")
        return

    # ── 安装后验证 ──
    say()
    say("验证：")
    j = is_junction(target)
    say("  · node_modules 里是联接          : %s" % ("✓" if j == "yes" else "✗ (%s)" % j))

    real = realpath_of(target)
    ok_real = os.path.normcase(real) == os.path.normcase(SRC_DIR)
    say("  · 联接指向本仓库                  : %s" % ("✓ " + real if ok_real else "✗ " + real))

    try:
        with io.open(client_js, "rb") as f:
            head = f.read(200)
        linked = os.path.join(target, "lib", "client.js")
        same = os.path.isfile(linked) and os.path.getsize(linked) == size
        say("  · 联接侧 client.js 大小一致       : %s" % ("✓ %d 字节" % size if same else "✗"))
    except Exception as e:
        say("  · 联接侧 client.js               : ✗ %s" % e)

    v = verify(profile, target)
    say("  · Node 能从 profile 解析到包入口  : %s" % ("✓" if v.get("main") else "✗ " + str(v.get("mainErr"))))
    say("  · Node 能解析 ./client 出口       : %s" % ("✓" if v.get("client") else "✗ " + str(v.get("clientErr"))))
    say("  · dsh.client.platform             : %s" % ("✓ " + str(v.get("platform")) if v.get("platform") == "web" else "✗ " + str(v)))

    with io.open(patch_path, encoding="utf-8") as f:
        pt = f.read()
    has_disabled = bool(re.search(
        r"(?ms)^- id:\s*%s\b.*?^\s*disabled:\s*true" % re.escape(ENTRY_ID), pt
    ))
    say("  · cordis.patch.yml 无 disabled    : %s" % ("✗ 仍有 disabled:true" if has_disabled else "✓"))

    say()
    say("─" * 64)
    if has_disabled or j != "yes" or not v.get("client"):
        say("安装未完全成功，请看上面标 ✗ 的项。")
        sys.exit(1)
    say("安装完成。")
    say()
    say("下一步（必须）：**完全退出 DeepSeek Harness 再重新打开**。")
    say("  cordis.patch.yml 是启动时读的，只刷新页面没用 ——")
    say("  客户端模块清单在启动时就扫描完了。")
    say()
    say("备份放在：" + STAMP_DIR)
    say("卸载：python tools/uninstall.py")
    say("─" * 64)


if __name__ == "__main__":
    main()
