/**
 * MCP 工具名 → provider 合规名 (^[a-zA-Z0-9_-]{1,64}$)
 * 一个不合规的名字会让整轮请求被 provider 400 拒掉, 见 utils.ts 头注释。
 */
import { describe, expect, it } from 'vitest';
import { dedupeMcpToolName, formatMcpToolName, isProviderSafeToolName } from '../utils.js';

describe('formatMcpToolName', () => {
  it('本来合规的名字保持原样 (已有的审批规则/历史不受影响)', () => {
    expect(formatMcpToolName('github', 'search_issues')).toBe('mcp__github__search_issues');
    expect(formatMcpToolName('my-server', 'do-it')).toBe('mcp__my-server__do-it');
  });

  it('点/空格/斜杠/中文 → 下划线', () => {
    const n = formatMcpToolName('my server.v2', 'repo/get file.内容');
    expect(isProviderSafeToolName(n)).toBe(true);
    expect(n).toBe('mcp__my_server_v2__repo_get_file___');
  });

  it('超长 → 截到 64 且带稳定哈希, 两个共前缀的长名不撞', () => {
    const a = formatMcpToolName('srv', `${'x'.repeat(70)}_alpha`);
    const b = formatMcpToolName('srv', `${'x'.repeat(70)}_beta`);
    expect(a.length).toBe(64);
    expect(isProviderSafeToolName(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(formatMcpToolName('srv', `${'x'.repeat(70)}_alpha`)).toBe(a); // 稳定
  });
});

describe('dedupeMcpToolName', () => {
  it('清洗后撞名 (a.b vs a_b) → 后来者改名, 仍合规', () => {
    const taken = new Set<string>();
    const first = dedupeMcpToolName(formatMcpToolName('s', 'a.b'), 's', 'a.b', taken);
    taken.add(first);
    const second = dedupeMcpToolName(formatMcpToolName('s', 'a_b'), 's', 'a_b', taken);
    expect(first).toBe('mcp__s__a_b');
    expect(second).not.toBe(first);
    expect(isProviderSafeToolName(second)).toBe(true);
  });
});
