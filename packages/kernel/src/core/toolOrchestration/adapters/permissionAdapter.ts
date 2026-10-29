/**
 * PermissionChecker adapter — 把 Neox 的 PermissionManager 包装成
 * orchestrate 的 PermissionChecker 接口。
 *
 * 关键:PermissionManager.checkPermission 内部**已经调用 evaluateToolRisk**
 * (见 PermissionManager.ts L113),所以用了 PermissionChecker 就不应该
 * 再挂 RiskEvaluator,否则 risk 被判两次。runner 路径选此 adapter。
 */

import type { Tool } from '../../../types/index.js';
import type { PermissionChecker } from '../types.js';

export interface PermissionManagerLike {
  checkPermission(
    tool: Tool,
    args: Record<string, any>,
    context?: { scopeKey?: string; agentName?: string; taint?: TaintLike },
  ): Promise<{
    allowed: boolean;
    reason?: string;
    denyKind?: string;
    source?: string;
  }>;
}

/** PermissionCheckContext.taint 的最小形状 (core/trust/sessionTaint)。 */
export type TaintLike = {
  isTainted(): boolean;
  describe(sideEffect: 'outbound' | 'destructive', toolName: string): string;
  snapshot(): { tainted: boolean; count: number; suspectCount: number; refs: string[]; firstAt?: number };
};

export interface CreatePermissionAdapterOptions {
  permissionManager: PermissionManagerLike;
  /** 会话染色读取器 —— 每次 check 时现取, 因为同一批工具里前一个 web_fetch 可能刚把会话染了。
   *  传入正在过闸的调用, 让批次预染色排掉它自己 (trust/batchTaint)。 */
  getTaint?: (self: { name: string; args: Record<string, any> }) => TaintLike | undefined;
  /** 可选的作用域 key(用于 scope-level 权限记忆) */
  scopeKey?: string;
  /** 可选的 agent 名(任务 Agent 有独立权限决策时用) */
  agentName?: string;
}

export function createPermissionAdapter(
  opts: CreatePermissionAdapterOptions,
): PermissionChecker {
  const { permissionManager, scopeKey, agentName, getTaint } = opts;
  return {
    async check(tool, args) {
      const decision = await permissionManager.checkPermission(tool, args, {
        scopeKey,
        agentName,
        taint: getTaint?.({ name: tool.name, args }),
      });
      return {
        allowed: decision.allowed,
        reason: decision.reason,
      };
    },
  };
}
