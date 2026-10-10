# 今日词汇 · dsh-vocab-study

DSH（DeepSeek Harness）的一个**纯客户端 UI 插件**：在输入框右边放一颗胶囊，点开就是一个背单词面板。

数据只存在你自己的浏览器里，不上报、不联网、不占 Host 服务。

---

## 它长什么样

**① 输入框旁那颗胶囊**（`conversation.input.right`，排在「权限」和「模型」之间）：

![输入框旁的胶囊](assets/screenshot-1-capsule.png)

**② 右侧栏里的面板**（`sidebar.right.pane.tab`，四个页签：今日 / 进度 / 生词本 / 设置）：

![右侧栏里的面板](assets/screenshot-2-panel.png)

| 位置 | 内容 |
|---|---|
| `conversation.input.right` | 一颗胶囊 `今天第一词`，排在「权限」和「模型」之间 |
| `sidebar.right.pane.tab` | 一个叫「今日背单词」的标签页，四个页签：今日 / 进度 / 生词本 / 设置 |

> **截图待补**：上面两张图对应 `screenshots.json` 里声明的路径。
> 图片放进 `assets/`（文件名必须是 `screenshot-1-capsule.png` 和 `screenshot-2-panel.png`）后即可显示；
> 市场详情页也会用同一份声明（上游 `probe-screenshots.mjs` 从仓库 HEAD 实时读取，不需要另外提 PR）。

不用它的日子它什么都不做。面板**永远不会自己弹出来**（这是刻意的，见下面「12 条硬约束」）。

### 背完一轮之后（不是死角）

一轮走完时不再只剩一个「换词库」，而是给三条**各自不同**的出路：

| 控件 | 做什么 | 什么时候出现 |
|---|---|---|
| **再背一轮** | 把刚才这一批**原样重来一遍**（不动记忆数据，不算新词） | 这一轮有内容可重背时 |
| **再来 5 个新词** | 往后加量：容器扩大，接在队列后面，**不重复** | 新词闸门开着时 |
| **我还是想继续** | 打开新词闸门（安全阀仍然自动触发，只是给了用户自己开门的权力） | 闸门**自动关闭**时 |
| 换词库 | 换一本词库 | 始终有，但降到最弱的样式 |

两个容易搞混的数字，故意分开：

- **进度环** = **这一轮**（`0/20` → `5/20` → 走完 `5/20`），点「再背一轮」后归零；
- **今天已背** = **今天累计**（KPI 里第一个，抽空背 3 个也看得见），跨轮累加、不归零。

> 为什么拆开：环原来用的是跨轮累加的值，点了「再背一轮」之后环显示上一轮的数字，
> 和「今天已背」互相矛盾（实测：环说 1、今日说 6）。用户会以为数字坏了。

**新词安全阀**（规格 §7.6）：今天新词错得太多时自动停新词。这是安全阀不是拦路虎 ——
它仍然自动触发，但界面上给一个「我还是想继续」，用户自己决定要不要开。

---

## 想先看效果，不装插件

```powershell
# 双击即可，纯本地，不需要装任何东西
start demo\index.html
```

`demo/` 是一个自包含的演示页：里面有一个假的 DSH 外壳（对话区 + 输入框 + 工具栏），
胶囊和面板都是**同一份源码**编译出来的，不是另写的仿制品。

`demo/` 里的几个文件：

| 文件 | 用途 |
|---|---|
| `index.html` | 打开就是这个 demo，可以真的点着背 |
| `smoke.html` | 自检页：外壳 11 项检查 + core 自检，全绿才算过 |
| `preview.html` | 直接截到「词卡」态（未揭晓） |
| `preview-reveal.html` | 截到「已揭晓」态 |
| `preview-progress.html` | 截到「进度」页 |
| `preview-settings.html` | 截到「设置」页 |
| `preview-vocab.html` | 截到「生词本」页 |

`preview*.html` 只是为了截图/看态方便，它们会在打开后自动点开对应页签。

---

## 装进 DSH

### 给别人用：从 GitHub 装（推荐）

```sh
dsh plugin --profile web add github:wt0812/dsh-vocab-study
```

装完 **完全退出 DeepSeek Harness 再打开**（`cordis.patch.yml` 是启动时读的，刷新页面没用）。

`web` 换成你自己的 profile 名即可（桌面版默认是 `desktop`）：

```sh
dsh plugin --profile desktop add github:wt0812/dsh-vocab-study
```

**不需要 npm、不需要构建、不需要 Python。** `lib/` 里的产物已经提交进仓库，`dsh plugin` 走的是 profile 目录里的 pnpm，装完就能用。

卸载：

```sh
dsh plugin --profile web remove dsh-vocab-study
```

> **它不联网、不上报。** 背单词的数据只落在你浏览器自己的 `localStorage` 里，插件不注册任何 Host 服务，
> 也不发一个网络请求（音标朗读用的是系统 TTS，不是在线服务）。唯一声明的能力是往两个槽位里画东西。

### 自己改代码用：本机脚本

想改源码、看完再装，用仓库自带的脚本（幂等，坏了重跑一次就能修好）：

```powershell
# 1. 构建产物（lib/client.js 是插件本体，lib/index.js 是 host 占位入口）
python tools/build.py
python tools/build-plugin.py

# 2. 安装（改 profile 的 package.json 与 cordis.patch.yml）
python tools/install.py
```

想看它会做什么而不动任何文件：`python tools/install.py --dry-run`。

> ⚠️ 这个脚本里的路径是**本机绝对路径**，只适合作者自己用。
> 给别人装请用上面的 `dsh plugin` 命令。

### 卸载

```powershell
python tools/uninstall.py            # 只想看会做什么就加 --dry-run
```

**卸载前必须完全退出 DeepSeek Harness**，否则 `node_modules` 里那份被正在运行的进程
占着删不掉（脚本会明确报 `✗ 删不掉` 并以退出码 1 结束，不会假报成功）。

卸载只动属于本插件的东西：`node_modules\dsh-vocab-study`、`package.json` 里的
两条登记、`cordis.patch.yml` 里的一段。**其它插件的条目一个都不碰**（脚本每次都会
打印其余 bundles 清单让你核对），本仓库的源码/测试/demo 也一个都不删。

### 为什么必须「完全退出」而不是刷新页面

`cordis.patch.yml` 是**启动时**读的，客户端模块清单也在启动时扫描并缓存
（客户端半身的机会只有启动那一次）。只按 F5 不够 —— 现象就是「装了、重启了、
界面上什么都没有」。而 `lib/client.js` 的字节变化在刷新后是能生效的（走 `?rev=`），
所以**改了插件代码只要刷新；改了 `cordis.patch.yml` 必须重启**。

### 万一重启后客户端起不来了（自救）

如果重启后**整个客户端停在启动页**、弹窗写着「DeepSeek Harness 无法使用」，
按弹窗那个「禁用第三方插件」按钮就能恢复（它会备份 profile patch 再禁用）。
然后**完全退出 DSH**，在本仓库里跑：

```powershell
python tools/uninstall.py     # 卸干净，回到装之前的状态
```

或者临时只改 `cordis.patch.yml`：把末尾 `- id: vocab-study` 那一条删掉（**必须完整重启**）。

这个问题曾经真实发生过一次，根因与修法见下面「排查笔记 · 事故二」。
装插件前跑一遍 `python tools/install.py --dry-run` 可以确认不会动到别的插件。

### 换用 dsh plugin 命令也可以

```powershell
dsh plugin --profile desktop add "F:\DeepSeek Harness\projects\vocab-study"
```

但它有两个已知副作用，所以本仓库默认用 `tools/install.py`：

1. 它可能把安装位做成**真实副本**而不是联接（于是以后重建产物到不了插件目录）；
2. 它在管理界面里点「停用」会往 `cordis.patch.yml` 写 `disabled: true`，而且
   **点「启用」不会删掉那一行** —— 那种状态下 Host 侧显示 `enabled: true /
   fiberPhase: active`，但客户端半身永远不加载。

`tools/install.py` 每次都会把这两件事纠正过来（重建联接、清掉 `disabled`）。

### 手动安装（不想用 dsh plugin 命令）

**关键：一定要用联接（junction），不要复制文件。** 原因见下面「最大的坑」。

```powershell
$profile = "C:\Users\<你>\.dsh\profiles\desktop"
$src     = "F:\DeepSeek Harness\projects\vocab-study"

# 用联接，不要 Copy-Item
cmd /c mklink /J "$profile\node_modules\dsh-vocab-study" "$src"

# 然后往 $profile\package.json 里补：
#   dependencies: { "dsh-vocab-study": "file:F:/DeepSeek Harness/projects/vocab-study" }
#   dsh.profile.bundles 数组末尾加 "dsh-vocab-study"
```

### 最大的坑：profile 里那份可能是「副本」，不是「联接」

`pnpm install` 装 `file:` 依赖时，**可能把包复制成真实目录**，而不是建联接。
一旦是副本，你在源码目录里 `python tools/build-plugin.py` 重建，
**profile 里那份永远不会变** —— 现象就是「改了没反应、刷新也没用」，
而所有测试又是绿的，非常难查。

**判断方法**（PowerShell 的 `LinkType` 属性不可靠，用 fsutil 或 Node）：

```powershell
fsutil reparsepoint query "$profile\node_modules\dsh-vocab-study"
# "不是重解析点" / "not a reparse point"  → 是副本，下面的坑就在你身上
```

```javascript
// 或者用 Node（最准）
const fs = require('fs');
fs.lstatSync(path).isSymbolicLink();     // junction 在 Windows 上也算 true
fs.realpathSync(path);                   // 指向源码目录 = 联接；指向自己 = 副本
```

**修法**：删掉副本目录，改建联接（本节顶部那行 `mklink /J`）。

**每次重建后自检**（两边大小必须一致）：

```powershell
(Get-Item "$src\lib\client.js").Length -eq (Get-Item "$profile\node_modules\dsh-vocab-study\lib\client.js").Length
# True = 一致（联接正常）；False = 你在看一份旧副本
```

### 第二个坑：插件管理器写的 `disabled: true` 清不掉

在插件管理界面里点「停用」，它会在 profile 的 `cordis.patch.yml` 里写下：

```yaml
- id: vocab-study
  disabled: true
```

**然后在界面里点「启用」并不会删掉这行。** 插件会一直处于停用状态：
Host 侧看起来是 `enabled: true / active`（因为运行时的树还记得启用过），
但**客户端半身永远不加载**，现象就是「装了、重启了、界面上什么都没有」。

**修法**：手动删掉那两行。文件末尾留一条注释提醒自己。

另外注意：`cordis.patch.yml` 是**启动时读取**的，改完必须**完整重启 DSH**
（刷新页面没用——客户端清单在启动时就扫描完了）。

---

## 它是怎么工作的

### 三层结构，界面与逻辑严格分开

```
core/      纯逻辑。零宿主依赖，可跨环境运行（Node 里直接跑单测）
  memory.mjs    半衰期记忆模型（HLR）：多久会忘、什么时候该复习
  mistake.mjs   错因诊断、形近词混淆、永久拉黑
  queue.mjs     今日容器：三层配额（复习/收藏/新词）、断签缩量、连续打卡
  game.mjs      连击倍率、等级、收服计数
  beckon.mjs    「该不该招呼你」的状态机（第一词/好久不见/到期/学词中/交接…）
  session.mjs   一次学习会话：轮次、同轮重训、撤销、拼写测验
  library.mjs   词库：内置种子 / 剪贴板解析 / 降级到内置词表
  speech.mjs    系统语音朗读（不支持就静默跳过，不影响背词）
  app.mjs       把它们缝起来，对外只暴露一个 createApp(ports)
  spec-cases.mjs 共享验收用例（demo 与 Node 单测跑的是同一套断言）

store/
  client-store.mjs  浏览器持久化：多窗口只读锁 + 配额降级（不阻塞）

ui/         界面。只依赖 core 的命名空间，不依赖任何 UI 框架
  dom.mjs       极小的 DOM 工具（el / mount / setText …）
  pages.mjs     进度页、生词本页、设置页的渲染
  panel.mjs     整个面板：四个页签、键盘快捷键、卡片交互
  capsule.mjs   输入框右边那颗胶囊
  styles.css    所有样式，类名与 CSS 变量统一带 vs- 前缀，不会跟宿主打架
  shell.mjs     演示用的假 DSH 外壳（**不属于插件**，只有 demo 用）

adapter/dsh/  插件适配层
  puppet.mjs   把 core + ui 组装成「胶囊」和「面板」两个傀儡
  client.js    真正的 DSH 客户端入口：占槽位、注册标签页
```

### 命名空间：界面层怎么拿到 core

单文件产物把所有文件摊平进同一作用域，ESM 绑定全部消失；插件入口又只能 `require('react')`，
不能 import 自己人。所以界面层拿 core 的唯一通道是 `ui/core-ref.mjs` 的注册表：

```js
// ESM 形态（Node 单测）：ui/pages.mjs 自己登记
setCore({ memory: M_, mistake: MK_, game: G_, queue: Q_, library: L_, beckon: B_ });

// 摊平形态（构建产物）：构建脚本按 CORE_EXPORTS 统一登记
setCore({ memory: { newMemory, encode, ... }, mistake: { ... }, ... });
```

读的时候**键名只有全名**，单字母只能当别名：

```js
const { queue: Q } = getCore();   // ✅
const { Q } = getCore();          // ❌ Q 是 undefined（构建期就会报错拦下）
```

这个坑真的踩过：设置页报 `Q.buildDailyContainer is not a function`。
现在两个构建脚本都会扫描这种写法，构建期直接失败，不会留到运行时。

### 构建

```powershell
python tools/build.py          # → demo/（自包含 HTML，双击可开）
python tools/build-plugin.py   # → lib/client.js + lib/index.js（真正装进 DSH 的产物）
```

两个脚本读的是**同一份源码**，没有手抄的核心逻辑。

`build-plugin.py` 会：
1. 剥掉所有 import/export（除 `react` 外任何可注册的默认导入都会让构建失败）
2. 把 core 里的 `Q.dayKey(...)` 改写成裸符号名 `dayKey(...)`（摊平后没有命名空间对象）
3. 把 CSS 包成字符串 + `injectVocabStudyCss()`
4. 用真的 `node --check` 验证语法
5. 检查符号清单、重名、`getCore()` 键名、ESM 别名残留

---

## 测试

```powershell
python tools/build.py && python tools/build-plugin.py
node test/core.test.mjs
node test/plugin.test.mjs
node test/demo-boot.test.mjs
node test/client-activation.test.mjs
node test/bundle-audit.test.mjs
node test/mount.test.mjs
node test/round-control.test.mjs
```

| 测试 | 覆盖什么 | 当前 |
|---|---|---|
| `test/core.test.mjs` | 共享验收用例 20 组 + 种子数据、字段名一致性等体检 + **记忆钩子 12 项** + **新词顺序 13 项** | **全部通过** |
| `test/plugin.test.mjs` | 假宿主：槽位契约、胶囊顺序、key 一致性、组件可实例化、样式只注入一次、**真的点一次胶囊并断言走到了 `openTabIn`**（见事故四） | **33 通过 / 0 失败** |
| `test/demo-boot.test.mjs` | 最小 DOM 里真的跑一遍 demo 产物：外壳建起来、四个页签逐个点开、**真的点一次「✨ 让我记住它」并检查输出非空**、**真的拨一次「出场顺序」开关并检查设置变了** | **34 通过 / 0 失败** |
| `test/client-activation.test.mjs` | **真的把 `lib/client.js` 跑起来**：注册 → 物化工厂 → 检查导出 → **调 `apply(ctx)`** → 断言注册了哪些槽位。守的是"插件能不能被宿主激活" | **18 通过 / 0 失败** |
| `test/bundle-audit.test.mjs` | 产物静态审计：只有 1 处 `load()`、只 `require('react')`、`inject` 声明齐全、没有"未声明服务上的裸方法调用"、`openVocabTab` 的契约（见事故三、四）、**宿主容器能撑开面板 + 限宽居中不被 margin 简写清零**（见事故五） | **全部通过** |
| `test/mount.test.mjs` | **真的把界面画出来并断言节点进了 DOM 树**：从产物里抠出傀儡工厂 → 拿真容器建一遍 → 断言容器里真的有 `.vs-panel` / `.vs-capsule`。守的是"注册成功了但屏幕上是空的"（见事故三）。第 ⑤ 节守**播放键不是死键**（见事故六） | **33 通过 / 0 失败** |
| `test/round-control.test.mjs` | 「背完一轮之后」的三条出路：今日已背计数、再背一轮、往后加量、安全阀（自动触发 + 用户放行）、跨天重置，**三个只有真点一遍才发现的 bug 的回归锁**，第 ⑧ 节**换词库必须真的把词换掉**（见事故七），第 ⑨ 节**设置要留痕**，第 ⑩ 节**用真实存储件测写入/读取对称**（见事故九 —— 这节的绿必须是真绿，因为前两节用的替身把它屏蔽过） | **92 通过 / 0 失败** |

另外有两个**浏览器里真点一遍**的验证工具（不是单测，需要本机 Chrome）：

```powershell
python tools/verify-clicks.py    # 真的点胶囊、背完一轮、点每个新按钮，断言状态变化
python tools/render-states.py    # 把「开局 / 走完一轮 / 放行之后」三个状态截成一张对比图
```

> **为什么要"真点一遍"**：这一轮修「背完一轮之后」时，单元测试全绿、截图看着也对，
> 但我把按钮真点了一遍，抓到三个**渲染和源码都看不出来**的问题：
>
> 1. 闸门关着时「再来 5 个新词」**点了什么也没发生** —— 闸门把新词挡住，容器扩了但没有新词进来。
>    一个"点了没反应"的按钮比没有按钮更坏，所以闸门关着时**不显示**它。
> 2. 点「再背一轮」后进度环显示上一轮的数字（环说 1、今日已背说 6），两个数字互相矛盾。
> 3. 点「我还是想继续」后，端上来的居然是**刚背完的那个词** ——
>    根因是 `createSession` 无条件把容器里所有条目变成 `answered:false` 的新队列，
>    把整个容器丢给它，就等于让用户把刚背的 20 个词原样再背一遍。
>
> 教训：**渲染出来 ≠ 能用**。截图能证明"画对了"，证明不了"点下去有反应"。
> 这三个都锁进了 `test/round-control.test.mjs`（第 ⑦ 节）。

> `client-activation`、`bundle-audit`、`mount` 三个都是**真实事故的产物**，而且它们守的是
> 三个**不同的**失效模式，缺一个就会漏：
>
> - `client-activation` 守「**激活不了**」——插件把整个客户端拦在启动页（事故二）；
> - `bundle-audit` 守「**契约写错**」——调了不存在的方法、服务没声明、静默吞异常（事故三前半）；
> - `mount` 守「**注册成功了但看不见**」——槽位 `active: true`、存储有痕迹，屏幕上却什么都没有（事故三后半）。
>
> 还有第四个失效模式，**上面三套一个都守不住**：界面**画出来了、也在 DOM 里、也不报错**，
> 但布局是塌的（事故五：面板只占 32% 高度、内容贴在左边）。这种只能靠
> 「把 `offsetWidth` / `getComputedStyle` 打出来」或截图看出来。
> `bundle-audit` 第 9、10 节是把当时量出来的那两条契约固化了 ——
> 它们的特征是**静默失效**：不会抛错，测试也不会红，只有肉眼看得出来。

> `demo-boot` 里那两条「真的点一次」是**故意**这么写的：以前那个 AI 按钮是假的
> （有加载态、有失败文案，看着像"功能正常只是 AI 挂了"），只读代码发现不了；
> 而且它还顺带抓出了一个真 bug —— 在「设置」页待过之后切回「今日」，页面会空白
> （`lastCardKey` 没变就跳过重建卡片骨架，`mount(null)` 抛错）。

调试开关：

```powershell
$env:VS_DUMP=1; node test/demo-boot.test.mjs   # 打印外壳 DOM 树与关键计数
```

`test/plugin.test.mjs` 是**装进 DSH 之前**的最后一道闸：它用假宿主真的把四个槽位的组件
各实例化一次。这一轮它抓出了 4 个「插件装上了但界面不出现」级别的 bug
（命名空间对象在摊平后不存在、TDZ、模板字面量剥离漏掉、ESM 别名残留）。

---

## 12 条硬约束

规格（`../VOCAB-STUDY-SPEC.md`）里的顶层原则，实现时当成不可协商的约束：

| # | 约束 | 怎么落地的 |
|---|---|---|
| P1 | 面板永不自作主张 | 胶囊只在那里待着，绝不自动展开；demo 外壳也一样 |
| P2 | 不打断当前工作 | 胶囊是输入框旁的普通按钮，不抢焦点、不弹窗 |
| P3 | 文案永不指责 | 断签文案是「好久不见」，不是「你落下了」；没有欠债措辞 |
| P4 | 加量必须点头 | 「每天几个词」要用户自己调，系统不悄悄加 |
| P5 | 任何时刻可离开 | 关面板不丢状态；Esc 把焦点还给输入框 |
| P6 | 不阻塞等待 | 词库拉不到就用内置词表；没有语音就静默跳过 |
| P7 | 数据诚实 | 「收服」要记忆强度 ≥ 0.9 **且**拼写答对，学了两下不算 |
| P8 | 互动不劫持 | 快捷键绑在面板元素上，焦点在输入框时按 1/2/3 完全没反应 |
| P9 | 不制造欠债感 | 断签后容器自动缩量（≤14 天 60%，再久 40%），不催补课 |
| P10 | 不主动召回 | 没有通知、没有红点、没有倒计时 |
| P11 | 进步必须可见 | 进度页有 30 天留存曲线、半月热力图、顽固词榜 |
| P12 | 回归门槛低于坚持门槛 | 回来随时能用，缩量后仍然算打卡（≥60% 容器即打卡） |

---

## 已知缺口（诚实清单）

1. **客户端半身需要重启 DSH 才会出现。**
   已实测：在 DSH **运行中**把插件装进 profile 后，Host 侧会被 Loader 正常认领
   （`include:vocab-study / enabled: true / fiberPhase: active`），但**浏览器里不会长出来**——
   客户端模块清单（`@deepseek-ai/dsh-client-modules`）在启动时就完成了扫描，
   它按 Loader 条目名逐包做增量对账，且注释明确写着"包元数据（包括『这不是客户端包』
   的否定结论）**缓存到重启为止**"。在运行中停用→启用该插件触发重扫，实测**无效**。
   **结论：装完必须完整退出 DSH 再打开。**

2. **`isStreaming` 恒为 false。**
   `adapter/dsh/client.js` 里 `createCapsulePuppet({ core, onOpen })` 的
   `isStreaming: () => false`。§3.1 的「交接态」招呼（任务在输出时把胶囊切成
   「我先退到一边」）因此暂时不会触发。原因：我无法从 DSH 文档确认客户端能读到的
   「本轮是否正在输出」信号（尝试过 Client inspect 查询，它挂在等待页面响应上）。
   这是**可降级缺口**：不影响背词，只是少一种招呼文案。

3. **发音依赖系统语音。**
   `speech.mjs` 用 `speechSynthesis`。没有语音的环境静默跳过，不报错、不挡流程。

4. **`AiPort` 没有实现 —— 记忆钩子是本地算出来的，不是 AI 编的。**
   规格 §9 设计了一个 `AiPort` 接口，让 DSH 适配层实现它、由一个模型生成记忆钩子。
   本插件的 `AiPort` **仍然是空的**，原因是纯客户端插件拿不到宿主的模型通道
   （`lib/index.js` 那个 Host 入口刻意什么都不做）。

   所以 `✨ 让我记住它` 现在走 `core/hook.mjs`：**只用词库里真实存在的字段**
   （词根 / 例句 / 搭配 / 易混词）重组成一句钩子，离线可算、零等待、不编造。产出带
   **来源标注**（「· 来自词根」），满足规格 §9「让人看得出它凭什么这么说」；
   结果**永久缓存**（§9「每词一生只付一次」），第二次点零等待。

   为什么这样做：以前这个按钮是**假的** —— 假装加载 900ms，然后写死一句
   「✨ 暂时没编出来 · 重试」。它违反 P7（数据诚实），而且用户永远用不上这个功能。
   与其留一个点了必然失败的按钮，不如给一个真的能用的。

   以后接上 AI 的正确形态是**叠加**而不是替换：有 AI 时用 AI，AI 挂了回落到本地
   结果（§9「AI 挂了不阻塞」）。那时「暂时没编出来」才是一句诚实的失败文案。

5. **词库网络拉取未在真实环境验证。**
   `library.mjs` 的拉取路径只有降级测试覆盖（拉不到 → 用内置词表）。演示与测试都走内置种子词表。

6. **`node_modules` 那份安装是联接，跑 `pnpm install` 可能把它换成副本。**
   换了以后插件**照旧能用**（副本内容是完整的），只是以后重建产物不会自动生效。
   自查与修复办法见下面「最大的坑」，或直接重跑 `python tools/install.py`。

7. **多窗口只读锁是「尽力而为」。**
   `client-store.mjs` 用 `sessionStorage` 的 tab id + 8 秒租约做单写者。浏览器异常退出
   时锁会在 8 秒内自然过期，不会永久卡死；但极端时序下仍可能出现短暂的双写。

8. ~~**胶囊点击不能把右侧栏标签页"拉出来"。**~~ **已修（见「排查笔记 · 事故三」）。**
   当时的判断是错的：`openTab` **确实**在 `ctx.sidebarRight` 上，只是无参形态内部走
   `require()` 守卫、侧栏没打开时必抛。正解是带 `sessionId` 走 `openTabIn(sessionId, kind)`，
   它走 `actionsFor(sessionId)`，**不要求侧栏已经打开**。

   > 这条留在清单里而不是删掉：**"已知缺口"也可能是自己判断错了**。
   > 当时把它写成"宿主不提供这个能力"，实际上是"我调错了方法"。

---

## 排查笔记：为什么"装了但界面不出现"

这次踩的坑记在这里，下次直接照这个顺序查，别再从外面猜。

**DSH 的两条独立链路**：Host 侧（Loader 条目）和客户端侧（浏览器模块）是**分开**的。
Host 侧成功**不代表**客户端会加载，必须分别验证。

| 要查的事 | 怎么查 | 可靠吗 |
|---|---|---|
| 条目是否被认领 | `plugin_manager list_plugins`，搜包名 | ✅ 可靠 |
| 客户端是否加载 | Client `Slots.listSubTree` 查**单个**槽位的 `occupants` | ⚠️ 查大范围会超长被截断，失去凭据 |
| 客户端是否加载 | ❌ **不要**用 `/plugins/<id>/client.js` 探测 | ❌ 该路由**本来就返回 404**：`chunkRequest` 只认 `client.<hash>.js`，且服务端路由对外一律 404 |
| 包能否被解析 | 复刻 `locatePkgJson`：`createRequire(profile/package.json).resolve(name)` + 向上找最近的 package.json | ✅ 可靠（用 Node 脚本，别用 PowerShell 猜） |
| 客户端产物是否合法 | `node test/client-activation.test.mjs` + `node test/bundle-audit.test.mjs` | ✅ 可靠 |

---

### 事故一：`disabled: true` 清不掉（症状：装了、重启了、界面上什么都没有）

### 事故二：一个笔误让**整个客户端**起不来 ⚠️ 最严重的一次

**症状**：启用插件后重启 DSH，**整个客户端停在启动页**，弹窗写着「DeepSeek Harness 无法使用」，
按钮是「禁用第三方插件、备份 profile patch 并重启」。**不是插件不显示，是整个应用用不了。**

**证据**（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`）：

```
Error: web boot: 1 entry did not activate
dsh-vocab-study: loading
```

**怎么读这行**：前端启动审计（`dsh-web-frontend` 里那个 `GS()`）要求**每一个客户端条目**
都到达 `ACTIVE`。它把 Cordis 的 fiber 状态映射成字符串，`1` 就是 `loading`。
注意它打印的是 `dsh-vocab-study`（包名）而不是 `vocab-study`（Loader 条目名）——
因为前端用的是 `entry.options.name`，而 `entries.create()` 里是 `options = { name: id }`。

**根因**（一行代码）：

```js
// adapter/dsh/client.js —— 错的写法
ctx.effect(() => ctx.sidebarRightTabs.register({...}), 'vocab-study: tab type');
// ...
export const inject = ['slots'];          // ← 没有声明 sidebarRightTabs
```

`ctx.sidebarRightTabs` 因此是 `undefined`，`undefined.register(...)` **同步抛错**，
整个 `apply` 挂掉，fiber 永远进不了 `ACTIVE` → 启动审计失败 → 整个客户端被拦下。

**为什么当时没发现**：同一份代码里 `ctx.sidebarRight.openTab(...)` 是**包在 try 里的**，
看起来"作者已经考虑过服务拿不到的情况了"。但 `sidebarRightTabs.register` 那一处漏了。
一个插件里的**一处**漏网的属性访问，代价是**整个客户端**。
**正确的契约**（从宿主自己的插件里抄来的，不要猜）：

```js
// inject 里写的是**服务名**，不是包名。宿主 ui-schedule 的 inject 就是这一批：
const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

// 服务由提供方用 reflect.provide 发布（ui-sidebar-right）：
ctx.reflect.provide('sidebarRightTabs', tabs);
ctx.reflect.provide('sidebarRight', controller);

// slots 服务由 ui-renderer 发布（SlotRegistry extends Cordis Service，属性名即服务名）：
function apply(ctx) { new SlotRegistry(ctx).install(createSlotRenderer()); }
```

**为什么 `inject: ['slots']` 原本能激活**：这恰好证明了运行时服务名**来自模块导出的 `inject`**
（`entries.create` 里只有 `options = { name: id }`，`dsh.client.inject` 只是透传到 wire）。
Cordis 会自动等 `sidebarRightTabs` 服务出现再激活——**这才是正确机制**；
少声明不是"自然缺失"，而是"`ctx.X` 是 undefined，访问即抛错"。

**修法**：
1. `inject` 补全成 `['slots', 'sidebarRightTabs', 'sidebarRight']`；
2. `sidebarRightTabs.register` 外面加 `try/catch` + `console.warn`（**降级，绝不静默**）；
3. `openVocabTab()` 统一处理"把右侧栏标签页拉出来"这件最佳努力的事，
   **每一条路径都包 try**；
4. 加 `test/client-activation.test.mjs`（真的调 `apply(ctx)`）和
   `test/bundle-audit.test.mjs`（静态审计"未声明服务上的裸方法调用"）当回归闸门。

> ⚠️ 上面第 3 条当时的注释里写着「`openTab` 属于 Tab domain、`Not part of ISidebarRight`」。
> **这句话是错的**，下一节（事故三）把它纠正了：`openTab` 确实在 `ctx.sidebarRight` 上，
> 只是**不能那么调**。别再照抄那句注释。

**这段经历的结论（写下来别忘了）**：
> 界面元素里的**可选能力**，一律不许有能力把**插件本身**带崩；
> 而插件本身崩了，代价是**整个客户端**。
> 所以：**`inject` 必须写全，`apply` 里不许有裸的 `ctx.X.method()`。**
> 而且这两条现在都有测试守着，不再靠记性。

---

### 事故三：界面出来了，但**点了没反应**、**面板是空的** ⚠️ 最会骗人的一次

这是继事故二之后最容易误判的一类：**插件状态完全健康，屏幕上却是空的**。
"一切正常"和"看得见"之间，隔着两道会**静默失败**的坎。

**症状一：重启后界面上什么都没有 —— 但内省显示一切正常**

用界面内省查活体槽位，结果是：

```json
"occupants": [
  { "id": "vocab-study-capsule",  "order": 45, "active": true },
  { "id": "vocab-study-open",     "order": 20, "active": true }
]
```

标签页类型也注册上了（`"key": "vocab-study", "active": true`），浏览器 Session Storage 里
还有插件写的 `vocab-study.tabId`（证明傀儡真的被创建过）。**但用户什么都看不见。**

**根因**：适配层调 `createPanelPuppet` 时**漏了 `mountTo`**：

```js
// puppet.mjs 里是这么挂的：
if (mountTo && typeof mountTo.appendChild === 'function') mountTo.appendChild(panel.root);
//    ^^^^^^^^ undefined → 整行静默跳过
```

面板 DOM 建好了，却挂在一个**游离节点**上，永远不进页面。**不报错、不警告、槽位还是 active。**

> 记录一个反直觉的细节：`hidden` 数据属性对 `HTMLElement` **不是** `visible` 的真正开关，
> 但 `mountTo` 那句 `&&` 短路**才是**——它把"画不出来"变成了一个无声的 no-op。

**症状二：胶囊能看见了，但点它没反应**

`openVocabTab` 当时试的是这个：

```js
ctx.sidebarRight?.openTab?.(TAB_KIND)
```

它**存在**，但内部第一句就是守卫：

```js
openTab(kind, options = {}) {
  const { sessionId, actions } = this.require();   // ← 这里
  this.placeTab(sessionId, actions, kind, options);
}
require() {
  if (this.binding === void 0) throw new Error("sidebarRight: no session surface is mounted");
  return this.binding;
}
```

而 `binding` **只在右侧栏那个 seat 真的挂载时**才绑得上（`RightbarSeat` 里是
`active ? bindService({...}) : void 0`）。于是「侧栏没打开 → 点胶囊 → 抛错 → 被 `try` 吞掉 →
什么都不发生」。**`try/catch` 在这里是对的（不许带崩插件），但它同时把失败藏了起来。**

**正确的入口**是同一个对象上的另一个方法：

```js
openTabIn(sessionId, kind, options = {}) {
  const actions = this.actionsFor(sessionId);          // ← 不是 require()
  if (actions !== void 0) this.placeTab(sessionId, actions, kind, options);
}
```

它**不要求侧栏已经打开**，只需要该会话的 surface 已被采纳（在对话里点胶囊时天然满足）。
而且宿主自己给插件用的那个 `ctx.sidebarRight.openTab`，内部**也是转手调 `openTabIn`**：

```js
openTab: (kind, options = {}) => {
  navigator.openTabIn(sessionId, kind, { ...place(options), params: options.params });
}
```

**修法**：
1. 两个席位都把 `mountTo` 传下去（`CapsuleSeat` → `createCapsulePuppet`，
   `VocabPane` → `createPanelPuppet`）；
2. `usePuppet` 改成**回调 ref + state 触发**，保证宿主容器真的在 DOM 里了才建傀儡
   （`useRef` + `useEffect` 的写法看起来更"标准"，实际会拿到还没挂载的节点）；
3. `openVocabTab(ctx, sessionId)` 改走 `openTabIn`，并要求调用方把 `sessionId` 传进来；
4. 傀儡 `destroy()` 自己把节点摘掉（否则容器重建会叠出第二个胶囊）；
5. 加 `test/mount.test.mjs`：**真的把界面画出来，断言节点进了 DOM 树**
   —— 前四个套件全绿时它才会红。

**这段经历的结论**：
> **"注册成功"不等于"画出来了"，"函数存在"不等于"调用有效"。**
> 一个能静默失败的分支，必须有测试真的走一遍它，而不是检查"注册表里有没有我"。
> 这也是为什么 `mount.test.mjs` 里那两条断言是这么写的：
> 一条正向（容器里必须有 `.vs-panel`），一条反向（不传 `mountTo` 时容器必须是空的）——
> 反向那条把"静默不画"这个机制本身钉住了。

---

### 事故四：组件里**根本没有 `ctx`** ⚠️ 查了三轮才见底

事故三修完，面板能画了、`openTabIn` 也调对了，**点击还是没反应**。

**症状**：点胶囊，Console 只报一句"没能打开标签页"，没说为什么。

**第一轮**：我把失败原因也打进日志（只报"不可用"等于没说）。得到：

```
sidebarRight.openTabIn(sessionId) → Cannot read properties of undefined (reading 'openTabIn')
sidebarRight.openTab(kind)        → Cannot read properties of undefined (reading 'openTab')
...
sidebarRight = undefined
ctx 自有键   = null            ← ctx 本身就是 undefined
```

**根因**：**槽位组件的 props 里没有 `ctx`**。我一直把 `ctx` 当成标准 prop 在传。

宿主渲染器（`dsh-client-ui-renderer`）是这么调组件的：

```js
jsx(Comp, { ...kit, ...injected, ...slotInjected.props, ...contextual, ...ownerProps })
```

`ctx` 不在任何一个展开里。那插件怎么往自己的组件里传能力？答案在 `runInject`：

```js
function runInject(entry, binding, actions) {
  const inject = entry.inject;
  if (!inject) return EMPTY_INJECTED_PROPS;
  return bindInjectSources(inject(...args));
}
```

**注册槽位时可以直接给一个 `inject` 函数，它的返回值会变成组件 props。**
宿主的 ui-chat 就是这么给自己要能力的：

```js
ctx.inject(["sidebarRightTabs"], (scope) => {
  const tabs = scope.sidebarRightTabs;        // ← 服务在 scope 上
  scope.slots.inject("settings.general.item", () => scope.slots.register({
    name: "settings.general.item", id: "link-opening", order: 14,
    inject: () => ({ hooks: { linkOpening, browserAvailable }, setLinkOpening }),
  }, LinkOpeningRow));
});
```

**注意 `scope.sidebarRightTabs`。** 这才是最反直觉的一条：

> `export const inject = [...]` 声明对了，不代表 `ctx.<服务名>` 就能用。
> **服务出现在 `ctx.inject([...], scope => ...)` 的 `scope` 上，不在根 `ctx` 上。**
> 所以 `ctx.sidebarRight` 恒为 `undefined` —— 而且**不报错**。

**修法**：
1. `apply` 里所有要宿主服务的动作，都包进 `ctx.inject(['slots','sidebarRightTabs','sidebarRight'], scope => ...)`；
2. 三个组件都不再找 `ctx`，改成从 props 拿能力（`CapsuleSeat`/`VocabMenuItem` 收 `openTab`）；
3. 能力用闭包封好再交出去：`const openTabFor = (sid) => () => openVocabTab({ scope }, sid)`，
   通过 `slots.register({ ..., inject: (sid) => ({ openTab: openTabFor(sid) }) })` 变成 props；
4. `openVocabTab` 的第一个参数从 `ctx` 改成**能力对象** `{ scope }`；
5. `plugin.test.mjs` 里**故意不再往 props 里塞 `ctx`**，并新增 `[4b]`：
   **照着宿主的方式跑一遍 `inject`，再真的触发一次点击，断言走到了 `openTabIn`。**

> 第 5 条是关键。上一版的 `plugin.test.mjs` 自己在 `fakeProps` 里放了 `ctx` ——
> **测试自己把 bug 掩盖了**。它一路绿，因为它模拟的 props 比真实宿主多给了一样东西。

**我在这里犯的三个错**（都是"猜 API"）：
- 第一次猜 `ctx.sidebarRight?.tabDomain?.openTab?.(...)` —— 方法压根不存在；
- 第二次猜 `ctx.sidebarRight?.openTab?.(...)` —— 存在，但内部 `require()` 守卫必抛；
- 第三次才去**读宿主自己插件的源码**（ui-chat 的 `ctx.inject` 用法），一眼见底。
- 教训：**同一个 API 猜错两次，就该去读实现，不要再猜第三次。**

---

**我犯过的三个错，别再犯：**

1. 用 Client inspect 查询当唯一验证手段。那个通道会挂死/被取消/返回截断结果。
   正确做法是**先读实现源码**：`@deepseek-ai/dsh-client-modules/lib/index.js`
   就在 app.asar 里，用十几行 Node 就能按路径读出来（asar 头 = 4 字节 `headerSize`
   字段偏移 12 + JSON 目录 + 数据区），比从外面猜快得多。
2. 把"某个 URL 返回 404"当成诊断结论——而那个 URL 按实现**本来就该是 404**。
   任何探测之前先确认"成功时应该长什么样"。
3. 用 PowerShell 的 `Get-Content -Raw` 读 UTF-8 中文文件会显示乱码（它按 GBK 解），
   看起来像文件坏了。查编码/合法性用 Python 或 Node，别用 PowerShell 判断。
   写文件也一样：`Set-Content` 默认写 GBK，会把 UTF-8 源码写坏——
   构建脚本会报 `UnicodeDecodeError`。要写就用
   `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`。

**还有一条**：**别再用 PowerShell 的宽松正则去数 YAML/JSON 的条目。**
`Select-String` 的正则默认是逐行的、`-Pattern` 又把内容当正则，
很容易跨条目误匹配（我因此误报过一次"用户的 disabled 被改了"，其实是脚本自己的 bug）。
结构化文件就用 Python `json` / 逐行 `startswith('- id:')` 数**顶级**条目。

**再补一条**：**别用 PowerShell 的 `Set-Content` / `Get-Content -Raw` 改含中文的文件。**
2026-10-09 我用 `(Get-Content -Raw) -replace ... | Set-Content -Encoding UTF8` 改一个测试页，
中文全变成 `闈㈡澘`（GBK 往返），页面直接白屏。含中文的文件一律用编辑工具改，不要过 PowerShell 管道。


---

### 事故五：面板**只画上半截，下面半屏黑**、内容**贴在左边** ⚠️ 最"安静"的一次

用户反馈原话：**"边框太宽了，我觉得可以弄窄一点，还有打开测边框就只有这个，下面是空的，一点都不好看"**

这一起和前四起都不一样：**它一个字都不报错，六套测试全绿，界面也"能看"。**
只有肉眼（和量尺寸）才看得出来。所以它有两层价值：既是布局 bug，也是"测试测不到的东西"的样本。

#### 真凶 A：`.vs-pane-host` 是一条都没有的样式规则

插件形态里面板挂在 React 渲染的 `<div class="vs-pane-host">` 里。这个 div **之前一条 CSS 都没有** ——
普通 block、没有高度。而 `.vs-panel.docked` 用的是 `flex: 1 1 auto`，**需要父容器是 flex 才能被撑满**。

父不是 flex → 面板只长到内容高 → **下半个标签页全空**。实测：

```
宿主观感：面板 222px / 宿主 698px = 填充率 32%
```

而 demo 形态（`demo/shell.css` 的 `.dsh-side .pane`）**一直是对**的，所以本地预览看不出问题：

```css
.dsh-side .pane { flex: 1 1 auto; min-height: 0; overflow-y: auto;
                  display: flex; flex-direction: column; }   /* ← 就缺这个 */
```

修法就是把这四行搬到 `.vs-pane-host` 上。**注意 `min-height: 0` 不能省** ——
没有它，flex 列里的子项不肯缩到内容以下，滚动会静默失效。

#### 真凶 B：`margin` 简写把居中的 `margin-left/right: auto` 清成了 0

面板原本是按 **340px 宽的右侧栏**设计的（demo 里 `.dsh-side.open` 就是 340px）。
但宿主也能把它开在主内容区 —— 那时标签页宽 800px+，内容还是原来的宽度又全部左对齐，右边空一大片。

于是加了一条限宽居中：

```css
.vs-panel.docked .vs-body > * { width: 100%; max-width: var(--vs-readw);
                                margin-left: auto; margin-right: auto; }
```

结果**还是贴在左边**。因为后面那条规则里我写了 `margin: auto 0`：

```css
.vs-panel.docked .vs-card { margin: auto 0; }   /* ← 把 left/right 又写成了 0 */
```

`margin: auto 0` = 上下 auto、**左右 0**。两条规则都作用于 `.vs-card`，后者把前者的居中**静默覆盖**。
实测证据（把真实数值打出来，不靠眼睛估）：

```
card offsetWidth = 560   offsetLeft = 12    mL = 0px    mR = 0px     ← 居中失效
改后：              left = 156   mL = 143.5px  mR = 143.5px        ← 左右对称
```

改法：卡片里**只写 `margin-top: auto` + `margin-bottom: auto`，绝不用 `margin` 简写**。

#### 附带修的：轴不统一

正文卡片限宽居中后左基准在 x≈175，而标签栏和底栏还贴着面板两边（x≈35）——
一个面板里两条左对齐线，看着像三块东西拼的。把 `.vs-tabs / .vs-banner / .vs-head / .vs-foot`
一起纳入同一条 `max-width`，全部对齐到 x≈175。

**窄侧栏不受影响**：340px 里 `--vs-readw: 560px` 比可用宽度大，这几条规则等于不存在。
实测 `宿主宽 338 → card w=314 left=12`，三个按钮同行、`overflowX 溢出 = false`。

#### 这一起教我的事

1. **"没有样式规则"和"样式写错了"是两种 bug，症状一样。** 前者连 DevTools 里都不显眼
   （元素在，样式面板是空的）。先把元素 `offsetWidth` / `getComputedStyle` 打出来，再谈改法。
2. **验证用的页面必须和真实环境一样有样式。** 我第一版验证页忘了引 CSS（`demo/app.js` 是纯逻辑摊平产物，
   **不含**注入的 CSS，那份只在 `lib/client.js` 里），量出 `display=block`、填充率 32%，
   差点当成 CSS bug 去改。**假的复现环境会把真 bug 藏起来，也会造出假 bug。**
3. **`margin` / `padding` / `background` 这些简写是"静默覆盖"的常客。**
   只要是和 `margin-left/right: auto` 配合的居中，一律别用简写。
4. **视觉问题要用视觉证据闭环。** 这一起我是「改 → 截图 → 读数字 → 再改」迭代的，
   每一轮都拿到真实像素值（`card w=560 left=12 maxW=560px mL=0px`）才敢说"修好了"。
   中间我还差点被"OCR 把「连击」读成「连词」"带偏去改一个不存在的错别字 —— **OCR 的字要当证据看，不是当结论看。**
5. **新加的测试必须先证明它能变红。** 我给这两条各注入一次人为破坏：
   测试 B 立刻变红 ✅；**测试 A 没红** —— 因为我往 CSS 块里插的 `display: block` 是插在
   `display: flex` **前面**，而我的断言只问"块里有没有 flex"。
   改成数"块里所有 `display` 声明，必须恰好一条且是 flex"之后才真的能抓。
   **一个抓不住 bug 的测试比没有测试更坏，它给人错觉。**

---

### 事故六：单词右边的**播放键是死的** ⚠️ 一次"两条退路都是空的"

用户原话：**"首先是你单词右边的播放键是无效的"**

点卡片上的单词（带 🔊）**毫无反应** —— 不发音、不报错、不提示。连让人查的线索都没有。

#### 真凶：处理函数里两条路，**两条都是空的**

`ui/panel.mjs` 里原本写的是：

```js
globalThis.__VS_SPEAK__?.(card.word.word);      // 路一
if (ctx.onSpeak) ctx.onSpeak(card.word.word);   // 路二
```

- **路一**：`__VS_SPEAK__` 全仓库**只有读、没有写** —— 配上 `?.` 于是永远静默。
- **路二**：`ctx.onSpeak` 是 `createPanel(app, ctx)` 的入参，**只有 demo 传过**；
  而插件真正走的 `adapter/dsh/puppet.mjs` `createPanelPuppet` 转发 host 那六项
  （theme / getDocked / isWide / toast / onEscape / onToggleDock）时**漏了 `onSpeak`**。

`core/speech.mjs` 本身没问题（用的 `window.speechSynthesis`，Electron 就是 Chromium）。
`puppet.mjs` 甚至早就导入了 `speak` 并且在用，还有个 `speech()` 能力探测函数
（注释写着"决定卡上要不要画喇叭"）—— **定义了，从来没被调用过**。

#### 修法

`panel.mjs` 删掉死钩子、取 `ctx.onSpeak(word)` 的返回值，发不出声时用 `ctx.toast`
说一句实话（**别让键看起来像坏的**）；`puppet.mjs` 转发 `onSpeak`，默认值就是本文件
已导入的 `speak(word)`。界面层不再依赖"谁记得传"，适配层自己就有兜底。

#### 这一起教我的事

1. **`?.(...)` 是"静默失败"的放大器。** 一个没人赋值的全局钩子，加了可选链之后
   连报错都省了。**要判断一个钩子是不是死的，就搜它有没有"写"的一方**，别只看读的地方。
2. **真浏览器拦 `speechSynthesis.speak` 计数**才是有力的证据：
   修前 `0 → 0`，修后 `0 → 1`（`speak("considerate") lang=en-US rate=0.9`）。
   断言要用**真的 `speechSynthesis`**，不能用 demo 自己的钩子 —— 坏的就是那一层，
   用它等于绕开被怀疑的代码。
3. **测试台的桩会把真 bug 藏起来。** 这一起我卡了很久，因为 `test/mount.test.mjs`
   的假 DOM 有三个桩在骗人：`addEventListener() {}` 是空的（`el()` 挂的 onclick
   全被静默丢掉）、`querySelector()` 恒返回 `null`（面板找 `#vs-badges` / `#vs-ipa`
   等十几处全落空）、`makeFakeApp()` 的 `state.card` 是 `null` 且 `raw` 没有 `mem`。
   **这和事故二那次黑屏是同一类错误：桩让测试在错误的前提下运行。**
   区别只是上次把坏的报成好的，这次把一个真的坏键报成"测不了"。
4. **"调用了 API" ≠ "用户听到了"。** 我能证明 `speak()` 被调到，证明不了有声音 ——
   那取决于系统装没装英文语音包。所以专门加了"发不出声时给一句提示"，
   让"代码没走到"和"环境没语音"这两种情况**能区分开**。

---

### 事故七：换词库**显示成功但主页没反应** ⚠️ 一次"只改了个字段"

用户原话：**"我背了一轮之后，我点击换词库，我明明显示了更换成功但是主页并没有反应，
还是显示今天没有需要复习的词"**

#### 真凶 A：换库压根没换词

`ui/pages.mjs` 的下拉框只调了：

```js
app.updateSettings({ collections: [v] })
```

而 `updateSettings` **只在 `dailyGoal` / `balance` 变化时**才 `buildContainer()`。
于是换库只改了一个设置字段：`state.words` 还是老词库的词、`state.container`
还是老的（已经背完、空着）→ 主页永远停在那个空状态。

更根本的是：**`L.loadCollection()` 全仓库原本只在 `init()` 里调用一次** ——
"换库"从来没有真正加载过另一个词库。

#### 真凶 B：新词闸门把新词库的词全挡了

修好 A 之后仍然没词。因为 `todayStats()` 是**跨所有词库**统计的：
你在四级全答"忘了"走完一轮 → `newAnswerCount=5, newWrongRate=1.0`
→ `shouldBlockNew` 为真 → 换到六级后闸门仍然认为"今天新词额度用完了"，
六级的新词一个都不推；而六级的复习池又是空的（那些词还没学过）→ **队列 0 张**。

口径修成**按当前词库**统计（记录里加 `collection` 字段），
闸门问的就变成"**这本**今天推了几个新词、错得多不多" —— 换库自然重新开始，
和用户"换本书重新学"的直觉一致。

#### 真凶 C：不存在的词库被静默接受

`loadCollection('no-such-collection')` **不报错** —— 它返回四级种子词，
只是把 id 前缀换掉（`seedFor` 的行为）。于是"换库成功"是假的：界面说成功、
设置里写了新 id，实际背的还是四级那批词换个名字。加了词库 id 白名单校验。

#### 这一起教我的事

1. **"设置保存成功了"不是"功能生效了"。** `updateSettings` 语法完全正确、
   下拉框也真的变了 —— 所以**只查下拉框的测试会全绿，而用户看到的没变**。
   断言必须落到**用户能看到的东西**上：主页有没有词卡。
2. **统计数据要问清"口径覆盖谁"。** 这一起的 B 和之前的闸门死规则是同一种病：
   数字算得没错，但算的范围不对。
3. **不认识的输入要明确拒绝。** C 那种"默许"最坏 —— 它把错误伪装成成功。
   同类问题在这一轮里出现了三次（死钩子、跨库统计、未知词库），
   **共同病根都是"静默地接受了一个不该接受的输入"**。
4. **测试断言也要"精确对准症状"。** 我第一版的换库断言里有一条
   "主页不能再显示空状态"，退回 bug 自检时它红是红了，但红的文案是
   「这一轮走完了 今天已背 46 词」——**那是另一个界面**。改成直接否定
   用户报的那句话之后，才真的锁住用户看到的东西。
5. **异步的结果别只写 DOM。** 换库成功会 `emit()` 触发整页重绘，
   我第一版把提示写进 DOM，**刚写完就被重绘冲掉**。结果存进
   `state.lastLibraryChange`，让重绘自己渲染出来才不丢。


---

### 事故八：点「再来 5 个新词」多出一大批、而且**出现重复的词** ⚠️ 一次"过滤在错误的前提上"

用户原话：**"我背完一轮之后，我点击再来五个，结果下面显示30个"**
以及追加的：**"我点击再来五个之后，出现的单词是重复的"**

#### 真凶：拿"重建"当"追加"，而去重的前提已经不成立了

`core/app.mjs` 的 `extendRound()` 原来是这么写的：

```js
const targetN = base + step * next;          // 20 → 25 → 30
const built = Q.buildDailyContainer(..., { N: targetN, ... });
const already = new Set(state.roundItems.map((it) => it.word.id));
const fresh = built.items.filter((it) => !already.has(it.word.id));   // ← 以为能去重
```

思路是"用更大的 N 重建一遍，把已经在队列里的滤掉，剩下的就是新增的"。
**这在走完一轮之后就不成立了。**

因为走完一轮后 `state.mem` 已经变了：那 20 个词被答过，`encodeCount > 0`，
它们从 `newPool`（新词池）**迁进了 `duePool`（到期复习池）**。于是用 N=25
重建时，返回的 25 个词里**大部分不是**原来那 20 个 —— `already` 这个过滤器
筛掉的东西和它以为自己在筛的东西根本对不上，去重几乎全部失灵。

实测（`_dbg` 探针，直接从 `core/app.mjs` 里读真实值）：

```
走完一轮后            容器条目=20   session 队列 60 张，其中 40 张是同一个词的重复
点一次「再来 5 个」后   容器条目=45   新增 25 个 ← 应该只加 5 个
```

那个 45 也解释了用户看到的数字：底部的 `今日 x/y` 和环的分母都来自
`container.stats.containerSize`，被写成累计目标 `targetN`，而条目却是按
"实际塞进去多少"长的，两个数从此对不上。

#### 修法：把排除做在**池子的源头**，并且只建设 batch 个

`buildDailyContainer` 新增 `opts.exclude`（已排过的 wordId 集合），
在**三个池子的入口**都 `skip()` 掉：`duePool` / `personalPool` / `newPool`，
连第 ⑤ 步的 5% 安全垫（它是从**学过**的词里挑的，最容易把刚迁走的词拉回来）
也要过一遍。然后 `extendRound` 改成：

```js
const built = Q.buildDailyContainer(..., { N: step, exclude });   // 只建设 5 个
// 再叠一层严格上限，凑不满就凑不满
```

从源头排除，学过的词就不可能再从复习池绕回来。

#### 我在这件事上犯的错，比 bug 本身更值得记

1. **改 bug 顺手改了产品语义。** 我一度写 `allowMoreNew: true`（理由听起来很顺：
   "用户亲手按了这个按钮，就是他想要更多新词"）。结果 `round-control` 第 ⑦ 节
   立刻变红 —— 那条锁的是"**闸门关着时 `extendRound` 不该硬塞新词**"，
   而界面在闸门关着时**根本不显示**这个按钮。硬写 `true` 等于让这个函数
   绕过安全阀，那是产品决策，不该由修 bug 顺手改掉。已改回
   `!!state.settings.allowMoreNew`。
2. **断言挂错了阶段，报出假 FAIL。** 我把"只加 5 个"的断言挂在了 `extend1`
   阶段，而那一刻闸门是**关着的**、按钮**不在界面上**，`click(null)` 什么都
   没点，于是"新增 0 个"变红。**是测试错了，不是产品错了** —— 证据是那条
   记录里的 `found: false`。真正该测的路径在用户放行之后，而且要**先走完
   放行后那一轮**才会看到「这一轮走完了」的界面（放行会立刻给卡，这是上一个
   修复的成果）。我在验证脚本里把 `buttonsNow` 也打了出来：找不到按钮时，
   最需要知道的就是"此刻界面上到底有什么按钮"。
3. **只在一处登记新符号。** 新增 `collectionLabel` 时，我登记了
   `build.py` 的 `SYMBOL_HOME`，**漏了同一文件里的 `CORE_EXPORTS`**，
   于是 `VOCAB_CORE.UI_PAGES.collectionLabel` 是 `undefined`，
   `demo-boot` 报 `collectionLabel is not a function`。两个注册表缺一不可。
4. **新断言必须证明它会红。** 先把 `extendRound` 逐字换回 5bccd73 的老实现，
   确认 2 条新断言立刻变红（第一次"退回"没退干净 —— `seen` 那层过滤还在
   起作用，所以全绿；重做时把整段函数体换掉才真红）。绿了不等于守住了。


---

### 事故九：设置**根本存不住**，每次重开都退回 20 ⚠️ 最隐蔽的一次（三个 bug 叠在一起）

用户原话：**"我需要的是我设置了多少就多少，你要记忆保存啊，我每次进来就是20，
可是我自己设置了10个啊，我需要我每次设置留痕呀，不能这样啊"**

#### 真凶（主因）：`storage.get()` 忘了拆自己套的包装层

`store/client-store.mjs` 里，写入和读取**不对称**：

```js
set(key, value) {
  ls.setItem(k(key), JSON.stringify({ v: SCHEMA, value }));   // 套了一层包装
}
get(key) {
  return JSON.parse(ls.getItem(k(key)));                       // ← 整个包装层原样返回
}
```

`append()` 和 `list()` 都老老实实取了 `.value`，**只有 `get()` 没有**。
于是 `app.init()` 里这一行：

```js
const saved = (await storage.get('state')) || {};
state.settings = normalizeSettings(saved.settings);   // saved.settings 永远是 undefined
```

`saved` 拿到的是 `{ v: 1, value: {...} }`，`saved.settings` 是 `undefined`，
每次启动都退回默认 20。**数据其实一直好好躺在 localStorage 里** ——
键名、写锁、配额、降级都没问题，坏的只有这一处对称性。

实测（真实存储件 + 假 localStorage）：

```
localStorage 原始内容: {"v":1,"value":{"settings":{"dailyGoal":10}}}
storage.get('state') 返回: {"v":1,"value":{"settings":{"dailyGoal":10}}}
  实得的 back.settings = undefined      ← 要的 10 在 back.value.settings 里
```

#### 为什么之前所有验证都是绿的（这一点比 bug 本身更值得记）

1. **单测用的是我自己写的内存存储**，它顺理成章地"写什么读什么"，
   把这个真凶**完全屏蔽**了。我加了 ⑨ 节一堆"重启后设置还在"的断言，
   它们全绿 —— 因为那条路径根本不经过真实存储。
2. **demo 用的是它自己的存储端口**（`ui/shell.mjs` 的 `demoStorage`，
   `mem[k]` 直接存取、没有包装层），所以浏览器验证再怎么点也照不出来。
3. 于是"我测过了"在这件事上**毫无价值**：被测的不是用户跑的那条路。

修完之后，我专门加了第 ⑩ 节，**用真实的 `store/client-store.mjs`** 来锁这条，
并且先写最底层的对称性断言（`set` 之后 `get` 必须拿回原值），再写端到端。
退回老 `get()` 时这四条立刻变红，报的正是用户那句话：`dailyGoal=20 roundSize=20`。

#### 顺带揪出的第二个 bug：恢复成功时容器是 `null`

把主因修好之后（设置终于读得回来了），另一个 bug 才显形。
`core/app.mjs` 的 `init()` 原来是：

```js
if (!state.session) buildContainer();      // 只有"没有 session"时才建容器
```

而崩溃恢复分支在成功时**会把 `state.session` 填上**，于是这行不执行，
`state.container` 留在 `null`。可是界面上一大堆东西是从容器算的：
底部「今日 x/y」的分母、环的分母、`st.empty`（`!container || items.length === 0`）。
实测：重启后 `container=null`、`roundSize=0`、`empty=false` 却拿不到规模。

修法：恢复成功时用 `rebuildContainerFromSession()` **从恢复出来的 session
反推容器**，绝不重新选词、不新建 session —— 否则会把用户恢复出来的队列位置
冲掉（规格 §7.2 要求"从第 N 个词继续"）。并且顺手把 `snapshotState()` 里
`state.container.items.length` 改成形状检查（`Array.isArray`）：那是**每次渲染
都会走**的一行，形状一旦不完整就抛 TypeError、整个界面白屏。
（这个我踩到了：去掉兜底后测试直接崩在那一行，后面断言一条都跑不到。
崩溃不等于断言。）

#### 结论

设置留痕这件事上，"我设置了多少就多少"**之前一次都没成立过** ——
上面两个 bug 单独任何一个都足以让它失效。第三个是测试的问题：
**测试用的替身（内存存储 / demo 存储）和被验证的真实路径不是同一条，
这种绿是假的。** 现在 ⑩ 节直接测真实存储件。


---

### 主页自报当前词库

用户原话：**"我主页，就是今日这里并没有显示我用的是哪个词库，
这样我就不知道我到底用的是哪个哎"**

头部那行灰字原来只说"离线模式 / 另一个窗口正在学"，**从不说是哪本词库**。
换库修好之后尤其需要：界面不说是哪本，用户就无从判断刚才那次换库到底成没成。

现在词库名放在这行**第一个**（窄侧栏被截断时，留下来的也是它）：

```
词库 · 四级 · 离线模式 · 用内置词表
```

实现：`ui/pages.mjs` 新增 `collectionLabel(state)`（`cet6` → `六级`，
名字取不到就退回 id 本身，宁可能看到 `cet6` 也不要空着），`ui/panel.mjs`
把它拼进 banner。真浏览器断言：`{"banner": "词库 · 四级 · 离线模式 · 用内置词表"}`。


---

## 目录速查

```
VOCAB-STUDY-SPEC.md     规格（在上一层目录）
package.json            dsh.bundle.patch / dsh.client.platform 在这里
cordis.patch.yml        host 一行条目（不注册服务）
core/  store/  ui/  adapter/dsh/    源码
lib/                    构建产物（client.js / index.js）
demo/                   自包含演示与截图页
test/                   七个测试（core / plugin / demo-boot / client-activation / bundle-audit / mount / round-control）
tools/build.py          demo 构建
tools/build-plugin.py   插件构建
tools/install.py        正式安装（幂等，可 --dry-run）
tools/uninstall.py      卸载（诚实报告失败）
```

> `python tools/verify-clicks.py` 需要本机 Chrome，且**跑之前先清掉残留 chrome 进程** ——
> 残留实例会让 `--dump-dom` 卡死（我撞过一次，白等十分钟）。
