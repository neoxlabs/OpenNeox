import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  trackFileAccess,
  trackSkillInvocation,
  trackWorkState,
  trackToolFailure,
  generatePostCompactReinjectMessages,
  sweepFileAccessTracker,
  resetFileAccessTracker,
  resetSkillTracker,
  resetWorkStateTracker,
  peekWorkState,
  runPostCompactCleanup,
} from '../postCompactReinject.js';
import type { Message } from '../../types/index.js';

beforeEach(() => {
  resetFileAccessTracker();
  resetSkillTracker();
  resetWorkStateTracker();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const byName = (messages: Message[], name: string) => messages.find(m => (m as any).name === name);

describe('post-compact 回灌 — 空状态', () => {
  it('什么都没记录时不生成消息', () => {
    const r = generatePostCompactReinjectMessages([]);
    expect(r).toMatchObject({ filesInjected: 0, skillsInjected: 0, workStateInjected: false, pathsListed: 0, totalTokens: 0 });
    expect(r.messages).toEqual([]);
  });

  it('budgetOverride=0 时仍注入工作状态，但不注文件/技能', () => {
    trackWorkState('todo', [{ content: '先跑测试' }]);
    trackFileAccess('/tmp/a.ts', 'alpha content');
    trackSkillInvocation('s', 'skill body');
    const r = generatePostCompactReinjectMessages([], 0);
    expect(r.workStateInjected).toBe(true);
    expect(r.filesInjected).toBe(0);
    expect(r.skillsInjected).toBe(0);
    expect(r.messages.map(m => (m as any).name)).toEqual(['PostCompactWorkState', 'PostCompactFileMap']);
  });
});

describe('post-compact 回灌 — 工作状态', () => {
  it('计划按状态渲染勾选框与完成数', () => {
    trackWorkState('plan', [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'blocked' },
      { content: 'd' },
    ]);
    const r = generatePostCompactReinjectMessages([]);
    const msg = byName(r.messages, 'PostCompactWorkState')!;
    expect(msg.content).toContain('## 当前计划 (1/4)');
    expect(msg.content).toContain('- [x] a');
    expect(msg.content).toContain('- [>] b');
    expect(msg.content).toContain('- [!] c');
    expect(msg.content).toContain('- [ ] d');
  });

  it('清单类型标题是“当前清单”', () => {
    trackWorkState('todo', [{ content: 'x', status: 'done' }]);
    const msg = byName(generatePostCompactReinjectMessages([]).messages, 'PostCompactWorkState')!;
    expect(msg.content).toContain('## 当前清单 (1/1)');
  });

  it('空清单 / 只含空白步骤视为清空', () => {
    trackWorkState('plan', [{ content: 'x' }]);
    trackWorkState('plan', []);
    expect(generatePostCompactReinjectMessages([]).workStateInjected).toBe(false);
    trackWorkState('plan', [{ content: '   ' }]);
    expect(generatePostCompactReinjectMessages([]).workStateInjected).toBe(false);
  });

  it('完全相同的失败只计一条', () => {
    trackToolFailure('edit', '  old_string   not found ');
    trackToolFailure('edit', 'old_string not found');
    expect(peekWorkState().failures).toBe(1);
    const msg = byName(generatePostCompactReinjectMessages([]).messages, 'PostCompactWorkState')!;
    expect(msg.content.split('old_string not found').length - 1).toBe(1);
  });

  it('回灌最多 6 条失败、按最近排序', () => {
    for (let i = 0; i < 8; i++) {
      trackToolFailure(`tool${i}`, `failure ${i}`);
      vi.advanceTimersByTime(1);
    }
    const msg = byName(generatePostCompactReinjectMessages([]).messages, 'PostCompactWorkState')!;
    expect(msg.content).toContain('已经失败过的尝试');
    expect(msg.content).toContain('tool7: failure 7');
    expect(msg.content).not.toContain('tool1: failure 1');
    const failureLines = msg.content.split('\n').filter(l => l.startsWith('- '));
    expect(failureLines.length).toBe(6);
  });

  it('空工具名或空摘要不记录', () => {
    trackToolFailure('', 'brief');
    trackToolFailure('edit', '   ');
    expect(peekWorkState().failures).toBe(0);
  });

  it('单条失败摘要截到 160 字符', () => {
    trackToolFailure('edit', 'x'.repeat(300));
    const msg = byName(generatePostCompactReinjectMessages([]).messages, 'PostCompactWorkState')!;
    const line = msg.content.split('\n').find(l => l.startsWith('- edit:'))!;
    expect(line.length).toBeLessThanOrEqual(160 + '- edit: '.length);
  });
});

describe('post-compact 回灌 — 文件', () => {
  it('有内容的文件按最近访问注入，并带路径头', () => {
    trackFileAccess('/tmp/a.ts', 'alpha');
    vi.advanceTimersByTime(10);
    trackFileAccess('/tmp/b.ts', 'beta');
    const r = generatePostCompactReinjectMessages([]);
    const msg = byName(r.messages, 'PostCompactFileRestore')!;
    expect(r.filesInjected).toBe(2);
    expect(msg.content.indexOf('### /tmp/b.ts')).toBeLessThan(msg.content.indexOf('### /tmp/a.ts'));
    expect(msg.content).toContain('alpha');
    expect(msg.content).toContain('beta');
  });

  it('没有内容的文件只进路径地图，并标出访问次数', () => {
    trackFileAccess('/tmp/a.ts');
    trackFileAccess('/tmp/a.ts');
    const r = generatePostCompactReinjectMessages([]);
    expect(r.filesInjected).toBe(0);
    expect(r.pathsListed).toBe(1);
    const msg = byName(r.messages, 'PostCompactFileMap')!;
    expect(msg.content).toContain('/tmp/a.ts (accessed 2x)');
  });

  it('最近 5 个文件注内容，其余进路径地图', () => {
    for (let i = 0; i < 7; i++) {
      trackFileAccess(`/tmp/f${i}.ts`, `content-${i}`);
      vi.advanceTimersByTime(1);
    }
    const r = generatePostCompactReinjectMessages([]);
    expect(r.filesInjected).toBe(5);
    expect(r.pathsListed).toBe(2);
  });

  it('压缩后保留消息里已有路径时去重', () => {
    trackFileAccess('/tmp/a.ts', 'alpha');
    const preserved: Message[] = [{ role: 'tool', name: 'readfile', content: 'file /tmp/a.ts content' } as Message];
    const r = generatePostCompactReinjectMessages(preserved);
    expect(r.filesInjected).toBe(0);
    expect(r.pathsListed).toBe(0);
  });

  it('非 read/edit/write 的工具消息不参与去重', () => {
    trackFileAccess('/tmp/a.ts', 'alpha');
    const preserved: Message[] = [{ role: 'tool', name: 'execute_shell', content: '/tmp/a.ts' } as Message];
    expect(generatePostCompactReinjectMessages(preserved).filesInjected).toBe(1);
  });

  it('单文件超过 4000 token 时截断并加标记', () => {
    trackFileAccess('/tmp/big.ts', 'x'.repeat(20_000));
    const r = generatePostCompactReinjectMessages([]);
    const msg = byName(r.messages, 'PostCompactFileRestore')!;
    expect(String(msg.content)).toContain('content truncated for post-compact re-injection');
    expect(String(msg.content).length).toBeLessThan(17_000);
  });

  it('小预算下只注一个文件', () => {
    trackFileAccess('/tmp/a.ts', 'a'.repeat(400));
    trackFileAccess('/tmp/b.ts', 'b'.repeat(400));
    const r = generatePostCompactReinjectMessages([], 100);
    expect(r.filesInjected).toBe(1);
    expect(r.pathsListed).toBe(1);
  });
});

describe('post-compact 回灌 — 技能与生命周期', () => {
  it('技能按最近使用排序注入，并受 3000 token 上限', () => {
    trackSkillInvocation('old', 'x'.repeat(20_000));
    vi.advanceTimersByTime(10);
    trackSkillInvocation('new', 'short');
    const r = generatePostCompactReinjectMessages([]);
    expect(r.skillsInjected).toBe(2);
    const msg = byName(r.messages, 'PostCompactSkillRestore')!;
    expect(msg.content.indexOf('### Skill: new')).toBeLessThan(msg.content.indexOf('### Skill: old'));
    expect(String(msg.content)).toContain('content truncated for post-compact re-injection');
  });

  it('peekWorkState 报告四类计数', () => {
    trackWorkState('plan', [{ content: 'a' }, { content: 'b' }]);
    trackToolFailure('x', 'y');
    trackFileAccess('/a');
    trackSkillInvocation('s', 'body');
    expect(peekWorkState()).toEqual({ steps: 2, failures: 1, files: 1, skills: 1 });
  });

  it('sweepFileAccessTracker 清掉超过 10 分钟的记录', () => {
    trackFileAccess('/old.ts', 'x');
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    sweepFileAccessTracker();
    expect(peekWorkState().files).toBe(0);
  });

  it('runPostCompactCleanup 只清旧文件，保留计划', () => {
    trackWorkState('plan', [{ content: '继续' }]);
    trackFileAccess('/old.ts', 'x');
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    runPostCompactCleanup();
    expect(peekWorkState()).toMatchObject({ files: 0, steps: 1 });
  });
});
