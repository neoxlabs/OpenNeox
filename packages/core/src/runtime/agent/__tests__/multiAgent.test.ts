import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSelfContainedPrompt,
  buildTaskNotification,
  parseTaskNotification,
} from '../selfContainedPrompt.js';
import {
  NotificationQueue,
  shouldSuggestUpgrade,
  extractComplexitySignals,
} from '../backgroundExecution.js';
import {
  AgentTypeRegistry,
} from '../agentTypeRegistry.js';
import {
  buildWorktreeNotice,
  type WorktreeInfo,
} from '../worktreeIsolation.js';

// ─── 自包含 Prompt ───

describe('SelfContainedPrompt', () => {
  it('builds complete prompt with all sections', () => {
    const prompt = buildSelfContainedPrompt({
      description: 'Fix auth bug',
      prompt: 'Find and fix the authentication bypass in src/auth.ts line 42.',
      workDir: '/project',
      agentType: 'coder',
      maxTurns: 30,
      allowedTools: ['readfile', 'edit_file'],
    });

    expect(prompt).toContain('Agent Task Assignment');
    expect(prompt).toContain('NO access to the parent conversation');
    expect(prompt).toContain('/project');
    expect(prompt).toContain('coder');
    expect(prompt).toContain('30');
    expect(prompt).toContain('readfile, edit_file');
    expect(prompt).toContain('authentication bypass');
  });

  it('includes worktree notice', () => {
    const prompt = buildSelfContainedPrompt({
      description: 'Test',
      prompt: 'Do something',
      workDir: '/project',
      worktreeNotice: 'You are in a worktree at /tmp/wt-123',
    });

    expect(prompt).toContain('worktree at /tmp/wt-123');
  });

  it('excludes optional sections when not provided', () => {
    const prompt = buildSelfContainedPrompt({
      description: 'Simple',
      prompt: 'Just do it',
      workDir: '/project',
    });

    expect(prompt).not.toContain('Tool Restriction');
    expect(prompt).not.toContain('Agent type');
    expect(prompt).toContain('Just do it');
  });
});

describe('TaskNotification', () => {
  it('builds valid XML', () => {
    const xml = buildTaskNotification({
      taskId: 'task-123',
      agentId: 'worker-1',
      status: 'completed',
      summary: 'Fixed the bug',
      result: 'Edited auth.ts to fix bypass',
      usage: { totalTokens: 5000, toolUses: 3, durationMs: 12000 },
    });

    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('<task-id>task-123</task-id>');
    expect(xml).toContain('<agent-id>worker-1</agent-id>');
    expect(xml).toContain('<status>completed</status>');
    expect(xml).toContain('<total_tokens>5000</total_tokens>');
  });

  it('escapes XML special chars', () => {
    const xml = buildTaskNotification({
      taskId: 't1',
      status: 'completed',
      summary: 'Fixed <script> & "stuff"',
      result: 'if (a < b && c > d)',
    });

    expect(xml).toContain('&lt;script&gt;');
    expect(xml).toContain('&amp;');
  });

  it('roundtrips through parse', () => {
    const xml = buildTaskNotification({
      taskId: 'rt-1',
      agentId: 'ag-2',
      status: 'failed',
      summary: 'Could not compile',
      result: 'Error: TypeScript error on line 5',
    });

    const parsed = parseTaskNotification(xml);
    expect(parsed).not.toBeNull();
    expect(parsed!.taskId).toBe('rt-1');
    expect(parsed!.agentId).toBe('ag-2');
    expect(parsed!.status).toBe('failed');
    expect(parsed!.result).toContain('TypeScript error');
  });

  it('parseTaskNotification returns null for non-notification', () => {
    expect(parseTaskNotification('just a normal message')).toBeNull();
  });
});

// ─── 通知队列 ───

describe('NotificationQueue', () => {
  let queue: NotificationQueue;

  beforeEach(() => {
    queue = new NotificationQueue();
  });

  it('enqueue and dequeue', () => {
    queue.enqueue({
      taskId: 't1',
      status: 'completed',
      summary: 'Done',
      result: 'All good',
    });

    expect(queue.pendingCount).toBe(1);
    const items = queue.dequeueAll();
    expect(items.length).toBe(1);
    expect(items[0].taskId).toBe('t1');
    expect(queue.pendingCount).toBe(0);
  });

  it('formatPendingAsXml returns XML for pending', () => {
    queue.enqueue({ taskId: 'a', status: 'completed', summary: 's', result: 'r' });
    queue.enqueue({ taskId: 'b', status: 'failed', summary: 'f', result: 'e' });

    const xml = queue.formatPendingAsXml();
    expect(xml).toContain('<task-id>a</task-id>');
    expect(xml).toContain('<task-id>b</task-id>');

    // Second call returns null (already delivered)
    expect(queue.formatPendingAsXml()).toBeNull();
  });

  it('onNotification fires on enqueue', () => {
    let called = false;
    queue.onNotification(() => { called = true; });
    queue.enqueue({ taskId: 'x', status: 'completed', summary: '', result: '' });
    expect(called).toBe(true);
  });
});

// ─── 复杂度检测 ───

describe('ComplexityDetection', () => {
  it('simple message → no upgrade', () => {
    const signals = extractComplexitySignals('fix a typo');
    const result = shouldSuggestUpgrade(signals);
    expect(result.suggest).toBe(false);
  });

  it('complex multi-system message → suggest upgrade', () => {
    const signals = extractComplexitySignals(
      '我需要你先修改前端的 Dashboard 组件，然后更新后端 API 接口，' +
      '最后写一个端到端测试。涉及 src/ui/Dashboard.tsx, src/api/dashboard.ts, ' +
      'src/api/routes.ts, tests/e2e/dashboard.test.ts, src/types/dashboard.ts',
    );
    const result = shouldSuggestUpgrade(signals);
    expect(result.suggest).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('multi-step instructions detected', () => {
    const signals = extractComplexitySignals('第一步读代码，第二步修改，第三步测试');
    expect(signals.hasMultipleSteps).toBe(true);
  });

  it('cross-system detected', () => {
    const signals = extractComplexitySignals('update frontend and backend');
    expect(signals.multipleSystemsMentioned).toBe(true);
  });

  it('many files mentioned', () => {
    const signals = extractComplexitySignals(
      'edit a.ts b.ts c.ts d.ts e.ts f.ts',
    );
    expect(signals.mentionedFiles).toBeGreaterThanOrEqual(5);
  });
});

// ─── Agent 类型注册表 ───

describe('AgentTypeRegistry', () => {
  let registry: AgentTypeRegistry;

  beforeEach(() => {
    registry = new AgentTypeRegistry();
  });

  it('has builtin types', () => {
    expect(registry.size).toBeGreaterThanOrEqual(4);
    expect(registry.get('explorer')).toBeDefined();
    expect(registry.get('coder')).toBeDefined();
    expect(registry.get('reviewer')).toBeDefined();
    expect(registry.get('tester')).toBeDefined();
  });

  it('explorer is read-only', () => {
    const explorer = registry.get('explorer')!;
    expect(explorer.disallowedTools).toContain('write_file');
    expect(explorer.disallowedTools).toContain('edit_file');
    expect(explorer.disallowedTools).toContain('execute_shell');
    expect(explorer.tools).not.toContain('execute_shell');
  });

  it('coder has no tool restrictions', () => {
    const coder = registry.get('coder')!;
    expect(coder.tools).toBeUndefined();
    expect(coder.disallowedTools).toBeUndefined();
  });

  it('register custom type', () => {
    registry.register({
      name: 'devops',
      description: 'DevOps agent',
      tools: ['execute_shell'],
      model: 'gpt-4-mini',
      maxTurns: 10,
      source: 'user',
    });

    const devops = registry.get('devops');
    expect(devops).toBeDefined();
    expect(devops!.model).toBe('gpt-4-mini');
  });

  it('getAgentTypesForPrompt generates listing', () => {
    const prompt = registry.getAgentTypesForPrompt();
    expect(prompt).toContain('## Available Agent Types');
    expect(prompt).toContain('**explorer**');
    expect(prompt).toContain('**coder**');
    expect(prompt).toContain('When to use:');
  });

  it('list returns all types', () => {
    const types = registry.list();
    expect(types.length).toBeGreaterThanOrEqual(4);
    expect(types.some(t => t.name === 'explorer')).toBe(true);
  });
});

// ─── Worktree Notice ───

describe('WorktreeNotice', () => {
  it('builds complete notice', () => {
    const info: WorktreeInfo = {
      path: '/tmp/neox-wt-abc',
      branch: 'neox/agent/worker-1-abc123',
      baseCommit: 'def456',
      createdAt: Date.now(),
      agentId: 'worker-1',
    };

    const notice = buildWorktreeNotice(info, '/project');
    expect(notice).toContain('Worktree Isolation Notice');
    expect(notice).toContain('/tmp/neox-wt-abc');
    expect(notice).toContain('neox/agent/worker-1-abc123');
    expect(notice).toContain('/project');
    expect(notice).toContain('separate branch');
    expect(notice).toContain('will NOT affect the main branch');
  });
});
