import { describe, expect, it } from 'vitest';
import { createAgenticModeTools } from '../agenticModeTools.js';
import { BackgroundAgentManager } from '../backgroundAgent.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';

describe('explore progress integration', () => {
  it.each([false, true])('publishes final member statistics before completion (parallel=%s)', async parallel => {
    const events: any[] = [];
    const explore = createAgenticModeTools({
      orchestrator: {
        runSession: async ({ onRuntimeEvent, prompt }: any) => {
          onRuntimeEvent({ type: 'thinking', iteration: 1 });
          onRuntimeEvent({ type: 'reasoning', delta: 'checking files' });
          onRuntimeEvent({
            type: 'token_usage', promptTokens: 90, completionTokens: 10,
            totalTokens: prompt === 'first' ? 100 : 200,
            sessionPromptTokens: 90, sessionCompletionTokens: 10,
          });
          return { summary: { output: 'ok', failed: false, interrupted: false } };
        },
      } as any,
      providerId: 'test', modelName: 'deepseek-v4.1-flash',
      permissionManager: new PermissionManager(), allTools: [], workDir: '/tmp',
      getParentMemory: () => new ShortTermMemory(),
      backgroundManager: new BackgroundAgentManager(),
      onTaskAgentEvent: (agentId, event) => events.push({ ...event, source: agentId }),
    }).find(t => t.name === 'explore')!;

    await explore.function(parallel ? { prompts: ['first', 'second'] } : { prompt: 'first' });
    const start = events.find(e => e.type === 'worker_start');
    expect(start.groupMembers).toHaveLength(parallel ? 2 : 1);
    for (const [index, member] of start.groupMembers.entries()) {
      const progress = events.filter(e => e.source === member.agentId && e.eventType === 'explore_progress');
      expect(progress.at(-1).data).toMatchObject({
        iterations: 1, tokens: (index + 1) * 100, tokensEstimated: false,
      });
      const doneIndex = events.findIndex(e => e.eventType === 'member_complete' && e.data.memberId === member.agentId);
      expect(events.indexOf(progress.at(-1))).toBeLessThan(doneIndex);
    }
    expect(events.at(-1)).toMatchObject({ type: 'worker_complete', success: true });
  });
});
