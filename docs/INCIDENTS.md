# 排查笔记（事故记录）

> `dsh-vocab-study` 开发过程中**真实踩过的坑**，按「症状 → 根因 → 修法 → 怎么验的」记录。
> 单独成篇是为了让 README 保持成一份产品文档；**内容一行都没删**。
>
> 其中对**其他 DSH 插件作者**也有用的部分，README 里留了摘要 ——
> 尤其是「客户端模块清单是启动时扫的，装完必须完全退出 DSH」这一条。

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

这个坑的完整记述在 README 的 [「第二个坑：插件管理器写的 `disabled: true` 清不掉」](../README.md#第二个坑插件管理器写的-disabled-true-清不掉) 一节，
那里有原样贴出的 `cordis.patch.yml` 片段和 `tools/install.py` 每次纠正它的做法。

不复述的原因：它属于**安装/维护**问题而不是运行时 bug，写在 README 的安装章节里
读者才找得到；这里只留指针，免得同一件事有两个版本、日后改一处忘另一处。
（原来这里只有一个空标题 —— 是个悬空指针。）

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


### 事故十：「再来 5 个新词」变成**从头重背一遍刚背的** ⚠️ 一次"测了错的变量"

用户原话：

> 我说再来五个新词，他会给我再原来的基础上加五个，然后从头过一遍我刚背的

**现象**：走完一轮（20 个词）后点「再来 5 个新词」，容器确实变成 25 个词、
数字也对，但**下一个开口问的还是刚才那 20 个里的第一个** —— 等于把刚背完的
一整轮重考一遍，5 个新词排在最后。

**根因**：`core/app.mjs` 的 `extendRound()` 在"上一轮已经走完"这条分支里写的是

```js
state.session = S.createSession({ items: merged, ... });
```

`merged` 是**这一轮排过的全部词**（旧 20 + 新 5 = 25）。把它当新会话的队列，
`cursor` 就从 0 开始 → 从头重问。而"这一轮有哪些词"这个事实需要 `merged`，
"接下来该问什么"需要的是**游标位置**，我把两个概念合并成了一个数组。

**修法**：队列仍然放整轮 25 个词（这样容器、环、底部说的是同一轮），但

- 把已经答过的卡标记为 `answered = true`（用上一场 session 的作答记录）；
- `cursor` 推到第一个还没作答的卡 → 开口问的就是那 5 个新词；
- `next.stats.answered` 取上一场的**已覆盖词数**作为底，进度条不归零。

实测（`_dbgre4` 那次探针）：

```
走完一轮    环=20/20  底部=20/20  当前词=(空)
点加量      环=20/25  底部=20/25  当前词=include   ← 接下来要问 5 张，回锅 0 张
背完新词    环=25/25  底部=25/25
再点一次    环=25/30  底部=25/30
```

**顺手揪出的第二个 bug：进度条分子分母不是一个单位**

环显示过 **`60/20`**。分子取的是 `session.stats.answered` —— 那个数的是**卡**，
而答"忘了/模糊"会在同一轮里再插重训卡（§5.5，一个词最多再出现 2 次），
20 个词走完就变成 60；分母 `plannedSize` 数的是**词**。一个数卡、一个数词，
除出来必然是谎话。

修法：`core/session.mjs` 新增 `coveredCount(session)`（覆盖了多少个**不同**的词），
`snapshotState()` 把它放进 `st.covered`，界面用它当分子。
`stats.answered` 的原义留给签到判定，不动。

**我这次最该记住的：为什么旧测试全绿还是让它上线了**

第 ③ 节当时断言的是：容器变大、容器内不重复、队列只增不重排。
**全是容器自己的属性，没有一条断言"接下来会问什么"。** 而用户看的恰恰是
下一张卡是谁。我测了一个跟现象无关的变量，然后拿绿色当"没问题"。

新加的 ③.5 节故意的写法是：

```js
const upcoming = s.queue.slice(s.cursor).filter((c) => !c.answered).map((c) => c.word.id);
const again = upcoming.filter((id) => learned.has(id));
ok('加量后开口问的词里，没有一个是刚背过的', again.length === 0, ...);
```

断言**游标之后、还没答过的词** —— 这才是"下一张卡"。把修复回退后，它报的是：

```
✗ 加量后开口问的词里，没有一个是刚背过的  (要问 25 张，其中 20 张是旧的：cet4:accent, cet4:deny, ...)
✗ 加量后确实只剩新词要问（不多不少 5 张）  (实得 25 张)
✗ 游标被推到第一个没背过的卡（而不是 0）  (cursor=0)
✗ 加量后进度不倒退（环不回到 0）          (20 → 0)
✗ 第二次加量同样不重考                    (要问 30 张)
✗ 第二次加量也是 5 张新词                  (实得 30 张)
→ 94 通过 / 6 失败
```

六条红，报的正是用户那句话。**先能红，才配叫回归锁。**

**同一次改动撞出来的坑（两个构建工具各有一份清单）**

`coveredCount` 是新的跨模块符号，我加进了 `tools/build-plugin.py` 的
`CORE_EXPORTS`，但漏了 `tools/build.py` 里那份 —— 于是
**demo 产物**里 `S.coveredCount` 是 undefined，`demo-boot` 报
`TypeError: S.coveredCount is not a function`（11 通过 / 3 失败）。

这里有两个值得记的点：

1. 插件构建有个"悬空前缀"守卫，直接拦下了 `S.coveredCount`，提示很准确。
   **它替我挡了一次"重启后界面整个不出现"**。别嫌它烦。
2. `demo-boot` 是**另一条独立的守卫**。它抓的正是"命名空间清单漏项"，
   `tools/build.py` 第 95-105 行的注释早就写了这件事（漏列 `shouldBlockNew`
   就是这么被抓到的）。**两处清单必须一起改**，改一处等于留一颗雷。

顺带一个我自己的操作失误：调试时我用 `Copy-Item demo/app.js demo/app.js.bak`
想备份产物，但那份 `.bak` 是我改代码**之前**的旧产物，事后 `Move-Item` 恢复
等于把过期产物搬了回去，于是症状"消失又出现"、把我绕了好几圈。
**产物不能当源码备份** —— 要备份就 `git stash` 或复制**源文件**。


### 事故十一：多个对话之间**不共享**，其中一个的改动还会被静默吞掉 ⚠️ 一次"按会话分实例"

用户原话：

> 还有个问题是，多个对话框之间居然不是共享的

（补充确认：同一个 DSH 桌面客户端里的多个对话，工作区可能相同也可能不同。
期望是"所有对话共用一份"。）

**根因**：`adapter/dsh/client.js` 里写的是

```js
const cores = new Map();
function coreFor(sessionId) { ... }
```

**按 sessionId 一个内核**（每个对话一个 app 实例）。原意是"避免多会话互相串
数据"，但实测（两个会话共用同一个 localStorage）坏在三处：

| 现象 | 实测 |
|---|---|
| ① 进度不同步 | A 背了 10 个词，B 内存里还是 **0** |
| ② 写入被吞 | B 把 dailyGoal 改成 30，磁盘上还是 **20** |
| ③ 数据对不上 | 两个内核各持一份完整状态，最后写入的覆盖另一份 |

② 之所以发生，是因为 `client-store.mjs` 有一把"只许一个写入者"的锁
（`claimLock()`：锁新鲜且不是自己 → `readOnly = true`）。
**每个对话一个内核 = 每个对话一个实例 id** → 第二个对话一建内核就被判只读，
之后的 `persist()` 全部只写内存、不落盘。那把锁本来是为了"多窗口别打架"，
结果被自己人撞上了。

**修法**：**一个窗口 = 一个内核**。背单词的进度属于"这个人"，不属于某个对话，
所以窗口里只该有一个 app 实例，所有对话的所有席位共用它。

```js
let corePromise = null;
function coreFor() { ... }        // 本窗口唯一，忽略 sessionId
function useCore() { ... }        // 座席用它；异步就绪，先渲染空壳
```

用 **Promise 单例**而不是直接返回实例：座席是 React 同步渲染的，而 `app.init()`
要异步读 localStorage。存 Promise，谁先到谁等它 resolve；`init()` 结尾自己会
`emit()`，所以先渲染的空壳会被这次 emit 填上真数据。

配套的三处改动：

- `usePuppet(create, deps, core)` 多收一个 `core`，`if (core)` 才建木偶 ——
  否则第一帧 `core` 还是 null，而木偶第一行就是 `core.app`，
  直接 `Cannot read properties of null` 把座席 render 打挂。
- `coreFor` 里 init 失败时**清掉缓存并 rethrow**（下次调用重试），
  再挂 `.catch(() => {})` 消费掉，免得变成 unhandled rejection。
- 卸载时只放**这一个**内核的锁（原来是遍历 `cores.values()`）。

**验证方式：断言"接线"，不是"核心逻辑"**

核心逻辑早有测试（`round-control` 100 条），但这个 bug **完全不在核心逻辑里** ——
它在"谁拿到哪个实例"这一层。所以新建 `test/multi-conversation.test.mjs`：
物化真产物 → 拿真注册的胶囊组件 → 用一套假 React 挂两次（`conv-a` / `conv-b`）
→ 断言两次拿到的是**同一个 app**，再从一个对话改设置、看另一个是否立刻变。

回退成"每个对话一个内核"后它报的是：

```
✗ 对话 B 拿到了内核  (null)
✗ 两个对话是**同一个内核实例**（这才是"共享"）  (两个不同实例 ← 就是用户报的问题)
✗ 两个对话指向同一个 app（进度/设置天然共享）
```

**这次自己踩的三个脚手架坑（都不是产品问题，但都曾让我误判）**

1. 假 React 的 `useState` setter 捕获了全局 `hookCursor`，异步 resolve 时游标
   早跑到别的组件去了，于是 A 把值写进了空槽 → 看起来像"对话 A 没拿到内核"。
   改成把 **hook 槽本身**抓住。
2. 断言 `app.state.words` —— 但 `app.state` 是**给界面看的精简快照**，
   `init()` 里被重新赋过值，里面没有 `words`/`mem`/`records`，内部状态在
   `app.raw`。差点当成"内核是个空壳"。
3. 用 grep 查源码字面量（`const cores = new Map()`、`coreFor(sessionId)`）
   **两版都假红** —— 事故记录和反面教材就写在注释里，按字面量查必然命中。
   最后把这两条删了：行为断言（同一实例）才是判据，grep 只留"只存在一处建
   内核入口"这种不会误报的结构事实。

**还有个操作失误值得单独记**：我写了个"忠实回退"脚本，用 `indexOf` 定边界做
字符串切片，结果 `end` 没匹配上（注释里是**全角**括号「（异步）」，我按半角写），
`slice(start, -1)` 一路切到文件末尾，把 `usePuppet` 到文件结尾**全删了** ——
一个"我以为在回退"的操作把源文件截断了。
**教训：改源文件的脚本必须先验证边界命中了没有；宁可就地单点替换，不要切片。**


---

### 事故十二：生词本页**永远是空的**，收藏多少词都看不见 ⚠️ 一次"少给一个字段，整块 UI 静默消失"

**症状**

「生词本」页永远显示「生词本还是空的」。在对话里选中单词点「加入生词本」
能加成功（数据真的进了存储），但回到生词本页还是空的 —— 列表、删除按钮、
「收藏 N 个」全都用不了。

**根因**

视图读的是**快照**，不是内部状态：

```
panel.mjs:   const st = app.state;                      ← 快照
             renderVocab(body, st, app);
pages.mjs:   st.personal && st.personal.length          ← 读快照里的 personal
app.mjs:     get state() { return snapshotState(); }    ← 而它没给 personal
             raw: state,                                ← 内部状态在 raw，有 personal
```

`snapshotState()` 漏了 4 个字段，`personal` 只是最显眼的一个：

| 缺的字段 | 后果 |
|---|---|
| `personal` | 生词本页**永远空状态**；「收藏 N 个」不参与天平计算 |
| `words` | 设置页读不到当前词表 |
| `report` | **周报卡片永远不渲染**（`maybeWeeklyReport()` 里有 `state.report = rep` 赋值） |
| `lastRevealResult` | 相关分支永远走不到（`state.lastRevealResult = res` 也确实在写） |

全部同一个原因：**值在内部 state 上存在（后两个甚至真的有赋值），只是没进快照。**

**为什么拖了这么久没人发现**

1. `undefined` 在 `if (st.personal && st.personal.length)` 里和平常一样安静 ——
   不抛错、不告警、不写日志，页面照样渲染，只是渲染成空状态。
2. **测试只验了页签的名字**，没验页面内容：
   ```js
   const tabTexts = ['今日', '进度', '生词本', '设置'];
   check(found.length >= tabTexts.length, `面板有 4 个页签`);
   // 再加一条"切过去不抛错"
   ```
   "渲染成空状态"和"渲染正常"在这种断言下**长得一模一样**，都是满分。
3. 我自己那次也差点被自己骗过去：第一版回归断言按行做正则找键，而我**在注释里
   写了那些键的名字**（`* · personal → renderVocab 读 ...`），于是那些字面量被
   当成了真的键 —— 把真字段删掉，断言照样绿。**假闸门比没有闸门更糟**，
   因为它给你一种"已经守住了"的错觉。

**修法**

1. `snapshotState()` 补上 4 个字段（`app.mjs`）。
2. `core.test.mjs` 加一条**结构对照**断言：静态解析 `snapshotState()` 返回对象的
   键（**先剥注释**，再按顶层逗号结构化切分，不再按行正则），和 `ui/` 里所有
   `st.X` 读取点做差集，必须为空。
3. `demo-boot.test.mjs` 加一节**内容级**断言：先 `addPersonal` 塞两个真词，
   再看生词本页面上有没有那两个字、有没有行、空状态文案有没有消失、
   点「删」是不是真的删掉了。
4. 顺便把 `pages.mjs` 三个渲染函数的形参从 `state` 改名成 `st`。
   它收到的本来就是快照，叫 `state` 会让人以为读的是内部状态 ——
   **名字撒谎会直接导致这种 bug 被写出来。**
   （改名过程自己踩了一坑：批量替换只覆盖顶层语句块、漏了嵌套回调，
   设置页整个白屏报 `ReferenceError: state is not defined`。
   而 8 套测试当时**全绿**，最后是**出图脚本的内容闸门**抓出来的。）

**反向验证（这一步不能省）**

把 `personal:` 改名成 `personalX:` 再重建，两条断言都必须变红：

```
core      ✗ 快照给全了视图要读的字段      ↑ 快照缺字段: personal
demo-boot ✗ 快照里有 personal 且有条目（实际 undefined 条）
          ✗ 生词本页列出了 2 个词（实际 0 行）
          ✗ 生词本页面上能看到「abandon」
          ✗ 不再显示「生词本还是空的」(生词本还是空的)
```

**教训**

- **`undefined` 是这套架构里最贵的错误值**：它不抛错，只是让整块 UI 安静地消失。
  凡是"视图读快照字段"，就该有一条断言把"快照给全了"钉死。
- **只在注释里写键名，会让按文本查键的检查变成假闸门。** 解析源码文本的第一步
  永远是**先剥注释**（和 CSS 那条断言是同一个教训 —— 同一个坑犯了两次）。
- **断言"没抛错"约等于没断言。** 要断言**看得见的结果**：页面上有没有那两个字。
- 事故十一的脚手架坑第 2 条其实已经写明了这个机制（`app.state` 是精简快照、
  内部状态在 `app.raw`），当时只是绕过去了，没有顺着问一句"那界面要读的字段
  到底给全了没有"。**记录机制不等于检查机制。**


---
