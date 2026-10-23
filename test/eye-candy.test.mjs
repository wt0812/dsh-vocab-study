// vocab-study / test / eye-candy.test.mjs
//
// 眼熟小组件验收：
//   · 默认不在左侧边栏显示
//   · todayStudiedWords 只返回今天答过的不同词
//
// 跑法：node test/eye-candy.test.mjs

import { createApp } from '../core/app.mjs';
import * as S from '../core/session.mjs';

const GREEN = '\x1b[32m', RED = '\x1b[31m', OFF = '\x1b[0m';
let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${GREEN}✓${OFF} ${name}`); }
  else { fail++; console.log(`  ${RED}✗${OFF} ${name}${detail ? ` (${detail})` : ''}`); }
}

console.log('vocab-study · 眼熟小组件验收\n');

const startOfDay = () => new Date(2026, 9, 9, 9, 0, 0, 0).getTime();
let clock = startOfDay();

const app = createApp({ now: () => clock });
await app.init();

ok('默认不在左侧边栏显示', app.state.settings.eyeCandy.showInSidebar === false);
ok('开局 todayStudiedWords 为空', app.todayStudiedWords().length === 0);

// 答 3 个不同词
let answered = 0;
while (answered < 3) {
  if (app.state.roundFinished) break;
  app.rate(S.RATING.KNOWN);
  app.next();
  answered++;
}

const studied = app.todayStudiedWords();
ok('答 3 个后 todayStudiedWords 有 3 个不同词', studied.length === 3);
ok('返回的词不重复', new Set(studied.map((w) => w.id)).size === studied.length);
ok('每个词都有单词/音标/释义字段', studied.every((w) => w.word && typeof w.meaning === 'string'));

if (fail) {
  console.log(`\n${RED}失败 ${fail} 项${OFF}`);
  process.exit(1);
}
console.log(`\n${GREEN}全部通过。${OFF}`);
