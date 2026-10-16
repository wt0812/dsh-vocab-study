// 把各平台配图统一重编号：0-操作步骤 / 1-正文 / 2,3,4... 配图
// 两步重命名（先改成临时名，再改成目标名）避免中途撞名
//
// 用法: node tools/renumber-assets.mjs

import { readdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';

import { assetsDir, asset } from './assets-dir.mjs';
const R = assetsDir;

// 每个平台：旧图文件名 -> 新序号（从 2 开始）
const plans = {
  '04-小红书': {
    '1-封面.png': 2, '2-背词界面.png': 3, '3-进度与热力图.png': 4, '4-生词本.png': 5,
    '5-设置.png': 6, '6-功能巡览.gif': 7, '7-测试全绿.png': 8, '8-社交卡片.png': 9,
  },
  '05-少数派': {
    '1-题图.png': 2, '2-背词界面.png': 3, '3-进度与热力图.png': 4,
    '4-生词本.png': 5, '5-设置.png': 6, '6-功能巡览.gif': 7,
  },
  '06-Appinn': {
    '1-背词界面.png': 2, '2-进度与热力图.png': 3, '3-生词本.png': 4,
    '4-设置.png': 5, '5-功能巡览.gif': 6, '6-题图.png': 7,
  },
  '08-B站': {
    '1-封面-带界面.png': 2, '2-封面-备选.png': 3, '3-分镜参考.gif': 4,
  },
  '09-掘金': {
    '1-头图.png': 2, '2-背词界面.png': 3, '3-进度与热力图.png': 4, '4-社交卡片.png': 5,
  },
  '10-知乎': {
    '1-背词界面.png': 2, '2-进度与热力图.png': 3, '3-生词本.png': 4, '4-设置.png': 5,
  },
  '11-抖音': {
    '1-封面-竖版.png': 2, '2-封面-带界面.png': 3,
  },
};

// 新名去掉文件名里的 "N-" 前缀，重新加序号
const newName = (old, n) => {
  const base = old.replace(/^\d+-/, '');
  return `${n}-${base}`;
};

for (const [folder, map] of Object.entries(plans)) {
  const dir = `${R}/${folder}`;
  const present = readdirSync(dir);

  // 第一步：全部改成临时名
  const staged = [];
  for (const [old, n] of Object.entries(map)) {
    if (!present.includes(old)) { console.log(`  ⚠️ ${folder} 找不到 ${old}`); continue; }
    const tmp = `__tmp__${old}`;
    renameSync(`${dir}/${old}`, `${dir}/${tmp}`);
    staged.push({ tmp, target: newName(old, n) });
  }
  // 第二步：临时名 -> 目标名
  for (const s of staged) {
    renameSync(`${dir}/${s.tmp}`, `${dir}/${s.target}`);
  }
  console.log(`  ✅ ${folder}  重编号 ${staged.length} 个`);

  // 删掉旧的「一键复制」文件（已被 1-正文 取代）
  for (const f of readdirSync(dir)) {
    if (f.startsWith('一键复制')) { unlinkSync(`${dir}/${f}`); console.log(`     删除旧文件 ${f}`); }
  }

  // 旧的原稿 md（内容已并入 0-操作步骤 / 1-正文）→ 删掉避免混淆
  const stale = {
    '04-小红书': ['文案.md'],
    '05-少数派': ['投稿正文.md'],
    '06-Appinn': ['Appinn-发帖正文.md', '投稿信息卡.md'],
    '08-B站': ['视频脚本.md'],
    '09-掘金': ['技术文章.md'],
    '10-知乎': ['回答草稿.md'],
    '11-抖音': ['短视频文案.md'],
  }[folder] || [];
  for (const f of stale) {
    if (existsSync(`${dir}/${f}`)) { unlinkSync(`${dir}/${f}`); console.log(`     归档旧稿 ${f}`); }
  }
}

console.log('');
console.log('  === 重构结果 ===');
for (const folder of Object.keys(plans).sort()) {
  console.log(`── ${folder}`);
  for (const f of readdirSync(`${R}/${folder}`).sort()) console.log(`     ${f}`);
}
