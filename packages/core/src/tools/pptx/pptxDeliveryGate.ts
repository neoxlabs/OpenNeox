
import { existsSync } from 'node:fs';
import { inspectPptxFile, type PptxInspectReport } from './pptxInspect.js';
import { fitIssueLinesIntoPayload, pptxIssueToSized, MAX_REPORT_CHARS } from '../delivery/compactToolReport.js';

/**
 * work:H-19 — 拦截时回给模型的 issue 清单, 守住 1.5K 字符。
 *
 *   以前这里把 `report.issues` 原样回传: 一个 20 页的 deck 能几十条, 每条还带 shape 矩形,
 *   模型扫完反而漏掉那 3 条 mustFix。现在每条压成一行且必须带页号, 超预算就截并如实报数。
 *   外部工具 (测试 / 其它调用方) 拿到的仍是 `issues` 字段, 只是改成了压缩后的条目。
 */
export function blockedPptxIssues(report: PptxInspectReport): {
  issues: string[];
  shown: number;
  dropped: number;
  mustFixCount: number;
  /** 已经装进预算的完整返回体 —— 调用方直接序列化, 不要再拼一遍文案 */
  payload: Record<string, unknown>;
} {
  /* inspect 已经把 mustFix 排在前面 (pptxInspect.ts:150), 保持顺序 = 保持优先级 */
  const sized = report.issues
    .filter((i) => i.severity === 'error')
    .map((i) => pptxIssueToSized(i));
  /* 预算按**整个返回**算 (issues + error + next 的序列化长度) */
  const fitted = fitIssueLinesIntoPayload(
    (lines) => ({
      error: `交付闸门拦截: 这份 deck 有 ${report.mustFixCount} 处必须修的排版问题, 未上屏。`,
      mustFixCount: report.mustFixCount,
      slideCount: report.slideCount,
      issues: lines,
      next: '按 issues 里的 index / 页号重做那几页 (deck_add_slide 同一个 index 原地替换), 再 deck_export、再 open_surface 复检。不要声称已完成, 不要绕过闸门。',
    }),
    sized,
    { minKeep: 3 },
  );
  return {
    issues: (fitted.payload.issues as string[]) ?? [],
    shown: fitted.shown,
    dropped: fitted.dropped,
    mustFixCount: report.mustFixCount,
    payload: fitted.payload,
  };
}

export { MAX_REPORT_CHARS };

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
