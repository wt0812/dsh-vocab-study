// 词根词缀：查询层
//
// 数据在 core/roots-data.mjs（由 tools/make-roots.mjs 从 ECDICT 生成）。
// 这一层只做**查询和拼装**，不产生新的语言学事实。
//
// 铁律（规格 §9）：**查不到就是查不到。** 任何函数在查不到时返回 null / 空数组，
// 绝不「猜一个词根」或「编一句所以意思是…」。

import { ROOT_FAMILIES, WORD_ROOTS, MORPH_TABLE, WORD_MORPH } from './roots-data.mjs';
// 例句（Tatoeba，CC BY 2.0）与词源（Wiktionary，CC BY-SA 4.0）都是**生成产物**，
// 见 tools/make-examples.py / tools/make-etym.py。这一层只查，不生成。
import { EXAMPLES } from './examples-data.mjs';
import { ETYM } from './etym-data.mjs';

// 注意：这里**不**转出 ROOTS_COVERAGE。
// 摊平进同一作用域后，RSD 和 RT 各声明一个同名常量就是 SyntaxError（构建期会拦）。
// 要用覆盖率数字请直接从 core/roots-data.mjs 取 —— 那里才是唯一来源。

/**
 * 查这个词的真实例句 → `[英文, 中文]`，没有就是 null。
 *
 * 数据来自 Tatoeba 中英对照语料，取的是「最短且完整」的那一句。
 * **没有例句就返回 null** —— `ui/panel.mjs` 会自己去显示「暂无例句 / 生成」那条路。
 */
export function examplesOf(word) {
  const key = String(word ?? '').trim().toLowerCase();
  if (!key) return null;
  const hit = EXAMPLES[key];
  return Array.isArray(hit) ? hit : null;
}

/**
 * 查这个词的真实词源 → `{ kind, text }`，没有就是 null。
 *
 * `kind` 两种，界面上必须分开显示（混在一起就是骗人）：
 *   - `split`  构词拆解（维基模板明确给出前缀/后缀/复合词）→ 进「词根词缀」那一行
 *   - `origin` 只能追到来源（`来自拉丁语 stāmina`）      → 进单独的「词源」折叠块
 *
 * 这是**补漏**用的：我们手写词根表能拆的词优先走 decompose()，
 * 拆不出来的再问这里 —— 它能把「什么都没有」的那一半词的很大一部分救回来。
 */
export function originOf(word) {
  const key = String(word ?? '').trim().toLowerCase();
  if (!key) return null;
  const hit = ETYM[key];
  if (!Array.isArray(hit) || hit.length < 2) return null;
  return { kind: hit[0], text: hit[1] };
}


/** 把词规整成查表用的键（数据表里全是小写）。 */
function rootKeyOf(word) {
  return String(word ?? '')
    .trim()
    .toLowerCase();
}

/**
 * 一个词挂的家族下标列表（1-based）。查不到返回空数组。
 * @returns {number[]}
 */
function rootFamilyIndices(word) {
  const hit = WORD_ROOTS[rootKeyOf(word)];
  return Array.isArray(hit) ? hit : [];
}

/**
 * 一个词的构词结构：前缀 / 词根 / 后缀，查不到返回 `null`。
 *
 * 数据来自两张表：
 *   · WORD_ROOTS（ECDICT 例词）—— 覆盖 25%，带「同族词」，优先用它；
 *   · WORD_MORPH（tools/morph-table.mjs 手写标准构词法表切分）—— 补到约 48%。
 *
 * 两套不混着报同一个位：有 ECDICT 词根就用 ECDICT 的（能连上同族词），
 * 没有才用手写表的词根。前缀/后缀一律来自手写表。
 *
 * @param {string} word
 * @returns {{prefixes: {k:string,m:string}[], roots: {k:string,m:string}[], suffixes: {k:string,m:string}[]}|null}
 */
export function morphOf(word) {
  const key = rootKeyOf(word);
  const idx = WORD_MORPH[key];
  const prefixes = [];
  const roots = [];
  const suffixes = [];

  // 先用 ECDICT 的家族条目（它带同族词，能连起来看）
  for (const f of rootFamiliesOf(key)) {
    if (!f || !f.key) continue;
    const kind = String(f.kind || '');
    const piece = { k: f.key, m: f.meaning };
    if (kind === '前缀') prefixes.push(piece);
    else if (kind.includes('后缀')) suffixes.push(piece);
    else roots.push(piece);
  }

  // 手写表只补 ECDICT **没有提供的那一类**，避免同一行出现两遍 ab-/abs-。
  if (Array.isArray(idx)) {
    if (!prefixes.length && idx[0]) {
      const t = MORPH_TABLE[idx[0] - 1];
      if (t) prefixes.push({ k: `${t.k}-`, m: t.m });
    }
    if (!roots.length && idx[1]) {
      const t = MORPH_TABLE[idx[1] - 1];
      if (t) roots.push({ k: t.k, m: t.m });
    }
    if (!suffixes.length && idx[2]) {
      const t = MORPH_TABLE[idx[2] - 1];
      if (t) suffixes.push({ k: `-${t.k}`, m: t.m });
    }
  }
  if (!prefixes.length && !roots.length && !suffixes.length) return null;
  return { prefixes, roots, suffixes };
}

/**
 * 词根词缀拆解，一行文本；查不到返回 `null`。
 *
 * 输出形如：
 *   distribute → "前缀 dis- · 词根 tribut(给予、分配)"
 *   skillful   → "后缀 -ful(充满…的)"
 *
 * ⚠️ 只有「前缀/词根/后缀(含义)」这种**事实**，后面**绝不加**「→ 所以意思是…」那半句。
 *    那半句是解释、是人的话，从词表里推不出来；编出来就是编词源。
 *    test/roots.test.mjs 有断言专门守这个。
 *
 * @param {string} word
 * @returns {string|null}
 */
export function decompose(word) {
  const m = morphOf(word);
  if (!m) return null;
  const parts = [];
  for (const p of m.prefixes) parts.push(`前缀 ${p.k}${p.m ? `(${p.m})` : ''}`);
  for (const r of m.roots) parts.push(`词根 ${r.k}${r.m ? `(${r.m})` : ''}`);
  for (const s of m.suffixes) parts.push(`后缀 ${s.k}${s.m ? `(${s.m})` : ''}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * 同族词：和这个词共享至少一个词根的其他词（**都在我们词库里**）。
 *
 * 为什么要它：词根拆解只能告诉用户「tract = 拉」，
 * 但真正帮助记忆的是「你认识的 attract / contract / distract 也是这一家」——
 * 这是从真实词库里查出来的语境，不是编的例句。
 *
 * 查不到、或那个家族只有它自己，返回空数组。
 *
 * @param {string} word
 * @returns {{word: string, root: string, kind: string}[]}
 */
export function relativesOf(word) {
  const key = rootKeyOf(word);
  const idx = rootFamilyIndices(key);
  if (!idx.length) return [];
  const seen = new Set([key]);
  const out = [];
  for (const i of idx) {
    const f = ROOT_FAMILIES[i - 1];
    if (!f || !Array.isArray(f.family)) continue;
    for (const member of f.family) {
      if (seen.has(member)) continue;
      seen.add(member);
      out.push({ word: member, root: f.key, kind: f.kind });
    }
  }
  return out;
}

/**
 * 这个词的词根家族（原始条目）。
 * @param {string} word
 * @returns {{key: string, kind: string, meaning: string, origin: string, family: string[]}[]}
 */
export function rootFamiliesOf(word) {
  const idx = rootFamilyIndices(word);
  const out = [];
  for (const i of idx) {
    const f = ROOT_FAMILIES[i - 1];
    if (f) out.push(f);
  }
  return out;
}

/**
 * 给「记忆钩子」用的最短一行（core/hook.mjs 的 ROOT 来源读它）。
 * 和 decompose 同源，只是把多个词根用 `;` 隔开，避免和 `+` 混在一起难读。
 */
export function rootLine(word) {
  const text = decompose(word);
  return text || null;
}
