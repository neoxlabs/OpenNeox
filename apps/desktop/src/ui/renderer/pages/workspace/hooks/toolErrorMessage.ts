
import { hasToolGuidanceFlag } from '../../../modules/agent-timeline/turnAnomaly';

/** 各家运行时里表示"出了什么错"的通用键, 按可信度排序。 */
export const ERROR_MESSAGE_KEYS = [
  'message',
  'error',
  'error_message',
  'detail',
  'stderr',
  'reason',
] as const;

/**
 * 从工具错误载荷里挑出给人看的那句话。挑不出返回空串。
 *
 * - 字符串载荷直接用 (裸字符串本来就是错误信息)
 * - 对象载荷按 ERROR_MESSAGE_KEYS 顺序找第一个非空字符串字段
 * - 其余 (数组 / null / 数字 / 只有参数字段的对象) 一律返回 ''
 */
export function pickToolErrorMessage(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  for (const key of ERROR_MESSAGE_KEYS) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 载荷里认不出错误信息时的兜底文案。原始载荷仍会挂在条目上供排障。 */
export function toolErrorFallbackText(language: string): string {
  return language === 'zh'
    ? '工具没有返回错误信息。下面是这次调用的参数, 排障时可以「复制错误详情」发给我们。'
    : 'The tool returned no error message. The call arguments are below; use "Copy error details" when reporting.';
}

export function describeToolError(payload: unknown, language: string): {
  humanError: string;
  errorText: string;
  toolGuidance: boolean;
} {
  const humanError = pickToolErrorMessage(payload);
  return {
    humanError,
    errorText: humanError || toolErrorFallbackText(language),
    toolGuidance: hasToolGuidanceFlag(payload),
  };
}
