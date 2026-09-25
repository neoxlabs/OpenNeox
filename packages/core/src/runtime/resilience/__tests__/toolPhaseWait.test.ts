/**
 * Active tool calls keep the phase alive; an idle phase or an expired maximum
 * wait remains eligible for stall handling.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldKeepWaitingInToolPhase, describeToolPhaseWait, toolPhaseMaxWaitMs,
} from '../toolPhaseWait.js';

const base = {
  phase: 'tool' as const,
  pendingToolCalls: 0,
  delegationAlive: false,
  waitedMs: 1000,
  maxWaitMs: 45 * 60_000,
};

describe('tool 阶段的判活', () => {
  it('有工具在飞 → 静默不算断流 (子 agent 探针为假也照等)', () => {
    expect(shouldKeepWaitingInToolPhase({ ...base, pendingToolCalls: 1 })).toBe(true);
  });

  it('工具已返回但子 agent 还在推进 → 仍然等', () => {
    expect(shouldKeepWaitingInToolPhase({ ...base, delegationAlive: true })).toBe(true);
  });

  it('什么都没在飞 → 走原来的 stall 重试', () => {
    expect(shouldKeepWaitingInToolPhase(base)).toBe(false);
  });

  it('等待 response 阶段从不适用 (那是真的该判断流)', () => {
    expect(shouldKeepWaitingInToolPhase({ ...base, phase: 'response', pendingToolCalls: 3 })).toBe(false);
  });

  it('超过上限就不再护着 —— 工具挂死不能把这一轮永远挂住', () => {
    expect(shouldKeepWaitingInToolPhase({
      ...base, pendingToolCalls: 2, waitedMs: 46 * 60_000,
    })).toBe(false);
  });

  it('上限 <= 0 表示不设上限', () => {
    expect(shouldKeepWaitingInToolPhase({
      ...base, pendingToolCalls: 2, waitedMs: 10 * 3600_000, maxWaitMs: 0,
    })).toBe(true);
  });

  it('默认上限比 deep_research 自己声明的 40 分钟宽', () => {
    expect(toolPhaseMaxWaitMs()).toBeGreaterThan(40 * 60_000);
  });

  it('日志说得出是哪个信号留住的', () => {
    expect(describeToolPhaseWait({ ...base, pendingToolCalls: 2 })).toContain('2 个工具');
    expect(describeToolPhaseWait({ ...base, delegationAlive: true })).toContain('子 agent');
  });
});

describe('宿主真的用上了这条判据', () => {
  /* The integration assertion checks that the host uses the same gate. Strip
   * comments before scanning source so the assertion does not match its own docs. */
  it('agentRuntimeHost 的 tool 阶段等待走 shouldKeepWaitingInToolPhase', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(HERE, '..', '..', 'agentRuntimeHost.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).toContain('shouldKeepWaitingInToolPhase');
    expect(src).toContain('pendingToolCalls: this.recentToolCalls.size');
    /* 旧判据不许再单独把关 */
    expect(src).not.toMatch(/while \('stalled' in result && waitPhase === 'tool' && delegationStillAlive\(\)\)/);
  });
});
