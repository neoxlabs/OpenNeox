
import { describe, it, expect } from 'vitest';
import { evaluateToolRisk } from '../toolRiskEvaluator.js';

function codes(command: string) {
  const a = evaluateToolRisk({ toolName: 'execute_shell', args: { command } } as any);
  return { level: a.level, codes: a.signals.map((s) => s.code) };
}

describe('只读 shell 命令不误判', () => {
  it('echo + ls + 2>/dev/null + | head 是 low', () => {
    const r = codes('ls -la; echo "=== 找 paper.pdf ==="; ls -la ~/Documents/Neox/工作/*.pdf 2>/dev/null; ls -la /tmp/*.pdf 2>/dev/null | head');
    expect(r.codes).toEqual([]);
    expect(r.level).toBe('low');
  });

  it('回归保护: 真写 .git/hooks 仍判 high, 重定向到绝对路径文件仍判 medium', () => {
    expect(codes('echo "x" > .git/hooks/pre-commit').codes).toContain('shell:git-internal-write');
    expect(codes('cat payload > /etc/hosts').codes).toContain('shell:truncate');
    expect(codes('ls > ~/out.txt').codes).toContain('shell:truncate');
  });
});
