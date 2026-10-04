import { describe, expect, it, vi, beforeEach } from 'vitest';

const stored = new Map<string, string>();
vi.mock('@neoxlabs/platform/platform/database.js', async (orig) => ({
  ...(await orig<object>()),
  getDatabase: () => ({ getSessionAgentMode: (id: string) => stored.get(id) ?? null }),
}));

const { AgenticRuntime } = await import('../agenticRuntime.js');
const getMode = (self: { sessionAgentModes: Map<string, string> }, sid: string) =>
  (AgenticRuntime.prototype as any).getSessionAgentMode.call(self, sid);

beforeEach(() => {
  stored.clear();
  delete process.env.NEOX_AGENT_MODE;
});

describe('getSessionAgentMode', () => {
  it('内存里没有 → 读库里这个会话的模式, 并记进内存', () => {
    stored.set('s-work', 'work');
    const self = { sessionAgentModes: new Map<string, string>() };
    expect(getMode(self, 's-work')).toBe('work');
    expect(self.sessionAgentModes.get('s-work')).toBe('work');
  });

  it('库里存的是已删的 assistant → 归 work', () => {
    stored.set('s-life', 'assistant');
    expect(getMode({ sessionAgentModes: new Map() }, 's-life')).toBe('work');
  });

  it('本轮请求带来的 (内存) 优先于库', () => {
    stored.set('s1', 'work');
    expect(getMode({ sessionAgentModes: new Map([['s1', 'code']]) }, 's1')).toBe('code');
  });

  it('库里也没有 → 还是走环境变量 / 全局默认', () => {
    process.env.NEOX_AGENT_MODE = 'work';
    expect(getMode({ sessionAgentModes: new Map() }, 's-none')).toBe('work');
  });
});
