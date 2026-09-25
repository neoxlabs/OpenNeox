
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { BackgroundAgentManager } from './backgroundAgent.js';
import { stopDeepResearch } from '../../research/activeRuns.js';

export interface StopAgentToolOptions {
  callerSessionId?: string;
  backgroundManager: BackgroundAgentManager;
}

export function createStopAgentTool(opts: StopAgentToolOptions): Tool {
  return {
    name: 'stop_agent',
    description: `Stop a sub-agent this conversation started. Use list_agents first to get its agentId.

- to: an agentId / name from list_agents → stops that one agent.
- to: "deep_research" → stops the running deep_research: no new angles are dispatched, workers in flight are aborted, and the report is still written from the evidence collected so far.`,
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'agentId or name from list_agents, or "deep_research"' },
        reason: { type: 'string', description: 'Why — shown in the stopped agent\'s record' },
      },
      required: ['to'],
    },
    async function(args: any) {
      const to = String(args?.to ?? '').trim();
      const reason = String(args?.reason ?? '').trim() || '主 agent 叫停';
      if (!to) return '[ERROR] 需要 to: list_agents 里的 agentId, 或 "deep_research"';

      if (to === 'deep_research' || to === 'deep-research') {
        const stopped = opts.callerSessionId ? stopDeepResearch(opts.callerSessionId, reason) : false;
        return stopped
          ? JSON.stringify({ type: 'ephemeral', status: 'success', tool: 'stop_agent', summary: '已叫停 deep_research — 在飞的调研员正在中止, 报告会用已查到的证据写出' })
          : '[ERROR] 这个会话没有在跑的 deep_research';
      }

      const task = opts.backgroundManager.resolveAgent(to);
      const mine = task && (!opts.callerSessionId || task.sessionId === opts.callerSessionId);
      if (!task || !mine) {
        const active = opts.backgroundManager.listActive(opts.callerSessionId);
        return `[ERROR] 这个会话没有叫 "${to}" 的子 agent。`
          + (active.length > 0
            ? ` 在跑的: ${active.map((a) => `${a.agentId} (${a.description})`).join('; ')}`
            : ' 当前没有在跑的子 agent。');
      }
      if (task.status !== 'running') {
        return JSON.stringify({ type: 'ephemeral', status: 'success', tool: 'stop_agent', summary: `${task.agentId} 已经结束 (${task.status}), 不用停` });
      }
      /* silent=false: 被停的是模型自己派的活, 结束回执照常送回 —— 那是它需要的信息 */
      const ok = opts.backgroundManager.abort(task.agentId, reason, false, 'system');
      return ok
        ? JSON.stringify({ type: 'ephemeral', status: 'success', tool: 'stop_agent', summary: `已停止 ${task.agentId} (${task.description})` })
        : `[ERROR] ${task.agentId} 没能停下 (可能刚好结束)`;
    },
  };
}
