/**
 * officeDeliveryGate — xlsx / docx 的交付结构闸门 (work O-22)。
 *
 * 与 pptx 那道闸门 (tools/pptx/pptxDeliveryGate.ts) 同一个落点与同一套语义:
 *   open_surface 是「用户能看到这份产出」的唯一必经通道, 所以交付前的自检装在这里。
 *
 *   1. 我们自己写出来的文件 (本次进程里 Neox 写盘过) + 有必须修的问题 → **拦**, 不开 surface,
 *      把问题清单回给模型去修。
 *   2. 用户自己带进来的文件 → **不拦**, 只附报告 (他拿来一份本来就带 #REF! 的表要预览,
 *      拦下来等于“你的文件不让我看”)。
 *   3. 自检跑不了 (文件不存在 / 不是 zip / 缺零件) → **放行但大声说不可用**, 并禁止模型声称已验证。
 *
 * 不设 force 参数: 要交付就得先修。修不了的情况 (比如模型没有删 sheet 的工具) 一律降级成 warn,
 * 见 sheet/xlsxInspect.ts 与 word/docxInspect.ts 里的严重级别说明。
 */
import { existsSync } from 'node:fs';
import type { SurfaceKind } from '../surface/surfaceTypes.js';
import { inspectXlsxStructure } from '../sheet/xlsxInspect.js';
import { inspectDocxStructure } from '../word/docxInspect.js';
import { isNeoxWritten } from './deliveryProvenance.js';
import { fitIssueLinesIntoPayload, officeIssueToSized } from './compactToolReport.js';
import type { OfficeFormat, OfficeInspectReport } from './officeInspectTypes.js';

export type { OfficeFormat, OfficeInspectReport, OfficeIssue } from './officeInspectTypes.js';

export type OfficeDeliveryVerdict =
  /** 自检通过 —— 放行。 */
  | { status: 'pass'; report: OfficeInspectReport }
  /** 我们写出来的文件且有问题 —— 拦截。 */
  | { status: 'blocked'; report: OfficeInspectReport }
  /** 外部文件 (不是我们写的) —— 放行, 报告仅供参考。 */
  | { status: 'external'; report: OfficeInspectReport }
  /** 自检跑不了 —— 放行但必须大声报, 且禁止声称已验证。 */
  | { status: 'unavailable'; reason: string; userHint: string | null };

/** open_surface 的 kind → 交付闸门认的格式。不归闸门管的 kind 返回 null。 */
export function officeFormatForSurfaceKind(kind: SurfaceKind | string): OfficeFormat | null {
  if (kind === 'sheet') return 'xlsx';
  if (kind === 'docx') return 'docx';
  return null;
}

export async function inspectOfficeForDelivery(format: OfficeFormat, absPath: string): Promise<OfficeDeliveryVerdict> {
  if (!existsSync(absPath)) {
    return {
      status: 'unavailable',
      reason: `文件不存在: ${absPath}. 先确认写盘的工具返回的就是这个路径。`,
      userHint: null,
    };
  }

  let report: OfficeInspectReport;
  try {
    report = format === 'xlsx'
      ? await inspectXlsxStructure(absPath)
      : await inspectDocxStructure(absPath);
  } catch (e) {
    return {
      status: 'unavailable',
      reason:
        `结构自检读不了这份文件: ${e instanceof Error ? e.message : String(e)}. `
        + '你**不许**声称这份文件已经过交付检查。',
      userHint: null,
    };
  }

  if (!isNeoxWritten(absPath)) return { status: 'external', report };
  if (report.mustFixCount > 0) return { status: 'blocked', report };
  return { status: 'pass', report };
}

/** 拦截时回给模型的错误体 (open_surface 直接用)。 */
export function blockedPayload(verdict: Extract<OfficeDeliveryVerdict, { status: 'blocked' }>): Record<string, unknown> {
  /* work:H-19 — 以前 error 级 issue 全量回传 (一张表几十个 #REF! 很常见), 现在压成
   * 一行一条 `[Sheet1!B4] error_value: ...`, 整个返回守 1.5K; 每条都带定位。 */
  const sized = verdict.report.issues.filter((i) => i.severity === 'error').map(officeIssueToSized);
  const fitted = fitIssueLinesIntoPayload(
    (lines) => ({
      error:
        `交付闸门拦截: 这份 ${verdict.report.format} 有 ${verdict.report.mustFixCount} 处必须修的结构问题, 未上屏。`,
      format: verdict.report.format,
      mustFixCount: verdict.report.mustFixCount,
      issues: lines,
      next:
        '按 issues 里每行开头的 [位置] 逐条修 (如 Sheet1!B4 / 第 3 页): 错误值用 sheet_get_range 定位后改掉; '
        + '空页补内容; 图片缺失重新插图; 断链改成本机真实路径或去掉。修完再调 open_surface 复检。'
        + '不要声称已完成, 不要绕过闸门。',
    }),
    sized,
    { minKeep: 3 },
  );
  return fitted.payload;
}

/** 把裁决翻译成 open_surface 要附带的字段 (与 pptx 的 describeVerdict 同形状)。 */
export function describeOfficeVerdict(verdict: OfficeDeliveryVerdict): Record<string, unknown> {
  switch (verdict.status) {
    case 'pass':
      return {
        selfCheck: {
          available: true,
          passed: true,
          format: verdict.report.format,
          stats: verdict.report.stats,
          warnings: verdict.report.issues.filter((i) => i.severity === 'warn').slice(0, 10),
        },
      };
    case 'external':
      return {
        selfCheck: {
          available: true,
          passed: null,
          format: verdict.report.format,
          note:
            '这份文件不是本次 Neox 写出来的 —— 结构闸门只对自己写出来的产出强制生效, 这里只做展示。'
            + '不要把自检结果当作对用户文件的评判去改它, 除非用户要求。',
          mustFixCount: verdict.report.mustFixCount,
          issues: verdict.report.issues.slice(0, 10),
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
            '自检没能运行。交付时必须如实说明"这份文件没有经过自动结构检查"。禁止声称已验证。',
        },
      };
    case 'blocked':
      /* 调用方走 blockedPayload, 这里只留个可读结构兜底 */
      return {
        selfCheck: { available: true, passed: false, format: verdict.report.format, mustFixCount: verdict.report.mustFixCount },
      };
  }
}
