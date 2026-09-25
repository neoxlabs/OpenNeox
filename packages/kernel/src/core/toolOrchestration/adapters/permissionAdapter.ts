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
    context?: { scopeKey?: string; agentName?: string },
  ): Promise<{
    allowed: boolean;
    reason?: string;
    denyKind?: string;
    source?: string;
  }>;
}

export interface CreatePermissionAdapterOptions {
  permissionManager: PermissionManagerLike;
  /** 可选的作用域 key(用于 scope-level 权限记忆) */
  scopeKey?: string;
  /** 可选的 agent 名(任务 Agent 有独立权限决策时用) */
  agentName?: string;
}

export function createPermissionAdapter(
  opts: CreatePermissionAdapterOptions,
): PermissionChecker {
  const { permissionManager, scopeKey, agentName } = opts;
  return {
    async check(tool, args) {
      const decision = await permissionManager.checkPermission(tool, args, {
        scopeKey,
        agentName,
      });
      return {
        allowed: decision.allowed,
        reason: decision.reason,
      };
    },
  };
}
