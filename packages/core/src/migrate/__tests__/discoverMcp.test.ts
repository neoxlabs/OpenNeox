import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverExternalMcpServers, normalizeMcpId, toMcpServerConfig } from '../discoverMcp.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-migrate-'));
});
afterEach(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeClaudeJson(obj: unknown): void {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(obj), 'utf-8');
}

describe('discoverExternalMcpServers', () => {
  it('扫得到 Claude Code 的**全局** mcpServers', () => {
    writeClaudeJson({ mcpServers: { global1: { command: 'run-global' } } });
    const out = discoverExternalMcpServers([], home);
    expect(out.map((c) => c.id)).toEqual(['global1']);
    expect(out[0].transport).toBe('stdio');
  });

  it('扫得到 Claude Code 的 **per-project** mcpServers —— 少扫这一处换台机器就漏', () => {
    writeClaudeJson({
      mcpServers: {},
      projects: {
        '/Users/x/repo-a': { mcpServers: { fromproj: { command: 'run-proj' } } },
        '/Users/x/repo-b': { mcpServers: {} },
      },
    });
    const out = discoverExternalMcpServers([], home);
    expect(out.map((c) => c.id)).toEqual(['fromproj']);
    expect(out[0].sourceProject).toBe('/Users/x/repo-a');
  });

  it('有 url 的是远程: 无 type 且不以 /sse 结尾 → http (Streamable HTTP); /sse 结尾 → sse', () => {
    writeClaudeJson({ mcpServers: {
      remote: { url: 'https://a.example/mcp' },
      legacy: { url: 'https://b.example/sse' },
    } });
    const byId = Object.fromEntries(discoverExternalMcpServers([], home).map((c) => [c.id, c.transport]));
    expect(byId).toEqual({ remote: 'http', legacy: 'sse' });
  });

  it('既没 command 也没 url 的条目**不猜**, 直接跳过', () => {
    writeClaudeJson({ mcpServers: { broken: { note: 'nothing useful' } } });
    expect(discoverExternalMcpServers([], home)).toEqual([]);
  });

  it('坏 JSON 不该让整次扫描炸 —— 这一个源跳过即可', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ not json', 'utf-8');
    expect(() => discoverExternalMcpServers([], home)).not.toThrow();
    expect(discoverExternalMcpServers([], home)).toEqual([]);
  });

  it('同名 server 在多处配过只列一次 (用户常两边都装)', () => {
    writeClaudeJson({
      mcpServers: { dup: { command: 'from-global' } },
      projects: { '/p': { mcpServers: { dup: { command: 'from-project' } } } },
    });
    const out = discoverExternalMcpServers([], home);
    expect(out).toHaveLength(1);
    expect(out[0].command).toBe('from-global');   /* 先扫到的赢 */
  });

  it('已存在同 id 的标 alreadyImported, 但仍然列出来 (由用户决定覆不覆盖)', () => {
    writeClaudeJson({ mcpServers: { known: { command: 'x' } } });
    const out = discoverExternalMcpServers(['known'], home);
    expect(out).toHaveLength(1);
    expect(out[0].alreadyImported).toBe(true);
  });

  it('env 的 key 要报出来 —— 用户导入前得看清自己会带走什么', () => {
    writeClaudeJson({ mcpServers: { s: { command: 'x', env: { TOKEN: 'secret', REGION: 'us' } } } });
    const out = discoverExternalMcpServers([], home);
    expect(out[0].envKeys.sort()).toEqual(['REGION', 'TOKEN']);
  });

  it('Codex 的 enabled=false 照样列出, 但转成配置时是停用的', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.off]\ncommand = "x"\nenabled = false\n',
      'utf-8',
    );
    const out = discoverExternalMcpServers([], home);
    expect(out[0].disabledAtSource).toBe(true);
    expect(toMcpServerConfig(out[0]).enabled).toBe(false);
  });
});

describe('normalizeMcpId', () => {
  it('大小写/空格/中文都归一成安全 id, 空输入有兜底', () => {
    expect(normalizeMcpId('OpenAI Developer Docs')).toBe('openai-developer-docs');
    expect(normalizeMcpId('  ')).toBe('mcp-server');
    /* 下划线是合法字符, **必须原样保留** —— Codex 真实配置里就有 node_repl,
     * 归一化成 node-repl 会让"已导入"判断对不上, 每次迁移都重复导一遍。 */
    expect(normalizeMcpId('node_repl')).toBe('node_repl');
    expect(normalizeMcpId('a  b')).toBe('a-b');
  });
});
