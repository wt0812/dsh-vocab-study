#!/usr/bin/env node
/**
 * 查 npm 包的下载量：累计 / 近 30 天 / 近 7 天 / 有下载的日期明细。
 *
 * 为什么需要：npm 网页和市场卡片只展示「近 7 天 / 近 30 天」，
 * 没有现成的“累计”接口。这里用 registry 的首次发布时间当起点，
 * 按区间拉每日数据再自己累加，就能得到累计总量。
 *
 * 用法：
 *   node tools/downloads.mjs
 *   node tools/downloads.mjs dsh-vocab-study
 */
const PKG = process.argv[2] || 'dsh-vocab-study';
const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads';

const DAY = 24 * 60 * 60 * 1000;
const CHUNK_DAYS = 180;

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}：${url}`);
  }
  return res.json();
}

async function rangeDownloads(startMs, endMs) {
  const days = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_DAYS * DAY, endMs);
    const url = `${DOWNLOADS}/range/${ymd(cursor)}:${ymd(chunkEnd)}/${encodeURIComponent(PKG)}`;
    const data = await getJson(url);
    if (Array.isArray(data.downloads)) days.push(...data.downloads);
    cursor = chunkEnd + DAY;
  }
  return days;
}

async function main() {
  const meta = await getJson(`${REGISTRY}/${encodeURIComponent(PKG)}`);
  const created = meta.time?.created || null;
  const startMs = created ? new Date(created).getTime() : Date.now() - 365 * DAY;
  const endMs = Date.now();

  const days = await rangeDownloads(startMs, endMs);
  const total = days.reduce((sum, d) => sum + (Number(d.downloads) || 0), 0);
  const nonZero = days.filter((d) => (Number(d.downloads) || 0) > 0);

  const [lastMonth, lastWeek] = await Promise.all([
    getJson(`${DOWNLOADS}/point/last-month/${encodeURIComponent(PKG)}`),
    getJson(`${DOWNLOADS}/point/last-week/${encodeURIComponent(PKG)}`),
  ]);

  console.log(`包名: ${PKG}`);
  console.log(`首次发布: ${created ? created.slice(0, 10) : '未知（按近一年估算）'}`);
  console.log(`统计区间: ${ymd(startMs)} ~ ${ymd(endMs)}`);
  console.log('');
  console.log(`累计下载: ${total}`);
  console.log(`近 30 天: ${lastMonth.downloads}  (${lastMonth.start} ~ ${lastMonth.end})`);
  console.log(`近 7 天:  ${lastWeek.downloads}  (${lastWeek.start} ~ ${lastWeek.end})`);
  console.log('');
  console.log('有下载的日期:');
  if (!nonZero.length) {
    console.log('  （暂无）');
  } else {
    for (const d of nonZero) console.log(`  ${d.day}  ${d.downloads}`);
  }
}

main().catch((err) => {
  console.error(`查询失败: ${err.message}`);
  process.exit(1);
});
