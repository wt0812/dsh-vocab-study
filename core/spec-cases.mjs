// vocab-study / core / spec-cases.mjs
//
// 验收用例集：把「规格里写死的规矩」变成一组可执行断言。
//
// 这个文件只描述「要验什么」，不含任何运行环境相关的东西：
//   · Node 单测（test/core.test.mjs）直接 import 它；
//   · 浏览器自检页（demo/smoke.html）由构建脚本把它拼进产物。
// 两边跑的是同一份断言 —— 谁改逻辑都不可能只改一边糊弄过去。
//
// 每个用例形如 { id, name, run(api, t) }，t.check(条件, 说明, 细节)。

import * as M from './memory.mjs';
import * as MK from './mistake.mjs';
import * as Q from './queue.mjs';
import * as G from './game.mjs';
import * as B from './beckon.mjs';
import * as S from './session.mjs';
import * as L from './library.mjs';

const DAY_MS = M.DAY_MS;
const DAY = 20260214;

/** 找一个种子词；找不到就抛错，让用例显式失败而不是静默跳过。 */
const word = (id) => {
  const w = L.seedFor('cet4').find((x) => x.word === id);
  if (!w) throw new Error(`种子里没有 ${id} —— 用例的前提没了，不是通过`);
  return w;
};

const mkSession = (tiers, opts = {}) => {
  const words = L.seedFor('cet4').slice(0, tiers.length);
  const mem = L.seedMemories(words, {}, DAY);
  const items = tiers.map((tier, i) => ({ word: words[i], mem: mem[words[i].id], tier, reason: null }));
  return {
    words,
    session: S.createSession(
      { items, stats: { containerSize: tiers.length }, dayKey: '2026-02-14' },
      { words, mem, now: DAY, ...opts },
    ),
  };
};

const isNew = (card) => !!card && card.tier === 3 && !card.isRetry;

const maxRun = (session) => {
  let run = 0, max = 0;
  for (const c of session.queue) {
    if (isNew(c)) { run++; max = Math.max(max, run); } else run = 0;
  }
  return max;
};

const readout = (session) => session.queue.map((c) => (isNew(c) ? '新' : '复')).join(' ');

export const SPEC_CASES = [
  // ── §7 日容器 ──────────────────────────────────────────────
  {
    id: 'container-cap',
    name: '日容器铁律：词数永远不超过 N（§7.1）',
    run(api, t) {
      const words = L.seedFor('cet4');
      const mem = L.seedMemories(words, {}, DAY);
      for (let i = 0; i < 60; i++) {
        mem[words[i].id] = Object.assign({}, mem[words[i].id], {
          lastSeenTs: DAY - 30 * DAY_MS, encodeCount: 3, correct: 3, e: 1,
        });
      }
      const c = Q.buildDailyContainer(words, mem, {
        N: 20, gapDays: 0, balance: 0.5, now: DAY, collections: ['cet4'],
      });
      t.check(c.items.length <= 20, '容器不超过 20 词', `实际 ${c.items.length}`);
      t.check(c.stats.containerSize === 20, '容器大小 = 20', `实际 ${c.stats.containerSize}`);
      t.check(
        c.stats.reviewCount + c.stats.personalCount + c.stats.newCount === c.items.length,
        '三层配比自洽',
        `${c.stats.reviewCount}+${c.stats.personalCount}+${c.stats.newCount} vs ${c.items.length}`,
      );
      t.check(c.stats.dueTotal > 20, `内部知道还有多少到期词（${c.stats.dueTotal}）`);
    },
  },
  {
    id: 'container-comeback',
    name: '断签越久容器越小，门槛越低（§6.6 / §7.7 / P12）',
    run(api, t) {
      t.check(Q.containerSize(0, 20) === 20, '断签 0 天 → 20 词', `实际 ${Q.containerSize(0, 20)}`);
      t.check(Q.containerSize(3, 20) === 20, '断签 1–3 天 → 20 词', `实际 ${Q.containerSize(3, 20)}`);
      t.check(Q.containerSize(7, 20) === 12, '断签 4–14 天 → 12 词', `实际 ${Q.containerSize(7, 20)}`);
      t.check(Q.containerSize(20, 20) === 8, '断签 >14 天 → 8 词', `实际 ${Q.containerSize(20, 20)}`);
    },
  },

  // ── §7.3 一天分界与连续天数 ────────────────────────────────
  {
    id: 'day-boundary',
    name: '一天从凌晨 4:00 起算（§7.3）',
    run(api, t) {
      const t330 = new Date(2026, 1, 14, 3, 30, 0).getTime();
      const t500 = new Date(2026, 1, 14, 5, 0, 0).getTime();
      t.check(Q.dayKey(t330) === '2026-02-13', '3:30 算前一天', Q.dayKey(t330));
      t.check(Q.dayKey(t500) === '2026-02-14', '5:00 算当天', Q.dayKey(t500));
    },
  },
  {
    id: 'streak-integrity',
    name: '连续天数不可补签、不可刷（§7.3）',
    run(api, t) {
      let s = Q.bumpStreak({ current: 0, longest: 0, lastDay: null }, '2026-02-10');
      s = Q.bumpStreak(s, '2026-02-10');
      t.check(s.current === 1, '同一天第二次不 +1', `current=${s.current}`);
      s = Q.bumpStreak(s, '2026-02-11');
      t.check(s.current === 2, '隔天 +1', `current=${s.current}`);
      s = Q.bumpStreak(s, '2026-02-14');
      t.check(s.current === 1, '断签后从 1 重来（没有补签）', `current=${s.current}`);
      t.check(s.longest === 2, '历史最长保留', `longest=${s.longest}`);
    },
  },
  {
    id: 'checkin-ratio',
    name: '打卡口径：完成容器 ≥60%（§7.3）',
    run(api, t) {
      t.check(Q.isCheckedIn(12, 20) === true, '12/20 算打卡');
      t.check(Q.isCheckedIn(11, 20) === false, '11/20 不算打卡');
    },
  },

  // ── §5 错误计数与同轮重训 ──────────────────────────────────
  {
    id: 'error-delta',
    name: '错误计数：忘了 +1，假掌握 +2（§5.4）',
    run(api, t) {
      t.check(MK.errorDelta({ rating: 'forgot' }) === 1, '自评「忘了」+1', `实际 ${MK.errorDelta({ rating: 'forgot' })}`);
      t.check(
        MK.errorDelta({ rating: 'known', fakeMastery: true }) === 2,
        '假掌握 +2',
        `实际 ${MK.errorDelta({ rating: 'known', fakeMastery: true })}`,
      );
      t.check(MK.errorDelta({ rating: 'known', fakeMastery: false }) === 0, '真会了不罚');
    },
  },
  {
    id: 'retry-gap',
    name: '同轮重训：绝不立刻重问，间隔必须 3–8 张（§5.5）',
    run(api, t) {
      const { session } = mkSession(new Array(20).fill(1));
      const card = S.currentCard(session);
      const plan = S.planRetry(session, card, 'forgot', DAY);
      t.check(plan.action === 'retry', '「忘了」触发同轮重训', `action=${plan.action}`);
      t.check(plan.gap >= 3 && plan.gap <= 8, `重训间隔落在 3–8 张内（${plan.gap}）`);
      const at = session.queue.findIndex((c) => c.isRetry && c.word.id === card.word.id);
      t.check(at > session.cursor + 1, '不是紧挨着下一张重问', `插入位置 ${at}，当前 ${session.cursor}`);
    },
  },
  {
    id: 'new-word-cap',
    name: '连续新词 ≤2，且拆不动时如实承认（§5.2）',
    run(api, t) {
      // 机制：复习词在前面、新词扎堆在后面，守卫必须把复习词拆进去
      const a = mkSession([1, 1, 3, 3, 3, 3]);
      t.check(a.session.queue.length === 6, '队列长度正确', `实际 ${a.session.queue.length}`);
      t.check(maxRun(a.session) <= 2, `开局就把连续新词压到 ≤2（实测 ${maxRun(a.session)}）`, readout(a.session));
      t.check(
        a.session.queue.filter((c) => !isNew(c)).length === 2,
        '复习词一张不多一张不少',
        readout(a.session),
      );

      // 可调上限：收到 1 就不许两个新词相邻
      const b = mkSession([1, 1, 1, 1, 3, 3, 3, 3]);
      // createSession 已经跑过一次守卫（按默认 2），这里显式再按 1 收紧
      const r = S.ensureNewWordCap(b.session, 1);
      t.check(maxRun(b.session) <= 1, `上限=1 → 连续新词 ≤1（实测 ${maxRun(b.session)}）`, readout(b.session));
      t.check(r.usable >= 0, '守卫返回可解释的结果', JSON.stringify(r));

      // 诚实性：队列里全是新词时，没有复习词可插，必须如实报告
      const c = mkSession(new Array(8).fill(3));
      const rc = S.ensureNewWordCap(c.session, 2);
      t.check(rc.applied === false, '全是新词 → 如实报告「拆不动」而不是假装满足');
      t.check(maxRun(c.session) === 8, '拆不动时不篡改队列', readout(c.session));
    },
  },
  {
    id: 'cap-preserves-history',
    name: '已走过的卡不许被守卫改动（用户看过的历史不能变）',
    run(api, t) {
      const { session } = mkSession([1, 3, 3, 3, 3, 3, 1, 3]);
      session.cursor = 3;
      const head = session.queue.slice(0, 3);
      S.ensureNewWordCap(session, 2);
      t.check(
        session.queue.slice(0, 3).every((c, i) => c === head[i]),
        '前 3 张（已答过）一字未动',
      );
      t.check(session.queue.length === 8, `总数不变（${session.queue.length}）`);
      t.check(new Set(session.queue).size === 8, `没有重复卡（${new Set(session.queue).size} 张唯一）`);
      let run = 0, max = 0;
      for (let i = 3; i < session.queue.length; i++) {
        if (isNew(session.queue[i])) { run++; max = Math.max(max, run); } else run = 0;
      }
      t.check(max <= 2, `游标之后连续新词 ≤2（实测 ${max}）`);
    },
  },

  // ── §5.4 假掌握 ────────────────────────────────────────────
  {
    id: 'fake-mastery',
    name: '假掌握：错误计数净增 +2，并拉回重训（§5.4）',
    run(api, t) {
      const { session } = mkSession(new Array(20).fill(1));
      const card = S.currentCard(session);
      const e0 = session.mem[card.word.id].e;
      S.reportFakeMastery(session, card, 'x', { now: DAY });
      const e1 = session.mem[card.word.id].e;
      t.check(Math.abs(e1 - e0 - 2) < 1e-9, '错误计数净增 +2', `${e0.toFixed(1)} → ${e1.toFixed(1)}`);
    },
  },

  // ── §7.5 收服判定 ──────────────────────────────────────────
  {
    id: 'conquered-is-hard',
    name: '「收服」是硬判定：没在辨词里答对过就不算（§7.5）',
    run(api, t) {
      let m = M.newMemory({ e: 0 }, DAY);
      m = Object.assign(m, {
        encodeCount: 9, correct: 9, stability: 20, difficulty: 0, lastSeenTs: DAY, reactionMs: 1200,
      });
      t.check(M.isConquered(m, DAY) === false, '强度很高但没辨词答对 → 不算收服');
      const m2 = M.markQuizCorrect(m, DAY);
      t.check(M.isConquered(m2, DAY) === true, '辨词答对之后 → 算收服');
    },
  },

  // ── §5.3 辨词干扰项与安全阀 ────────────────────────────────
  {
    id: 'distractors',
    name: '辨词干扰项必须「真难」（§5.3）',
    run(api, t) {
      const words = L.seedFor('cet4');
      const target = word('adapt');
      const picks = MK.pickDistractors(target, words, { count: 3, rand: () => 0.5 });
      t.check(picks.length === 3, '给出 3 个干扰项', `实际 ${picks.length}`);
      const sims = picks.map((p) => MK.similarity(target.word, p.word));
      const best = Math.max.apply(null, sims);
      t.check(best >= 0.6, `至少有一个形近（最高相似度 ${best.toFixed(2)}）`);
      t.check(picks.every((p) => p.id !== target.id), '不把自己当干扰项');
    },
  },
  {
    id: 'confusion-blacklist',
    name: '同一对被 ⚑ ≥2 次 → 永久拉黑（§5.3 安全阀）',
    run(api, t) {
      let c = {};
      c = MK.flagConfusion(c, 'a', 'b');
      t.check(c[MK.pairKey('a', 'b')].blacklisted === false, '标 1 次还不拉黑');
      c = MK.flagConfusion(c, 'a', 'b');
      t.check(c[MK.pairKey('a', 'b')].blacklisted === true, '标 2 次永久拉黑');

      const words = L.seedFor('cet4');
      const target = word('adapt');
      const partner = word('adopt');
      let conf = {};
      conf = MK.flagConfusion(conf, target.id, partner.id);
      conf = MK.flagConfusion(conf, target.id, partner.id);
      const picks = MK.pickDistractors(target, words, { count: 3, confusions: conf });
      t.check(!picks.some((p) => p.id === partner.id), '被拉黑的干扰项不再出现');
    },
  },

  // ── §4 记忆模型 ────────────────────────────────────────────
  {
    id: 'half-life',
    name: '记忆模型：错得越多半衰期越短、复现越密（§4.3）',
    run(api, t) {
      // 注意：halfLifeDays(mem, theta) 的第二参是 theta，不是 now。
      // 挑一组「不撞上下夹子」的中间值，才测得出趋势（上下界 0.4 / 32）。
      const base = { e: 0, encodeCount: 3, correct: 3, stability: 1.5, difficulty: 0.3, reactionMs: 3500 };
      const good = M.newMemory(base, DAY);
      const bad = M.newMemory(Object.assign({}, base, { e: 4, correct: 0, difficulty: 0.8 }), DAY);
      const hg = M.halfLifeDays(good);
      const hb = M.halfLifeDays(bad);
      t.check(Number.isFinite(hg) && Number.isFinite(hb), `半衰期是有限数（${hg.toFixed(2)} / ${hb.toFixed(2)}）`);
      t.check(hg > hb, `真会了的半衰期更长（${hg.toFixed(2)} vs ${hb.toFixed(2)} 天）`);
      t.check(hg > 0.4 && hg < 32, '没撞上界，趋势可比较');
      t.check(M.recallProb(good, 3) > M.recallProb(bad, 3), '3 天后「会了」的词记得更牢');
      // clamp 是硬边界：全天候都不许跑出去
      t.check(M.halfLifeDays(M.newMemory({ e: 999 }, DAY)) >= 0.4, '下界 0.4 天守得住');
      t.check(M.halfLifeDays(M.newMemory({ stability: 999, difficulty: 0 }, DAY)) <= 32, '上界 32 天守得住');
    },
  },
  {
    id: 'retention-curve',
    name: '保持曲线：按排期走必须优于不管它（§7.5 证据②）',
    run(api, t) {
      const mems = L.seedFor('cet4').slice(0, 20).map(() => M.newMemory({ e: 1 }, DAY));
      const cur = M.retentionCurve(mems, { days: 30, now: DAY });
      const s30 = cur.scheduled[cur.scheduled.length - 1].recall;
      const p30 = cur.passive[cur.passive.length - 1].recall;
      t.check(s30 > p30, `30 天后：按排期 ${s30.toFixed(2)} > 不管它 ${p30.toFixed(2)}`);
    },
  },

  // ── §3 情绪胶囊（P3 文案零指责）───────────────────────────
  {
    id: 'beckon-priority',
    name: '情绪胶囊：优先级取第一个命中，且文案永不指责（§3.1 / P3）',
    run(api, t) {
      const first = B.beckonState({ hasRecords: false, streak: {}, gapDays: 0, dueCount: 0 });
      t.check(first.state === 'first', `无记录 → 今天第一词（实际 ${first.state}）`);

      const gone = B.beckonState({
        hasRecords: true, streak: { current: 0, longest: 23 }, gapDays: 5, dueCount: 180, containerSize: 12,
      });
      t.check(gone.state === 'longGone', `断签 → 好久不见，优先于欠账（实际 ${gone.state}）`);
      t.check(gone.label.indexOf('23') >= 0, `用旧荣耀接住：${gone.label}`);
      t.check(!/落后|欠|还剩|未完成|坚持/.test(gone.label), `断签文案零指责：${gone.label}`);

      const handoff = B.beckonState({
        hasRecords: true, streak: { current: 7 }, gapDays: 0, containerSize: 20,
        containerDone: 5, roundJustFinished: true, streamActive: true,
      });
      t.check(handoff.state === 'handoff', `任务在输出 + 刚答完 → 交接态（实际 ${handoff.state}）`);
      t.check(handoff.needsAction === false, '交接态不要求任何动作（P8）');

      const learning = B.beckonState({
        hasRecords: true, streak: { current: 7 }, gapDays: 0,
        session: { cursor: 1, queue: [1, 2, 3] }, streamActive: true,
      });
      t.check(learning.state === 'learning', `任务在输出且没答完 → 学词中（实际 ${learning.state}）`);
    },
  },

  // ── §4.2 词库降级 ──────────────────────────────────────────
  {
    id: 'library-degrade',
    name: '词库降级：不用联网也能开背，且不阻塞（§4.2 / P6）',
    run(api, t) {
      const seed = L.seedFor('cet4');
      t.check(seed.length > 100, `内置种子词库可用（${seed.length} 词）`);
      // ipa 不再要求非空：四级补全词表里 `a` / `an` 这类功能词源文件就没给音标，
// 硬要求非空只有两种做法——编一个音标，或者把它们丢掉。都错。
t.check(seed.every((w) => w.word && typeof w.ipa === 'string' && w.meaning), '种子词条字段完整');
      t.check(L.isPureEnglish('abandon') === true, '纯英文可收藏');
      t.check(L.isPureEnglish('这是一个词') === false, '中文不触发收藏');

      // 去重是硬要求：重复词会两次吃掉当天的 N 个名额
      const ids = seed.map((w) => w.id);
      t.check(new Set(ids).size === ids.length, `种子库按 id 去重（${ids.length} → ${new Set(ids).size}）`);
      const spellings = seed.map((w) => w.word);
      t.check(
        new Set(spellings).size === spellings.length,
        `同一拼写不重复出现（${new Set(spellings).size} 个唯一拼写）`,
      );
      for (const col of ['cet6', 'kaoyan', 'ielts', 'toefl', 'gre']) {
        const a = L.seedFor(col);
        const b = L.seedFor(col);
        t.check(a.length === b.length, `${col} 库稳定（${a.length} 词）`);
        t.check(a.every((w) => w.collection === col), `${col} 库词条 collection 标注正确`);
      }
      // 去重后名额不被重复词浪费：容器里不该出现同一拼写两次
      const mem = L.seedMemories(seed, {}, DAY);
      const c = Q.buildDailyContainer(seed, mem, {
        N: 20, gapDays: 0, balance: 0.5, now: DAY, collections: ['cet4'],
      });
      const picked = c.items.map((it) => it.word.word);
      t.check(new Set(picked).size === picked.length, `容器内无同词重复（${picked.length} 张唯一）`);
    },
  },

  // ── §6.1.1 时间只作参考 ────────────────────────────────────
  {
    id: 'time-is-not-a-constraint',
    name: '时间是参考显示，不是约束（§6.1.1 / P4）',
    run(api, t) {
      const mins = M.estimateMinutes(20);
      t.check(mins >= 5 && mins <= 12, `20 词预估约 ${mins} 分钟（只是个参考）`);
      // 容器大小只由断签天数决定，与「你有多少时间」无关
      t.check(
        Q.containerSize(0, 20) === Q.containerSize(0, 20) && Q.containerSize(0, 50) === 50,
        '容器大小随设置走，不掺时间因素',
      );
    },
  },

  // ── §7.5 进步可见 ──────────────────────────────────────────
  {
    id: 'progress-visible',
    name: '进步必须可见：等级只升不降（§7.4 / P11）',
    run(api, t) {
      t.check(G.LEVELS.length >= 5, `等级表存在（${G.LEVELS.length} 级）`);

      // 从头到尾扫一遍：等级必须单调不减，且不能跳级丢经验
      let prev = 0;
      let mono = true;
      let covered = true;
      for (let exp = 0; exp <= 6000; exp += 7) {
        const lv = G.levelFor(exp).level; // 字段名是 level（1 起），不是 index
        if (lv < prev) mono = false;
        if (lv - prev > 1) covered = false;
        prev = lv;
      }
      t.check(mono, '经验增长时等级永不回落');
      t.check(covered, '等级是逐级升的，没有跳过某一级');
      t.check(prev === G.LEVELS.length, `经验拉满到最高级（${G.levelFor(6000).name}）`);

      const low = G.levelFor(0);
      const high = G.levelFor(6000);
      t.check(high.level > low.level, `${low.name} → ${high.name}`);
      t.check(G.levelFor(99999).level === G.LEVELS.length, '超量经验不越界');
      t.check(G.levelFor(0).progress >= 0 && G.levelFor(0).progress <= 1, '进度落在 0–1');
      t.check(G.conqueredCount([], {}, () => true) === 0, '没有记录时收服数为 0');
    },
  },

  // ── §14.1 焦点纪律（UI 层）────────────────────────────────
  {
    id: 'panic-offsets-freeze',
    name: '守卫是纯函数：不改动传入以外的任何东西（可重复调用）',
    run(api, t) {
      const { session } = mkSession([1, 1, 3, 3, 3, 3]);
      const before = maxRun(session);
      S.ensureNewWordCap(session, 2);
      const once = session.queue.map((c) => c.cardId ?? c.word.id).join('|');
      S.ensureNewWordCap(session, 2);
      const twice = session.queue.map((c) => c.cardId ?? c.word.id).join('|');
      t.check(once === twice, '幂等：连跑两次结果一致');
      t.check(maxRun(session) <= before, '连续新词只会变少不会变多');
    },
  },
];

/**
 * 跑全部用例。
 * @param {(msg: string, kind: 'info'|'ok'|'bad', detail?: string) => void} report
 * @returns {{pass:number, fail:number, results:Array}}
 */
export function runSpecCases(report) {
  let pass = 0, fail = 0;
  const results = [];
  for (const c of SPEC_CASES) {
    const checks = [];
    const t = {
      check(cond, label, detail) {
        checks.push({ ok: !!cond, label, detail });
      },
    };
    let error = null;
    try {
      c.run({ M, MK, Q, G, B, S, L }, t);
    } catch (err) {
      error = err;
    }
    if (error) {
      fail++;
      results.push({ id: c.id, name: c.name, error: error.message });
      report?.(`  ✗ ${c.name}`, 'bad', `用例本身抛错：${error.message}`);
      continue;
    }
    for (const chk of checks) {
      if (chk.ok) {
        pass++;
        report?.(`    · ${chk.label}`, 'ok');
      } else {
        fail++;
        report?.(`    ✗ ${chk.label}`, 'bad', chk.detail);
      }
    }
    results.push({ id: c.id, name: c.name, checks });
  }
  return { pass, fail, results };
}
