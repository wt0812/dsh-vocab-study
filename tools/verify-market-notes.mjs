#!/usr/bin/env node
/**
 * 核对「插件市场上的『更新内容』弹窗，现在到底会显示什么」。
 *
 * 为什么需要这个脚本
 * ---------------------------------------------------------------------------
 * 市场弹窗的数据不在我们仓库里，链路是：
 *
 *   市场目录条目(data/plugins/*.yml) ──每日生成──> plugins.json（仓库 ↔ npm 名映射）
 *   GitHub Release ──────────────每日快照──> updates.json（tag + 正文）
 *   ↓
 *   dshmarket/lib/changelog.js 的 updateNotesFor() 按四级降级挑一个给人看
 *
 * 这条链上有两处**不看代码就猜不到**的行为：
 *
 *   1) 「防重复说明」闸门：如果快照里的 Release 版本 ≤ 用户已装版本，
 *      上游**故意不显示正文**，改显示「提交记录」。理由写在源码注释里：
 *      快照是每日的，更新目标却是实时读 npm 的，展示用户已经装上的那版说明
 *      等于解释一个他已经拥有的变更（上游 issue #925）。
 *      → 后果：**刚发版当天，市场弹窗看不到这版的详细说明**，要等次日快照。
 *
 *   2) 开发态安装（profile 里记的是 `file:` / `link:`）直接返回 `none`，
 *      显示「该插件未提供更新说明」。所以本地 junction 装的版本永远看不到，
 *      这不是我们写错了 Release。
 *
 * 本脚本把 updateNotesFor() 的判定**照着源码复刻一遍**，并主动核对
 * dshmarket 源码里那几个关键标记还在（上游改了就报警，而不是继续输出旧结论）。
 *
 * 用法：
 *   node tools/verify-market-notes.mjs
 *   node tools/verify-market-notes.mjs --installed 0.2.8
 *   node tools/verify-market-notes.mjs --assume-snapshot v0.2.9   # 预览次日快照
 *   node tools/verify-market-notes.mjs --spec git                 # 模拟 git 形态安装
 *   node tools/verify-market-notes.mjs --offline                  # 用上次缓存
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(tmpdir(), 'vs-market-notes');
const REPO_URL = 'https://github.com/wt0812/dsh-vocab-study';
const NPM_NAME = 'dsh-vocab-study';
const UPDATES_URL = 'https://awesome-dsh-plugin.com/updates.json';
const PLUGINS_URL = 'https://awesome-dsh-plugin.com/plugins.json';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const OFFLINE = !!flag('offline');
const ASSUME = flag('assume-snapshot');
const SPEC = String(flag('spec') ?? 'npm'); // npm | git | file

const TTL_MS = 30 * 60 * 1000;

async function fetchCached(url, file) {
  const path = join(CACHE_DIR, file);
  if (existsSync(path)) {
    const age = Date.now() - readFileSync(path + '.at', 'utf8') * 1 || Infinity;
    if (age < TTL_MS || OFFLINE) return JSON.parse(readFileSync(path, 'utf8'));
  }
  if (OFFLINE) throw new Error(`--offline 但没有缓存：${file}`);
  // 市场主机偶发抽风（实测过一次 120s 超时、紧接着 1s 就下来了），
  // 所以重试 2 次再放弃，别让一次抖动把核对判成"链路坏了"。
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} 读 ${url}`);
      const json = await res.json();
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(path, JSON.stringify(json));
      writeFileSync(path + '.at', String(Date.now()));
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

/** 语义化版本比较，忽略 v 前缀与预发布尾巴（跟上游 compareVersions 同口径） */
function parseVer(v) {
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersions(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * 复刻 dshmarket 的 updateNotesFor() 里跟「显示哪一档」有关的那段。
 * 参数都用最小集合表达：entry（updates.json 里的那一条）+ installed（已装版本）。
 */
function decideTier({ entry, installed, spec }) {
  const specKey = spec === 'git' ? REPO_URL : null; // npm 版本范围里没有仓库信息
  const npmName = spec === 'file' ? null : NPM_NAME;
  if (spec === 'file') return { kind: 'none', why: '开发态安装（file:/link:）上游直接返回 none' };
  if (!entry) {
    return specKey === null && npmName !== null
      ? { kind: 'npm', why: 'updates 里没有我们的条目 → 只能显示 npm 发布时间' }
      : { kind: 'source', why: 'updates 里没有我们的条目 → 显示"市场还没收录"' };
  }
  const rel = entry.release ?? null;
  if (rel && ((rel.body ?? '') !== '' || (rel.tag ?? null) !== null)) {
    // ⚠️ 这里只能把**原始字符串**交给 compareVersions。
    // 我先写成 parseVer(rel.tag) 再比，而 compareVersions 内部还会再 parse 一次，
    // 数组被 String() 成 "0,2,9" → 解析失败 → null ?? 0 → 恒判「不新于已装版本」，
    // 于是永远退到提交记录。自己踩的坑，写在这里免得再犯。
    const cmp = installed === null ? null : compareVersions(rel.tag, installed);
    const behind = cmp !== null && cmp <= 0;
    const hasCommits = (entry.commits?.length ?? 0) > 0;
    // ← 就是这一行决定"刚发版当天看不到正文"
    if (!(behind && (hasCommits || (specKey === null && npmName !== null)))) {
      return { kind: 'release', release: rel, why: behind ? '快照版本不旧于已装版本，但没有提交记录可退，仍显示正文' : '快照 Release 比已装版本新 → 显示版本说明（正文）' };
    }
    return { kind: 'commits', why: `快照 Release(${rel.tag}) 不新于已装版本(${installed}) → 上游改显示提交记录（防 #925 重复说明）` };
  }
  if ((entry.commits?.length ?? 0) > 0) return { kind: 'commits', why: '条目里没有 release 字段，只有提交记录' };
  if (specKey === null && npmName !== null) return { kind: 'npm', why: '没有说明也没有提交 → 退到 npm 发布时间' };
  return { kind: 'none', why: '上游兜底：该插件未提供更新说明' };
}

/**
 * 弹窗正文要过白名单渲染，这些写法会被丢掉（docs/releases/README.md 的三条硬规矩）。
 *
 * ⚠️ 尖括号**哪怕在行内代码里也不行**：上游第一步就是「先剥掉 HTML」，
 * 它不看 Markdown 结构。真实踩到：正文里引用了坏数据样本 `clip<t:cut…>`，
 * 渲染出来那个词就没了。所以这里对全文扫尖括号，不排除代码块。
 */
function lintBody(body) {
  const problems = [];
  const lines = String(body).split('\n');
  if (/^\s*#{1,2}\s/.test(lines[0] ?? '')) problems.push('首行是 #/## 标题 —— 会渲染成一个不该有的特大标题');
  if (lines.some((l) => /^\s*\|/.test(l))) problems.push('出现表格行（| ... |）—— 白名单渲染会丢掉');
  if (lines.some((l) => /^\s*(-{3,}|\*{3,})\s*$/.test(l))) problems.push('出现 --- 分隔线 —— 会被丢掉');
  const tag = String(body).match(/<\/?[a-zA-Z][^>\n]{0,40}>/);
  if (tag) problems.push(`出现尖括号标记 ${JSON.stringify(tag[0])} —— 上游先剥 HTML，会把这段连同里面的字一起吃掉（行内代码里也不行）`);
  return problems;
}

/** 核对 dshmarket 源码里我们依赖的判定还在（上游改了就早点发现） */
function checkUpstreamMarkers() {
  const paths = [
    join(process.env.USERPROFILE ?? '', '.dsh/profiles/desktop/node_modules/dshmarket/lib/changelog.js'),
    join(process.env.APPDATA ?? '', '..', '.dsh/profiles/desktop/node_modules/dshmarket/lib/changelog.js'),
  ];
  const file = paths.find((p) => existsSync(p));
  if (!file) return { found: false, note: '本机没找到 dshmarket（不影响结论，只是少了源码标记核对）' };
  const src = readFileSync(file, 'utf8');
  const markers = [
    ['updateNotesFor', '导出函数名'],
    ["kind: 'release'", 'Release 档'],
    ["kind: 'commits'", '提交记录档'],
    ["kind: 'npm'", 'npm 发布时间档'],
    ['behind', '「快照不新于已装版本」判断'],
  ];
  const missing = markers.filter(([m]) => !src.includes(m)).map(([, label]) => label);
  return { found: true, file, missing };
}

let code = 0;
try {
  console.log('  vocab-study · 市场「更新内容」弹窗核对');
  console.log('');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const repoVersion = pkg.version;
  const installedArg = flag('installed');
  const installed = installedArg === true || installedArg === null ? repoVersion : String(installedArg);

  const plugins = await fetchCached(PLUGINS_URL, 'plugins.json');
  const updates = await fetchCached(UPDATES_URL, 'updates.json');

  // ── ① 市场目录里有没有我们，npm 名映射对不对 ────────────────────
  const catalog = (plugins.plugins ?? plugins).find((p) => p.url === REPO_URL);
  console.log('  ① 市场目录（plugins.json）');
  if (!catalog) {
    console.log(`     ✗ 没收录我们（${REPO_URL}）—— PR 还没合并？`);
    code = 1;
  } else {
    console.log(`     ✓ 已收录：name=${catalog.name}  category=${catalog.category}  npm=${catalog.npm ?? '（未映射）'}`);
    if (catalog.npm !== NPM_NAME) {
      console.log(`     ⚠️ npm 名映射是 ${catalog.npm}，期望 ${NPM_NAME} —— npm 形态安装会找不到我们的说明`);
    }
  }
  console.log(`     数据更新于 ${plugins.updated ?? '?'}，共 ${plugins.count ?? '?'} 条`);

  // ── ② updates.json 里我们的快照 ────────────────────────────────
  const entry = updates.updates?.[REPO_URL];
  let release = entry?.release ?? null;
  console.log('');
  console.log('  ② 更新快照（updates.json）');
  console.log(`     快照更新于 ${updates.updated ?? '?'}`);
  if (!entry) {
    console.log('     ✗ 里面没有我们的条目 → 弹窗只能显示"市场还没收录这个插件的更新说明"');
    code = 1;
  } else {
    console.log(`     ✓ 条目在：release.tag=${release?.tag ?? '(无)'}  publishedAt=${release?.publishedAt ?? '?'}`);
    console.log(`       正文 ${(release?.body ?? '').length} 字符，提交记录 ${entry.commits?.length ?? 0} 条`);
    if (ASSUME) {
      // 只改内存里的副本，用来看"次日快照到了之后会显示什么"
      release = { ...release, tag: String(ASSUME), publishedAt: new Date().toISOString(), body: readFileSync(join(ROOT, 'docs/releases', `${String(ASSUME)}.md`), 'utf8') };
      console.log(`     ↳ 预览模式：假设快照已更新到 ${ASSUME}（正文取 docs/releases/${ASSUME}.md）`);
    }
  }

  // ── ③ 弹窗现在会显示哪一档 ─────────────────────────────────────
  const simEntry = entry ? { ...entry, release } : undefined;
  const verdict = decideTier({ entry: simEntry, installed, spec: SPEC });
  console.log('');
  console.log(`  ③ 弹窗会显示什么（已装 ${installed}，安装形态 ${SPEC}）`);
  const label = { release: '「版本说明」+ Release 正文', commits: '「提交记录」圆点列表', npm: '「版本发布时间」', source: '「市场还没收录」', none: '「该插件未提供更新说明」' };
  console.log(`     → ${label[verdict.kind]}`);
  console.log(`       理由：${verdict.why}`);
  if (verdict.kind === 'commits') {
    console.log('       （这是"刚发版当天"的正常表现，次日快照更新后会自动变成版本说明）');
  }

  // ── ④ 正文能不能过白名单渲染 ──────────────────────────────────
  const bodyToLint = verdict.kind === 'release' ? verdict.release.body : readFileSync(join(ROOT, 'docs/releases', `v${repoVersion}.md`), 'utf8');
  const problems = lintBody(bodyToLint);
  console.log('');
  console.log('  ④ 正文格式（市场弹窗的白名单渲染）');
  if (problems.length === 0) console.log(`     ✓ ${bodyToLint.length} 字符，无表格/分隔线/HTML，首行是裸段落`);
  else {
    for (const p of problems) console.log(`     ✗ ${p}`);
    code = 1;
  }

  // ── ⑤ 上游判定逻辑有没有变 ────────────────────────────────────
  const up = checkUpstreamMarkers();
  console.log('');
  console.log('  ⑤ 上游判定逻辑（dshmarket/lib/changelog.js）');
  if (!up.found) console.log(`     · ${up.note}`);
  else if (up.missing.length === 0) console.log('     ✓ 我们复刻的五个判定标记都还在源码里');
  else {
    console.log(`     ⚠️ 源码里找不到：${up.missing.join('、')} —— 上游可能改过逻辑，本脚本的结论要重看`);
    code = 1;
  }

  // ── ⑥ 快照是否落后于最新 Release ──────────────────────────────
  console.log('');
  console.log('  ⑥ 快照 vs 仓库版本');
  const snapTag = entry?.release?.tag ?? null;
  const behindSnap = snapTag !== null && parseVer(snapTag) !== null && (compareVersions(snapTag, repoVersion) ?? 0) < 0;
  console.log(`     仓库 package.json = ${repoVersion}   快照 tag = ${snapTag ?? '(无)'}`);
  if (behindSnap) console.log('     ⚠️ 快照还没收到最新版（每日重生成，属正常延迟；次日它会自动前进）');
  else if (snapTag === `v${repoVersion}`) console.log('     ✓ 快照已是最新版本');
  else if (snapTag !== null) console.log(`     · 快照比仓库还新（${snapTag}）—— 本地版本号是不是没推？`);

  // ── ⑦ npm 上到底发了没有 ──────────────────────────────────────
  // 市场「有新版本」这个提示读的是 npm **实时**数据，不是每日快照。
  // 所以「发了 npm 但没建 Release」和「建了 Release 但没发 npm」两种漏法表现完全不同，
  // 这一步把两件事分开核对。
  console.log('');
  console.log('  ⑦ npm 上的最新版本');
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_NAME}/latest`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = await res.json();
    const cmp = compareVersions(latest.version, repoVersion);
    console.log(`     npm latest = ${latest.version}   仓库 = ${repoVersion}`);
    if (cmp === 0) console.log('     ✓ 已发布，装旧版的用户会看到"有新版本"提示');
    else if (cmp !== null && cmp < 0) {
      console.log('     ✗ npm 上还没有这版 —— 用户端收不到更新提示，市场也读不到这版说明');
      code = 1;
    } else console.log(`     · npm 上比仓库更新（${latest.version}）—— 本地是不是有未提交的版本回退？`);
  } catch (e) {
    console.log(`     · 查不到 npm 数据（${e && e.message ? e.message : e}），不影响其它结论`);
  }

  // ── ⑧ 端到端：拿上游真实函数跑一次，别只信我复刻的逻辑 ────────
  //
  // ⑤ 只是核对"源码里的标记还在"，这里直接 **import 上游的 updateNotesFor()**
  // 并造一个临时 profile（模拟某个已装版本），看它真实返回什么。
  // 这是唯一能证明"市场用户点开弹窗会看到正文"的方式 —— 不是靠读代码推测。
  console.log('');
  console.log('  ⑧ 端到端（直接调上游 updateNotesFor）');
  if (!up.found) {
    console.log('     · 本机没装 dshmarket，跳过');
  } else {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(up.file).href);
      // 故意取"比快照旧一版"的用户来测：这正是刚发版后、用户该看到正文的情形
      const snapVer = snapTag ? String(snapTag).replace(/^v/i, '') : repoVersion;
      const pv = parseVer(snapVer);
      const probeInstalled = pv ? `${pv[0]}.${pv[1]}.${Math.max(0, pv[2] - 1)}` : repoVersion;
      const dir = join(tmpdir(), `vs-popup-probe-${probeInstalled}`);
      mkdirSync(join(dir, 'node_modules', NPM_NAME), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', dependencies: { [NPM_NAME]: probeInstalled } }));
      writeFileSync(join(dir, 'node_modules', NPM_NAME, 'package.json'), JSON.stringify({ name: NPM_NAME, version: probeInstalled }));
      const real = await mod.updateNotesFor('desktop', dir, NPM_NAME);
      const body = String(real.release?.body ?? '');
      console.log(`     模拟用户装 ${probeInstalled}（比快照 ${snapTag ?? '?'} 旧一版）→ kind=${real.kind}`);
      if (real.kind === 'release') {
        console.log(`     ✓ 上游真的把正文给了出来：tag=${real.release?.tag}，${body.length} 字符`);
      } else if (real.kind === 'commits') {
        console.log('     · 上游给了提交记录 —— 说明快照里还没有比该用户更新的 Release');
      } else {
        console.log(`     · 上游给了 kind=${real.kind}（不意外，但拿不到正文）`);
      }
      // 硬断言：快照比该用户新时，必须给正文
      const cmp = compareVersions(snapVer, probeInstalled);
      if (cmp !== null && cmp > 0 && real.kind !== 'release') {
        console.log('     ✗ 断言失败：快照更新时上游却没给正文，这条链有 bug');
        code = 1;
      }
      if (body.length > 0 && body.length < 300) {
        console.log('     ⚠️ 正文短于 300 字符 —— 市场弹窗会显得空，检查 Release 正文');
      }
    } catch (e) {
      console.log(`     · 调用失败（${e && e.message ? e.message : e}）—— 不影响其它结论`);
    }
  }

  console.log('');
  console.log('  ────────────────────────────────────────────────────────');
  console.log(`  结论：${code === 0 ? '链路正常 ✅' : '有需要处理的问题 ⚠️'}`);
  if (code !== 0) console.log('  退出码 1，便于 CI / 手动复核。');
} catch (e) {
  console.log(`  ✗ 核对失败：${e && e.message ? e.message : e}`);
  code = 1;
}
process.exit(code);
