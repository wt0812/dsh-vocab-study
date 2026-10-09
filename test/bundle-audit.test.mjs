// 产物审计：把 lib/client.js 当成"要交给宿主内核的东西"来检查。
//
// 这个文件是一次真实事故的产物：插件的 apply 里有一处 undefined 属性访问
// （ctx.sidebarRightTabs 没在 inject 里声明），同步抛错把整个客户端拦在启动页。
// 修复之后把当时的排查手段固化成这些断言 —— 它们守的是"插件能不能被宿主激活"，
// 而不是"插件功能对不对"（功能由 core/plugin/demo-boot 三套守着）。
//
// 每一条都对应一个具体的、会做出"整个客户端用不了"的失效模式。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const t = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
let bad = 0;
const ok = (c, l) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + l);
  if (!c) bad++;
};

// ── 抽出 apply 函数体（用花括号配平，别靠猜结尾）──
function bodyOf(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}
// 去掉注释，避免注释里的关键词被当成代码
const applyBody = bodyOf(t, 'function apply(ctx)').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
// 注意签名是 (abilities, sessionId) —— 第一个参数**不是** ctx。
// 组件的 props 里没有 ctx，所以这里收的是 apply 组装好的能力对象（见「事故四」）。
const ovBody = bodyOf(t, 'function openVocabTab(abilities, sessionId)').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const noComment = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

console.log('\n=== 1) 注册结构 ===');
const loads = [...noComment.matchAll(/__ModuleLoader__\.load\(/g)];
ok(loads.length === 1, `只有 1 处真实 __ModuleLoader__.load 调用（实际 ${loads.length}）`);

console.log('\n=== 2) 模块请求 ===');
const reqs = [...new Set([...noComment.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))];
console.log('    请求的模块:', JSON.stringify(reqs));
ok(reqs.every((r) => r === 'react'), '只 require react（其余全部摊平，无仓库外依赖）');
ok(!noComment.includes('require.async'), '没有用 require.async');

console.log('\n=== 3) inject 服务声明 ===');
// 两个坑：
//   1. 产物里是 `export const inject = [...]`，正则必须容忍前面的 `export`；
//   2. **必须在去注释后的源码里找** —— 源码注释里有一句
//      `const inject = entry.inject;`（摘抄宿主 runInject），
//      在原文里搜会先命中注释，然后 JSON.parse 直接炸掉。
const injectMatch = noComment.match(/(?:export\s+)?const\s+inject\s*=\s*(\[[^\]]*\])/);
ok(!!injectMatch, '能在产物里定位到 inject 声明');
const inject = injectMatch ? JSON.parse(injectMatch[1].replace(/'/g, '"')) : [];
console.log('    inject =', JSON.stringify(inject));
ok(inject.includes('slots'), 'slots（宿主 ui-renderer: new SlotRegistry(ctx) → Service 子类自动注册）');
ok(inject.includes('sidebarRightTabs'), 'sidebarRightTabs（ui-sidebar-right: ctx.reflect.provide）');
ok(inject.includes('sidebarRight'), 'sidebarRight（ui-sidebar-right: ctx.reflect.provide）');

const FRAMEWORK = ['effect', 'inject', 'on', 'get', 'logger', 'reflect', 'plugin', 'provide'];

console.log('\n=== 4) apply 里每个 ctx.<服务> 都已声明 ===');
const members = [...new Set([...applyBody.matchAll(/ctx\.([a-zA-Z_][\w]*)/g)].map((x) => x[1]))];
console.log('    apply 用到的 ctx 成员:', JSON.stringify(members));
for (const mem of members) {
  if (FRAMEWORK.includes(mem)) continue;
  ok(inject.includes(mem), `ctx.${mem} 已声明（少声明 = Cordis 里永久 pending = 启动失败）`);
}

console.log('\n=== 5) 服务上的方法调用：要么服务已声明，要么用可选链 ===');
const risky = [];
// 匹配 ctx.svc.method( 或 ctx.svc?.method( 或 ctx.svc?.method?.
for (const mm of noComment.matchAll(/ctx\.([a-zA-Z_][\w]*)(\??)\.([a-zA-Z_][\w]*)(\??)\(/g)) {
  const [, svc, opt1, method, opt2] = mm;
  if (FRAMEWORK.includes(svc)) continue;
  if (inject.includes(svc)) continue; // 声明过的服务，Cordis 保证存在
  if (opt1 || opt2) continue; // 可选链，安全
  risky.push(`ctx.${svc}.${method}(`);
}
ok(risky.length === 0, `没有"未声明服务上的裸方法调用"${risky.length ? ': ' + risky.join(', ') : ''}`);

console.log('\n=== 6) openVocabTab 的契约（三个坑都在这里）===');
ok(ovBody.length > 0, '能定位到 openVocabTab 的函数体');
// 坑一：任何一条路径都必须能被 try 兜住，不许有能力把插件带崩
ok(/try\s*\{/.test(ovBody) && /catch/.test(ovBody), '有 try/catch 兜底');
ok(/\?\./.test(ovBody), '用可选链接触宿主服务（不假设服务一定在）');
ok(/console\.warn/.test(ovBody), '所有退路都失败时有 console.warn 留痕（不静默）');

// 坑二：候选里必须包含"带 sessionId"的入口。
// 无参 openTab 内部走 require() 守卫，侧栏没打开时必抛 —— 只会表现为"点了没反应"。
ok(/openTabIn\s*\(/.test(ovBody), '候选里有带 sessionId 的 openTabIn');
ok(/sessionId/.test(ovBody), '把 sessionId 传下去');

// 坑三（本轮新增）：失败原因**不许被丢掉**。
// 上一版的 catch 是空的 `catch { /* 换下一种 */ }`，结果日志只说"都不可用"，
// 看不出到底是"方法不存在"还是"方法存在但抛了守卫错误"——于是又白试一轮。
// 所以这里要求：catch 里必须把 err 用起来（取 message 或整个打出来）。
ok(/catch\s*\(\s*[a-zA-Z_$]\w*\s*\)/.test(ovBody), 'catch 捕获了错误对象（不是裸 catch）');
ok(/err\.?m?e?s?s?a?g?e?/.test(ovBody) || /String\(\s*\(?\s*err/.test(ovBody), '把错误原因取出来（message 或 String(err)）');

// 全文件不允许出现裸的（非可选链）sidebarRight 方法调用
const bare = [...noComment.matchAll(/ctx\.sidebarRight\.([a-zA-Z_]\w*)\(/g)].map((m) => m[1]);
ok(bare.length === 0, `没有裸的 ctx.sidebarRight.<方法>() 调用${bare.length ? ': ' + bare.join(', ') : ''}`);

console.log('\n=== 7) sidebarRightTabs.register 包在 try 里（本次事故直接原因）===');
const regIdx = applyBody.indexOf('ctx.sidebarRightTabs.register');
ok(regIdx >= 0, 'apply 里有 sidebarRightTabs.register');
const before = applyBody.slice(0, regIdx);
const lastTry = before.lastIndexOf('try {');
const lastCatch = before.lastIndexOf('catch');
ok(lastTry > lastCatch, 'register 之前有一个尚未闭合的 try（即它被包住了）');

console.log('\n=== 8) 降级路径不能静默到"什么都没发生" ===');
ok(/console\.warn/.test(applyBody), '注册失败时有 console.warn 留痕（不是静默吞掉）');

// ─────────────────────────────────────────────────────────────
// 布局契约：这两条守的是**静默失效**——不会报错、测试也不会红，
// 只是界面上"下面半屏黑 / 内容贴在左边"，肉眼才看得出来。
// 都是真实发生过的（2026-10-09，用户反馈"边框太宽、下面是空的"）。
// ─────────────────────────────────────────────────────────────
console.log('\n=== 9) 宿主容器必须能撑开面板（.vs-pane-host）===');
// 面板用的是 flex:1，父容器不是 flex 的话它就只长到内容高
// → 下半个标签页全空。而"父不是 flex"本身不会报任何错。
const hostRule = t.match(/\.vs-pane-host\s*\{([^}]*)\}/);
ok(hostRule !== null, 'CSS 里有 .vs-pane-host 规则（没有 → 面板只有内容高，下面全空）');
if (hostRule) {
  const decl = hostRule[1];
  const displays = [...decl.matchAll(/display:\s*([a-z-]+)/g)].map((m) => m[1]);
  // ⚠️ 必须数"块内所有 display 声明"，不能只测 /display:\s*flex/ 存在。
  //    我第一版就是那么写的，然后往块里插了一条 `display: block;` 在前面，
  //    测试照样全绿 —— 一个抓不住 bug 的测试比没有测试更坏，它给人错觉。
  ok(displays.length === 1 && displays[0] === 'flex', `.vs-pane-host 恰好一条 display:flex（实际: ${displays.join(', ') || '无'}）`);
  ok(/flex-direction:\s*column/.test(decl), '.vs-pane-host 是纵向 flex');
  ok(/min-height:\s*0/.test(decl), '.vs-pane-host 有 min-height:0（否则子项不肯缩、滚动失效）');
}

console.log('\n=== 10) 限宽居中不能被 margin 简写清零（静默失效）===');
// `.vs-card { margin: auto 0 }` 会把 left/right 写成 0，
// 于是上一条 `margin-left/right: auto` 的居中被**静默覆盖**，
// 卡片还是限宽 560px，但死死贴在左边（实测 offsetLeft=12，右边空一大片）。
const centered = /margin-left:\s*auto/.test(t) && /margin-right:\s*auto/.test(t);
ok(centered, '有限宽居中用的 margin-left/right: auto');
ok(
  !/\.vs-panel\.docked \.vs-card\s*\{[^}]*\bmargin:\s/.test(t),
  '.vs-card 里没有 margin 简写（简写会覆盖左右 auto，居中静默失效）',
);

console.log('\n=== 11) 产物里不能有悬空的命名空间前缀（2026-10-09 黑屏事故）===');
// 这是一次真实事故，而且是**最难查的一类**：界面整个不出现，但 7 个测试套件
// 全绿、构建成功、装好了也激活了。
//
// 事故链条：
//   1. 新功能用到 Q.shouldBlockNew()（core/queue.mjs 的导出）
//   2. build-plugin.py 的 CORE_EXPORTS 清单漏登记这个名字
//   3. 打包器的 rewrite_namespaces() 只替换**清单里有的**成员，
//      于是 `Q.shouldBlockNew(...)` 原样留在产物里
//   4. 单文件产物把 19 个文件摊平进同一作用域，**根本没有 `Q` 这个对象**
//   5. 那句话在 snapshotState() 里 —— 也就是渲染第一帧
//   6. → ReferenceError → 面板建不出来 → 用户点开标签页看到的是一片黑
//
// 为什么测试全绿：core/round-control.test.mjs 直接 `import core/app.mjs`，
// 走的是真 ESM 命名空间，`Q` 当然存在。**只有产物形态会炸。**
// 所以这一条必须针对 lib/client.js 断言，不能靠单元测试。
//
// 判据（这里我写错过一次，记下来免得再犯）：
//
// 第一版我用「成员名在 setCore 注册表里就跳过」来排除误报。但 `shouldBlockNew`
// **本身就是合法成员**（它被正确登记了），于是 `Q.shouldBlockNew` 这个真·悬空
// 引用被我的"跳过"规则放过了 —— 好样本坏样本都判 0，断言永远不会红。
// 一个不会失败的断言比没有断言更坏。
//
// 正确判据看**前缀本身**：摊平后根本没有 `Q` 这个变量（只有裸函数
// shouldBlockNew），所以任何 `Q.xxx` 都是错的 —— 与 xxx 叫什么无关。
// 反过来 `M.foo` 可能是合法的局部对象（某个 `const M = {...}`），
// 所以必须先查"这个前缀在产物里有没有被声明"。
const NS_PREFIXES = ['M', 'MK', 'SEED', 'L', 'SP', 'HK', 'Q', 'G', 'B', 'S', 'A'];
const dangling = new Map();
for (const prefix of NS_PREFIXES) {
  const declared = new RegExp(
    String.raw`(?:^|[\s,;({\[])(?:const|let|var|function|class)\s+${prefix}\b` +
      String.raw`|\b${prefix}\s*[:=]` +
      String.raw`|\(\s*${prefix}\b`,
    'm',
  ).test(noComment);
  if (declared) continue; // 产物里真有这个变量，是合法局部对象
  const re = new RegExp(String.raw`\b${prefix}\.([A-Za-z_$][\w$]*)`, 'g');
  for (const m of noComment.matchAll(re)) {
    const full = `${prefix}.${m[1]}`;
    if (!dangling.has(full)) dangling.set(full, noComment.slice(0, m.index).split('\n').length);
  }
}
ok(
  dangling.size === 0,
  dangling.size === 0
    ? '没有悬空命名空间前缀（摊平后不存在的对象没有被调用）'
    : '发现悬空前缀（摊平后这些对象不存在，一执行就 ReferenceError、界面全黑）：' +
        [...dangling].map(([k, l]) => `${k}@约${l}行`).join(', ') +
        ' —— 修法：加进 tools/build-plugin.py 的 CORE_EXPORTS',
);

console.log(`\n${bad === 0 ? '✅ 全部通过' : `❌ ${bad} 项未通过`}`);
process.exit(bad === 0 ? 0 : 1);

