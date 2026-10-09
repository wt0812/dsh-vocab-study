// vocab-study / ui / dom.mjs
// 极小的 DOM 工具。刻意不引入任何 UI 框架：
// 插件要跟宿主共享一个页面，DOM 越小、依赖越少，越不容易跟 DSH 的样式打架。

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  // 子节点允许嵌套数组，也允许 null/false 这种「条件不成立就什么都不放」的写法
  const append = (c) => {
    if (c === null || c === undefined || c === false || c === true) return;
    if (Array.isArray(c)) {
      for (const inner of c) append(inner);
      return;
    }
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  };
  for (const c of [].concat(children)) append(c);
  return node;
}

const h = el;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function mount(parent, ...nodes) {
  clear(parent);
  const place = (n) => {
    if (n === null || n === undefined || n === false || n === true) return;
    if (Array.isArray(n)) {
      n.forEach(place);
      return;
    }
    if (!(n instanceof Node)) {
      // 这类 bug 的典型后果是整块界面静默不渲染，所以直接点名报出来
      throw new TypeError(
        `mount() 收到了非节点值：${Object.prototype.toString.call(n)} ` +
          `（parent=<${parent.tagName?.toLowerCase() || '?'} class="${parent.className || ''}">）`,
      );
    }
    parent.appendChild(n);
  };
  nodes.forEach(place);
  return parent;
}

/** 只在内容真的变了时才写 DOM —— 避免无谓的重排，也让文本选区不被打断。 */
function setText(node, text) {
  if (!node) return;
  const next = text == null ? '' : String(text);
  if (node.textContent !== next) node.textContent = next;
}

function setClass(node, cls, on) {
  if (!node) return;
  if (on) node.classList.add(cls);
  else node.classList.remove(cls);
}

function toggle(node, on) {
  if (!node) return;
  node.hidden = !on;
}

/** 聚焦到卡片正文（带 tabindex 的容器），不抢输入框焦点。 */
function focusSelf(node) {
  if (!node) return;
  try {
    node.focus({ preventScroll: true });
  } catch {
    /* 忽略 */
  }
}

function prefersReducedMotion() {
  try {
    return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export { el, h, clear, mount, setText, setClass, toggle, focusSelf, prefersReducedMotion };
