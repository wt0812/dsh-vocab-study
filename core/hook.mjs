// vocab-study / core / hook.mjs
//
// 「让我记住它」—— 记忆钩子。
//
// ══ 这个模块为什么存在 ══════════════════════════════════════════════════
// 规格 §9 要求：点 `✨ 让我记住它` → 生成一个记忆钩子，**每词一生只付一次**，
// 结果写回本地永久复用；AI 挂了不阻塞，显示「✨ 暂时没编出来 · 重试」。
//
// 但之前的实现里，那个按钮**只有壳**：它假装加载 900ms，然后写死一句
// 「暂时没编出来」——永远不会成功。这违反 P7「数据诚实」。
//
// ══ 现在的做法 ═══════════════════════════════════════════════════════════
// 规格 §9 本身给了两条约束，恰好指向同一个答案：
//   · 「严禁编造词源、编造释义」
//   · 「AI 挂了不阻塞」
// 而内置词库里**本来就有** root（词根拆解）、collocations（搭配）、
// example（例句）、confusables（易混词）这些真实材料。
// 所以这里**先用真实材料组出钩子**——离线可算、绝不编造、零等待。
//
// 将来接上真 AI 时（规格 §9 的 AiPort），只要在 buildHook 之上加一层：
// 有 AI 就用 AI 的，AI 挂了就回落到这里的本地结果。那才是「不阻塞」的正解。
//
// ══ 为什么不是纯 AI ═════════════════════════════════════════════════════
// 这是一个**纯客户端插件**：没有 host 侧 AI 服务，客户端也拿不到模型通道。
// 与其给一个点了必然失败的按钮，不如给一个**真的能用**的钩子。
// 输出的每一句都带着来源标注（词根 / 例句 / 搭配），用户看得出它凭什么这么说
// ——这也是规格 §9 的要求（「提示词本身可编辑，用户能看到它凭什么这么说」）。

/**
 * 钩子种类。用于在界面上标注「这句话凭什么这么说」。
 */
export const HOOK_SOURCE = {
  ROOT: 'root',
  EXAMPLE: 'example',
  COLLOCATION: 'collocation',
  CONTRAST: 'contrast',
  SPELLING: 'spelling',
};

const SOURCE_LABEL = {
  [HOOK_SOURCE.ROOT]: '来自词根',
  [HOOK_SOURCE.EXAMPLE]: '来自例句',
  [HOOK_SOURCE.COLLOCATION]: '来自搭配',
  [HOOK_SOURCE.CONTRAST]: '来自易混词',
  [HOOK_SOURCE.SPELLING]: '来自拼写',
};

/** 钩子的一句话长度上限（规格 §9：不超 40 字）。 */
export const HOOK_MAX_CHARS = 40;

/**
 * 把词根拆解收拾成一句真正的钩子。
 *
 * 词库里的 root 形如：
 *   'a-(去) + band(约束) + -on → 解开束缚，放手不管'
 *   'ac-(加强) + cept(拿) → 拿过来'
 *
 * 箭头右边是词根给出的画面。但**光有画面不算钩子**——
 * 「拿过来」这三个字单独摆着，读者想不起是 accept 还是 receive。
 * 所以画面太短时把单词拼进去，让钩子自带「哪个词」这个信息：
 *   accept → `accept：拿过来`
 */
function fromRoot(word) {
  const root = word.roots;
  if (!root || typeof root !== 'string') return null;
  const arrow = root.indexOf('→');
  let tail = arrow >= 0 ? root.slice(arrow + 1).trim() : root.trim();
  if (!tail) return null;

  // 画面太短（说不出所以然）就把单词带上，让它成为一个完整的钩子
  const w = String(word.word || '').trim();
  if (w && tail.length < 8 && !tail.toLowerCase().includes(w.toLowerCase())) {
    tail = `${w}：${tail}`;
  }
  return tail;
}

/**
 * 用例句造一句场景联想。
 * 规格 §9 允许「没把握时改用场景联想」——例句是真实材料，不涉及编造。
 */
function fromExample(word) {
  const ex = word.example;
  if (!ex || typeof ex !== 'string') return null;
  const zh = word.exampleZh;
  // 有中文就借中文说事，没有就用英文例句本身
  if (zh && typeof zh === 'string') return zh.trim() || null;
  return ex.trim() || null;
}

/**
 * 用搭配造钩子：搭配是最小可用的固定说法，适合"记不住就用它"。
 */
function fromCollocation(word) {
  const col = word.collocations;
  if (!Array.isArray(col) || !col.length) return null;
  const first = String(col[0] || '').trim();
  return first || null;
}

/**
 * 用易混词造钩子：只提「跟谁容易混」，不编造区分理由
 * （编理由就是编造词源，规格明令禁止）。
 */
function fromContrast(word) {
  const conf = word.confusables;
  if (!Array.isArray(conf) || !conf.length) return null;
  const other = String(conf[0] || '').trim();
  if (!other) return null;
  return `别跟 ${other} 弄混`;
}

/**
 * 拼写兜底：词太长、又没有任何可用材料时，用首尾字母给个抓手。
 * 这是纯形式观察，不涉及任何编造。
 */
function fromSpelling(word) {
  const w = String(word.word || '').trim();
  if (w.length < 6) return null;
  return `${w.slice(0, 3)}…${w.slice(-3)}`;
}

/** 兜底：真的什么都没有时，诚实地说明，而不是编一句。 */
function fallbackLine(word) {
  const m = String(word.meaning || '').trim();
  if (m) return `${m}`;
  return '暂无可用材料';
}

/** 按优先级挑第一个能用的来源。顺序即"材料可靠度"顺序。 */
const BUILDERS = [
  [HOOK_SOURCE.ROOT, fromRoot],
  [HOOK_SOURCE.EXAMPLE, fromExample],
  [HOOK_SOURCE.COLLOCATION, fromCollocation],
  [HOOK_SOURCE.CONTRAST, fromContrast],
  [HOOK_SOURCE.SPELLING, fromSpelling],
];

/** 截断到上限，超了就加省略号（中文按字符算，规格说的是"字"）。 */
function clamp(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= HOOK_MAX_CHARS) return t;
  return t.slice(0, HOOK_MAX_CHARS - 1) + '…';
}

/**
 * 为单词构造记忆钩子。
 *
 * **纯函数**：同样的输入永远得到同样的输出，不读时间、不读随机数、
 * 不碰存储、不发网络请求。所以它可以被单测穷举，也可以安全地缓存。
 *
 * @param {object} word 词条（来自 library / seed-cet4）
 * @returns {{ text: string, source: string, sourceLabel: string, word: string }}
 *          text 是给用户看的那一句；source 标出它凭什么这么说。
 */
export function buildHook(word) {
  const w = word || {};
  for (const [source, fn] of BUILDERS) {
    let line = null;
    try {
      line = fn(w);
    } catch {
      line = null; // 任何一条材料坏了都不该让整个按钮失败
    }
    const text = clamp(line);
    if (text) {
      return {
        text,
        source,
        sourceLabel: SOURCE_LABEL[source] || '',
        word: String(w.word || ''),
      };
    }
  }
  // 连一个可用材料都没有：给出释义本身，并诚实标注来源
  return {
    text: clamp(fallbackLine(w)),
    source: 'meaning',
    sourceLabel: '来自释义',
    word: String(w.word || ''),
  };
}

/**
 * 批量构造（「全部预生成」模式，规格 §9 的设置项会用到）。
 */
export function buildHooks(words) {
  const out = {};
  for (const w of words || []) {
    if (w && w.id) out[w.id] = buildHook(w);
  }
  return out;
}

/**
 * 缓存的读写封装。
 *
 * 规格 §9：「每词一生只付一次，结果写回本地永久复用」。
 * 所以这里只做一件事：有缓存就用缓存，没有才生成，生成后立刻写回。
 *
 * @param {object} opts
 * @param {object} opts.storage 端口：{ get(k), set(k, v) }（异步）
 * @param {string} [opts.key]   存储键，默认 'hooks'
 * @returns {{ get: Function, ensure: Function, all: Function, forget: Function }}
 */
export function createHookCache({ storage, key = 'hooks' } = {}) {
  let table = null;

  async function load() {
    if (table) return table;
    let raw = null;
    try {
      raw = storage ? await storage.get(key) : null;
    } catch {
      raw = null;
    }
    table = raw && typeof raw === 'object' ? raw : {};
    return table;
  }

  return {
    /** 只读：拿已缓存的钩子，没有就返回 null（不触发生成）。 */
    async get(wordId) {
      const t = await load();
      return t[wordId] || null;
    },

    /**
     * 拿到钩子：有缓存直接返回（零等待），没有就生成 + 写回。
     * 返回 { hook, cached }，让界面能区分"刚编的"和"早就编好的"。
     */
    async ensure(word) {
      const t = await load();
      const id = word && word.id;
      if (id && t[id]) return { hook: t[id], cached: true };
      const hook = buildHook(word);
      if (id) {
        t[id] = hook;
        try {
          if (storage) await storage.set(key, t);
        } catch {
          // 存不下也不能失败：规格 §14.5 磁盘不可写 → 只读模式，不清空已有数据
        }
      }
      return { hook, cached: false };
    },

    /** 导出全部（设置页要看"用它凭什么这么说"，也方便用户自己备份）。 */
    async all() {
      return { ...(await load()) };
    },

    /** 忘掉一个词的钩子（重编）。 */
    async forget(wordId) {
      const t = await load();
      if (Object.prototype.hasOwnProperty.call(t, wordId)) {
        delete t[wordId];
        try {
          if (storage) await storage.set(key, t);
        } catch {
          /* 同上 */
        }
      }
    },
  };
}
