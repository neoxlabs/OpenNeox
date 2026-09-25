import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { CHAT_ONLY_THRESHOLD } from './jev/jevToolPreload.js';

export type TurnTier = 'chat' | 'lite' | 'agent';

export interface TurnTierInput {
  /** 用户在输入框 + 菜单里切到了聊天模式 */
  chatMode: boolean;
  /** 用户这句明说「不要用工具」 —— 工具照旧清空, 但 prompt 不换 (那是现有行为) */
  noToolsIntent: boolean;
  /** 重试 / 续跑 / 恢复: 不是新需求, 沿用会话当前档位 */
  isRecovery: boolean;
  agentMode: string;
  /** 本会话已经进过满档 (进程内记的) */
  latchedAgent: boolean;
  /** 本会话上一轮是轻档 */
  wasLite: boolean;
  /** 会话历史里有过工具调用 (进程重启 / host 淘汰后, 闩丢了靠这个补) */
  hasToolHistory: boolean;
  /** Jev 判这句是纯聊天的概率; 没开 Jev / 预判没赶上 = null */
  chatOnly: number | null;
}

export function decideTurnTier(input: TurnTierInput): TurnTier {
  if (input.chatMode) return 'chat';
  if (input.noToolsIntent) return 'agent';
  if (input.latchedAgent || input.hasToolHistory) return 'agent';
  /* 轻档只给 Code / Work。Life 模式有自己精简过的工具面, 不叠这一层。 */
  if (input.agentMode !== 'code' && input.agentMode !== 'work') return 'agent';
  if (input.isRecovery) return input.wasLite ? 'lite' : 'agent';
  if (input.chatOnly !== null) return input.chatOnly >= CHAT_ONLY_THRESHOLD ? 'lite' : 'agent';
  /* 没判出来 (单字、没赶上预判): 已经在轻档里聊着的会话留在轻档, 真要干活模型会调 start_task */
  return input.wasLite ? 'lite' : 'agent';
}

export const START_TASK_TOOL_NAME = 'start_task';

/** 轻档里唯一的工具。`escalate` 负责换满档并返回解锁后可用的工具名。 */
export function createStartTaskTool(escalate: () => string[]): Tool {
  return {
    name: START_TASK_TOOL_NAME,
    description:
      'Unlock the full toolset for this conversation: reading and editing files, searching the project, '
      + 'running shell commands, web search and fetch, the browser and the rest. '
      + 'Call it before doing anything beyond talking, then continue with the request.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'A few words on what you are about to do' },
      },
    },
    function: async () => {
      const names = escalate();
      return `Full toolset unlocked (${names.length} tools, including ${names.slice(0, 12).join(', ')}). `
        + 'Continue with the user\'s request now.';
    },
  };
}
