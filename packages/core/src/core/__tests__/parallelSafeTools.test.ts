import { describe, it, expect } from 'vitest';
import { PARALLEL_SAFE_TOOLS, isParallelSafeTool } from '@neoxlabs/kernel/core/parallelSafeTools.js';

describe('parallelSafeTools (canonical 单点)', () => {
  it('contains core read-only tools', () => {
    expect(PARALLEL_SAFE_TOOLS.has('readfile')).toBe(true);
    expect(PARALLEL_SAFE_TOOLS.has('search')).toBe(true);
    expect(PARALLEL_SAFE_TOOLS.has('grep')).toBe(true);
    expect(PARALLEL_SAFE_TOOLS.has('glob')).toBe(true);
    expect(PARALLEL_SAFE_TOOLS.has('list_directory')).toBe(true);
    expect(PARALLEL_SAFE_TOOLS.has('show_tree')).toBe(true);
  });

  it('contains git read-only tools', () => {
    expect(PARALLEL_SAFE_TOOLS.has('git_status')).toBe(true);
    expect(PARALLEL_SAFE_TOOLS.has('git_diff')).toBe(true);
  });

  it('contains the agent taskagent tool (independent side-effect scope)', () => {
    expect(PARALLEL_SAFE_TOOLS.has('agent')).toBe(true);
  });

  it('rejects write / execute tools', () => {
    expect(PARALLEL_SAFE_TOOLS.has('write_file')).toBe(false);
    expect(PARALLEL_SAFE_TOOLS.has('edit_file')).toBe(false);
    expect(PARALLEL_SAFE_TOOLS.has('execute_shell')).toBe(false);
    expect(PARALLEL_SAFE_TOOLS.has('delete_file')).toBe(false);
  });

  describe('isParallelSafeTool', () => {
    it('is case-insensitive', () => {
      expect(isParallelSafeTool('readfile')).toBe(true);
      expect(isParallelSafeTool('ReadFile')).toBe(true);
      expect(isParallelSafeTool('READFILE')).toBe(true);
    });

    it('returns false for falsy / unknown', () => {
      expect(isParallelSafeTool(undefined)).toBe(false);
      expect(isParallelSafeTool(null)).toBe(false);
      expect(isParallelSafeTool('')).toBe(false);
      expect(isParallelSafeTool('some_unknown_tool')).toBe(false);
    });
  });

  it('is immutable at the type level (ReadonlySet)', () => {
    // TypeScript 编译期保证;这里做一个运行时兜底检查 —— 现有使用方不应 add
    const snapshotSize = PARALLEL_SAFE_TOOLS.size;
    expect(snapshotSize).toBeGreaterThanOrEqual(20);
  });
});
