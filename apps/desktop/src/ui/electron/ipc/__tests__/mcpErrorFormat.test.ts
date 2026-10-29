import { describe, expect, it, vi } from 'vitest';

vi.mock('../ipcMainBridged.js', () => ({ ipcMain: { handle: vi.fn() } }));

const { formatMcpError } = await import('../mcpHandlers.js');

describe('formatMcpError', () => {
  it('包装层已含 cause 原话 → 不重复', () => {
    const cause = new Error('MCP error -32000: Connection closed');
    const wrapped = new Error('MCP error -32000: Connection closed\nserver stderr:\nmissing API_KEY', { cause });
    expect(formatMcpError(wrapped)).toBe('MCP error -32000: Connection closed\nserver stderr:\nmissing API_KEY');
  });

  it('cause 带新信息 → 串起来', () => {
    const err = new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND mcp.example.com') });
    expect(formatMcpError(err)).toBe('fetch failed: getaddrinfo ENOTFOUND mcp.example.com');
  });

  it('抛的是字符串 / 无 message → 不变成空', () => {
    expect(formatMcpError('boom')).toBe('boom');
    expect(formatMcpError({})).toBe('[object Object]');
  });
});
