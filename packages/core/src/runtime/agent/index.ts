/**
 * Agent 模块导出
 */

// WriteLockManager - 文件写入锁（读并发/写串行）
export {
  WriteLockManager,
  getGlobalWriteLockManager,
  resetGlobalWriteLockManager,
} from './writeLockManager.js';
export type { LockInfo, LockResult, WriteLockManagerOptions } from './writeLockManager.js';

// ParentContext - 对话历史提取
export { buildParentContext } from './parentContext.js';

// AgenticModeTools - Agentic 模式 explore + task
export { createAgenticModeTools, AGENTIC_MODE_SUBAGENT_INSTRUCTIONS } from './agenticModeTools.js';

// Worktree 隔离 (Team P1) — cleanupWorktree(agentId) 是 Team 合并后的清理入口
export { cleanupWorktree, createAgentWorktree, finishAgentWorktree, registerAgentWorktree } from './agentTool.js';
export type { AgentWorktreeInfo } from './agentTool.js';

// ReportToConductorTool (Team P1 §3.4) - 成员 agent → Conductor 单向上报
export { createReportToConductorTool } from './reportToConductorTool.js';
export type { ReportToConductorToolOptions, ReportKind } from './reportToConductorTool.js';
