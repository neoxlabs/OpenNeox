/**
 * Stage 3 gate applies risk, guardrail, permission, and loop checks in order.
 *
 * The checks are centralized with a fixed order:
 *
 *   A. Risk — critical → 直接拦 + terminate; high → 拦但不 terminate
 *   B. Guardrail — input guardrails 命中 → 拦
 *   C. Permission — PermissionManager 拒绝 → 拦
 *   D. Loop — loopDetector HARD → 拦 + terminate(SOFT/MEDIUM 由 orchestrate
 *                  后续转为 advisory, 不在本 stage 体现)
 *
 * Risk runs first, followed by guardrails, permissions, and loop detection.
 *
 * Unconfigured checks are skipped. Hard risk and loop blocks terminate the loop;
 * softer loop levels are returned as advisory data.
 */

import { block, type StageResult } from '../types.js';
import type { Tool } from '../../../types/index.js';
import type { ToolUseContext } from '../types.js';

export interface GateStageData {
  /**
   * SOFT/MEDIUM 循环的 advisory message(非阻断, 继续 execute), 传给 orchestrate
   * 最终写进 outcome.loopAdvisoryMessage。HARD 级别直接在 block 里处理, 不走这里。
   */
  loopAdvisoryMessage?: string;
}

export async function runGateStage(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolUseContext,
): Promise<StageResult<GateStageData>> {
  // ─── A. Risk ──────────────────────────────────────────────
  if (ctx.risk) {
    const r = ctx.risk.evaluate(tool.name, args);
    if (r.level === 'critical') {
      return block(
        'risk',
        `Blocked by risk evaluator (critical): ${r.summary ?? tool.name}`,
        /* terminateLoop */ true,
      );
    }
    if (r.level === 'high') {
      return block(
        'risk',
        `Blocked by risk evaluator (high): ${r.summary ?? tool.name}`,
      );
    }
    // medium/low 放行
  }

  // ─── B. Guardrail ────────────────────────────────────────
  if (ctx.inputGuardrails) {
    try {
      const g = await ctx.inputGuardrails.run(tool.name, args);
      if (!g.allow) {
        return block(
          'guardrail',
          `Blocked by input guardrail${g.guardrailName ? ` "${g.guardrailName}"` : ''}: ${g.reason ?? 'policy violation'}`,
        );
      }
    } catch (err: any) {
      // Fail-closed:guardrail 自身异常视为拒绝(与 preHook 策略一致)
      return block(
        'guardrail',
        `Input guardrail threw: ${err?.message ?? String(err)}`,
      );
    }
  }

  // ─── C. Permission ───────────────────────────────────────
  // 始终走 PermissionManager。YOLO 由 approvalMode=dangerous → ALLOW 表达,
  // 不再用 shouldAutoApprove 整段跳过(否则 session scoped manual 形同虚设)。
  if (ctx.permission) {
    try {
      const p = await ctx.permission.check(tool, args);
      if (!p.allowed) {
        return block(
          'permission',
          `Permission denied for "${tool.name}": ${p.reason ?? 'user or policy declined'}`,
        );
      }
    } catch (err: any) {
      // Fail-closed 同上
      return block(
        'permission',
        `Permission check threw: ${err?.message ?? String(err)}`,
      );
    }
  }

  // ─── D. Loop ─────────────────────────────────────────────
  let loopAdvisoryMessage: string | undefined;
  if (ctx.loopDetector) {
    const l = ctx.loopDetector.check(tool.name, args);
    if (l.level === 'hard') {
      return block(
        'loop',
        l.message ?? `Loop detector hard-blocked repeated "${tool.name}" calls`,
        /* terminateLoop */ true,
        /* userNotice */ (l as { userNotice?: string }).userNotice,
      );
    }
    // soft/medium 不 block, 但把 advisory message 透传给 orchestrate
    if ((l.level === 'soft' || l.level === 'medium') && l.message) {
      loopAdvisoryMessage = l.message;
    }
  }

  return { kind: 'ok', data: { loopAdvisoryMessage } };
}
