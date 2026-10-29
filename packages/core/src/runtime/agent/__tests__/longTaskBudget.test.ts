import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';


const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('长任务预算 — 计数/时长闸默认必须无限', () => {
  it('主 agent: 迭代数与工具调用数默认无限', async () => {
    const t = await import('@neoxlabs/kernel/types/index.js');
    expect(t.DEFAULT_MAX_ITERATIONS).toBe(0);
    expect(t.DEFAULT_MAX_TOOL_CALLS).toBe(0);
    expect(t.DEFAULT_MAX_RUNTIME_MS).toBe(0);
  });

  it('子 agent: 六种类型的 maxIterations 全部为 0 (无限)', () => {
    const src = read('runtime/agent/agentTypes.ts');
    /* 接口声明 `maxIterations: number;` 不算; 只看赋值 */
    const assigned = [...src.matchAll(/maxIterations:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(assigned.length).toBeGreaterThanOrEqual(6);
    expect(assigned.every((v) => v === 0)).toBe(true);
  });

  it('子 agent: 六种类型的 maxRuntimeMs 全部为 0 (无限)', () => {
    const src = read('runtime/agent/agentTypes.ts');
    const assigned = [...src.matchAll(/maxRuntimeMs:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(assigned.length).toBeGreaterThanOrEqual(6);
    expect(assigned.every((v) => v === 0)).toBe(true);
  });

  it('explore: 墙钟硬超时默认关闭, 且 0 不会 setTimeout(fn, 0)', () => {
    const src = read('runtime/agent/agenticModeTools.ts');
    expect(src).toMatch(/NEOX_EXPLORE_HARD_TIMEOUT_MS\s*\?\?\s*0/);
    expect(src).toMatch(/EXPLORE_HARD_TIMEOUT_MS\s*>\s*0/);
    expect(src).toMatch(/maxRuntimeMs:\s*0/);
  });

  it('子 agent: wall-clock 硬超时默认关闭', () => {
    const src = read('runtime/agent/backgroundAgent.ts');
    expect(src).toMatch(/NEOX_AGENT_HARD_TIMEOUT_MS\s*\?\?\s*0\s*\)/);
  });

});

describe('长任务预算 — 兜底必须还在 (放开时长闸的前提)', () => {
  it('子 agent: 零进展 watchdog 仍启用, 且不长于 10 分钟', () => {
    const src = read('runtime/agent/backgroundAgent.ts');
    const m = /NEOX_AGENT_NO_PROGRESS_MS\s*\?\?\s*(\d+)\s*\*\s*60_000/.exec(src);
    expect(m, '零进展 watchdog 必须存在 —— 时长闸放开后它是子 agent 唯一的判死信号').toBeTruthy();
    const mins = Number(m![1]);
    expect(mins).toBeGreaterThan(0);
    expect(mins).toBeLessThanOrEqual(10);
  });

  it('子 agent: 成本熔断仍启用 (防跑飞烧穿账单)', () => {
    const src = read('runtime/agent/backgroundAgent.ts');
    const m = /NEOX_AGENT_MAX_OUTPUT_TOKENS\s*\?\?\s*([\d_]+)\s*\)/.exec(src);
    expect(m, '时长闸放开后, 成本熔断是唯一挡在跑飞 agent 和无上限账单之间的东西').toBeTruthy();
    expect(Number(m![1].replace(/_/g, ''))).toBeGreaterThan(0);
  });

  it('主 agent: turnStallGuard 三档仍在, 且 abort 前必须查 hasLiveWork', () => {
    const guard = read('runtime/resilience/turnStallGuard.ts');
    expect(guard).toMatch(/NEOX_TURN_STALL_ABORT_MS/);
    expect(guard).toMatch(/hasLiveWork/);
    /* 探针为真时必须刷新进度而不是开火 —— 否则 8 分钟的 build 会被误杀 */
    expect(guard).toMatch(/hasLiveWork[\s\S]{0,400}lastProgressAt\s*=/);
  });

  it('主 agent: hasLiveWork 探针出错时按"有活"处理 (宁可晚杀不误杀)', () => {
    const main = read('server/main.ts');
    const i = main.indexOf('hasLiveWork:');
    expect(i).toBeGreaterThan(0);
    const block = main.slice(i, i + 900);
      expect(block).toMatch(/catch\s*\{[\s\S]{0,200}return true/);
  });

  it('父 agent: tool 阶段 180s 迭代器静默不得误杀仍在推进的子 agent', () => {
    const src = read('runtime/agentRuntimeHost.ts');
    expect(src).toMatch(/STALL_TIMEOUT_TOOL_MS\s*=\s*180_000/);
    expect(src).toMatch(/delegationStillAlive/);
    expect(src).toMatch(/getActiveRunDiagnostics/);
    expect(src).toMatch(/shouldKeepWaitingInToolPhase\(waitInput\)/);
    expect(src).toMatch(/pendingToolCalls: this\.recentToolCalls\.size/);
    expect(src).toMatch(/sessionId\.startsWith\('agent_'\)/);
  });
});
