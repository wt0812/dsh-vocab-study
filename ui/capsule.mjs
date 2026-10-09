// vocab-study / ui / capsule.mjs
// 情绪胶囊：输入框工具栏里那一格。
//
// 规格 §2.3 的落点是 conversation.input.right（模型选择器正前方）。
// 这个组件只认 props：{ label, tone, visible }。
// 它不要求任何动作 —— 像同伴轻轻说一句，不是系统弹窗（§3.2）。

import { el, setText, prefersReducedMotion } from './dom.mjs';

export function createCapsule(ctx = {}) {
  const root = el('button', {
    class: 'vs vs-capsule',
    type: 'button',
    title: '今日背单词',
    'aria-label': '今日背单词',
    dataset: { tone: 'fresh' },
  });
  const dot = el('span', { class: 'vs-cap-dot' });
  const label = el('span', { class: 'vs-cap-label' });
  root.append(dot, label);

  let lastState = null;
  let rippleTimer = null;

  root.addEventListener('click', () => ctx.onToggle?.());

  function render(b) {
    if (!b) return;
    root.hidden = b.visible === false;
    root.dataset.tone = b.tone?.key || 'fresh';
    if (b.tone?.textColor) root.style.color = '';
    setText(label, b.label || '');

    // 达成时一次轻微涟漪，3 秒后沉静（§5.1：一轮结束不做全屏庆祝）
    const justDone = b.state === 'done' && lastState !== 'done';
    if (justDone && !prefersReducedMotion()) {
      root.dataset.ripple = '1';
      clearTimeout(rippleTimer);
      rippleTimer = setTimeout(() => {
        root.dataset.ripple = '0';
      }, 900);
    }
    lastState = b.state;
  }

  function destroy() {
    clearTimeout(rippleTimer);
  }

  return { root, render, destroy };
}
