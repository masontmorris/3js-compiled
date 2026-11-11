// Web Storage. Reads come from a map in JavaScript. Each change goes to `sink`, which for localStorage is the
// host's writer thread, so a change costs the size of the change and never the size of the store.
const ENTRIES = Symbol('entries');
const SINK = Symbol('sink');
const QUOTA = Symbol('quota');
const USED = Symbol('used');

// Edge's quota per origin: 10 MiB of UTF-16, counted over keys and values.
export const STORAGE_QUOTA = 5 * 1024 * 1024;

export class Storage {
  constructor(entries = [], sink = null, quota = STORAGE_QUOTA) {
    this[ENTRIES] = new Map(entries.map(([key, value]) => [String(key), String(value)]));
    this[SINK] = sink;
    this[QUOTA] = quota;
    this[USED] = [...this[ENTRIES]].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
    return new Proxy(this, {
      get: (target, key, receiver) => typeof key === 'string' && !(key in target) && target[ENTRIES].has(key) ? target[ENTRIES].get(key) : Reflect.get(target, key, receiver),
      set: (target, key, value) => { if (typeof key === 'string' && !(key in Storage.prototype)) target.setItem(key, value); else target[key] = value; return true; },
      deleteProperty: (target, key) => { if (typeof key === 'string') target.removeItem(key); return true; },
      has: (target, key) => (typeof key === 'string' && target[ENTRIES].has(key)) || key in target,
      ownKeys: target => [...target[ENTRIES].keys()],
      getOwnPropertyDescriptor: (target, key) => typeof key === 'string' && target[ENTRIES].has(key)
        ? { value: target[ENTRIES].get(key), writable: true, enumerable: true, configurable: true } : undefined,
    });
  }
  get length() { return this[ENTRIES].size; }
  key(index) { return [...this[ENTRIES].keys()][index] ?? null; }
  getItem(key) { return this[ENTRIES].get(String(key)) ?? null; }
  setItem(key, value) {
    key = String(key);
    value = String(value);
    const old = this[ENTRIES].get(key);
    if (old === value) return;
    const used = this[USED] - (old === undefined ? 0 : key.length + old.length) + key.length + value.length;
    if (used > this[QUOTA]) throw new DOMException(`Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`, 'QuotaExceededError');
    this[USED] = used;
    this[ENTRIES].set(key, value);
    this[SINK]?.set(key, value);
  }
  removeItem(key) {
    key = String(key);
    const old = this[ENTRIES].get(key);
    if (old === undefined) return;
    this[USED] -= key.length + old.length;
    this[ENTRIES].delete(key);
    this[SINK]?.remove(key);
  }
  clear() {
    if (!this[ENTRIES].size) return;
    this[ENTRIES].clear();
    this[USED] = 0;
    this[SINK]?.clear();
  }
  get [Symbol.toStringTag]() { return 'Storage'; }
}
