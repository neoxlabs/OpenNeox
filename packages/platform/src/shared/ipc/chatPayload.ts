import type { ChatMetadata } from './coreTypes.js';

export interface ChatRequestPayload {
  sessionId?: string;
  prompt: string;
  isRetry?: boolean;
  isContinue?: boolean;
  workspacePath?: string;
  /** 多根工作区: 本工作区全部项目根 (含 primary workspacePath)。server 据此让 agent
   *  在系统提示里感知其它根。缺省/单根 → 完全无影响。 */
  workspaceRoots?: string[];
  modelId?: string;
  stream?: boolean;
  metadata?: ChatMetadata;
  /** 用途模式 (assistant/work/code) — 每条消息携带, server 重启后 mode 也不丢。 */
  agentMode?: string;
  /** 聊天模式 (输入框 + 菜单切) — 精简 prompt、不带工具, 见 core/runtime/turnTier.ts */
  chatMode?: boolean;
}

export interface ChatResponsePayload {
  sessionId: string;
  finalText: string;
  tokens: number;
  contextUsed: number;
  startedAt: number;
  finishedAt: number;
}

export interface SupervisorProgress {
  completed: number;
  total: number;
  percentage: number;
  currentStep?: string;
  source?: 'plan' | 'todo' | 'tools';
}
