# 发布到 DSH 社区市场

目标：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— `dsh-market` 插件读的目录
（`https://awesome-dsh-plugin.com/plugins.json`）。**这不是 DeepSeek 官方市场，社区维护。**
实测该目录当前有 **4481 条**条目，其中 **1943 条**是用 `github:` 形态安装的
（2026-10-10 实测；这两个数会随时间漂，用之前重新数一遍）。

---

## 清单

| 步骤 | 状态 |
|---|---|
| 1. `package.json` 声明 `dsh.bundle`（收录 CI 的硬条件） | ✅ |
| 2. `dsh.client.platform = "web"` + `exports["./client"]` | ✅ |
| 3. 明确许可证（MIT） | ✅ |
| 4. 公开 GitHub 仓库 | ✅ `wt0812/dsh-vocab-study` |
| 5. 仓库加 `dsh-plugin` topic | ✅ |
| 6. README 含 `dsh plugin --profile web add <包名>` 安装命令 | ✅ |
| 7. **仓库存在满 1 天**（CI 自动检查） | ✅ 创建于 2026-10-09，已满 |
| 8. 提 PR：`data/plugins/wt0812__dsh-vocab-study.yml` | ⬜ 待提 |

**上游 CI 到底查什么**（读的是 `scripts/check-submission.mjs`，不是猜的 —— 它只查 4 条）：
仓库里有 `package.json` 声明 `dsh.bundle`、仓库满 1 天、未归档、不是 DSH 本体。
**没有提交数门槛**（上游 2026-09-03 已取消 `MIN_COMMITS`）。
单个 PR 最多 3 条条目（我们提 1 条）。

**条目的字段规则**（读的是 `scripts/lib/entries.mjs`）：
允许的键只有 `url` / `name` / `category` / `description` / `tarball`，
**多一个键就报 unknown field 被拒**；文件名必须等于 `url` 推出的 slug；
`name` 写成 `owner/repo` 时必须与 `url` 指向同一个仓库；`category` 必须在官方列表里。
`npm:` 字段**不要写** —— 上游从 `data/npm-map.json` 自动采集。

本地先验一遍（用上游同一个解析器 js-yaml）：

```sh
node tools/verify-market-entry.mjs <一个装了 js-yaml 的目录>
```

---

## 实际过程（已完成，留作记录）

1. **建仓库并推送** —— `wt0812/dsh-vocab-study`（公开、MIT），加了 `dsh-plugin` topic。
2. **等满 1 天** —— 创建于 `2026-10-09T03:15:29Z`，CI 要求 ≥ 1 天，满足。
3. **提 PR** —— [awesome-dsh-plugin#7043](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7043)，
   分支 `wt0812:add-dsh-vocab-study` → `awesome-dsh-plugin:main`，**只加 1 个文件 +6 行**。
   用的是 `_submit.py`（本机脚本，未进仓库）：克隆 fork → 加条目 → 推分支 → `gh pr create`。
4. **CI** —— `check` 与 `Submission gate` 双绿，gate 原文：
   *"All 1 submitted entry passes: `dsh.bundle` declared, repo old enough, enough commits."*

> ⚠️ **别重提**：上游在 pr-gate 里写明年龄门槛会自动清除，不需要 resubmit / push / close & reopen。
> 现在只等人工复核，合了之后才会出现在目录里。

**关于 `--profile`：这是最容易搞错的一处。**
DSH 按 profile 分目录装插件，装错等于装进另一个平行世界：

| 界面 | 该用哪个 profile |
|---|---|
| 桌面客户端（Electron app） | `desktop` |
| 浏览器里的 Web 界面 | `web` |

市场目录里 4481 条的 install 命令**全是 `--profile web`**（那是给浏览器场景的默认值）。
而我们这个仓库的开发与实测环境是**桌面客户端**，所以本机用的是 `profiles/desktop`。
依据是 DSH 本体启动器里的 `runProfile({ profile: "desktop", ... })`
（注释：*Launch the Desktop profile through the Web application*），
而 `PROFILE_TEMPLATES` 里只有 `acp` / `web` / `headless` / `sdk` / `sdk-minimal`，**没有 `desktop`**。

---

## 条目长什么样

**只加一个文件** `data/plugins/wt0812__dsh-vocab-study.yml`：

```yaml
url: https://github.com/wt0812/dsh-vocab-study
name: wt0812/dsh-vocab-study
category: ui
description:
  en: 'Offline vocabulary panel in the sidebar: a capsule beside the composer opens a word card, and a right-pane tab tracks today, progress, the mistake book and settings.'
  zh: '侧边栏里的离线背词面板：输入框旁一颗胶囊点开是词卡，右栏标签页管着今日、进度、生词本与设置。'
```

格式要点（来自 `contributing.md`）：

- 文件名必须是 `<owner>__<repo>.yml`（双下划线）。
- `url` 必须与仓库完全一致。
- 只有 `description.en` 必填。
- **描述里含 `: ` 必须加引号**，否则 YAML 把它当嵌套键解析失败。
  实测 4481 条里有 **2491 条**的英文描述含 `": "`（2026-10-10 数），这是高频踩坑点。
- 一个 PR 最多 3 条。
- **不要**手工编辑仓库的两个 README（它们是生成物）；**不要**手写 `npm:` 字段（会被校验拒绝）。
- 不要改这个仓库除自己条目文件以外的任何东西。

---

## 截图（可选，推荐）

在市场里能像 App Store 一样展示。**在自己的仓库里声明** `screenshots.json`（1–8 张）：

```jsonc
// F:\DeepSeek Harness\projects\vocab-study\screenshots.json
[
  "assets/screenshot-1.png"
]
```

路径相对于该文件本身（不能以 `/` 开头、不能含 `..`）。也可以写 GitHub 托管的 https 绝对地址
（`raw.githubusercontent.com` 等），第三方图床会被拒。

不声明也行：市场会退而从 README 里抽图。

---

## 发 npm（可选，不影响收录）

发 npm 能让市场显示下载量。要求：包的 `repository` 字段必须指回被收录的那个仓库。
**不需要**在条目里写任何字段，映射会自动采集。

---

## 复查命令

```sh
# 收录要求第 1 条：dsh.bundle 是否存在
node -e "const p=require('./package.json');console.log('dsh.bundle.patch =',p.dsh.bundle.patch)"

# 仓库是否满 1 天（推送后）
# https://api.github.com/repos/wt0812/dsh-vocab-study  -> created_at

# 目录里是否已被收录
curl -s https://awesome-dsh-plugin.com/plugins.json | grep -c dsh-vocab-study
```
