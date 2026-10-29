import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let enabled = true;
vi.mock('../../../mcp/index.js', () => ({
  addMcpServer: vi.fn(),
  listMcpServers: vi.fn(() => []),
  removeMcpServer: vi.fn(() => true),
  updateMcpServer: vi.fn((_w: string, _s: string, _id: string, updates: { enabled?: boolean }) => {
    if (updates.enabled !== undefined) enabled = updates.enabled;
    return true;
  }),
}));

const { createMcpBridgeHandlers } = await import('../mcpBridgeHandlers.js');

const fakeTool = (name: string): Tool => ({
  name, description: name, parameters: { type: 'object', properties: {} }, function: async () => '',
} as unknown as Tool);

describe('bridge.updateMcpServer', () => {
  it('停用 server 后 agent 工具表里它的 mcp__ 工具被摘掉', async () => {
    const fakeManager = {
      getTools: vi.fn(async () => (enabled ? [fakeTool('mcp__srv__echo')] : [])),
    };
    const tools: Tool[] = [fakeTool('readfile'), fakeTool('mcp__srv__echo')];
    const bridge = createMcpBridgeHandlers({ workDir: '/tmp/ws', mcpManager: fakeManager as any, tools });

    expect(bridge.updateMcpServer!('user', 'srv', { enabled: false })).toBe(true);
    await vi.waitFor(() => expect(tools.map((t) => t.name)).toEqual(['readfile']));
    expect(fakeManager.getTools).toHaveBeenCalledWith({ refresh: true });
  });
});
