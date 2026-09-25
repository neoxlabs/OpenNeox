/**
 * pptxDeliveryGate — 「生成的 pptx 必须自检通过才准交付」的**产物层**闸门 .
 *
 * The gate lives at the artifact boundary so every generated deck follows the
 * inspect-and-fix contract before it reaches open_surface.
 *
 * 唯一必经的收口是 **open_surface({kind:'pptx'})** —— 用户能看到这份 deck 的唯一通道。
 * 所以闸门装在这里:
 *   1. 跑 inspect (pptxInspect.ts, 真实字体度量 + 钉死行高)。
 *   2. `neoxGenerated=false` (用户自己拿进来的第三方 pptx) → **不拦**, 只附报告。
 *   3. `neoxGenerated=true` 且 `mustFixCount > 0` → **拦**, 不开 surface, 把 mustFix 清单回给模型。
 *      硬闸门, 没有 force 参数。
 *   4. 自检跑不了 (文件不存在 / 读不开) → **放行但大声说不可用**, 并禁止模型声称"已验证"。
 *
 * Inspection runs as an in-process function and does not require an optional external runtime.
 */

import { existsSync } from 'node:fs';
import { inspectPptxFile, type PptxInspectReport } from './pptxInspect.js';

export type { PptxInspectReport } from './pptxInspect.js';

export type PptxGateVerdict =
  /** 自检跑通且没有 mustFix —— 放行。 */
  | { status: 'pass'; report: PptxInspectReport }
  /** 自检跑通, 是 Neox 生成的 deck 且有 mustFix —— 拦截。 */
  | { status: 'blocked'; report: PptxInspectReport }
  /** 外部 pptx (非 Neox 生成) —— 放行, 报告仅供参考。 */
  | { status: 'external'; report: PptxInspectReport }
  /** 自检跑不了 —— 放行但必须大声报, 且禁止声称已验证。 */
  | { status: 'unavailable'; reason: string; userHint: string | null };

/**
 * 对一个存盘 .pptx 跑结构自检。
 * 任何一环失败都返回 'unavailable' + 具体原因 —— 不吞错, 不假装通过。
 */
export async function inspectPptxForDelivery(pptxPath: string): Promise<PptxGateVerdict> {
  if (!existsSync(pptxPath)) {
    return {
      status: 'unavailable',
      reason: `文件不存在: ${pptxPath}. 先确认 deck_export 返回的就是这个路径。`,
      userHint: null,
    };
  }

  let report: PptxInspectReport;
  try {
    report = await inspectPptxFile(pptxPath);
  } catch (e) {
    return {
      status: 'unavailable',
      reason:
        `排版自检读不了这份文件: ${e instanceof Error ? e.message : String(e)}. `
        + '你**不许**声称这份 deck 已经过排版验证。',
      userHint: null,
    };
  }

  if (!report.neoxGenerated) return { status: 'external', report };
  if (report.mustFixCount > 0) return { status: 'blocked', report };
  return { status: 'pass', report };
}

/**
 * 把裁决翻译成 open_surface 要附带的字段。
 * blocked 走调用方的拒绝分支; 其余三种都放行, 但 selfCheck 字段照实写。
 */
export function describeVerdict(verdict: PptxGateVerdict): Record<string, unknown> {
  switch (verdict.status) {
    case 'pass':
      return {
        selfCheck: {
          available: true,
          passed: true,
          slideCount: verdict.report.slideCount,
          warnings: verdict.report.warnings,
        },
      };
    case 'external':
      return {
        selfCheck: {
          available: true,
          passed: null,
          note:
            '这份 pptx 不是 Neox 生成的 (无 Neox 出处标记) —— 排版闸门只对 Neox 自己生成的 deck 生效, '
            + '这里只做展示。不要把 inspect 结果当作对用户文件的评判去改它, 除非用户要求。',
          mustFixCount: verdict.report.mustFixCount,
        },
      };
    case 'unavailable':
      return {
        selfCheck: {
          available: false,
          passed: null,
          reason: verdict.reason,
          userHint: verdict.userHint,
          agentInstruction:
            '自检没能运行。交付时必须如实说明"这份 PPT 的排版没有经过自动校验"'
            + (verdict.userHint ? `, 并把这句转达给用户: ${verdict.userHint}` : '')
            + '。禁止声称已验证 / 已检查排版。',
        },
      };
    case 'blocked':
      /* 调用方不会走到这里 (blocked 分支自己组装错误), 保底给个可读结构。 */
      return { selfCheck: { available: true, passed: false, mustFixCount: verdict.report.mustFixCount } };
  }
}
