import { createRequire } from 'node:module';

/** 只解析一次: createRequire 每次都走一遍模块解析, 而这个结果在进程内不会变。 */
let cached: any | null | undefined;

/** 拿到 electron 模块; 不在 Electron 里返回 null。 */
export function electronOrNull(): any | null {
  if (cached !== undefined) return cached;
  if (!(process as any).versions?.electron) {
    cached = null;
    return cached;
  }
  try {
    cached = createRequire(import.meta.url)('electron') ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** 当前是不是真的跑在 Electron 里。 */
export function isElectron(): boolean {
  return electronOrNull() !== null;
}

export function requireElectron(what: string): any {
  const e = electronOrNull();
  if (!e) throw new Error(`[lazyElectron] 当前宿主不是 Electron, 做不了: ${what}`);
  return e;
}

export function lazyElectron<T = any>(prop: string): T {
  let real: any;
  return new Proxy(function () { /* 可 construct/调用的 target, 兼容 new BrowserWindow(...) */ } as any, {
    get: (_t, k) => {
      real ??= (requireElectron(`${prop}.${String(k)}`) as any)[prop];
      const v = real[k];
      return typeof v === 'function' ? v.bind(real) : v;
    },
    set: (_t, k, val) => {
      real ??= (requireElectron(`${prop}.${String(k)}=`) as any)[prop];
      real[k] = val;
      return true;
    },
    construct: (_t, args) => {
      real ??= (requireElectron(`new ${prop}()`) as any)[prop];
      return new real(...args);
    },
    apply: (_t, _this, args) => {
      real ??= (requireElectron(`${prop}()`) as any)[prop];
      return real(...args);
    },
  }) as T;
}
