
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { BackgroundAgentManager } from './backgroundAgent.js';
import { getActiveDeepResearch } from '../../research/activeRuns.js';

export interface ListAgentsToolOptions {
  /** 调用方 sessionId — 只列这个会话派出去的 */
  callerSessionId?: string;
  backgroundManager: BackgroundAgentManager;
}

export function createListAgentsTool(opts: ListAgentsToolOptions): Tool {
  return {
    name: 'list_agents',
    description: `List the sub-agents this conversation has running right now — including deep_research workers and agents dispatched in the foreground.

Use it before answering the user about running agents, and before stop_agent / send_message. Never tell the user nothing is running without calling this first.

No parameters.`,
    parameters: {
      type: 'object',
      properties: {},
    },
    async function() {
      const active = opts.backgroundManager.listActive(opts.callerSessionId);
      const research = opts.callerSessionId ? getActiveDeepResearch(opts.callerSessionId) : undefined;

      if (active.length === 0 && !research) {
        return JSON.stringify({
          type: 'info',
          summary: '这个会话当前没有在跑的子 agent',
          agents: [],
        });
      }

      const agents = active.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        description: a.description,
        status: a.status,
        elapsedSec: a.elapsed,
        toolCalls: a.progress?.toolUseCount,
        model: a.model,
      }));

      return JSON.stringify({
        type: 'info',
        summary: `${active.length} 个子 agent 在跑${research ? ' · 1 个 deep_research 进行中' : ''}`,
        agents,
        ...(research ? {
          deep_research: {
            topic: research.topic,
            startedAtIso: new Date(research.startedAt).toISOString(),
            note: '调研员是它派出去的; 要整轮停掉用 stop_agent(to: "deep_research"), 只停一个角度就传那个 agentId',
          },
        } : {}),
      }, null, 2);
    },
  };
}
