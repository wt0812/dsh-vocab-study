"""在 Gitee 上建 v0.3.1 发行版（Release），正文与 GitHub 同一份。

凭据来源：git 的 credential.helper=manager（Windows 凭据管理器）里已保存的
Gitee HTTPS 凭据 —— 用 `git credential fill` 取出来直接用，**不打印、不落盘**。

用法: python tools/make-gitee-release.py [--dry-run]
"""
import io
import json
import subprocess
import sys
import urllib.parse
import urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

OWNER = "wutong2005"
REPO = "dsh-vocab-study"
TAG = "v0.3.1"
TITLE = "v0.3.1 · 眼熟小组件 + CI 自检修复"
BODY_FILE = "docs/releases/v0.3.1.md"
API = f"https://gitee.com/api/v5/repos/{OWNER}/{REPO}"


def credential():
    """取 Gitee 私人令牌。

    优先级：环境变量 `GITEE_TOKEN` / `GITEE_ACCESS_TOKEN`（**推荐**，不落盘、不进历史）
    → 退回 git 凭据管理器。注意：凭据管理器里存的是**登录密码**，Gitee API v5 不认
    （实测 401 "Access token does not exist"），所以最终要用的还是私人令牌。
    令牌在 https://gitee.com/profile/personal_access_tokens 生成，勾 `projects` 权限。
    """
    import os
    tok = (os.environ.get("GITEE_TOKEN") or os.environ.get("GITEE_ACCESS_TOKEN") or "").strip()
    if tok:
        return "(env)", tok
    r = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=gitee.com\n\n",
        capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode != 0:
        raise SystemExit("取不到 Gitee 凭据：" + (r.stderr or "").strip()[:200])
    data = {}
    for line in (r.stdout or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            data[k.strip()] = v.strip()
    if "password" not in data:
        raise SystemExit("凭据里没有 password 字段（可能不是令牌登录）")
    return data.get("username", ""), data["password"]


def call(method, path, token, params=None, payload=None):
    url = API + path
    q = dict(params or {})
    q["access_token"] = token
    url = url + "?" + urllib.parse.urlencode(q)
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header("Content-Type", "application/json;charset=UTF-8")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:300]}


def main():
    dry = "--dry-run" in sys.argv
    user, token = credential()
    print(f"  凭据: 用户 {user}，令牌长度 {len(token)}（不显示内容）")

    status, releases = call("GET", "/releases", token)
    if status != 200:
        print(f"  ✗ 读发行版列表失败 HTTP {status}: {releases}")
        return 1
    existing = {r.get("tag_name"): r for r in releases} if isinstance(releases, list) else {}
    print(f"  现有发行版 {len(existing)} 个: {', '.join(sorted(existing)) or '（无）'}")
    if TAG in existing:
        r = existing[TAG]
        print(f"  ⏭ {TAG} 已存在（id={r.get('id')}）→ {r.get('html_url')}")
        return 0

    body = io.open(BODY_FILE, encoding="utf-8").read()
    print(f"  正文 {len(body)} 字符（{BODY_FILE}），标题：{TITLE}")
    if dry:
        print("  --dry-run：不提交")
        return 0

    status, res = call("POST", "/releases", token, payload={
        "tag_name": TAG,
        "name": TITLE,
        "body": body,
        "target_commitish": "main",
        "prerelease": False,
    })
    if status in (200, 201):
        print(f"  ✓ 已创建发行版 id={res.get('id')}")
        print(f"    {res.get('html_url')}")
        return 0
    print(f"  ✗ 创建失败 HTTP {status}: {json.dumps(res, ensure_ascii=False)[:400]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
