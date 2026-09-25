import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { evaluateToolRisk } from '@neoxlabs/kernel/core/toolRiskEvaluator.js';

describe('toolRiskEvaluator', () => {
  it('flags destructive shell command as critical', () => {
    const assessment = evaluateToolRisk({
      toolName: 'execute_shell',
      args: { command: 'rm -rf /' },
      category: 'execute' as any,
    });

    expect(assessment.level).toBe('critical');
    expect(assessment.signals.some((s) => s.domain === 'shell')).toBe(true);
  });

  it('flags SQL delete/update without where as high', () => {
    const assessment = evaluateToolRisk({
      toolName: 'execute_shell',
      args: { command: 'psql -c "DELETE FROM users;"' },
    });

    expect(assessment.level).toBe('high');
    expect(assessment.signals.some((s) => s.domain === 'sql')).toBe(true);
  });

  it('flags write path outside workspace as high', () => {
    const assessment = evaluateToolRisk({
      toolName: 'write_file',
      args: { file_path: '../outside.txt' },
      category: 'write' as any,
      workspaceRoot: '/tmp/ws',
    });

    expect(assessment.level).toBe('high');
    expect(assessment.signals.some((s) => s.domain === 'path')).toBe(true);
  });

  it('keeps safe read command as low', () => {
    const assessment = evaluateToolRisk({
      toolName: 'readfile',
      args: { file_path: 'README.md' },
      category: 'read' as any,
      workspaceRoot: '/tmp/ws',
    });

    expect(assessment.level).toBe('low');
    expect(assessment.signals.length).toBe(0);
  });

  describe('path:sensitive', () => {
    const hasSensitive = (a: ReturnType<typeof evaluateToolRisk>) => a.signals.some((s) => s.code === 'path:sensitive');

    it('write_file ~/.ssh/config → critical', () => {
      const a = evaluateToolRisk({
        toolName: 'write_file',
        args: { file_path: '~/.ssh/config', content: 'x' },
        category: 'write' as any,
        workspaceRoot: '/tmp/ws',
      });
      expect(a.level).toBe('critical');
      expect(hasSensitive(a)).toBe(true);
    });

    it('readfile ~/.aws/credentials → critical (读也算, 外泄)', () => {
      const a = evaluateToolRisk({
        toolName: 'readfile',
        args: { path: '~/.aws/credentials' },
        category: 'read' as any,
        workspaceRoot: '/tmp/ws',
      });
      expect(a.level).toBe('critical');
      expect(hasSensitive(a)).toBe(true);
    });

    it('write_file ~/.neox/skills/demo/SKILL.md → 不算敏感 (创建技能)', () => {
      const a = evaluateToolRisk({
        toolName: 'write_file',
        args: { file_path: path.join(os.homedir(), '.neox/skills/demo/SKILL.md'), content: 'x' },
        category: 'write' as any,
        workspaceRoot: '/tmp/ws',
      });
      expect(hasSensitive(a)).toBe(false);
    });

    it('git_status path=.git/hooks → critical', () => {
      const a = evaluateToolRisk({
        toolName: 'git_status',
        args: { path: '.git/hooks' },
        category: 'read' as any,
        workspaceRoot: '/tmp/ws',
      });
      expect(a.level).toBe('critical');
      expect(hasSensitive(a)).toBe(true);
    });
  });
});
