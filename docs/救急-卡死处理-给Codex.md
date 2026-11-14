# 救急：dsh-vocab-study 0.3.3 导致 DSH 卡死的处理方案

> 给执行者（人或 AI Agent）看的操作手册。
> 目标：让卡死的 DSH 恢复正常，且**不丢背单词进度**。
> 编写时间：2026-11-14。所有命令都在 Windows PowerShell 下验证过。

## 太长不看（三条路，选一条）

| 路径 | 前提 | 命令 |
|---|---|---|
| **A. 从 Gitee 装**（推荐） | 有 git、能上网 | `dsh plugin --profile desktop add "git+https://gitee.com/wutong2005/dsh-vocab-study.git#v0.3.4"` |
| **B. 用作者给的 tgz 装**（最稳） | 有那个 3.2 MB 的文件 | `dsh plugin --profile desktop add "<tgz 的路径>"` |
| **C. 先停用止血** | 上面都不行 | 见 §7（DSH 能开，但没有背单词面板，进度不丢） |

三条都要求：**先完全关掉 DSH**（§2），**装完重新打开**。装完用 §4 的三行验证（版本 / 字节 / 哈希）。

---

## 0. 先说清楚是什么病（不需要修，但决定怎么修）

`dsh-vocab-study@0.3.3` 有一个**同步死循环** bug：出「辨词题」（选择题）时，
如果挑不出三个不同维度的干扰项，代码会在主线程里无限循环。

- 插件跑在 DSH 界面的主线程里 → **整个 DSH 界面冻死，鼠标点哪都没反应，只能点叉强杀**
- 重启没用：每次启动都会重新出那道题，又卡在同一个词上
- 触发面很大：四级词库 **4,491 个词里有 2,303 个（51.3%）必卡**，含 `a` `able` `about` `accept` `amount` `content` `maintain` `attain` `although` 这类超常见词
- **跟用户同时跑什么任务无关**，也跟「插件吃资源」无关：插件单文件 5.4 MB、运行时依赖 0、网络请求 0、空闲只有一个 8 秒定时器

**修复版本是 0.3.4**（同一批词全部跑过：卡死 0 次、数量不对 0 次、单次最多抽签 8 次）。

⚠️ 0.3.4 **还没发到 npm**。所以本方案不用 npm，有两条替代通道：

1. 从 Gitee 的 git tag 装 —— 那个仓库里 `lib/client.js` 是编译好并提交进 git 的成品，拉下来就能跑（§4）
2. 用作者打好的 `dsh-vocab-study-0.3.4.tgz` 离线装 —— 不需要 git、不需要联网（§4-B）

---

## 1. 验收标准（做到这些就算修好）

| # | 检查项 | 期望值 |
|---|---|---|
| 1 | DSH 能正常打开，界面不冻 | 能点、能输入 |
| 2 | profile 里装的是 0.3.4 | `dsh-vocab-study` 版本 = `0.3.4` |
| 3 | `lib/client.js` 大小 | `5678409` 字节 |
| 4 | `lib/client.js` 的 SHA256 | `EF4D5168B95B062B58C6B657E1C81F0516C2C36FF11E14DF0ED763C3F5C93F3A` |
| 5 | 出辨词题不再卡死 | 见 §6 的高危词测试 |
| 6 | 背过的词还在 | 面板里历史/进度照旧（数据在浏览器 localStorage，不在包里） |

**第 3、4 条是硬证据**：对不上就说明装的是旧包，回到 §3 重装。

---

## 2. 第一步：彻底关掉 DSH

DSH 开着的时候 `node_modules` 有文件占用，装不上。

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'DeepSeek|dsh' } | Select-Object ProcessName, Id
```

- 有输出 → 关掉 DSH 主窗口，再跑一次这条命令确认列表为空
- 还不为空 → `Stop-Process -Id <上一步列出的 Id> -Force`（**只结束列表里那几个，别用通配符乱杀**）

也可以用任务管理器：结束 `DeepSeek Harness`（以及名字里带 `dsh` 的进程）。

---

## 3. 第二步：确认插件装在哪个 profile

DSH 支持多个 profile（`desktop` / `web` / …）。插件装在哪个 profile，就要对哪个 profile 动手。

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\*\package.json" |
  Where-Object { (Get-Content $_.FullName -Raw) -match 'dsh-vocab-study' } |
  ForEach-Object { $_.Directory.Name }
```

**可能的结果：**

- 输出 `desktop`（或 `web`）→ 记住这个名字，下面命令里的 `desktop` 就换成它
- 输出多行 → 每个都执行一遍下面的 §4（每个 profile 各装一次）
- **没有任何输出** → 插件不在 profile 里，属于别的情况，**停下来问提出诉求的人**，不要瞎装

同时确认一下 DSH 命令行工具在哪（`dsh` 后面要用）：

```powershell
Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```

- 有路径输出 → 下面直接用 `dsh`
- 没输出 → 用完整路径。DSH 装在 `F:\harness` 时是 `F:\harness\resources\runtime\cli\bin\dsh.cmd`；其他安装位置可以这样找：

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs","C:\Program Files","C:\Program Files (x86)","D:\","F:\" -Filter dsh.cmd -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 5 FullName
```

（找到后，把下文所有 `dsh` 换成那个 `.cmd` 的完整路径，注意加引号。）

---

## 4. 第三步：装上修好的 0.3.4（主方案，推荐）

```powershell
dsh plugin --profile desktop add "git+https://gitee.com/wutong2005/dsh-vocab-study.git#v0.3.4"
```

- `desktop` 换成 §3 查到的 profile 名
- 大约 20 秒，输出里应出现 `+ dsh-vocab-study 0.3.4`
- 这一步只改两处：profile 的 `package.json` 依赖项、`node_modules` 里的包。**不动** 会话、配置、进度

**前提检查：这台机器上有没有 git？**

```powershell
git --version
```

- 有版本号 → 继续
- 没有 → 先装：`winget install --id Git.Git -e`（装完**新开一个 PowerShell 窗口**再继续；装不了 git 就走 §7 备用方案）

**装完立刻验证（不要跳过）：**

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-vocab-study"
Select-String -Path "$p\package.json" -Pattern '"version"' | ForEach-Object { $_.Line.Trim() }
"字节: " + (Get-Item "$p\lib\client.js").Length
"哈希: " + (Get-FileHash "$p\lib\client.js" -Algorithm SHA256).Hash
```

必须看到：

```
"version": "0.3.4",
字节: 5678409
哈希: EF4D5168B95B062B58C6B657E1C81F0516C2C36FF11E14DF0ED763C3F5C93F3A
```

三行里任何一行不对 → 说明没换成新包，回到 §3 重新确认 profile 名后重跑。

---

## 4-B. 更稳的一条：用作者给的 tgz 离线装（不需要 git、不需要联网）

如果这台机器没 git、或者连不上 gitee，用这个。作者已打好包：

| 项 | 值 |
|---|---|
| 文件名 | `dsh-vocab-study-0.3.4.tgz`（3,270,802 字节） |
| SHA1 | `5a80f042a070476fa0e052af6b17bfb5f0518ef7` |
| 包内 `lib/client.js` | 5,678,409 字节，SHA256 `EF4D5168B95B062B58C6B657E1C81F0516C2C36FF11E14DF0ED763C3F5C93F3A` |

**做法：**

1. 把这个 tgz 放到本机，比如 `C:\Users\<你的用户名>\Downloads\dsh-vocab-study-0.3.4.tgz`
2. 先校验文件没传坏（可选但推荐）：

```powershell
(Get-FileHash "$env:USERPROFILE\Downloads\dsh-vocab-study-0.3.4.tgz" -Algorithm SHA1).Hash.ToLower()
```

必须等于 `5a80f042a070476fa0e052af6b17bfb5f0518ef7`。

3. 关掉 DSH（§2），然后装：

```powershell
dsh plugin --profile desktop add "$env:USERPROFILE\Downloads\dsh-vocab-study-0.3.4.tgz"
```

`desktop` 换成 §3 查到的 profile 名。

4. 验证：照 §4 最后那三行（版本 / 字节 / 哈希）跑一遍，必须一致。

---

## 5. 第四步：打开 DSH

双击正常启动即可。**注意：装完必须「完全退出再打开」**，DSH 的客户端模块清单是启动时扫的，刷新页面不算。

打开后看两件事：

1. 界面能点、能输入（不冻）
2. 输入框旁边那颗「今日词汇」胶囊在（说明插件确实加载了）

---

## 6. 第五步：验证死循环真的没了

按这个顺序点：

1. 点开胶囊，进面板
2. 设置里把词库切到 **四级（cet4，4,491 词）**
3. 正常答题，一直答到面板出**辨词题（三选一的选择题）**
4. 故意多答几十个词

**通过标准：全程不卡、不用点叉。** 特别可以用这几个以前必挂的词试：`a` `able` `about` `accept` `amount` `content` `maintain` `attain` `although`。

如果又卡死了 → 先回去看 §4 的三行验证，通常是装错 profile、或者 DSH 没完全退出就重开了。

---

## 7. 备用方案：装不上 0.3.4 时先「停用」（不推荐，只是止血）

用于：没有 git、Gitee 连不上、`dsh` 命令找不到、或折腾不动了。
目的是**让 DSH 能开**，代价是暂时没有背单词面板 —— 进度不会丢，装回来就有。

**7.1 先备份配置**

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$prof\package.json" "$prof\package.json.bak-vocab" -Force
Copy-Item "$prof\cordis.patch.yml" "$prof\cordis.patch.yml.bak-vocab" -Force
```

**7.2 从 profile 的 bundle 列表里去掉这个包**

用文本编辑器打开 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，
在 `dsh.profile.bundles` 数组里删掉 **`"dsh-vocab-study",` 这一行**（只删这一行，逗号一起删，别动别的）。
同时在 `dependencies` 里删掉 `"dsh-vocab-study": "0.3.3",` 这一行。

> ⚠️ 这个文件是严格 JSON：删完不能多出逗号、不能少括号。删完让 AI 执行
> `Get-Content "$prof\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null`，
> **不报错**才继续（`-Encoding UTF8` 不能省，否则 Windows PowerShell 5.1 会按 ANSI 读、直接误报"对象无效"）。

**7.3 把包挪走（防止它被当成已安装）**

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
if (Test-Path "$prof\node_modules\dsh-vocab-study") {
  Rename-Item "$prof\node_modules\dsh-vocab-study" "dsh-vocab-study.off"
}
```

（`node_modules` 里那个是 pnpm 的符号链接/目录，改名即可，不用删。）

**7.4 重开 DSH** → 应该能正常打开，只是没有背单词面板。
等 npm 上有了 0.3.4（或能从别处拿到包），执行 §4 装回来。

**7.5 备份怎么恢复**

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$prof\package.json.bak-vocab" "$prof\package.json" -Force
Copy-Item "$prof\cordis.patch.yml.bak-vocab" "$prof\cordis.patch.yml" -Force
if (Test-Path "$prof\node_modules\dsh-vocab-study.off") {
  Rename-Item "$prof\node_modules\dsh-vocab-study.off" "dsh-vocab-study"
}
```

---

## 8. 回滚（万一 0.3.4 反而出问题）

```powershell
dsh plugin --profile desktop add dsh-vocab-study@0.3.3
```

⚠️ 注意 **0.3.3 就是会卡死的那版**，回滚只用于排查，不要留在 0.3.3 上。

---

## 9. 红线：这些动作会丢数据 / 帮倒忙，一律不许做

1. **不要删 `%USERPROFILE%\.dsh` 目录下任何东西**（里面有全部会话记录）
2. **不要清浏览器缓存 / 站点数据 / localStorage** —— 背单词进度存在这里，清了就没了
3. **不要动 `%USERPROFILE%\.dsh\storages\workspace.json`** —— 会话索引，写坏会「会话消失」
4. **不要 `npm publish`、不要 `git push`** —— 发版由作者本人走流程
5. **不要改 `cordis.patch.yml` 里 `- id: vocab-study` 那段**（DSH 自己维护，手改容易把插件加载搞坏）；要停用就按 §7 走
6. 改任何 `package.json` 之前先 `Copy-Item` 备份，改完用 `ConvertFrom-Json` 校验
7. **每执行一步，把命令的真实输出贴出来再走下一步**，不要"看起来没报错就继续"

---

## 10. 一分钟速查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 界面完全冻死、只能点叉 | 0.3.3 出辨词题死循环 | 按 §2–§5 装 0.3.4 |
| 没 git / 连不上 gitee | — | 走 §4-B，用作者给的 tgz 离线装 |
| `dsh plugin ... add` 报 `dsh` 不是命令 | CLI 不在 PATH | §3 找 `dsh.cmd` 完整路径 |
| add 报 git 相关错误 | 没装 git | `winget install --id Git.Git -e`，或走 §7 |
| add 卡住 / 连不上 gitee | 网络 | 换网络重试，或走 §7 |
| 装完还是卡 | 装错 profile / 没完全退出 DSH | 回 §3 查 profile，§4 三行验证，彻底退出后重开 |
| 装完界面里找不到面板 | bundle 列表里没有这个包 | 检查 profile `package.json` 的 `dsh.profile.bundles` 有没有 `"dsh-vocab-study"` |
| 想暂时不用但保留进度 | — | 按 §7 停用，进度在 localStorage 里不会动 |

---

## 11. 给 AI Agent 的额外约束

- 只做 §2–§6（或 §7）里写明的命令，**不要自己发挥**：不重装 DSH、不改系统配置、不清理注册表
- 每一步先 `echo` 当前值（现有版本号 / 现有字节数），再执行，再复核
- 遇到与本手册不一致的现状（比如 profile 里根本没有这个包、或者版本已经是 0.3.4）→ **停下来报告现状**，不要强行执行
- 拿不到证据（命令失败、输出看不懂）就如实说，不要猜
