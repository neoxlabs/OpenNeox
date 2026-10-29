/**
 * AgentThreadContext — 防 task-agent 递归 fork 爆炸
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getAgentThreadContext,
  __resetAgentThreadContextForTest,
  AgentThreadDepthExceededError,
  DEFAULT_MAX_THREAD_DEPTH,
} from '../agentThreadContext.js';

describe('AgentThreadContext', () => {
  const savedEnv = process.env.NEOX_MAX_AGENT_THREAD_DEPTH;

  beforeEach(() => {
    __resetAgentThreadContextForTest();
    delete process.env.NEOX_MAX_AGENT_THREAD_DEPTH;
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.NEOX_MAX_AGENT_THREAD_DEPTH = savedEnv;
    else delete process.env.NEOX_MAX_AGENT_THREAD_DEPTH;
  });

  it('default MAX is 3', () => {
    expect(getAgentThreadContext().getMaxDepth()).toBe(DEFAULT_MAX_THREAD_DEPTH);
    expect(DEFAULT_MAX_THREAD_DEPTH).toBe(3);
  });

  it('outside any agent context depth is 0', () => {
    expect(getAgentThreadContext().getCurrentDepth()).toBe(0);
    expect(getAgentThreadContext().getNextChildDepth()).toBe(1);
  });

  it('enterDepth binds to ALS async subtree', () => {
    const ctx = getAgentThreadContext();
    ctx.enterDepth(2);
    expect(ctx.getCurrentDepth()).toBe(2);
    expect(ctx.getNextChildDepth()).toBe(3);
  });

  it('checkCanSpawnOrThrow allows up to MAX', () => {
    const ctx = getAgentThreadContext();
    ctx.enterDepth(0);
    expect(ctx.checkCanSpawnOrThrow('test')).toBe(1);
    ctx.enterDepth(1);
    expect(ctx.checkCanSpawnOrThrow('test')).toBe(2);
    ctx.enterDepth(2);
    expect(ctx.checkCanSpawnOrThrow('test')).toBe(3);
  });

  it('checkCanSpawnOrThrow rejects beyond MAX', () => {
    const ctx = getAgentThreadContext();
    ctx.enterDepth(3);
    expect(() => ctx.checkCanSpawnOrThrow('grandson')).toThrow(AgentThreadDepthExceededError);
  });

  it('error carries depth + max', () => {
    const ctx = getAgentThreadContext();
    ctx.enterDepth(5);
    try {
      ctx.checkCanSpawnOrThrow('x');
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgentThreadDepthExceededError);
      expect(e.depth).toBe(6);
      expect(e.max).toBe(3);
    }
  });

  it('env override NEOX_MAX_AGENT_THREAD_DEPTH=5 allows deeper', () => {
    process.env.NEOX_MAX_AGENT_THREAD_DEPTH = '5';
    const ctx = getAgentThreadContext();
    ctx.enterDepth(4);
    expect(ctx.checkCanSpawnOrThrow('x')).toBe(5);
    ctx.enterDepth(5);
    expect(() => ctx.checkCanSpawnOrThrow('x')).toThrow();
  });

  it('env override NEOX_MAX_AGENT_THREAD_DEPTH=0 blocks any spawn', () => {
    process.env.NEOX_MAX_AGENT_THREAD_DEPTH = '0';
    const ctx = getAgentThreadContext();
    ctx.enterDepth(0);
    expect(() => ctx.checkCanSpawnOrThrow('anything')).toThrow();
  });

  it('invalid env falls back to default', () => {
    process.env.NEOX_MAX_AGENT_THREAD_DEPTH = 'abc';
    expect(getAgentThreadContext().getMaxDepth()).toBe(DEFAULT_MAX_THREAD_DEPTH);
  });
});
