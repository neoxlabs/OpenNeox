/** 子 Agent 占位会话使用父会话提示补齐 workspacePath 和 parentSessionId。 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SessionStore, peekSubAgentParentHint } from '../sessionStore.js';

const PARENT = 'session-parent-abc';
const CHILD = 'agent-child-xyz';
const WS = '/Users/me/proj';

let store: SessionStore;

beforeEach(() => {
  store = new SessionStore();
});

describe('子 Agent 归属提示', () => {
  it('登记过就带上父会话和工作区 —— 占位行不再是孤儿', () => {
    store.rememberSubAgentParent(CHILD, PARENT, WS);
    const hint = peekSubAgentParentHint(CHILD);
    expect(hint?.parentSessionId).toBe(PARENT);
    expect(hint?.workspacePath).toBe(WS);
  });

  it('没登记过就没有提示 —— 保持原有的"先占坑不撞外键"语义', () => {
    expect(peekSubAgentParentHint('never-registered-child')).toBeUndefined();
  });

  it('父会话查不到时只有 workspace 退到 workDir, 父子关系仍然记得住', () => {
    /* server 侧 parent 为 null 的分支: workspacePath 兜底, sid 照常传 */
    store.rememberSubAgentParent(CHILD, PARENT, '/fallback/workdir');
    const hint = peekSubAgentParentHint(CHILD);
    expect(hint?.parentSessionId).toBe(PARENT);
    expect(hint?.workspacePath).toBe('/fallback/workdir');
  });

  it('缺 childId 或 parentId 一律不登记 —— 不写半条脏提示', () => {
    store.rememberSubAgentParent('', PARENT, WS);
    store.rememberSubAgentParent('child-missing-parent', '', WS);
    expect(peekSubAgentParentHint('')).toBeUndefined();
    expect(peekSubAgentParentHint('child-missing-parent')).toBeUndefined();
  });

  it('workspace 缺省时退空串, 不会写进 undefined 撞 NOT NULL', () => {
    store.rememberSubAgentParent('child-no-ws', PARENT);
    expect(peekSubAgentParentHint('child-no-ws')?.workspacePath).toBe('');
    expect(peekSubAgentParentHint('child-no-ws')?.parentSessionId).toBe(PARENT);
  });

  it('重复登记以最后一次为准 —— 后到的正规信息该盖掉早期兜底', () => {
    store.rememberSubAgentParent(CHILD, PARENT, '/fallback/workdir');
    store.rememberSubAgentParent(CHILD, PARENT, WS);
    expect(peekSubAgentParentHint(CHILD)?.workspacePath).toBe(WS);
  });

  it('提示表有上界 —— 长跑派几千个子 agent 不会把它撑爆', () => {
    for (let i = 0; i < 260; i++) {
      store.rememberSubAgentParent(`bulk-child-${i}`, PARENT, WS);
    }
    /* 最早的会被丢掉, 最近的一定还在 —— 它只是兜底提示, 不是状态源 */
    expect(peekSubAgentParentHint('bulk-child-0')).toBeUndefined();
    expect(peekSubAgentParentHint('bulk-child-259')?.parentSessionId).toBe(PARENT);
  });
});
