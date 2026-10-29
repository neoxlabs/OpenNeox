import { beforeEach, describe, expect, it, vi } from 'vitest';

class MemStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const listeners = new Set<() => void>();
const setSessionChatMode = vi.fn(async (_id: string, _on: boolean) => ({ ok: true }));

function installGlobals() {
  const storage = new MemStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('CustomEvent', class { type: string; constructor(t: string) { this.type = t; } });
  vi.stubGlobal('window', {
    neox: { setSessionChatMode },
    addEventListener: (_t: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_t: string, fn: () => void) => { listeners.delete(fn); },
    dispatchEvent: () => { for (const fn of listeners) fn(); return true; },
  });
  return storage;
}

async function load() {
  vi.resetModules();
  return import('../chatModeStore');
}

beforeEach(() => {
  listeners.clear();
  setSessionChatMode.mockClear();
  installGlobals();
});

describe('chatModeStore · 会话记录是真源', () => {
  it('切换时同时落库, 不是只写 localStorage', async () => {
    const store = await load();
    store.setChatMode('s1', true);
    expect(store.isChatMode('s1')).toBe(true);
    expect(setSessionChatMode).toHaveBeenCalledWith('s1', true);
  });

  it('会话记录里的值兜底: 本机没切过的会话按记录走 (换客户端 / 重装)', async () => {
    const store = await load();
    expect(store.isChatMode('s1', true)).toBe(true);
    expect(store.isChatMode('s1', false)).toBe(false);
    expect(store.isChatMode('s1', null)).toBe(false); // 没设过 + 默认 Agent
  });

  it('本机切过的值优先于记录 (切的同时已经写库)', async () => {
    const store = await load();
    store.setChatMode('s1', true);
    expect(store.isChatMode('s1', false)).toBe(true);
  });

  it('没钉过的会话 pin 时按默认值落库', async () => {
    const store = await load();
    store.setChatMode(null, true); // 只改默认 (新会话沿用)
    store.pinChatMode('s-new');
    expect(store.isChatMode('s-new')).toBe(true);
    expect(setSessionChatMode).toHaveBeenCalledWith('s-new', true);
  });

  it('新设备打开记录里的聊天会话, 首次发送不会按本机默认值把它钉成 Agent', async () => {
    const store = await load();
    store.setChatMode(null, false); // 本机默认 Agent
    store.pinChatMode('s-chat', true);
    expect(store.isChatMode('s-chat')).toBe(true);
    expect(setSessionChatMode).toHaveBeenLastCalledWith('s-chat', true);
  });

  it('已经钉过的会话 pin 不覆盖它的值, 但会补写库 (存量会话第一次发消息)', async () => {
    const store = await load();
    store.setChatMode('s1', false);
    store.setChatMode(null, true);
    store.pinChatMode('s1');
    expect(store.isChatMode('s1')).toBe(false);
    expect(setSessionChatMode).toHaveBeenLastCalledWith('s1', false);
  });

  it('写库失败不影响界面状态', async () => {
    setSessionChatMode.mockRejectedValueOnce(new Error('db down'));
    const store = await load();
    expect(() => store.setChatMode('s1', true)).not.toThrow();
    expect(store.isChatMode('s1')).toBe(true);
  });
});
