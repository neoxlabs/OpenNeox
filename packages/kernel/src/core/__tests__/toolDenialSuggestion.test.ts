/**
 * 工具不存在时的"最近邻建议"
 *
 * 用户实录: 模型调了 `execute_sql` —— 这个工具全仓从来没注册过, 是它按常理捏的名字。
 * 旧文案只说"不在工具集里, 去 tool_search", 白烧一整轮往返, 而正确答案
 * (execute_shell 里跑 sqlite3/psql) 就在手边。
 *
 * 这里锁: 拒绝消息必须带上真实可用的最近邻, 且不能乱推荐。
 */
import { describe, it, expect } from 'vitest';
import { filterToolCallsByMode, suggestClosestTools } from '../runnerModeFilterUtils.js';

const ALLOWED = new Set([
  'execute_shell', 'readfile', 'edit', 'write_file', 'search',
  'git_status', 'git_diff', 'run_tests', 'run_lint', 'update_plan',
]);

const call = (name: string) => ({ id: 't1', function: { name, arguments: '{}' } });

describe('suggestClosestTools', () => {
  it('execute_sql → execute_shell (真实用户案例)', () => {
    expect(suggestClosestTools('execute_sql', ALLOWED)[0]).toBe('execute_shell');
  });

  it('复数/变体 → 命中同族工具', () => {
    expect(suggestClosestTools('git_commits', ALLOWED)).toContain('git_status');
    expect(suggestClosestTools('run_test', ALLOWED)).toContain('run_tests');
  });

  it('毫无关系的名字 → 不硬推荐 (乱建议比不建议更坏)', () => {
    expect(suggestClosestTools('zzz_quantum_flux', ALLOWED)).toEqual([]);
  });

  it('最多给 3 个', () => {
    expect(suggestClosestTools('run_something', ALLOWED).length).toBeLessThanOrEqual(3);
  });
});

describe('filterToolCallsByMode 的拒绝文案', () => {
  it('带上最近邻, 并明确禁止重试同名', () => {
    const { blockedToolCalls, executableToolCalls } = filterToolCallsByMode({
      toolCalls: [call('execute_sql')],
      allowedToolNames: ALLOWED,
      currentMode: 'agent',
    });
    expect(executableToolCalls).toHaveLength(0);
    const out = blockedToolCalls[0].denialOutput;
    expect(out).toContain('execute_shell');
    expect(out).toContain('Do NOT retry "execute_sql"');
  });

  it('合法工具照常放行', () => {
    const { executableToolCalls, blockedToolCalls } = filterToolCallsByMode({
      toolCalls: [call('readfile')],
      allowedToolNames: ALLOWED,
      currentMode: 'agent',
    });
    expect(executableToolCalls).toHaveLength(1);
    expect(blockedToolCalls).toHaveLength(0);
  });

  it('完全无关的幻觉名 → 文案里不塞假建议', () => {
    const { blockedToolCalls } = filterToolCallsByMode({
      toolCalls: [call('zzz_quantum_flux')],
      allowedToolNames: ALLOWED,
      currentMode: 'agent',
    });
    expect(blockedToolCalls[0].denialOutput).not.toContain('Closest tools');
  });
});
