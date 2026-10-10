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
| 7. **仓库存在满 1 天**（CI 自动检查） | ✅ 创建于 `2026-10-09T03:15:29Z`，提交 PR 时已 **29.41 小时** |
| 8. 提 PR：`data/plugins/wt0812__dsh-vocab-study.yml` | ✅ [#7043](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7043) 已提，双绿 |
| 9. 发布到 npm | ✅ `dsh-vocab-study@0.1.0` 已上线 |
| 10. 等维护者合并 PR | ⏳ **唯一剩下的** |

**上游 CI 到底查什么**（读的是 `scripts/check-submission.mjs`，不是猜的 —— 它只查 4 条）：
仓库里有 `package.json` 声明 `dsh.bundle`、仓库满 1 天、未归档、不是 DSH 本体。
**没有提交数门槛**（上游 2026-09-03 已取消 `MIN_COMMITS`）。
单个 PR 最多 3 条条目（我们提 1 条）。

**条目的字段规则**（读的是 `scripts/lib/entries.mjs`）：
允许的键只有 `url` / `name` / `category` / `description` / `tarball`，
**多一个键就报 unknown field 被拒**；文件名必须等于 `url` 推出的 slug；
`name` 写成 `owner/repo` 时必须与 `url` 指向同一个仓库；`category` 必须在官方列表里。

**`npm:` 字段不要手写，但要知道它决定别人从哪下载。**
条目里没有 `npm` 字段时，上游生成的装法是 `add github:<owner>/<repo>`，
别人拉的是 **GitHub 仓库**；一旦补上 `npm` 字段才变成 `add <包名>`，改拉 **npm**。
这个字段由上游每日探测自动填（`scripts/probe-npm.mjs`）：
它读**我们仓库** `package.json` 的 `name` → 确认 npm 上有这个包
→ 且该包的 `repository` 字段指回我们仓库（防抢名），三者都成立才填。
**本仓库三条都满足**（已按上游逻辑逐行复刻验证），所以合并后次日会被自动补上。

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
   （末句是模板用语；实际上游已无提交数门槛，见上文。）

> ⚠️ **别重提**：上游在 pr-gate 里写明年龄门槛会自动清除，不需要 resubmit / push / close & reopen。
> 现在只等人工复核，合了之后才会出现在目录里。

**排队实况**（2026-10-10 实测，供估时用）：上游**没有合并机器人**在 CI 里，
最近 25 个合并的 PR 全都是 **API 直接合并**（无人工 `merged_by` 记录、没开 GitHub auto-merge）——
是维护者本机跑脚本批量挑绿的合，**每批约 12 个，无固定时间表**
（10-08 跑了 5 批，10-09 只跑 1 批）。所以"什么时候合"没有可预测的时刻。

**关于 `--profile`：这是最容易搞错的一处 —— 正确写法就是 `--profile web`。**

DSH 按 profile 分目录装插件。`dsh plugin` 是命令行工具，它把后面的参数
**原样转发给 profile 目录里的 pnpm**（读自 DSH 本体命令定义：
*"manage a profile's plugins by forwarding the remaining arguments to pnpm in the
profile directory"*），`--profile` 是**必填项**：

```sh
dsh plugin --profile web add dsh-vocab-study
dsh plugin --profile web add github:wt0812/dsh-vocab-study
```

⚠️ **`--profile desktop` 会直接报错**，不要写：

```
error: profile "desktop" is managed exclusively by the Electron application
```

读自 DSH 本体启动器 `rejectElectronProfile()`：`desktop` 这个 profile 名
**保留给 Electron 应用独占管理**，CLI 拒绝针对它的 `plugin-management`。
桌面客户端用户也**照写 `--profile web`** —— 桌面 App 用的
`profiles/desktop` 是**它自己写进去的**，不需要手工装。

> **这段曾经写错并已订正。** 早先的结论是「桌面客户端该用 `--profile desktop`」，
> 依据只有 `runProfile({ profile: "desktop" })` 和 `PROFILE_TEMPLATES` 里没有 `desktop` ——
> **都是真的，但漏了 `rejectElectronProfile` 这道硬校验，所以推论是错的。**
> 教训：从一个真事实（App 用 `desktop`）推出一个结论（CLI 就能写 `desktop`）之前，
> 要把**拒绝路径**也读了。

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

## 发布 npm

### 当前状态

| 项 | 值 |
|---|---|
| 包名 | `dsh-vocab-study`（**归本账号所有，别人抢不走**） |
| 已发布 | `0.1.0` |
| 页面 | https://www.npmjs.com/package/dsh-vocab-study |
| 发布账号 | `wt0812` |
| 国内镜像 | npmmirror ✅ / 腾讯云 ✅ 均已同步（几分钟到几小时延迟） |

发布的前提是包的 `repository` 字段必须指回被收录的那个仓库 —— 满足。
**不需要**在条目里写任何字段，映射由上游自动采集。

### ⚠️ 发布新版必须"两边一起发"

这是本仓库**唯一**的发布硬规则。原因是市场判断"有没有新版"的方式**取决于用户当初怎么装的**：

| 用户怎么装的 | 市场检查什么 | 只发 npm 会怎样 |
|---|---|---|
| `add dsh-vocab-study`（npm 装法） | npm 的 `latest` 标签，比语义版本 | ✅ 自动显示更新按钮 |
| `add github:wt0812/dsh-vocab-study`（github 装法） | GitHub 的 HEAD commit | ❌ **永远不知道**（市场刻意不问 npm） |

**github 装法为什么不看 npm**：指向上游 `dshmarket` 的 `lib/updates.js` 明写 ——
对 git 来源的安装**绝不用包名去问 npm**，否则一个恰好同名的 npm 包会被当成更新，
把人从 git 源覆盖成 npm 包（上游 issue #525）。

**代价**：市场条目合并后**一开始是 github 装法**（条目里还没有 `npm` 字段），
所以**最早那批用户不会因为你在 npm 发新版而收到更新**。等每日探测补上 `npm` 字段后，
之后新装的人才是 npm 装法、才会自动收到更新。
**结论：两边都发，才覆盖所有用户。**

### 发布步骤

```sh
# 1) 改版本号（npm 不允许重复发同一个版本号，不改发不上去）
#    编辑 package.json 的 "version"

# 2) 确认仓库干净、测试全绿、产物和提交一致
git status --porcelain          # 应为空
python tools/build.py           # 重新生成 demo/
python tools/build-plugin.py    # 重新生成 lib/client.js
git diff --quiet -- lib/ && echo "产物与提交一致"
npm test                        # 8 个套件

# 3) 两个远端都要推（GitHub + Gitee 镜像）
git commit -am "release: v0.2.0"
git push
git push gitee main

# 4) 打 tag（⚠️ 别忘了对齐 —— 见下方"已知不一致"）
git tag v0.2.0
git push origin v0.2.0

# 5) 发 npm（必须带 --otp，账号开了 auth-and-writes 2FA）
npm publish --registry=https://registry.npmjs.org/ --otp=<6位验证码>

# 6) 验证（不要只看 npm 打印的 + 就完事）
npm view dsh-vocab-study version --registry=https://registry.npmjs.org/
npm view dsh-vocab-study version --registry=https://registry.npmmirror.com/
```

**GitHub Release**：`v0.2.0` 的 Release 也要发（带更新说明）。

### 更新按钮的行为（写给未来的自己看）

- 市场服务端 `lib/updates.js`：**每 30 分钟**缓存一次（`UPDATES_TTL_MS`），
  安装/卸载/换源时立即失效。
- 只在"**新的比已装的更高**"时才显示按钮（`isUpgrade`，语义版本比较）。
  上游注释记录过一次真实事故 #64：早先用简单 `!==` 比较，
  一旦 `latest` 标签指向更旧的版本，点"更新"反而把人**降级**到起不来。
- **本机看不到自己插件的更新按钮**：本仓库在 `profiles/desktop` 里是
  `file:F:/DeepSeek Harness/projects/vocab-study`，而 `updates.js` 对 `file:`
  开头直接跳过、恒为"无更新"（注释：其他 `link:` 都是开发工作区，永不参与在线更新）。
  **这是对的，不是 bug。** 想验证更新按钮，得在另一个 profile 里装 npm 版。

### 已知不一致（待处理）

- **`v0.1.0` 这个 tag 指向 `8e51774`，而 `main` 已经到 `3928e42`。**
  当初选择不动它。**后果**：别人下载 `v0.1.0` 的源码压缩包会拿到**旧版本**。
  发布下一个版本时应当把 tag 对齐当前提交。
- npm 上有个 `0.0.0-stage` 占位条目（`stub: true`，内容是 "Temporary package placeholder"）。
  不影响安装（`latest` 指向 `0.1.0`），介意的话可以 `npm deprecate` 标掉。

---

## 复查命令

```sh
# 收录要求第 1 条：dsh.bundle 是否存在
node -e "const p=require('./package.json');console.log('dsh.bundle.patch =',p.dsh.bundle.patch)"

# 仓库年龄（上游要求 >= 1 天，读 created_at）
curl -s https://api.github.com/repos/wt0812/dsh-vocab-study | grep created_at

# PR 合了没（merged_at 非空就是合了）
gh pr view 7043 --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --json state,mergedAt,mergeable,mergeStateStatus

# 目录里是否已被收录（才是"市场能搜到"）
curl -s https://awesome-dsh-plugin.com/plugins.json | grep -c dsh-vocab-study

# npm 上有没有、是哪个版本
npm view dsh-vocab-study version --registry=https://registry.npmjs.org/

# 国内镜像跟不跟得上
npm view dsh-vocab-study version --registry=https://registry.npmmirror.com/

# 万一市场读的是慢一天的 npm 目录包，可以用这个绕过（临时）
# DSHM_REGISTRY_URL=https://awesome-dsh-plugin.com/plugins.json
```

**市场当前状态（2026-10-10）**：目录共 **4481 条**，其中 **2320 条**是 npm 装法、
**2161 条**是 `github:` 装法。我们这条在合并前**还没有 `npm` 字段**，所以属后者。
