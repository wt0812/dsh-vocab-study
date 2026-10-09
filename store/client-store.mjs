// vocab-study / store / client-store.mjs
//
// 持久化层：给 core/app.mjs 提供它要的那个 storage port。
//
// 存储契约（app.mjs 只依赖这四个方法）：
//   await get(key)        → 值或 null
//   await set(key, value) → 写入
//   append(key, row)      → 追加一条记录（列表语义，不重写整表）
//   list(key)             → 读出全部记录
//
// 三条规矩（都是规格里写死的，不是实现偏好）：
//   1. 数据存在**用户级**目录/键空间，跨工作区共享 —— 换工作区不许「进度消失」（§7.4）。
//   2. 多窗口同时开着时，第二个窗口**只读**，并且要明说，不许静默互相覆盖（§7.4）。
//   3. 绝不因为存储写失败就把用户正在做的操作卡住（P6 不阻塞）——
//      写不进去就降级成内存，只在状态里挂一个诚实的标记。

const NS = 'vocab-study';
const SCHEMA = 1;
const LOCK_KEY = `${NS}.v1.lock`;
const LOCK_TTL_MS = 8000;

/** 生成一个足够短的实例 id：同一个窗口内所有实例共用（用 sessionStorage 固定）。 */
function instanceId() {
  try {
    const k = `${NS}.tabId`;
    let id = globalThis.sessionStorage?.getItem(k);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      globalThis.sessionStorage?.setItem(k, id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

/**
 * localStorage 版 storage。
 *
 * @param {object} opts
 * @param {string} opts.namespace  键前缀（demo 用独立命名空间，不污染真插件数据）
 * @param {() => number} opts.now
 * @param {(msg:string)=>void} opts.onDegrade 写失败时通知上层（面板里会显示「只读」）
 */
export function createLocalStorage({ namespace = NS, now = () => Date.now(), onDegrade = null } = {}) {
  const myId = instanceId();
  let available = true;
  let degradedReason = null;
  let readOnly = false;
  let readOnlyReason = null;
  const mem = new Map(); // 降级时的内存兜底
  const lists = new Map();

  const k = (key) => `${namespace}:${key}`;

  const ls = (() => {
    try {
      const probe = `${namespace}:__probe__`;
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    } catch (err) {
      available = false;
      degradedReason = '浏览器拒绝写入本地存储';
      onDegrade?.(degradedReason);
      return null;
    }
  })();

  /** 抢写锁：拿到锁的窗口可写，其它窗口只读。锁有 TTL，崩溃的窗口不会永久锁死。 */
  function claimLock() {
    if (!ls) return;
    try {
      const raw = ls.getItem(LOCK_KEY);
      const held = raw ? JSON.parse(raw) : null;
      const fresh = held && now() - (held.ts || 0) < LOCK_TTL_MS;
      if (fresh && held.id !== myId) {
        readOnly = true;
        readOnlyReason = '另一个窗口正在使用词汇面板';
        return;
      }
      ls.setItem(LOCK_KEY, JSON.stringify({ id: myId, ts: now() }));
      readOnly = false;
      readOnlyReason = null;
    } catch {
      // 锁本身出错不该拦住用户
      readOnly = false;
    }
  }

  function renewLock() {
    if (!ls || readOnly) return;
    try {
      ls.setItem(LOCK_KEY, JSON.stringify({ id: myId, ts: now() }));
    } catch {
      /* 忽略 */
    }
  }

  claimLock();

  return {
    get namespace() {
      return namespace;
    },
    get readOnly() {
      return readOnly;
    },
    get readOnlyReason() {
      return readOnlyReason;
    },
    get degraded() {
      return !available;
    },
    get degradedReason() {
      return degradedReason;
    },
    /** 内容信号：多窗口下另一个窗口改了数据，这边可以据此提示重载。 */
    async get(key) {
      claimLock();
      if (!ls) return mem.has(key) ? mem.get(key) : lists.get(key) || null;
      try {
        const raw = ls.getItem(k(key));
        if (raw === null) {
          const arr = lists.get(key);
          return arr ? arr.slice() : null;
        }
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      claimLock();
      if (!ls || readOnly) {
        // 只读窗口：写到内存里，界面照常响应，但不落盘、不假装成功
        mem.set(key, value);
        return { ok: false, readOnly };
      }
      try {
        ls.setItem(k(key), JSON.stringify({ v: SCHEMA, value }));
        return { ok: true };
      } catch (err) {
        mem.set(key, value);
        if (!available) return { ok: false };
        available = false;
        degradedReason =
          err && /quota/i.test(String(err.name || err.message)) ? '本地存储已满，本次改动只在内存里' : '本地存储写入失败';
        onDegrade?.(degradedReason);
        return { ok: false };
      }
    },
    /** 追加一条记录。列表语义：不重写整表，避免 O(n²) 写放大。 */
    append(key, row) {
      claimLock();
      if (!ls || readOnly) {
        const arr = lists.get(key) || [];
        arr.push(row);
        lists.set(key, arr);
        return;
      }
      try {
        const cur = ls.getItem(k(key));
        const arr = cur ? JSON.parse(cur).value || [] : [];
        arr.push(row);
        ls.setItem(k(key), JSON.stringify({ v: SCHEMA, value: arr }));
      } catch {
        const arr = lists.get(key) || [];
        arr.push(row);
        lists.set(key, arr);
      }
    },
    list(key) {
      if (!ls) return (lists.get(key) || []).slice();
      try {
        const raw = ls.getItem(k(key));
        return raw ? JSON.parse(raw).value || [] : [];
      } catch {
        return [];
      }
    },
    renewLock,
    /** 主动放锁（窗口关闭/面板销毁）。 */
    releaseLock() {
      if (!ls) return;
      try {
        const raw = ls.getItem(LOCK_KEY);
        const held = raw ? JSON.parse(raw) : null;
        if (held && held.id === myId) ls.removeItem(LOCK_KEY);
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 纯内存实现：单测与「浏览器完全禁写」时的兜底。 */
export function createMemoryStorage() {
  const map = new Map();
  const lists = new Map();
  return {
    readOnly: false,
    readOnlyReason: null,
    degraded: false,
    async get(key) {
      return map.has(key) ? map.get(key) : lists.get(key) || null;
    },
    async set(key, value) {
      map.set(key, value);
      return { ok: true };
    },
    append(key, row) {
      const arr = lists.get(key) || [];
      arr.push(row);
      lists.set(key, arr);
    },
    list(key) {
      return (lists.get(key) || []).slice();
    },
    renewLock() {},
    releaseLock() {},
  };
}

/**
 * 选一个能用的 storage。localStorage 不可用就默默退到内存 —— 但把降级事实挂出来，
 * 面板会显示「只读」，而不是假装一切正常（P7 数据诚实）。
 */
export function createStorage(opts = {}) {
  if (typeof globalThis.localStorage === 'undefined') return createMemoryStorage();
  try {
    return createLocalStorage(opts);
  } catch {
    return createMemoryStorage();
  }
}
