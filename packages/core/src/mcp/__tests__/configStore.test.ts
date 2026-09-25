import { describe, it, expect } from 'vitest';
import { expandEnvVars, getMcpServerSignature, dedupServers } from '../configStore.js';
import type { MCPServerEntry } from '../configStore.js';

describe('expandEnvVars', () => {
  it('expands existing env vars', () => {
    process.env.TEST_MCP_VAR = 'hello';
    const { expanded, missingVars } = expandEnvVars({
      id: 'test',
      transport: 'stdio',
      command: '${TEST_MCP_VAR}-world',
    });
    expect(expanded.command).toBe('hello-world');
    expect(missingVars).toEqual([]);
    delete process.env.TEST_MCP_VAR;
  });

  it('reports missing vars', () => {
    const { expanded, missingVars } = expandEnvVars({
      id: 'test',
      transport: 'stdio',
      command: '${NONEXISTENT_VAR_XYZ}',
    });
    expect(expanded.command).toBe('${NONEXISTENT_VAR_XYZ}');
    expect(missingVars).toContain('NONEXISTENT_VAR_XYZ');
  });

  it('expands in args and env', () => {
    process.env.TEST_ARG = 'arg-val';
    process.env.TEST_ENV = 'env-val';
    const { expanded } = expandEnvVars({
      id: 'test',
      transport: 'stdio',
      command: 'cmd',
      args: ['--flag=${TEST_ARG}'],
      env: { KEY: '${TEST_ENV}' },
    });
    expect(expanded.args![0]).toBe('--flag=arg-val');
    expect(expanded.env!.KEY).toBe('env-val');
    delete process.env.TEST_ARG;
    delete process.env.TEST_ENV;
  });

  it('expands URL for SSE servers', () => {
    process.env.MCP_HOST = 'example.com';
    const { expanded } = expandEnvVars({
      id: 'test',
      transport: 'sse',
      url: 'https://${MCP_HOST}/mcp',
    });
    expect(expanded.url).toBe('https://example.com/mcp');
    delete process.env.MCP_HOST;
  });
});

describe('getMcpServerSignature', () => {
  it('generates stdio signature from command + args', () => {
    const sig = getMcpServerSignature({
      id: 'a',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    expect(sig).toBe('stdio:["node","server.js"]');
  });

  it('generates URL signature for SSE', () => {
    const sig = getMcpServerSignature({
      id: 'b',
      transport: 'sse',
      url: 'https://example.com/mcp',
    });
    expect(sig).toBe('url:https://example.com/mcp');
  });

  it('returns null for servers without command/url', () => {
    const sig = getMcpServerSignature({
      id: 'c',
      transport: 'stdio',
    });
    expect(sig).toBeNull();
  });
});

describe('dedupServers', () => {
  it('removes duplicates by signature', () => {
    const servers: MCPServerEntry[] = [
      { id: 'server-a', transport: 'stdio', command: 'node', args: ['s.js'], scope: 'user' },
      { id: 'server-b', transport: 'stdio', command: 'node', args: ['s.js'], scope: 'workspace' },
    ];
    const { deduped, suppressed } = dedupServers(servers);
    expect(deduped.length).toBe(1);
    expect(deduped[0].id).toBe('server-b'); // workspace wins
    expect(suppressed.length).toBe(1);
    expect(suppressed[0].id).toBe('server-a');
  });

  it('keeps servers with different signatures', () => {
    const servers: MCPServerEntry[] = [
      { id: 'a', transport: 'stdio', command: 'node', args: ['a.js'], scope: 'user' },
      { id: 'b', transport: 'stdio', command: 'python', args: ['b.py'], scope: 'user' },
    ];
    const { deduped } = dedupServers(servers);
    expect(deduped.length).toBe(2);
  });

  it('handles servers without signatures', () => {
    const servers: MCPServerEntry[] = [
      { id: 'no-cmd', transport: 'stdio', scope: 'user' },
      { id: 'with-cmd', transport: 'stdio', command: 'node', scope: 'user' },
    ];
    const { deduped } = dedupServers(servers);
    expect(deduped.length).toBe(2);
  });
});
