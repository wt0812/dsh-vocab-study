// vocab-study / ui / eye-candy.mjs
// 「眼熟小组件」面板版：背完一轮后，在按钮区与数据带之间轮播今天已背过的词。
//
// 设计约束：
//   · 不交互、不计分、不影响学习记录；
//   · 面板版总是显示（有今天背过的词时），不需要设置项开关；
//   · 左侧边栏版由 adapter/dsh/client.js 里的 React 组件单独渲染，开关在设置页。

import { el, mount } from './dom.mjs';

export const EYE_CANDY_INTERVAL = 8000;

/**
 * 创建一个面板用眼熟小组件 DOM 节点。
 *
 * @param {object} app   core app 实例（需有 todayStudiedWords）
 * @param {object} st    当前快照
 * @returns {HTMLElement|null} 返回挂载后带 __eyeCandyTimer 的节点；无词时返回 null
 */
export function createEyeCandy(app, st) {
  const words = app.todayStudiedWords?.() || [];
  if (!words.length) return null;

  const root = el('div', { class: 'vs-eye-candy' });
  let index = Math.floor(Math.random() * words.length);

  const label = el('div', { class: 'vs-eye-label', text: '今天背过的词' });
  const closeBtn = el('button', {
    class: 'vs-eye-close',
    title: '隐藏',
    text: '×',
    onclick: () => {
      root.style.display = 'none';
    },
  });
  const wordEl = el('div', { class: 'vs-eye-word' });
  const phoneticEl = el('div', { class: 'vs-eye-phonetic' });
  const meaningEl = el('div', { class: 'vs-eye-meaning' });

  function show(i) {
    const w = words[i % words.length];
    wordEl.textContent = w.word || '';
    phoneticEl.textContent = w.ipa || '';
    meaningEl.textContent = w.meaning || '';
  }

  mount(root, label, closeBtn, wordEl, phoneticEl, meaningEl);
  show(index);

  const timer = setInterval(() => {
    index = (index + 1) % words.length;
    show(index);
  }, EYE_CANDY_INTERVAL);

  // 让外部在重绘或卸载时能清掉定时器，避免泄漏
  root.__eyeCandyTimer = timer;

  return root;
}
