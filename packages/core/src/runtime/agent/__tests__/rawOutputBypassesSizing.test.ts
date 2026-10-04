import { describe, it, expect, vi } from 'vitest';
import { createAgentTool } from '../agentTool.js';
import { BackgroundAgentManager } from '../backgroundAgent.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { ShortTermMemory as STM } from '@neoxlabs/kernel/memory/shortterm.js';

/* 一份"像归纳产物"的大 JSON: 远超 8000 字符, 且真正的结构在**中间** */
const BIG_JSON = JSON.stringify({
  summary: ['折叠形态拿到正面口碑', 'Pro 线涨价是独立争议'],
  sections: Array.from({ length: 80 }, (_, i) => ({
    title: `第 ${i + 1} 章`,
    body: `这一章的正文${'内容'.repeat(60)}`,
    tables: [],
    charts: [],
  })),
  recommendations: ['重度拍照用户不建议本代'],
});

function createOptions(output: string) {
  return {
    orchestrator: {
      runSession: vi.fn(async () => ({
        summary: { output, totalTokens: 10, durationMs: 1, iterations: 1, toolCalls: 0, interrupted: false, failed: false },
        contextUsed: 0,
        providerId: 'test-provider',
      })),
    } as any,
    providerId: 'test-provider',
    modelName: 'test-model',
    permissionManager: new PermissionManager({ defaultPermission: ToolPermission.ALLOW }),
    allTools: [],
    workDir: '/tmp/neox-test',
    getParentMemory: () => new STM(),
    backgroundManager: new BackgroundAgentManager(),
  };
}

describe('raw_output: 结构化输出绕开子 agent 瘦身闸', () => {
  it('不传 raw_output 时照旧截断 (防并发大输出炸主 memory 的闸不能拆)', async () => {
    expect(BIG_JSON.length).toBeGreaterThan(8000);
    const agent = createAgentTool(createOptions(BIG_JSON));
    const out = await agent.function({
      description: 'synth', prompt: 'x', type: 'plan', run_in_background: false,
    }) as string;

    expect(out).toContain('output truncated');
    expect(() => JSON.parse(out)).toThrow();
  });

  it('传 raw_output 时拿到原样 JSON, 尾巴上不拼任何说明', async () => {
    const agent = createAgentTool(createOptions(BIG_JSON));
    const out = await agent.function({
      description: 'synth', prompt: 'x', type: 'plan', run_in_background: false, raw_output: true,
    }) as string;

    expect(out).toBe(BIG_JSON);
    const parsed = JSON.parse(out);
    /* 结构在中间 —— 被掏空的那一版这里必然对不上 */
    expect(parsed.sections).toHaveLength(80);
    expect(parsed.recommendations[0]).toBe('重度拍照用户不建议本代');
  });

  it('raw_output 不在模型能看到的 schema 里 (只给内部调用方)', () => {
    const agent = createAgentTool(createOptions('ok'));
    expect(Object.keys((agent.parameters as any).properties)).not.toContain('raw_output');
  });
});
