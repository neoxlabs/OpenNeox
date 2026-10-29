import { describe, expect, it } from 'vitest';
import { inferRemoteTransport } from '../mcpRemoteTransport';

describe('inferRemoteTransport', () => {
  it('跟 core 的 inferRemoteMcpTransport 同一套规则', () => {
    expect(inferRemoteTransport('http', 'https://x.dev/mcp')).toBe('http');
    expect(inferRemoteTransport('streamable-http', 'https://x.dev/mcp')).toBe('http');
    expect(inferRemoteTransport('sse', 'https://x.dev/mcp')).toBe('sse');
    expect(inferRemoteTransport(undefined, 'https://x.dev/sse')).toBe('sse');
    expect(inferRemoteTransport(undefined, 'https://x.dev/mcp')).toBe('http');
    expect(inferRemoteTransport(undefined, 'not a url')).toBe('http');
  });
});
