import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

vi.mock('../../tools/runtimeTools.js', () => ({ getTools: vi.fn() }));

const { getTools } = await import('../../tools/runtimeTools.js');
const { prepareChatTurnTools, __resetChatToolPoolRepairForTests } = await import('../chatTurnTools.js');

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {} },
    execute: async () => `${name}-ok`,
  } as unknown as Tool;
}

const opts = (pool: Tool[]) => ({
  pool,
  workDir: '/tmp/neox-chat-turn-tools',
  services: {} as any,
});

describe('prepareChatTurnTools', () => {
  beforeEach(() => {
    vi.mocked(getTools).mockReset();
    __resetChatToolPoolRepairForTests();
  });

  it('池子正常: 只剩搜索 + 画图, 可用性如实报 true/true, 不重装', async () => {
    const pool = [fakeTool('readfile'), fakeTool('web_search'), fakeTool('generate_image'), fakeTool('execute_shell')];
    const turn = await prepareChatTurnTools(opts(pool));

    expect(turn.tools.map((t) => t.name)).toEqual(['web_search', 'generate_image']);
    expect(turn.tools.length).toBeGreaterThan(0);
    expect(turn.availability).toEqual({ search: true, image: true });
    expect(getTools).not.toHaveBeenCalled();
  });

  it('池子是空的 (没装好): 重装内置工具, 挑出两件', async () => {
    vi.mocked(getTools).mockResolvedValue([fakeTool('web_search'), fakeTool('generate_image'), fakeTool('readfile')] as any);

    const turn = await prepareChatTurnTools(opts([]));

    expect(getTools).toHaveBeenCalledTimes(1);
    expect(turn.tools.map((t) => t.name)).toEqual(['web_search', 'generate_image']);
    expect(turn.availability).toEqual({ search: true, image: true });
  });

  it('重装也拿不到 (真没能力): 空表 + 两件都报 false, 且整进程只重装一次', async () => {
    vi.mocked(getTools).mockResolvedValue([] as any);

    const first = await prepareChatTurnTools(opts([]));
    expect(first.tools).toEqual([]);
    expect(first.availability).toEqual({ search: false, image: false });

    const second = await prepareChatTurnTools(opts([]));
    expect(second.availability).toEqual({ search: false, image: false });
    expect(getTools).toHaveBeenCalledTimes(1);   /* 第二次不再装 */
  });

  it('只缺画图 (没登录也能搜): 可用性 search=true / image=false', async () => {
    const turn = await prepareChatTurnTools(opts([fakeTool('web_search')]));
    expect(turn.availability).toEqual({ search: true, image: false });
    expect(getTools).not.toHaveBeenCalled();
  });
});
