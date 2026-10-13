// vocab-study / core / app.mjs
// 组合根：把记忆 / 队列 / 会话 / 记录 / 游戏 拼成一个能被 UI 直接驱动的门面。
//
// 这一层仍然不认识 DSH：它只跟一个 Ports 对象打交道（见 §15 adapter 分层）。
//   ports.storage  本地持久化（JSONL + 快照）
//   ports.now      时钟（测试可注入假时钟）
//   ports.fetcher  词库拉取（可注入；离线给 null）
//   ports.ai       AI 增强（可注入；不注入就只有词库自带内容）
//   ports.context  「我上一级输入」的语境（只在用户点了 ✨ 时才读，隐私最小化 —— §9.1）

import * as M from './memory.mjs';
import { DAY_MS } from './memory.mjs';
import * as Q from './queue.mjs';
import * as S from './session.mjs';
import * as G from './game.mjs';
import * as MK from './mistake.mjs';
import * as L from './library.mjs';
import * as B from './beckon.mjs';
import { buildHook, createHookCache } from './hook.mjs';

// DAY_MS 只在 memory.mjs 声明一处：ESM 形态下经 import 拿到，单文件形态下同处一个作用域。
// （曾经三处重复声明，把整个单文件产物炸成 SyntaxError 白屏。）

export function createApp(ports = {}) {
  const storage = ports.storage || memoryStorage();
  const now = () => (ports.now ? ports.now() : Date.now());

  const state = {
    ready: false,
    readOnly: false, // 多窗口：第二个窗口只读（§7.4）
    readOnlyReason: null,
    dayKey: Q.dayKey(now()),
    words: [],
    mem: {},
    confusions: {},
    personal: [],
    records: [],
    settings: null,
    streak: { current: 0, longest: 0, lastDay: null, totalDays: 0 },
    combo: G.newCombo(now()),
    exp: 0,
    pause: null,
    proposal: null, // 自适应提议（只提议，不自动执行 —— P4）
    container: null,
    session: null,
    lastReveal: null,
    // 「再背一轮」用的那一批卡（不含同轮重训插入）；「自己往后背」的加量次数。
    roundItems: null,
    extendCount: 0,
    offline: false,
    banner: null,
    librarySource: 'seed',
    /** 换词库的一次性结果，给设置页显示；成功/失败/原因都放这里（别只写 DOM） */
    lastLibraryChange: null,
    /*
     * 已收服的生词本档案（2026-10-12 新增）。
     *
     * 用户的要求：「真正确定收服就可以自动删」+「留记录」。
     * 所以收服的词从**生词本列表**里移走，但在这里留一条最小记录。
     *
     * 为什么只存 {word, id, ts, collection} 而不是整条词目：
     * 词目本身在词库里、随时能按 id 查回来（`L.lookupWord`），
     * 而且 `state.words` 每次 init 都由「词库 + state.personal」重建 ——
     * 所以移走**不会丢任何词**，记忆数据也一个字都不动。
     * 万一它其实没记牢（判定再硬也是模型算的），下次忘了还能重新进来。
     */
    archivedPersonal: [],
    /** 「今天这几个词没记住」的提示被忽略到哪一天（同一天不再反复烦） */
    hintDismissedDay: null,
  };

  const listeners = new Set();
  function emit() {
    for (const fn of listeners) {
      try {
        fn(snapshotState());
      } catch {
        /* 一个监听器出错不该拖垮别人 */
      }
    }
  }
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function snapshotState() {
    return {
      ready: state.ready,
      readOnly: state.readOnly,
      readOnlyReason: state.readOnlyReason,
      dayKey: state.dayKey,
      streak: state.streak,
      combo: state.combo,
      exp: state.exp,
      settings: state.settings,
      pause: state.pause,
      proposal: state.proposal,
      container: state.container,
      session: state.session,
      card: state.session ? S.currentCard(state.session) : null,
      lastReveal: state.lastReveal,
      /*
       * 下面这 4 个字段是**漏掉的**，一次补齐（2026-10-12）。
       *
       * 症状：视图读 `st.X` 拿到 undefined，于是整块 UI 静默不出现 ——
       * 都在内部 `state` 上真实存在（后两个还真的有赋值），只是没进快照：
       *
       *   · personal          → renderVocab 读 `state.personal`，
       *                         undefined 恒为假 → 生词本页**永远显示
       *                         「生词本还是空的」**，手动增删和列表都用不了。
       *   · words             → 设置页的词库下拉读 `state.words`，拿不到当前词表。
       *   · lastRevealResult  → app.mjs 里 `state.lastRevealResult = res` 确实在写，
       *                         但界面读的是快照 → 相关分支永远走不到。
       *   · report            → `maybeWeeklyReport()` 算出周报后 `state.report = rep`
       *                         也在写，同样没进快照 → **周报卡片永远不渲染**。
       *
       * 为什么之前没发现：面板那套测试只验了四个标签页的**名字**存在
       * （demo-boot 里 `['今日','进度','生词本','设置']`），没有验页面**内容**。
       * 所以"页面渲染成空状态"和"正常"在测试里长得一模一样。
       * 现在 core 测试里加了一条对照断言：快照必须给出视图要读的每个字段。
       */
      personal: state.personal,
      words: state.words,
      lastRevealResult: state.lastRevealResult,
      report: state.report,
      // 已收服档案 + 「今天没记住」提示（2026-10-12 新增功能，同样必须进快照，
      // 否则生词本页读到的又是 undefined —— 就是上面那个 bug 的同一种死法）。
      archivedPersonal: state.archivedPersonal,
      unfamiliarCount: dismissHintToday() ? 0 : unfamiliarToday().length,
      offline: state.offline,
      banner: state.banner,
      librarySource: state.librarySource,
      // 换词库的一次性结果（成功/失败/原因）。必须放进快照里：
      // changeCollection 成功后会 emit() 触发整页重绘，只写在 DOM 上的提示会被冲掉。
      lastLibraryChange: state.lastLibraryChange,
      stats: computeStats(),
      // ① 这里**必须**同时保住 container 和 container.items。
      //    `state` 是每次渲染都读的 getter，只要有一个容器形状不完整
      //    （items 缺失 / 被写坏 / 老版本存下来的数据结构），这一行就会抛
      //    TypeError —— 而它抛出来，整个界面就白屏，用户看到的是"插件坏了"。
      //    这次修「设置不留痕」时就真的踩到了：container 曾经是 null，
      //    去掉兜底后测试直接崩在这里，后面所有断言一条都跑不到。
      //    判空写成"形状不对就当空"，比"假设形状一定对"安全。
      empty: !state.container || !Array.isArray(state.container.items) || state.container.items.length === 0,
      // 本轮是否已经跑完（用来决定"再背一轮 / 再来几个新词"要不要出现）
      roundFinished: !state.session || S.isFinished(state.session),
      // 进度**分子**：这一个会话覆盖了多少个**不同的词**。
      //
      // 不能用 session.stats.answered：那个数的是"卡"，而重训会在同一轮里
      // 再插卡（答"忘了"一个词最多再出现 2 次），20 个词走完会变成 60 ——
      // 和"词"为单位的分母一除，环就显示「60/20」。分子分母必须同单位。
      // 核心侧算好放这里，界面直接读，省得再往命名空间注册表里加符号。
      covered: S.coveredCount(state.session),
      // 本轮排过的卡数（不含同轮重训插入），用于文案「这一轮 20 词」
      roundSize: (state.roundItems || []).length,
      extendedBy: state.extendCount || 0,
      canRestart: !!(state.roundItems && state.roundItems.length),
      // 新词闸门状态：**每次快照实时重算**。
      // 不能只读 container.stats.newBlocked —— 容器一天只建一次，
      // 建的时候今天还没答题，那个字段天然恒为 false（死代码）。
      // 这里用和组队时同一个 shouldBlockNew()，保证口径一致。
      //
      // `state.settings` 必须带兜底：面板在 createPanelPuppet 里是**先 append
      // 再异步 init**（adapter/dsh/puppet.mjs 的 `void ensureReady()`），所以
      // 第一帧渲染时 settings 还是 null。读 `.allowMoreNew` 会抛
      // "Cannot read properties of null" —— 渲染中断，用户看到的就是空标签页。
      // 初始化完成后 ensureReady() 会再 render 一次，那时才是真设置。
      newGate: (() => {
        const blocked = Q.shouldBlockNew(todayStats());
        const bypassed = state.settings?.allowMoreNew === true;
        return {
          autoBlocked: blocked,           // 自动判断：今天该不该停推新词
          bypassed,                       // 用户是否已显式放行
          closed: blocked && !bypassed,    // 当前是否真的关着（关着才给用户入口）
        };
      })(),
    };
  }

  // ── 启动 ────────────────────────────────────────────────
  async function init() {
    const saved = (await storage.get('state')) || {};
    state.settings = normalizeSettings(saved.settings);
    state.mem = saved.mem || {};
    state.confusions = saved.confusions || {};
    state.personal = saved.personal || [];
    state.streak = { current: 0, longest: 0, lastDay: null, totalDays: 0, ...(saved.streak || {}) };
    state.combo = saved.combo || G.newCombo(now());
    state.exp = saved.exp || 0;
    state.pause = saved.pause || null;
    // 打卡历史：热力图（heatmap() 遍历 state.records）与「今日已背几词」都看这里。
    // 它一直靠 storage.append('records', row) 追加写盘，但这边**从来没读回来过** ——
    // 于是每一次重启/重开面板，热力图与今日统计都归零，像刚装好一样。
    // （真插件走 JSONL，demo 走 localStorage，两条路的 list() 语义一致。）
    state.records = typeof storage.list === 'function' ? storage.list('records') : [];
    // history 是 persist() 一直在写、这边却漏读的另一个字段：
    // 「连续 3 天完成 → 自动回到 N」（effectiveBaseN）要靠 history.days。
    state.history = saved.history || { days: [] };
    // 已收服档案 + 提示忽略日期（不读回来的话，每次重开面板收服记录就没了，
    // 提示也会在同一天反复弹 —— 和 history 当初漏读是同一类错）。
    state.archivedPersonal = Array.isArray(saved.archivedPersonal) ? saved.archivedPersonal : [];
    state.hintDismissedDay = saved.hintDismissedDay || null;

    // 0 屏提问（§11）：默认四级，直接开背；首屏不问任何东西
    const coll = state.settings.collections?.[0] || 'cet4';
    const res = await L.loadCollection(coll, { fetcher: ports.fetcher, cache: cachePort() });
    state.words = mergePersonal(res.words, state.personal);
    state.mem = L.seedMemories(state.words, state.mem, now());
    state.offline = res.offline;
    state.banner = res.banner;
    state.librarySource = res.source;

    // 启动时也归档一次「已收服」的生词本词条。
    //
    // 为什么启动时也要做：判定依据里有**时间**（记忆强度随天数衰减，
    // isConquered 看的是此刻的强度）。用户昨天答对、今天强度够 0.9 了，
    // 如果只在答题那一刻检查，这一批就要等到他下次答题才会被发现。
    // 放在 init 里、且 emit 在它之后，界面第一次画出来就是归档后的状态。
    archiveConqueredPersonal();

    // 崩溃恢复：存在未结算的 sessionId → 恢复队列顺序与剩余词，已答过的不重考（§7.2）
    const snap = await storage.get('session');
    if (snap && snap.dayKey) {
      const restored = S.restore(snap, {
        words: state.words,
        mem: state.mem,
        confusions: state.confusions,
        quizPool: state.words,
        now: now(),
      });
      if (restored && !S.isFinished(restored) && snap.dayKey === state.dayKey) {
        state.session = S.resumeSession(restored, now());
      }
    }

    // ⚠️ 恢复成功也必须把 container 补出来，不能只在"没 session"时才建。
    //
    // 这里原来只有一行 `if (!state.session) buildContainer();` —— 于是恢复成功的
    // 那条路上 `state.container` **永远是 null**，而界面上一大堆东西是从它算的：
    //   · 底部「今日 x/y」的分母、环的分母
    //   · st.empty（= !container || items.length === 0）→ 判成"今天没词"
    // 用户报「我设置了 10 个，每次进来就是 20」就是这一条：设置其实**存住了**
    // （存储里 dailyGoal 确实是 10），但容器是 null，界面拿不到真实的本轮规模，
    // 于是显示成"没有需要复习的词" / 默认数字，看起来就像设置没保存。
    //
    // 注意：这里**只能重建容器，绝不能重新选词建新 session** ——
    // 那会把用户恢复出来的队列位置冲掉（§7.2 要求从第 N 个词继续）。
    if (state.session && !state.container) rebuildContainerFromSession();

    if (!state.session) buildContainer();
    state.ready = true;
    emit();
    return snapshotState();
  }

  /**
   * 把容器从**已经恢复出来的 session** 反推出来：不重新选词、不新建 session，
   * 所以用户不会因为中途关掉面板而回到第 1 个词。
   *
   * 只在"有 session 但没有 container"（重启后恢复）时用。
   */
  function rebuildContainerFromSession() {
    const key = state.dayKey || Q.dayKey(now());
    const gap = gapDays();
    const byWord = new Map();
    // 过滤掉同轮重训卡：一个词在队列里可能出现多次（答"忘了"最多再现 2 次），
    // 但容器要的是"本轮排过的**词**"，不是"要做的卡"。
    for (const c of state.session.queue) {
      if (!c || !c.word) continue;
      if (c.isRetry) continue;
      // mem 从 state.mem 取，**不要**用 c.mem：S.restore() 重建队列时不带
      // mem 字段（见 session.mjs 里 restore 的 map），恢复出来的卡 c.mem 是
      // undefined。照抄它会让容器里的条目少一个字段，界面按层级/强度取用时踩空。
      if (!byWord.has(c.word.id)) {
        byWord.set(c.word.id, { word: c.word, mem: state.mem[c.word.id], tier: c.tier });
      }
    }
    const items = [...byWord.values()];
    const size = state.session.plannedSize || items.length;
    const tierCount = (t) => items.filter((i) => i.tier === t).length;
    state.container = {
      items,
      stats: {
        // 重训卡不算"词"，所以这些数字按去重后的词条重算，不照抄 session.stats
        reviewCount: tierCount(Q.TIER.REVIEW),
        personalCount: tierCount(Q.TIER.PERSONAL),
        newCount: tierCount(Q.TIER.NEW),
        size: items.length,
        // 用户设了多少就是多少 —— 恢复时也要用存下来的本轮规模，
        // 不能退回默认值，否则「我设了 10 却显示 20」会再犯一次。
        containerSize: size,
        balance: state.settings.balance,
        offline: !!state.offline,
        newBlocked: false,
        newBlockBypassed: false,
      },
      dayKey: key,
      gapDays: gap,
      comeback: Q.comebackCopy(gap),
      baseN: state.settings.dailyGoal,
      autoN: Q.containerSize(gap, state.settings.dailyGoal),
      restored: true,
    };
    // 「再背一轮」据此重建同一批卡，所以必须一起补上
    state.roundItems = items.map((it) => ({ ...it, isRetry: false }));
  }

  function cachePort() {
    return {
      get: (k) => storage.get(`cache:${k}`),
      set: (k, v) => storage.set(`cache:${k}`, v),
    };
  }

  function mergePersonal(words, personal) {
    const byId = new Map(words.map((w) => [w.id, w]));
    for (const p of personal) {
      if (!byId.has(p.id)) byId.set(p.id, p);
      else byId.set(p.id, { ...byId.get(p.id), ...p, personal: true });
    }
    return [...byId.values()];
  }

  function normalizeSettings(s = {}) {
    return {
      collections: s.collections || ['cet4'],
      dailyGoal: clampInt(s.dailyGoal ?? 20, 3, 200), // N = 20 铁律的默认值，用户可自己改
      balance: typeof s.balance === 'number' ? s.balance : 0.5, // 攻守天平
      // 新词出场顺序：'shuffle'（默认，随机）| 'seq'（按词库/字母序）
      order: s.order === 'seq' ? 'seq' : 'shuffle',
      aiMode: s.aiMode || 'ondemand', // off | ondemand | all
      masterEnabled: s.masterEnabled !== false, // AI 增强总开关（默认开）
      roundSize: s.roundSize || 5, // 碎片冲刺 3/5/10
      /*
       * 「再来几个新词」一次加多少（2026-10-12 新增）。
       *
       * 用户在设置页找不到这个 —— 因为以前它根本不存在：界面上写死了
       * `app.extendRound(5)`，想改只能改代码。现在变成可设项，默认仍是 5
       * （和以前的行为一致，老用户升上来不会突然变样）。
       */
      extendBatch: s.extendBatch || 5,
      paused: s.paused || null,
      vacationUntil: s.vacationUntil || null,
      dismissedProposals: s.dismissedProposals || {},
      // 用户显式放行新词闸门。默认 false（安全阀照常自动触发）；
      // 只有用户本人按了「我还是想继续」才变 true，代码不会替他打开。
      allowMoreNew: s.allowMoreNew === true,
      prompts: s.prompts || defaultPrompts(),
      schemaVersion: 1,
    };
  }
  function clampInt(v, lo, hi) {
    const n = Math.round(Number(v) || 0);
    return Math.max(lo, Math.min(hi, n));
  }

  // ── 日容器 ──────────────────────────────────────────────
  function buildContainer() {
    const key = Q.dayKey(now());
    const gap = gapDays();
    state.dayKey = key;
    const auto = Q.containerSize(gap, state.settings.dailyGoal);
    // 恢复：连续 3 天正常完成 → 自动回到 N（不问）
    const recovered = Q.effectiveBaseN(state.settings.dailyGoal, state.streak, state.history?.days);
    const N = recovered || auto;
    state.container = {
      ...Q.buildDailyContainer(personalToWords(), state.mem, {
        N,
        gapDays: gap,
        balance: state.settings.balance,
        now: now(),
        collections: state.settings.collections,
        todayStats: todayStats(),
        allowMoreNew: !!state.settings.allowMoreNew,
        // 新词随机顺序的种子 = 今天。同一天内结果稳定，所以中途重开面板
        // 仍然是「从第 N 个词继续」（规格 §7.2 / §540）；换一天换一个排法。
        seed: key,
        order: state.settings.order,
      }),
      dayKey: key,
      gapDays: gap,
      comeback: Q.comebackCopy(gap),
      baseN: state.settings.dailyGoal,
      autoN: auto,
    };
    // 本轮"排过队的词"（不含同轮重训插入）。「再背一轮」据此重建同一批卡：
    // 不重新选词，所以重背的就是刚才那一批，不会偷偷换成别的词。
    state.roundItems = state.container.items.map((it) => ({ ...it }));
    state.session = S.createSession({ ...state.container, dayKey: key }, sessionOpts());
    persist();
    emit();
    return state.container;
  }

  /**
   * 再背一轮：把刚才这一批卡重新跑一遍。
   *
   * 为什么不复用 buildContainer()：那个会重新选词（种子虽然按天稳定，但
   * mem 已经变了，到期/新词池都不同），重背出来的就不是刚才那一批了。
   * 用户要的是"把这一轮再来一次"，所以拿 roundItems 原样重建。
   *
   * 注意：这里**不动**任何记忆数据。重背只是多练一遍，答错照样照常更新记忆，
   * 所以"再背一轮"既不是惩罚也不是刷分，就是再练一次。
   */
  function restartRound() {
    if (!state.roundItems || !state.roundItems.length) return null;
    const dayKey = state.dayKey || Q.dayKey(now());
    state.session = S.createSession(
      { items: state.roundItems, stats: { ...(state.container?.stats || {}), containerSize: state.roundItems.length }, dayKey },
      sessionOpts(),
    );
    state.lastReveal = null;
    persist();
    emit();
    return state.session;
  }

  /**
   * 再来几个新词：突破当天计划 N，继续往后取。
   *
   * 自己控制"多背多少"：每点一次，目标加 5 个（不超过 dailyGoal）。
   * 为什么不一次给很多：用户说的是"能不能自己往后背"，要的是**由他决定继续**，
   * 不是系统一口气塞 100 个给他。一次 5 个，想继续再点。
   */
  /**
   * 「再来 5 个新词」：本轮再多排 step 个**没排过**的词，接在正在背的这一轮后面。
   *
   * ⚠️ 这里原来错得很厉害（用户报「点完显示 30 个」「出现的单词是重复的」）：
   * 老写法是「用更大的 N（base + step*next）重建一遍容器，再拿结果去重」。
   * 但走完一轮后 mem 已经变了 —— 那 20 个词从"新词池"迁进了"到期复习池"，
   * 于是重建出来的大部分**不是**它们本身，去重几乎全部失灵。实测：
   *   一轮 20 个词 → 点一次「再来 5 个」→ 容器 45 个条目、session 队列 40 个重复。
   *
   * 现在改成：把「本轮已排过的词」作为 exclude 交给 buildDailyContainer，
   * **只建设 step 个**。排除发生在池子源头（见 queue.mjs 的 skip），
   * 所以学过的词不会从复习池绕回来；再叠一层严格上限，凑不满就凑不满。
   */
  /**
   * 「再来 N 个新词」——本轮再多排 N 个**没排过**的词，接在正在背的这一轮后面。
   *
   * N 的来路（2026-10-12 起）：优先用显式传入的 batch（测试和内部调用用），
   * 没传就读用户在设置页选的 `settings.extendBatch`。以前界面上写死 5，
   * 用户找不到地方改 —— 现在改成可设项。
   */
  function extendRound(batch = null) {
    const want = batch ?? state.settings?.extendBatch ?? 5;
    const step = Math.max(1, Math.min(20, Math.round(want) || 5));
    const key = state.dayKey || Q.dayKey(now());

    const prev = Array.isArray(state.roundItems) ? state.roundItems : [];
    const exclude = new Set(prev.map((it) => it.word.id).filter(Boolean));

    const built = Q.buildDailyContainer(personalToWords(), state.mem, {
      N: step,
      gapDays: state.container?.gapDays ?? gapDays(),
      balance: state.settings.balance,
      now: now(),
      collections: state.settings.collections,
      todayStats: todayStats(),
      // ⚠️ 这里**必须**沿用设置的闸门状态，不能写死成 true。
      // 我曾写成 `allowMoreNew: true`（理由是"用户亲手按了按钮"），结果
      // test/round-control.test.mjs 第 ⑦ 节立刻变红 —— 那条锁的是
      // 「闸门关着时 extendRound 不该硬塞新词」，而界面在闸门关着时
      // 根本不显示这个按钮。硬写 true 等于让这个函数**绕过安全阀**，
      // 那是产品决策，不该由修 bug 顺手改掉。
      allowMoreNew: !!state.settings.allowMoreNew,
      seed: key,
      order: state.settings.order,
      exclude,
    });

    // 严格只要没排过的，并且**不超过 step**。
    const seen = new Set(exclude);
    const fresh = [];
    for (const it of built.items) {
      const id = it.word && it.word.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fresh.push({ ...it });
      if (fresh.length >= step) break;
    }
    if (!fresh.length) return state.container;

    const merged = [...prev, ...fresh];
    state.extendCount = (state.extendCount || 0) + 1;
    state.container = {
      ...state.container,
      ...built,
      items: merged,
      stats: { ...built.stats, containerSize: merged.length, size: merged.length },
      dayKey: key,
      baseN: state.settings.dailyGoal,
      autoN: state.container?.autoN || state.container?.baseN || state.settings.dailyGoal,
      extendedBy: state.extendCount,
    };
    state.roundItems = merged.map((it) => ({ ...it }));

    // 续上正在背的这一轮，把新词接在后面。
    const s = state.session;
    if (!s || S.isFinished(s)) {
      // 上一轮**已经走完**时开新会话。这里要同时满足三件事，缺一样用户就会骂：
      //   ① 不许重考刚背过的（用户原话：「他会给我再原来的基础上加五个，
      //      然后从头过一遍我刚背的」）
      //   ② 计数器要连续（底部的「今日 x/y」不能因为续背而清零）
      //   ③ 这一轮的总量还是 25（环和底部说的是同一轮）
      //
      // 我第一版把队列直接缩成 fresh（5 张）—— ① 满足了，但 ② 挂了：
      // 新会话 answered 从 0 起，底部变成「今日 0/25」，看起来像进度被清空。
      // 正确做法是**队列保留整轮 25 个词，但把已经答过的标成已答、
      // 游标挪到新词开头**：currentCard() 只会拿到新词（①），
      // stats.answered 延续上一场的数（②），总量 25（③）。
      const doneIds = new Set();
      if (s) for (const c of s.queue) if (c.answered) doneIds.add(c.word.id);
      const next = S.createSession(
        { items: merged, stats: state.container.stats, dayKey: key },
        sessionOpts(),
      );
      for (const c of next.queue) if (doneIds.has(c.word.id)) c.answered = true;
      // 游标推到第一个还没背过的卡，这样开口问的就是新词
      next.cursor = next.queue.findIndex((c) => !c.answered);
      if (next.cursor < 0) next.cursor = next.queue.length;
      // 计数器要**接着上一场**，不能因为"这是新会话"就归零。
      // 用户刚背完 20 个，点了"再来 5 个"，进度条从 0/25 重新爬是错的 ——
      // 他看到的应该是 20/25 继续往上走。
      next.stats.answered = Math.max(next.stats.answered, doneIds.size);
      state.session = next;
    } else {
      const have = new Set(s.queue.map((c) => c.word.id));
      const add = fresh.filter((it) => !have.has(it.word.id));
      if (add.length) {
        const extra = S.createSession(
          { items: add, stats: built.stats, dayKey: key }, sessionOpts(),
        ).queue;
        for (const c of extra) s.queue.push(c);
        // 本轮总量要跟着队列一起长，否则环会说"这一轮已经完了"
        s.plannedSize = Math.max(s.plannedSize || 0, s.queue.length);
      }
    }
    state.lastReveal = null;
    persist();
    emit();
    return state.container;
  }

  /** 用户显式放行新词闸门（安全阀仍自动触发，只是不再无法绕过）。 */
  function allowMoreNew() {
    state.settings = { ...state.settings, allowMoreNew: true };
    buildContainer();
    // 放行之后必须**立刻给出卡**，而且只给还没背过的。
    //
    // 两个坑都在这几行里：
    //  1. buildContainer() 只是把容器重建（新词回到 container.items），
    //     但当前 session 已经走完了。不重开一场的话，界面会回到"这一轮
    //     走完了"，用户点了「我还是想继续」却什么也没发生。
    //  2. 更隐蔽的：container.items 里既有没有背过的**新词**，也有刚刚
    //     已经答完的卡。而 createSession 无条件把 items 全变成
    //     answered:false 的新队列 —— 直接把容器丢给它，等于让用户把
    //     刚背完的词原样再背一遍。所以要显式滤掉已答的。
    //     （这个坑我在无头浏览器里点出来才发现：点「我还是想继续」后，
    //      环显示 0/20、当前词是刚背过的第一个词。）
    const answered = new Set();
    if (state.session) {
      for (const c of state.session.queue) if (c.answered) answered.add(c.word.id);
    }
    const pending = state.roundItems.filter((it) => !answered.has(it.word.id));
    if (pending.length) {
      // 用 state.dayKey：buildContainer 里有它自己的 const key，出了那个函数
      // 就没了（我第一版直接写 key，会踩作用域错）。buildContainer 已经把
      // state.dayKey 设好了，restartRound 也是这么读的。
      state.session = S.createSession(
        { items: pending, stats: state.container.stats, dayKey: state.dayKey },
        sessionOpts(),
      );
    }
    state.lastReveal = null;
    persist();
    emit();
    return state.container;
  }

  function personalToWords() {
    const personalIds = new Set(state.personal.map((p) => p.id));
    return state.words.map((w) => (personalIds.has(w.id) ? { ...w, personal: true } : w));
  }
  function sessionOpts() {
    return {
      words: state.words,
      mem: state.mem,
      confusions: state.confusions,
      quizPool: state.words,
      sessionId: `s${now().toString(36)}`,
      now: now(),
    };
  }
  /**
   * 今天的新词闸门统计 —— **只算当前这本词库**。
   *
   * ⚠️ 这里少了"按词库过滤"曾经是个真 bug（用户报「换词库显示成功但主页没反应」）：
   * 原来把当天所有词库的作答混在一起数。用户在四级全答"忘了"走完一轮 →
   * newAnswerCount=5、newWrongRate=1.0 → shouldBlockNew 为真；
   * 这时换到六级，闸门仍然认为"今天新词额度用完了"，于是六级的新词一个都不推；
   * 而六级的复习池又是空的（那些词还没学过）→ 队列 0 张 →
   * 主页继续显示「今天没有需要复习的词」，换多少个库都一样。
   *
   * 口径修成按词库之后：闸门问的是"**这本**今天推了几个新词、错得多不多"，
   * 换库自然重新开始，和用户"换本书重新学"的直觉一致。
   */
  function todayStats() {
    const active = state.settings?.collections?.[0] || null;
    const today = state.records.filter((r) => {
      if (r.dayKey !== state.dayKey) return false;
      if (!active) return true;
      // 老记录没有 collection 字段：从 wordId 前缀推（cet6:abandon），
      // 推不出来就当作"属于四级"，免得历史数据被算丢。
      const coll = r.collection || (String(r.wordId || '').includes(':') ? String(r.wordId).split(':')[0] : 'cet4');
      return coll === active;
    });
    const newRecs = today.filter((r) => r.tier === 3);
    const wrong = newRecs.filter((r) => r.incorrect).length;
    return {
      newAnswerCount: newRecs.length,
      newWrongRate: newRecs.length ? wrong / newRecs.length : 0,
    };
  }
  function gapDays() {
    if (!state.streak.lastDay) return 0;
    return Math.max(0, Q.daysBetweenKeys(state.streak.lastDay, Q.dayKey(now())) - 1);
  }

  // ── 作答 ────────────────────────────────────────────────
  function rate(rating, extra = {}) {
    const s = state.session;
    if (!s || state.readOnly) return null;
    const card = S.currentCard(s);
    if (!card) return null;
    const t0 = extra.reactionMs ?? 0;
    const payload = S.submitRating(s, card, rating, { ...extra, now: now(), reactionMs: t0 });
    state.mem = s.mem;
    state.lastReveal = payload.reveal;
    state.lastPlan = payload.plan;
    state.combo = s.combo;
    state.exp = s.exp;
    writeRecord({
      mode: card.mode,
      rating,
      correct: rating !== S.RATING.FORGOT,
      fakeMastery: false,
      card,
      extra,
    });
    enforceNewGate(s);
    persist();
    emit();
    return payload;
  }

  /**
   * 让新词闸门**真的生效**。
   *
   * 第二个真问题（第一个是判断用了永远为 0 的统计量）：容器是一天开局建一次的，
   * 那时还没答题、闸门必然算成"开"；等答完几个新词、答错率超过 70% 时，
   * 判断虽然变成"该关"，但**已经建好的队列不会因此改变** —— 判断结果对
   * 已排好的卡没有任何作用。规格 §7.6 因此还是一条空规则。
   *
   * 这里在每次作答后执行：闸门刚关上时，把本轮还没答的**新词**从队列里撤掉。
   * 三条克制：
   *   · 只撤"还没答"的新词；已答的不动（不抹掉用户已经做完的事）
   *   · 不撤复习词/收藏词（那些是维护记忆，与推新词无关，撤回会让记忆断档）
   *   · 撤掉不是作废：这些词没被标记学过，明天照常轮得到
   * 用户按下「我还是想继续」后 settings.allowMoreNew = true，本函数不再介入。
   */
  function enforceNewGate(s) {
    if (!s) return 0;
    if (state.settings.allowMoreNew) return 0;
    if (!Q.shouldBlockNew(todayStats())) return 0;
    const before = s.queue.length;
    // 撤掉 cursor 之后所有"还没答"的新词。已答过的卡都在 cursor 之前，不进候选人。
    const head = s.queue.slice(0, s.cursor);
    const rest = s.queue.slice(s.cursor).filter((c) => c.tier !== Q.TIER.NEW || c.answered);
    // 收尾：闸门关掉后，"cursor 之后已答过的卡"也切掉。
    // 它们永远排不到（cursor 只前进），却让 queue.length 虚高，
    // 界面上的"本轮还剩多少"就会骗人 —— 实测确实剩下 5 张这种卡。
    const tailIdx = rest.findIndex((c) => c.answered);
    s.queue = tailIdx >= 0 ? [...head, ...rest.slice(0, tailIdx)] : [...head, ...rest];
    const removed = before - s.queue.length;
    if (removed > 0) {
      // plannedSize 必须跟着队列走。它原本在会话创建时固定为 queue.length，
      // 而同轮重训（忘了 → 同轮再来一次，§5.5）会往队列里插新卡，
      // 于是"本轮总量"长期偏小：实测重背时实际要过 4 张卡，环却写 1/1，
      // 看起来这一轮已经完了。宁大不小，所以取 max。
      s.plannedSize = Math.max(s.plannedSize || 0, s.queue.length);
      // 容器统计跟着真实队列走：界面上的"新词"数量不能继续显示已经撤掉的那些
      if (state.container?.stats) {
        const remainingNew = s.queue.filter((c) => c.tier === Q.TIER.NEW && !c.answered).length;
        state.container = {
          ...state.container,
          stats: { ...state.container.stats, newCount: remainingNew },
        };
      }
    }
    return removed;
  }

  function next() {
    const s = state.session;
    if (!s) return null;
    S.advance(s, now());
    state.lastReveal = null;
    if (S.isFinished(s)) settle();
    persist();
    emit();
    return S.currentCard(s);
  }

  function undo() {
    const res = S.undoLast(state.session, now());
    if (res.ok) {
      state.lastReveal = null;
      persist();
      emit();
    }
    return res;
  }

  /** 揭晓后用户说「其实我搞混了」→ 假掌握 +2，并立刻安排同轮重训。 */
  function reportFakeMastery(confusedWith) {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const res = S.reportFakeMastery(s, card, confusedWith, { now: now() });
    state.mem = s.mem;
    if (confusedWith) state.confusions = MK.noteConfusion(state.confusions, card.word.id, confusedWith, now());
    writeRecord({ mode: card.mode, rating: S.RATING.KNOWN, correct: false, fakeMastery: true, card, extra: { confusedWith } });
    persist();
    emit();
    return res;
  }

  /** 辨词作答。 */
  function answerQuiz(optionId, extra = {}) {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const res = S.submitQuiz(s, card, optionId, { ...extra, now: now(), reactionMs: extra.reactionMs ?? 0 });
    state.mem = s.mem;
    state.combo = s.combo;
    state.exp = s.exp;
    // 供 UI 显示「并排两个词 + 一句人话」（§5.3：不出现红叉）
    state.lastRevealResult = res;
    state.lastReveal = { quiz: true, correct: res.correct };
    state.lastHuman = res.human ? res.human.line : null;
    state.lastPlan = res.plan;
    if (!res.correct && res.chosen) {
      state.confusions = MK.noteConfusion(state.confusions, card.word.id, res.chosen.id, now());
    }
    writeRecord({ mode: 'quiz', rating: res.correct ? S.RATING.KNOWN : S.RATING.FORGOT, correct: res.correct, card, extra: { chosen: res.chosen?.id } });
    persist();
    // 答对之后才可能「收服」——所以在这里检查一次自动归档，紧接着再 emit，
    // 界面刷新时看到的就是「已经移走」之后的状态（不会先画出来再消失一下）。
    archiveConqueredPersonal();
    emit();
    return res;
  }

  /** 安全阀：这道题有问题（本词本轮不计分并标记待复核 —— §5.3）。 */
  function flagQuestion() {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const partner = card.quizOptions?.find((o) => !o.correct)?.id;
    state.confusions = MK.flagConfusion(state.confusions, card.word.id, partner || card.word.id, now());
    // 不计分：跳过这张卡
    card.flagged = true;
    S.advance(s, now());
    persist();
    emit();
    return { ok: true, blacklisted: (state.confusions[MK.pairKey(card.word.id, partner || card.word.id)] || {}).blacklisted };
  }

  function quiz() {
    const s = state.session;
    const card = S.currentCard(s);
    if (!card) return null;
    const q = S.buildQuiz(card, s, ports.rand || Math.random);
    card.quizOptions = q.options;
    return q;
  }

  // ── 一轮结束 ────────────────────────────────────────────
  function settle() {
    const s = state.session;
    if (!s) return null;
    const key = Q.dayKey(now());
    const done = s.stats.answered;
    const checked = Q.isCheckedIn(done, s.plannedSize);
    if (checked) {
      state.streak = Q.bumpStreak(state.streak, key);
      (state.history = state.history || { days: [] }).days.push({ key, done: true });
    } else {
      (state.history = state.history || { days: [] }).days.push({ key, done: false });
    }
    // 每周一次：周度对账单（§7.5 证据③，必须是周报不是日报）
    const rep = maybeWeeklyReport();
    if (rep) state.report = rep;
    // 放弃信号检测 + 自适应提议（只提议，不自动改 —— P4）
    state.proposal = detectProposal();
    state.roundJustFinished = true;
    state.container = { ...state.container, done, checkedIn: checked };
    return state.container;
  }

  function writeRecord(rec) {
    const card = rec.card;
    const row = {
      ts: now(),
      dayKey: Q.dayKey(now()),
      wordId: card.word.id,
      mode: rec.mode,
      selfRating: rec.rating,
      correct: !!rec.correct,
      incorrect: !rec.correct,
      fakeMastery: !!rec.fakeMastery,
      reactionMs: rec.extra?.reactionMs ?? 0,
      hintUsed: !!rec.extra?.hintUsed,
      confusedWith: rec.extra?.confusedWith || rec.extra?.chosen || null,
      cardId: card.cardId,
      sessionId: state.session?.sessionId || null,
      queueSnapshotId: state.session?.dayKey || null,
      tier: card.tier,
      // 这条记录属于哪本词库。todayStats() 用它把新词闸门**按词库**统计：
      // 换了词库之后，"上一本今天推过 5 个新词"不该继续挡住新词库。
      // 用户报的换库无反应，有一半就是这个原因（见 todayStats 的注释）。
      collection: card.word.collection || null,
      schemaVersion: 1,
    };
    state.records.push(row);
    // 追加写，不可变（P5：每答完一张卡即落盘）
    storage.append('records', row);
  }

  // ── 统计 ────────────────────────────────────────────────
  function computeStats() {
    const conquered = G.conqueredCount(state.words, state.mem, (m) => M.isConquered(m, now()));
    const learned = state.words.filter((w) => (state.mem[w.id]?.encodeCount || 0) > 0).length;
    const todayRecs = state.records.filter((r) => r.dayKey === state.dayKey);
    const total = Math.max(1, todayRecs.length);
    const correct = todayRecs.filter((r) => r.correct).length;
    // 今日新词作答数：只数 tier 3（新词）且当天已作答的记录。
    // 用户抱怨"我抽空背了几个词却看不到"，就是缺这个数 —— 它一直在
    // todayStats() 里算着，只是从没挂到界面上。
    const todayNewCount = todayRecs.filter((r) => r.tier === 3).length;
    return {
      conquered, // 「已收服 N 词」取代「掌握度 x%」（§7.5 证据①）
      learned,
      totalWords: state.words.length,
      todayAnswered: todayRecs.length,
      todayNewCount,
      todayAccuracy: correct / total,
      level: G.levelFor(state.exp),
      heatmap: heatmap(),
      curve: null, // 按需计算，避免每次 emit 都跑 30 天模拟
      diagnosis: MK.diagnosis(todayRecs, { wordById: wordByIdFn() }),
      stubborn: stubbornWords(10),
      confusionsNeedingDrill: MK.pairsNeedingDrill(state.confusions),
    };
  }
  const wordByIdFn = () => (id) => state.words.find((w) => w.id === id);

  function retention() {
    const ids = new Set(state.container ? state.container.items.map((i) => i.word.id) : []);
    const mems = [...ids].map((id) => state.mem[id]).filter(Boolean);
    return M.retentionCurve(mems, { days: 30, now: now() });
  }

  function heatmap({ weeks = 15 } = {}) {
    const byDay = new Map();
    for (const r of state.records) byDay.set(r.dayKey, (byDay.get(r.dayKey) || 0) + 1);
    const days = [];
    // 口径与记录完全一致：每个格子按 4:00 分界的 dayKey 取
    const offset = 3600000 * (Q.DAY_START_HOUR + 1);
    const todayTs = Q.dayStartTs(now()) + offset;
    for (let i = weeks * 7 - 1; i >= 0; i--) {
      const key = Q.dayKey(todayTs - i * DAY_MS);
      const n = byDay.get(key) || 0;
      // 空白天数没有任何红字警告（§7.1）—— level 0 就是空白，不是惩罚
      days.push({ key, n, level: n === 0 ? 0 : n < 5 ? 1 : n < 12 ? 2 : n < 20 ? 3 : 4 });
    }
    return days;
  }

  function stubbornWords(n) {
    return state.words
      .map((w) => ({ w, e: state.mem[w.id]?.e || 0 }))
      .filter((x) => x.e > 0)
      .sort((a, b) => b.e - a.e)
      .slice(0, n);
  }

  // ── 周报 ────────────────────────────────────────────────
  function maybeWeeklyReport() {
    const key = Q.dayKey(now());
    const today = new Date(now());
    if (today.getDay() !== 1) return null; // 只在周一自动出（§7.8 周一那行）
    const last = state.settings.lastReportDay;
    if (last === key) return state.report || null;
    state.settings.lastReportDay = key;
    const weekAgo = now() - 7 * DAY_MS;
    const recs = state.records.filter((r) => r.ts >= weekAgo);
    const words = new Set(recs.map((r) => r.wordId)).size;
    const conqueredThisWeek = recs.filter((r) => r.correct && r.mode === 'quiz').length;
    const diag = MK.diagnosis(recs, { wordById: wordByIdFn() });
    const stubborn = stubbornWords(1)[0];
    const rec = suggestNextWeek(recs, diag);
    return {
      weekStart: Q.dayKey(weekAgo),
      words,
      conqueredThisWeek,
      longestStreak: state.streak.longest,
      stubborn: stubborn ? { word: stubborn.w.word, e: stubborn.e } : null,
      diagnosis: diag.sentence,
      suggestion: rec,
    };
  }

  function suggestNextWeek(recs, diag) {
    if (!recs.length) return null;
    const acc = recs.filter((r) => r.correct).length / recs.length;
    if (acc < 0.6 && diag?.kind === MK.ERROR_KIND.sound) {
      return '下周把新词减到 15 个，先把读音像的那几组清掉。';
    }
    if (acc < 0.6) return '下周把新词减到 15 个，先把复习做完。';
    if (acc > 0.85) return '手感不错 —— 想加量的话可以在设置里把每天调到 25 个。';
    return '照现在这样走就行。';
  }

  // ── 放弃信号检测（§7.6：系统主动降载，而不是等用户用尽力气）──
  function detectProposal() {
    const days = (state.history?.days || []).slice(-3);
    const dismissed = state.settings.dismissedProposals || {};
    const canPropose = (k) => !dismissed[k] || now() - dismissed[k] > 7 * DAY_MS;
    const todayRecs = state.records.filter((r) => r.dayKey === state.dayKey);
    if (todayRecs.length > 0 && todayRecs.length < 3 && canPropose('lowAnswer')) {
      const shortSessions = (state.history?.shortStreak || 0) + 1;
      state.history = { ...(state.history || {}), shortStreak: shortSessions };
      if (shortSessions >= 3) return { kind: 'reduce', to: 8, text: '要不要把每天降到 8 个？先把习惯养起来。' };
    }
    if (days.length === 3 && days.every((d) => !d.done) && canPropose('lowDone')) {
      return { kind: 'reduceRound', to: 3, text: '要不要把每轮改成 3 个？做完就算完。' };
    }
    return null;
  }

  function acceptProposal() {
    const p = state.proposal;
    if (!p) return;
    if (p.kind === 'reduce') state.settings.dailyGoal = p.to;
    if (p.kind === 'reduceRound') state.settings.roundSize = p.to;
    state.proposal = null;
    persist();
    emit();
  }
  function dismissProposal() {
    const p = state.proposal;
    if (!p) return;
    state.settings.dismissedProposals = { ...state.settings.dismissedProposals, [p.kind]: now() };
    state.proposal = null; // 拒绝后静默 7 天
    persist();
    emit();
  }

  // ── 设置 ────────────────────────────────────────────────
  function updateSettings(patch) {
    state.settings = normalizeSettings({ ...state.settings, ...patch });
    // dailyGoal / balance 变了必须重建，否则预算对不上。
    //
    // 但 **order（新词顺序）故意不在这里重建**：
    // buildContainer() 会 createSession() 出一轮全新的队列，正在背的那一轮
    // 就没了。拨个顺序开关把用户背到一半的 12 个词清掉，代价太大。
    // 所以它立即保存、**下一轮自然生效**（面板上会明说这一点）。
    if (patch.dailyGoal || patch.balance !== undefined) buildContainer();
    persist();
    emit();
  }

  /**
   * 换词库：**真的把词换掉**。
   *
   * ⚠️ 这里曾经是个真 bug（用户报「显示更换成功但主页没反应」）：
   * 设置页的下拉框只调了 `updateSettings({ collections: [id] })`，
   * 而 updateSettings 只在 dailyGoal / balance 变化时重建容器 ——
   * 于是换库只改了一个设置字段：`state.words` 还是老词库的，
   * `state.container` 还是老的（多半已经背完、空着）。
   * 今日页因此永远停在「今天没有需要复习的词」，怎么换都不动。
   *
   * 而 `L.loadCollection()` 全仓库原本**只在 init() 里调用一次**，
   * 所以"换库"从来没有真正加载过另一个词库。
   *
   * 现在按和 init() 同样的顺序做：重载词表 → 重种记忆 → 重建今日队列。
   *
   * @param {string} id 词库 id（L.COLLECTIONS 里的）
   * @returns {Promise<{ok:boolean, count?:number, offline?:boolean, error?:string}>}
   */
  async function changeCollection(id) {
    const coll = String(id || '').trim();
    if (!coll) {
      const error = '词库 id 是空的';
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }
    // ⚠️ 必须校验词库 id 是**认识的**。
    // loadCollection() 对不认识的 id 不会报错，它会返回四级种子词、
    // 只是把 id 前缀换掉（见 library.mjs 的 seedFor）→ 于是"换库成功"是假的：
    // 界面上说成功、设置里写了新 id，实际背的还是四级那批词换个名字。
    // 这类"不认识的输入被默许"正是这一串 bug 的共同病根。
    const known = Object.keys(L.COLLECTIONS || {});
    if (known.length && !known.includes(coll)) {
      const error = `没有「${coll}」这个词库`;
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }
    if (coll === (state.settings.collections?.[0] || '')) {
      // 选的还是当前这本：不重建，免得把正在背的那一轮清掉
      state.lastLibraryChange = { ok: true, unchanged: true, at: now() };
      emit();
      return { ok: true, count: (state.words || []).length, unchanged: true };
    }

    // 词表可能来自网络；失败不能把状态搞坏，所以先加载、成功了再改设置。
    let res;
    try {
      res = await L.loadCollection(coll, { fetcher: ports.fetcher, cache: cachePort() });
    } catch (e) {
      const error = (e && e.message) || '词库加载失败';
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }
    if (!res || !Array.isArray(res.words) || !res.words.length) {
      const error = '这个词库里没有词';
      state.lastLibraryChange = { ok: false, error, at: now() };
      emit();
      return { ok: false, error };
    }

    state.settings = normalizeSettings({ ...state.settings, collections: [coll] });
    state.words = mergePersonal(res.words, state.personal);
    // 只对新词库的词补记忆种子；已有记忆原样保留（换库不该清掉学习记录）
    state.mem = L.seedMemories(state.words, state.mem, now());
    state.offline = res.offline;
    state.banner = res.banner;
    state.librarySource = res.source;
    // 换库结果要能被**重绘正确地渲染出来**，不能只写在 DOM 上：
    // buildContainer() 会 emit() → 整页重建，临时写进 DOM 的提示会被冲掉。
    state.lastLibraryChange = { ok: true, count: state.words.length, collection: coll, at: now() };

    // 关键的一步：重建今日队列。
    // 这会丢掉当前这一轮（未答完的部分）—— 和改 dailyGoal 的既有行为一致。
    // 换库本质上就是"换一批词"，留着旧队列反而更让人困惑。
    buildContainer();
    persist();
    emit();
    return { ok: true, count: state.words.length, offline: !!res.offline, source: res.source };
  }

  /** 主动休假（§7.7）：有钥匙的退出，比偷偷溜走更容易回来。 */
  function setVacation(untilTs) {
    state.settings.vacationUntil = untilTs;
    persist();
    emit();
  }

  // ── 生词本（§10）──
  function addPersonal(word, { context = null, source = null } = {}) {
    const id = word.id || `personal:${String(word.word).toLowerCase()}`;
    /*
     * 收录时**自动补释义**。
     *
     * 之前这里是照抄调用方给的内容，而唯一的调用点传的是 `meaning: ''`
     * —— 于是生词本里永远显示「（还没释义）」。可内置 6 个词库（29,841 词）
     * 本来就带音标和释义，只是从来没人去查过。
     *
     * 顺序：**调用方明确给了就用给的**（以后悬浮条可能会带上上下文里的释义），
     * 只有缺了才去词库查。查得到就把音标/词性/释义一起补上；查不到才留空，
     * 由界面显示「（还没释义）」并给出手填入口。
     *
     * `lookupWord` 读的是打包进产物的种子数据，所以这里是同步、离线、零等待的。
     */
    const given = {
      ipa: word.ipa || '',
      pos: word.pos || '',
      meaning: word.meaning || '',
    };
    const hit = given.meaning ? null : L.lookupWord(word.word, word.collection || null);
    const entry = {
      id,
      word: word.word,
      ipa: given.ipa || (hit ? hit.ipa : ''),
      pos: given.pos || (hit ? hit.pos : ''),
      meaning: given.meaning || (hit ? hit.meaning : ''),
      example: context || word.example || null,
      collection: 'personal',
      personal: true,
      addedTs: now(),
      source,
      // 释义哪来的：'manual' 人填的 / 'lookup' 词库查到的 / '' 还没有
      meaningSource: given.meaning ? 'manual' : (hit ? 'lookup' : ''),
      seq: 100000 + state.personal.length,
    };
    state.personal = [...state.personal.filter((p) => p.id !== id), entry];
    state.words = mergePersonal(state.words, [entry]);
    state.mem = L.seedMemories([entry], state.mem, now());
    persist();
    emit();
    return entry;
  }

  /**
   * 手动给生词本里的某个词补/改释义（界面上那个手填入口）。
   *
   * 为什么要有：查词库查不到的（人名、缩写、生僻词、词组）总得有个出口。
   * 之前那一行**完全没有编辑入口**，用户只能删掉重来 —— 而重来还是空的。
   */
  function setPersonalMeaning(id, meaning) {
    const text = String(meaning ?? '').trim();
    const cur = (state.personal || []).find((p) => p.id === id);
    if (!cur) return null;
    const next = { ...cur, meaning: text, meaningSource: text ? 'manual' : '' };
    state.personal = state.personal.map((p) => (p.id === id ? next : p));
    state.words = mergePersonal(state.words, [next]);
    persist();
    emit();
    return next;
  }

  function removePersonal(id) {
    state.personal = state.personal.filter((p) => p.id !== id);
    persist();
    emit();
  }

  /**
   * 「今天没记住的几个词」—— 生词本页那条提示的数据源。
   *
   * 用户的实测反馈：「我今天背的不熟的也会加进去」。他原话里没说多不熟算不熟，
   * 所以我选了**最容易被用户预判**的口径 —— **今天答错过的词**。
   * 没用「记忆强度低于某阈值」那种口径：用户没法从界面上知道一个词现在强度
   * 是多少，那样弹出来的提示会显得无缘无故。
   *
   * 已经在生词本里的词不重复提示（用户已经认可过了）。
   * 返回的是**词对象数组**，因为界面要显示单词和释义。
   */
  function unfamiliarToday() {
    const seen = new Set();
    const out = [];
    const inPersonal = new Set((state.personal || []).map((p) => p.id));
    // 这个函数**每次快照渲染都会跑一遍**（界面读 st.unfamiliarCount），
    // 所以按 id 建一次 Map 再查，别对每个候选做一遍 O(n) 的 find ——
    // 词表 7000 词 × 今天 200 条记录那个量级下是 140 万次比较，白卡一帧。
    const byId = new Map();
    for (const w of state.words || []) if (w && w.id) byId.set(w.id, w);
    for (const it of state.container?.items || []) {
      if (it && it.word && it.word.id && !byId.has(it.word.id)) byId.set(it.word.id, it.word);
    }
    for (const r of state.records || []) {
      if (r.dayKey !== state.dayKey) continue;   // 只看今天
      if (!r.incorrect) continue;                // 只看答错的
      const wid = r.wordId;
      if (!wid || seen.has(wid) || inPersonal.has(wid)) continue;
      seen.add(wid);
      const w = byId.get(wid);
      if (w) out.push(w);
    }
    return out;
  }

  /** 把「今天没记住的几个词」一次性收进生词本（用户点了提示上的按钮）。 */
  function addUnfamiliarToday() {
    const list = unfamiliarToday();
    if (!list.length) return 0;
    for (const w of list) addPersonal(w, { source: '今日没记住' });
    return list.length;
  }

  /** 用户点了提示上的「先不用」：今天不再提示（存盘，重开也不再弹）。 */
  function dismissUnfamiliarHint() {
    state.hintDismissedDay = state.dayKey;
    persist();
    emit();
  }

  /** 今天这条提示是否已经被用户「先不用」掉了（跨天自动恢复）。 */
  function dismissHintToday() {
    return state.hintDismissedDay === state.dayKey;
  }

  /**
   * 已收服的生词本词条 → 自动从**列表**里移走，同时留一条档案。
   *
   * 用户的要求：「真正确定收服就可以自动删」+「留记录」。
   *
   * 三条安全边界（这是会动数据的地方，必须写清楚）：
   *   1. **只动 `state.personal` 这一个列表。** 不碰 `mem`（记忆强度/稳定性）、
   *      不碰 `records`（答题记录）、不碰 `confusions`。判定哪怕算错，
   *      代价也只是一行从列表里挪走。
   *   2. `state.words` 每次 init 都由「词库 + state.personal」重建，
   *      所以挪走**不丢词** —— 词还在词库里，下次忘了照样能排进队列。
   *   3. 档案只存最小信息（词、id、时间、原词库）。词目能按 id 查回来
   *      （`L.lookupWord`），不重复存一份，省体积。
   *
   * 判定用的既有硬标准：`M.isConquered` = 强度 ≥ 0.9 **且**在辨词里答对过。
   *
   * @returns {number} 本次移走几条
   */
  function archiveConqueredPersonal() {
    const list = state.personal || [];
    if (!list.length) return 0;
    const t = now();
    const gone = list.filter((p) => {
      const m = state.mem?.[p.id];
      return !!m && M.isConquered(m, t);
    });
    if (!gone.length) return 0;
    const goneIds = new Set(gone.map((p) => p.id));
    state.personal = list.filter((p) => !goneIds.has(p.id));
    state.archivedPersonal = [
      ...(state.archivedPersonal || []),
      ...gone.map((p) => ({ id: p.id, word: p.word, ts: t, collection: p.collection || null })),
    ];
    persist();
    emit();
    return gone.length;
  }

  // ── 情绪胶囊（§3）──
  function beckon() {
    return B.beckonState({
      now: now(),
      hasRecords: state.records.length > 0,
      streak: state.streak,
      gapDays: gapDays(),
      dueCount: state.container ? state.container.stats.dueTotal : 0,
      deferredCount: state.container ? state.container.stats.deferred : 0,
      containerDone: state.container ? state.container.done || 0 : 0,
      containerSize: state.container ? state.container.stats.containerSize : 0,
      session: state.session,
      streamActive: !!ports.isStreaming?.(),
      roundJustFinished: !!state.roundJustFinished,
      paused: state.pause,
      vacationUntil: state.settings?.vacationUntil,
      combo: state.combo,
      longest: state.streak.longest,
    });
  }

  // ── 记忆钩子「✨ 让我记住它」（§9）──
  // 规格：每词一生只付一次，结果写回本地永久复用；失败不阻塞卡片。
  //
  // 这里**总是能成功**：钩子由 hook.mjs 从词库的真实材料（词根/例句/搭配/
  // 易混词）组出来，离线可算、不编造、零等待。所以那句
  // 「✨ 暂时没编出来 · 重试」在这条路径上不会出现 —— 它只该在
  // **接了真 AI 且 AI 真的挂了**时出现（规格 §9 的原意）。
  const hookCache = createHookCache({ storage });

  /**
   * 取某个词的记忆钩子。有缓存直接返回（零等待），没有就生成 + 永久写回。
   * @returns {Promise<{text, source, sourceLabel, word, cached}>}
   */
  async function hookFor(wordOrId) {
    const word =
      typeof wordOrId === 'string'
        ? state.container?.items?.find((c) => c.word && c.word.id === wordOrId)?.word ||
          (state.personal || []).find((w) => w.id === wordOrId) ||
          null
        : wordOrId;
    if (!word) return null;
    const { hook, cached } = await hookCache.ensure(word);
    return { ...hook, cached };
  }

  /** 只读查询，不触发生成（设置页/词本页要看"编过没有"）。 */
  async function hookPeek(wordId) {
    return hookCache.get(wordId);
  }

  function persist() {
    storage.set('state', {
      settings: state.settings,
      mem: state.mem,
      confusions: state.confusions,
      personal: state.personal,
      streak: state.streak,
      combo: state.combo,
      exp: state.exp,
      pause: state.pause,
      history: state.history,
      // 已收服档案 / 提示忽略日期 —— 少写一个就等于每次重开都丢。
      archivedPersonal: state.archivedPersonal,
      hintDismissedDay: state.hintDismissedDay,
    });
    if (state.session) storage.set('session', S.snapshot(state.session));
  }

  return {
    init,
    subscribe,
    get state() {
      return snapshotState();
    },
    raw: state,
    buildContainer,
    restartRound,
    extendRound,
    allowMoreNew,
    rate,
    next,
    undo,
    quiz,
    answerQuiz,
    flagQuestion,
    reportFakeMastery,
    retention,
    updateSettings,
    changeCollection,
    setVacation,
    addPersonal,
    removePersonal,
    setPersonalMeaning,
    unfamiliarToday,
    addUnfamiliarToday,
    dismissUnfamiliarHint,
    archiveConqueredPersonal,
    acceptProposal,
    dismissProposal,
    beckon,
    hookFor,
    hookPeek,
    refresh: () => {
      const key = Q.dayKey(now());
      // 跨天：新的一天要重新排容器，「自己往后背」的加量次数和本轮卡组也跟着重置。
      // 不重置的话，昨天点了 3 次加量会让今天一开场就是 N+15。
      if (key !== state.dayKey) {
        state.extendCount = 0;
        state.roundItems = null;
        state.dayKey = key;
        state.container = null;
        buildContainer();
        return;
      }
      state.dayKey = key;
      state.container = state.container ? { ...state.container } : null;
      emit();
    },
    persist,
  };
}

function defaultPrompts() {
  return {
    hook: [
      '角色：中文母语的英语学习者，正在做单词记忆卡片',
      '任务：为单词生成「一句话记忆钩子」',
      '硬约束：',
      '· 只用一句，不超 40 字',
      '· 词根词源只在有把握时使用，没把握改用场景联想',
      '· 严禁编造词源、编造释义',
      '· 禁止空洞套话（"多读多背就记住了"）',
      '· 中文输出',
      '输出：{ hook, example, collocation }',
    ].join('\n'),
    contrast: [
      '任务：为混淆对 {wordA, wordB} 生成一组辨析',
      '硬约束：',
      '· 必须包含「一句话区分法」，用最短锚点区分二者',
      '· 干扰项必须真难（音近/形近/义近），不许一眼假',
      '· 不许说"这两个词很容易混淆"之类的废话',
      '输出：{ anchor, contrast, quiz[4] }',
    ].join('\n'),
  };
}

/** 没有 storage port 时的内存实现（测试用）。 */
function memoryStorage() {
  const map = new Map();
  const lists = new Map();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    append(k, row) {
      const arr = lists.get(k) || [];
      arr.push(row);
      lists.set(k, arr);
    },
    list(k) {
      return lists.get(k) || [];
    },
  };
}
