/**
 * 运行时解析「这一轮是不是聊天」(chat:C1-01 / C1-02)
 *
 * 客户端显式带 chatMode 就以它为准 (用户刚在界面上切过); 没带 (手机 / 旧客户端) 才回落
 * sessions.chat_mode —— 桌面开的聊天会话换个客户端接着聊仍然是聊天。
 * 读库失败 (CLI / eval / 旧库没这一列) 当没设过, 不挡这一轮。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const stored = new Map<string, boolean>();
let throwOnRead = false;

vi.mock('@neoxlabs/platform/platform/database.js', async (orig) => ({
  ...(await orig<object>()),
  getDatabase: () => ({
    getSessionChatMode: (id: string) => {
      if (throwOnRead) throw new Error('db closed');
      return stored.has(id) ? stored.get(id)! : null;
    },
  }),
}));

const { resolveChatMode } = await import('../chatSessionMode.js');

beforeEach(() => {
  stored.clear();
  throwOnRead = false;
});

describe('resolveChatMode', () => {
  it('客户端显式 true → 聊天 (不看库)', () => {
    stored.set('s1', false);
    expect(resolveChatMode({ chatMode: true }, 's1')).toBe(true);
  });

  it('客户端显式 false → 不是聊天, 库里的旧值不翻盘', () => {
    stored.set('s1', true);
    expect(resolveChatMode({ chatMode: false }, 's1')).toBe(false);
  });

  it('没带 chatMode → 读会话记录 (1 → 聊天)', () => {
    stored.set('s1', true);
    expect(resolveChatMode({ agentMode: 'work' }, 's1')).toBe(true);
  });

  it('没带 chatMode, 记录是 0 → 不是聊天', () => {
    stored.set('s1', false);
    expect(resolveChatMode({ agentMode: 'work' }, 's1')).toBe(false);
  });

  it('没带 chatMode, 记录 NULL → 不是聊天 (存量会话) 且不冒充', () => {
    expect(resolveChatMode({}, 's-none')).toBe(false);
  });

  it('agent_mode=chat (手机本机会话) 没记录也算聊天', () => {
    expect(resolveChatMode({ agentMode: 'chat' }, 's-phone')).toBe(true);
  });

  it('库不可用 → 当没设过, 不挡这一轮', () => {
    throwOnRead = true;
    expect(resolveChatMode({ agentMode: 'work' }, 's1')).toBe(false);
  });
});
