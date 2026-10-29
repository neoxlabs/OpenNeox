import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setAuthHostBindings, authHost } from '../authHostBindings.js';

beforeEach(() => {
  /* 每条用例都从"没注入"开始 —— 注入是全局单例, 不重置会互相污染 */
  setAuthHostBindings({});
});

describe('auth 宿主注入点', () => {
  it('没注入时是安全空实现, 不抛 —— 广播失败不该让登录失败', () => {
    expect(() => authHost().broadcastAuthChanged({ userId: 'u1' })).not.toThrow();
    expect(authHost().legacyUserDataDir()).toBeNull();
  });

  it('注入后广播真的走到宿主, 且带上 payload', () => {
    const seen: Array<[Record<string, unknown>, number | undefined]> = [];
    setAuthHostBindings({ broadcastAuthChanged: (p, id) => { seen.push([p, id]); } });

    authHost().broadcastAuthChanged({ userId: 'u1' }, 7);

    expect(seen).toEqual([[{ userId: 'u1' }, 7]]);
  });

  it('excludeId 必须原样传给宿主 —— 少了它会有自我广播风暴', () => {
    const ids: Array<number | undefined> = [];
    setAuthHostBindings({ broadcastAuthChanged: (_p, id) => { ids.push(id); } });

    authHost().broadcastAuthChanged({}, 42);
    authHost().broadcastAuthChanged({});          /* 不排除任何人也是合法调用 */

    expect(ids).toEqual([42, undefined]);
  });

  it('部分注入时, 没给的那些回落到空实现 (而不是变成 undefined 后被调用炸掉)', () => {
    setAuthHostBindings({ legacyUserDataDir: () => '/tmp/ud' });

    expect(authHost().legacyUserDataDir()).toBe('/tmp/ud');
    expect(() => authHost().broadcastAuthChanged({})).not.toThrow();
    expect(typeof authHost().appVersion()).toBe('string');
  });

  it('authHandlers 自己不再直接 import electron 的 BrowserWindow', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'authHandlers.ts'), 'utf-8');

    /* 注释里提 BrowserWindow 无所谓, 代码里 import 它才是问题 */
    const codeLines = src.split('\n').filter((l) => {
      const t = l.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    });
    const offenders = codeLines.filter((l) => /import\(['"]electron['"]\)/.test(l) && /BrowserWindow/.test(l));
    expect(offenders, `authHandlers 又直接引 BrowserWindow 了:\n${offenders.join('\n')}`).toEqual([]);
  });
});
