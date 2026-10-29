/**
 * RiskEvaluator adapter — 把 evaluateToolRisk 包装成 orchestrate 的
 * RiskEvaluator 接口。
 *
 * 使用场景:agentLoop 路径没有 PermissionManager(仅作为 worker/taskagent 不做
 * 用户级审批), 用这个 adapter 保留 "risk critical → 拦截" 的能力。
 *
 * runner 路径**不应**挂此 adapter, 因为 PermissionManager 内部已经调 evaluateToolRisk,
 * 重复挂会在 gate 阶段二次评估同一个 risk。
 */

import type { RiskEvaluator } from '../types.js';

export interface EvaluateToolRiskLike {
  (input: {
    toolName: string;
    args: Record<string, any>;
    workspacePath?: string;
    category?: string;
  }): {
    level: 'low' | 'medium' | 'high' | 'critical';
    summary?: string;
  };
}

export interface CreateRiskAdapterOptions {
  evaluateToolRisk: EvaluateToolRiskLike;
  workspacePath?: string;
  /** 通过 tool.category 传给 evaluateToolRisk, 让它做更精准的判断 */
  getToolCategory?: (toolName: string) => string | undefined;
}

export function createRiskAdapter(
  opts: CreateRiskAdapterOptions,
): RiskEvaluator {
  const { evaluateToolRisk, workspacePath, getToolCategory } = opts;
  return {
    evaluate(toolName, args) {
      const category = getToolCategory?.(toolName);
      const r = evaluateToolRisk({
        toolName,
        args,
        workspacePath,
        category,
      });
      return { level: r.level, summary: r.summary };
    },
  };
}
