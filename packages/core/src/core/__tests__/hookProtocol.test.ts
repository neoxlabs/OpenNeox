/**
 * Hook 协议 —— 事件表 + 决策语义。
 *
 * 这里断言的是**安全语义**, 不是格式解析: 一条 deny 能不能被后面的 allow 翻案、
 * 一个写坏的 hook 会不会把用户的工具卡死、matcher 会不会悄悄多管两个工具。
 * 这几条错了不会有人报 bug —— 只会在某天出事。
 */
import { describe, it, expect } from 'vitest';
import {
  HOOK_EVENTS, isHookEvent, isBlockingEvent,
  parseHookOutcome, mergeHookOutcomes, skipsApproval, matchesTool,
} from '../hookProtocol.js';

describe('事件表', () => {
  it('覆盖工具/会话/压缩/子agent/权限/worktree/交互/配置各组', () => {
    for (const e of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit',
                     'Stop', 'StopFailure', 'SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact',
                     'SubagentStart', 'SubagentStop', 'PermissionRequest', 'PermissionDenied',
                     'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult',
                     'Notification', 'ConfigChange', 'PostToolBatch']) {
      expect(HOOK_EVENTS, `${e} 应该在事件表里`).toContain(e);
    }
    expect(isHookEvent('PreToolUse')).toBe(true);
    expect(isHookEvent('MadeUpEvent')).toBe(false);
  });

  it('只有能拦的事件才算 blocking —— 通知式事件说什么都不该改流程', () => {
    expect(isBlockingEvent('PreToolUse')).toBe(true);
    expect(isBlockingEvent('UserPromptSubmit')).toBe(true);
    expect(isBlockingEvent('PermissionRequest')).toBe(true);
    expect(isBlockingEvent('PostToolUse')).toBe(false);
    expect(isBlockingEvent('Notification')).toBe(false);
    expect(isBlockingEvent('SessionEnd')).toBe(false);
  });
});

describe('退出码语义', () => {
  it('exit 2 = 拦下, stderr 当理由', () => {
    const o = parseHookOutcome(2, '', '不许动生产配置');
    expect(o.allow).toBe(false);
    expect(o.decision).toBe('deny');
    expect(o.reason).toBe('不许动生产配置');
  });

  it('**写坏的 hook 不该把工具卡死** —— 非 0 非 2 一律放行 (fail-open)', () => {
    /* 刻意的: 安全边界靠审批档位和沙箱, 不靠 hook。hook 是用户的自动化,
     * 它自己崩了应该吵一声然后放行, 而不是让人不能干活。 */
    for (const code of [1, 127, 126, 3]) {
      expect(parseHookOutcome(code, '', 'command not found').allow, `exit ${code} 应放行`).toBe(true);
    }
  });

  it('stdout 不是 JSON 就当日志, 不猜', () => {
    expect(parseHookOutcome(0, 'checking...\ndone', '').allow).toBe(true);
    expect(parseHookOutcome(0, '{坏掉的 json', '').allow).toBe(true);
  });

  it('老写法 decision:"block" 继续认', () => {
    const o = parseHookOutcome(0, '{"decision":"block","reason":"nope"}', '');
    expect(o.allow).toBe(false);
    expect(o.reason).toBe('nope');
  });

  it('permissionDecision 四态 + defer', () => {
    expect(parseHookOutcome(0, '{"permissionDecision":"allow"}', '').decision).toBe('allow');
    expect(parseHookOutcome(0, '{"permissionDecision":"deny","reason":"r"}', '').allow).toBe(false);
    expect(parseHookOutcome(0, '{"permissionDecision":"ask"}', '').decision).toBe('ask');
    expect(parseHookOutcome(0, '{"permissionDecision":"defer"}', '').decision).toBe('defer');
  });

  it('改写字段: updatedInput / updatedToolOutput / additionalContext', () => {
    const o = parseHookOutcome(0, JSON.stringify({
      updatedInput: { path: '/safe/x' },
      updatedToolOutput: 'redacted',
      additionalContext: '这个仓库禁止改 CI',
    }), '');
    expect(o.updatedInput).toEqual({ path: '/safe/x' });
    expect(o.updatedToolOutput).toBe('redacted');
    expect(o.additionalContext).toBe('这个仓库禁止改 CI');
  });
});

describe('多个 hook 的合成 —— 谁压过谁', () => {
  it('**deny 不可被后面的 allow 翻案**', () => {
    const m = mergeHookOutcomes([
      { allow: false, decision: 'deny', reason: '企业策略: 禁止改 CI', source: 'enterprise' },
      { allow: true, decision: 'allow', source: 'user' },
    ]);
    expect(m.allow).toBe(false);
    expect(m.reason).toBe('企业策略: 禁止改 CI');
    expect(skipsApproval(m)).toBe(false);
  });

  it('deny 排在后面也一样压过前面的 allow', () => {
    const m = mergeHookOutcomes([
      { allow: true, decision: 'allow', source: 'user' },
      { allow: false, decision: 'deny', reason: '企业策略', source: 'enterprise' },
    ]);
    expect(m.allow).toBe(false);
    expect(m.reason).toBe('企业策略');
  });

  it('第一个 deny 的理由胜出 —— 先说的那条更接近根因', () => {
    const m = mergeHookOutcomes([
      { allow: false, reason: '真因' },
      { allow: false, reason: '连带的' },
    ]);
    expect(m.reason).toBe('真因');
  });

  it('allow 能跳过审批卡, 但只有在没人 deny 时', () => {
    expect(skipsApproval(mergeHookOutcomes([{ allow: true, decision: 'allow' }]))).toBe(true);
    expect(skipsApproval(mergeHookOutcomes([{ allow: true, decision: 'ask' }]))).toBe(false);
    expect(skipsApproval(mergeHookOutcomes([{ allow: true }]))).toBe(false);
  });

  it('改写是链式的, additionalContext 一条都不能丢', () => {
    const m = mergeHookOutcomes([
      { allow: true, updatedInput: { a: 1 }, additionalContext: 'ctx1' },
      { allow: true, updatedInput: { b: 2 }, additionalContext: 'ctx2' },
      { allow: true, updatedToolOutput: 'final' },
    ]);
    expect(m.updatedInput).toEqual({ a: 1, b: 2 });
    expect(m.updatedToolOutput).toBe('final');
    expect(m.additionalContext).toBe('ctx1\nctx2');
  });
});

describe('matcher', () => {
  it('空 matcher 匹配所有', () => {
    expect(matchesTool(undefined, 'Edit')).toBe(true);
    expect(matchesTool('  ', 'Edit')).toBe(true);
  });

  it('**带连字符的 MCP 工具名精确匹配**', () => {
    expect(matchesTool('mcp__my-server__do-thing', 'mcp__my-server__do-thing')).toBe(true);
    expect(matchesTool('mcp__my-server__do-thing', 'mcp__my-server__do-other')).toBe(false);
  });

  it('名字里有正则元字符时按字面量算 —— 不许一条 hook 悄悄多管两个工具', () => {
    /* `get.file` 当正则时 `.` 是任意字符, 会把 get_file / getXfile 一起匹上 */
    expect(matchesTool('mcp__srv__get.file', 'mcp__srv__get.file')).toBe(true);
    expect(matchesTool('mcp__srv__get.file', 'mcp__srv__get_file')).toBe(false);
    expect(matchesTool('mcp__srv__get.file', 'mcp__srv__getXfile')).toBe(false);
  });

  it('正则写法照旧能用, 且是**搜索**语义 (想精确自己写 ^…$)', () => {
    expect(matchesTool('Edit|Write', 'Edit')).toBe(true);
    expect(matchesTool('Edit|Write', 'Write')).toBe(true);
    expect(matchesTool('Edit|Write', 'Read')).toBe(false);
    expect(matchesTool('^git_', 'git_commit')).toBe(true);
    expect(matchesTool('^Edit$', 'MultiEdit')).toBe(false);
  });

  it('没有正则结构就当名字比 —— 不是"什么都当正则"', () => {
    /* 判据是"有没有 | ^ $ * + ?  [ ] { } \\", 点和连字符不算:
     * 它们在工具名里太常见, 当元字符处理只会误伤。 */
    expect(matchesTool('Edit', 'MultiEdit')).toBe(false);
    expect(matchesTool('git_commit', 'git_commit')).toBe(true);
    expect(matchesTool('git_commit', 'git_commit_all')).toBe(false);
  });

  it('非法正则不炸, 且不误放 —— 只有字面量相等才算命中', () => {
    expect(matchesTool('[unclosed', '[unclosed')).toBe(true);
    expect(matchesTool('[unclosed', 'anything')).toBe(false);
  });
});
