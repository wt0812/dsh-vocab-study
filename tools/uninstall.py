#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 dsh-vocab-study 从 DSH profile 里彻底卸掉。

用法：
    python tools/uninstall.py            # 卸载
    python tools/uninstall.py --dry-run  # 只看会做什么

**只动属于本插件的东西**，其它插件一律不碰：

  · 删掉 <profile>/node_modules/dsh-vocab-study
  · 从 <profile>/package.json 的 dependencies 里删掉本包
  · 从 <profile>/package.json 的 dsh.profile.bundles 里删掉 "dsh-vocab-study"
  · 从 <profile>/cordis.patch.yml 里删掉本插件维护的那一段

本仓库自己的文件（含背词数据不在这里）**一个都不删**。卸载后你想再装回来，
跑 `python tools/install.py` 即可。
"""

import argparse
import io
import json
import os
import re
import shutil
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 复用安装脚本里那套「认出并摘掉我们那一段」的逻辑。
# 两边各写一份的话迟早会走偏 —— 安装认得旧注释头、卸载不认得，就会出现
# 「装了两次、卸载一次还剩一段」这种事。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from install import BLOCK_HEAD, strip_our_block, strip_stray_entries  # noqa: E402

PKG_NAME = "dsh-vocab-study"
ENTRY_ID = "vocab-study"
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


def load_json(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def backup(path, tag):
    os.makedirs(STAMP_DIR, exist_ok=True)
    dst = os.path.join(STAMP_DIR, "%s.%s" % (os.path.basename(path), tag))
    shutil.copy2(path, dst)
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry = args.dry_run

    profile = resolve_profile()
    target = os.path.join(profile, "node_modules", PKG_NAME)
    pkg_path = os.path.join(profile, "package.json")
    patch_path = os.path.join(profile, "cordis.patch.yml")

    say("=" * 64)
    say("dsh-vocab-study 卸载" + ("（dry-run，不会改任何文件）" if dry else ""))
    say("=" * 64)
    say("  profile: " + profile)
    say("  仓库   : " + SRC_DIR + "（本仓库的文件不会被动）")
    say()

    if not os.path.isdir(profile):
        say("profile 不存在，没什么可卸的：" + profile)
        return

    changed = 0
    failed = False

    # ── 1. 删 node_modules 里的安装 ──
    if os.path.exists(target):
        if dry:
            say("  [1/3] 会删除 " + target)
            changed += 1
        else:
            try:
                shutil.rmtree(target, ignore_errors=True)
            except Exception as e:
                say("  [1/3] 删除失败：" + str(e))
            if not os.path.exists(target):
                changed += 1
                say("  [1/3] 已删除 node_modules\\%s" % PKG_NAME)
            else:
                # 正在运行的 DSH 会占住这个目录（它的客户端产物已加载进内存）。
                # 这不算"卸载完成"，必须明说，否则用户重启后插件还在。
                failed = True
                say("  [1/3] ✗ 删不掉 —— DeepSeek Harness 正开着，它占住了这个目录。")
                say("        请**完全退出** DeepSeek Harness，再重新跑一次本脚本。")
    else:
        say("  [1/3] node_modules 里本来就没有 → 跳过")

    # ── 2. package.json ──
    if os.path.isfile(pkg_path):
        pkg = load_json(pkg_path)
        touched = []

        deps = pkg.get("dependencies") or {}
        if PKG_NAME in deps:
            touched.append("dependencies")
            if not dry:
                backup(pkg_path, "before-uninstall")
                del deps[PKG_NAME]

        bundles = (pkg.get("dsh") or {}).get("profile", {}).get("bundles") or []
        if PKG_NAME in bundles:
            touched.append("bundles")
            if not dry:
                bundles.remove(PKG_NAME)

        if touched:
            changed += 1
            if dry:
                say("  [2/3] 会从 package.json 移除：" + "、".join(touched))
            else:
                save_json(pkg_path, pkg)
                say("  [2/3] 已从 package.json 移除：" + "、".join(touched))
        else:
            say("  [2/3] package.json 里没有它 → 跳过")

    # ── 3. cordis.patch.yml ──
    if os.path.isfile(patch_path):
        with io.open(patch_path, encoding="utf-8") as f:
            text = f.read()

        cleaned = strip_stray_entries(strip_our_block(text))
        cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip() + "\n"

        if cleaned != text:
            changed += 1
            if dry:
                say("  [3/3] 会从 cordis.patch.yml 移除本插件条目")
            else:
                backup(patch_path, "before-uninstall")
                with io.open(patch_path, "w", encoding="utf-8", newline="") as f:
                    f.write(cleaned)
                say("  [3/3] 已从 cordis.patch.yml 移除本插件条目")
        else:
            say("  [3/3] cordis.patch.yml 里没有它 → 跳过")

    # ── 验证：其它插件还在 ──
    say()
    say("验证（确认没伤到别的插件）：")
    if os.path.isfile(pkg_path):
        pkg = load_json(pkg_path)
        bundles = (pkg.get("dsh") or {}).get("profile", {}).get("bundles") or []
        deps = pkg.get("dependencies") or {}
        say("  · bundles 还剩 %d 项" % len(bundles))
        say("    " + ", ".join(bundles) if bundles else "    （空）")
        say("  · 还有 %d 个 dependencies" % len(deps))
        if dry:
            # dry-run 什么都没删，所以这里不能当成"残留"来判失败
            say("  · （dry-run 未改文件，残留判定跳过）")
        elif PKG_NAME in bundles or PKG_NAME in deps:
            say("  · ✗ 本插件仍有残留")
            failed = True
        else:
            say("  · ✓ 本插件已无残留")

    say()
    say("─" * 64)
    if dry:
        say("dry-run 结束，没有改动任何文件。")
        return
    if failed:
        say("卸载**未完全成功** —— 请看上面标 ✗ 的项。")
        say("最常见的原因：DeepSeek Harness 还开着。完全退出再跑一次即可。")
        sys.exit(1)
    say("卸载完成。" if changed else "本来就没装，未做改动。")
    say()
    say("**完全退出 DeepSeek Harness 再打开**，界面才会恢复干净。")
    say("想再装回来：python tools/install.py")
    say("本仓库的文件（源码、测试、demo）一个都没动。")
    say("─" * 64)


if __name__ == "__main__":
    main()
