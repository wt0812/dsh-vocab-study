// vocab-study / ui / core-ref.mjs
//
// UI 层拿 core 命名空间的**唯一**通道。
//
// 背景：单文件产物把所有文件摊平进同一作用域，ESM 绑定全部消失。所以界面
// 代码不能用 `import * as Q` 拿到命名空间，必须有人在运行时把命名空间交给它。
//
// 这件事之前散在几个地方（「谁记得调 injectCore 谁就对」），结果 demo 调了、
// 插件形态没调：今日页不碰命名空间所以看着正常，一切到设置页就
// “Q.buildDailyContainer is not a function”。现在收成一处：
//
//   · ESM 形态：ui/pages.mjs 自己导入命名空间并 setCore(...)
//   · 摊平形态：构建脚本在 UI 代码之前插一段 setCore({...})（作用域里只有名字）
//
// 两种形态、同一个读法，没有第三种可能。

let CORE = {
  memory: {},
  mistake: {},
  game: {},
  queue: {},
  library: {},
  beckon: {},
  speech: {},
  hook: {},
};

/**
 * 填命名空间。同时接受全名与单字母键 —— demo/构建/测试三处的写法不统一
 * 曾经就是那次静默失败的原因，这里一次兼容掉。
 */
export function setCore(input) {
  const c = input || {};
  const pick = (...names) => {
    for (const n of names) if (c[n]) return c[n];
    return null;
  };
  CORE = {
    memory: pick('memory', 'M') || CORE.memory,
    mistake: pick('mistake', 'MK') || CORE.mistake,
    game: pick('game', 'G') || CORE.game,
    queue: pick('queue', 'Q') || CORE.queue,
    library: pick('library', 'L') || CORE.library,
    beckon: pick('beckon', 'B') || CORE.beckon,
    speech: pick('speech', 'SP') || CORE.speech,
    hook: pick('hook', 'HK') || CORE.hook,
  };
  return CORE;
}

/**
 * 读命名空间。每个界面函数调用时读，不缓存成模块级常量（避免早读成空对象）。
 *
 * 键名**只有全名**（memory / mistake / game / queue / library / beckon / speech / hook）。
 * 单字母键（M / Q / …）只在 setCore 的**入参**里被兼容 —— 那是构建产物与
 * ESM 两边的写法差异。读的时候必须写全名：
 *
 *     const { queue: Q } = getCore();   ✅
 *     const { Q } = getCore();          ❌ Q 会是 undefined
 *
 * 后者在设置页炸过一次（previewBalance 里），症状是
 * “Cannot read properties of undefined (reading 'buildDailyContainer')”。
 * tools/build.py 与 tools/build-plugin.py 都会在构建期扫描这种写法并报错。
 */
export function getCore() {
  return CORE;
}
