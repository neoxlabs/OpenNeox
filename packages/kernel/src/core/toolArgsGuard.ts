/**
 * Validate required tool arguments at the shared invocation boundary.
 *
 * Both direct and dynamically dispatched tools use this check so malformed
 * arguments are reported before tool implementations access their fields.
 */
import type { Tool } from '../types/index.js';
import { cliLogger } from '../platform/cliLogger.js';
import { appendToolTrace } from '../runtime/agent/toolTraceLog.js';

/**
 * 该工具缺了哪些必填参数。
 *
 * 判据与 call_tool 原有实现一致: 只有 undefined / null 算缺 —— 空串、0、false
 * 都是模型有意给的值, 拦下来反而会把能跑的调用挡掉。
 * args 不是对象 (模型传了字符串/数组) 时按"全缺"处理, 交给调用方回 schema。
 */
export function findMissingRequiredArgs(
  tool: Pick<Tool, 'parameters'>,
  args: unknown,
): string[] {
  const required = tool.parameters?.required ?? [];
  if (required.length === 0) return [];
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  return required.filter((k) => a[k] === undefined || a[k] === null);
}

/** 工具 schema 文本 (给模型看的)。描述截断到 200 字, 免得把上下文撑爆。 */
export function formatToolSchemaForModel(
  tool: Pick<Tool, 'name' | 'description' | 'parameters'>,
): string {
  const props = tool.parameters?.properties;
  const hasProps = !!props && Object.keys(props).length > 0;
  const params = hasProps
    ? Object.entries(props as Record<string, any>)
        .map(([k, v]: [string, any]) => {
          const req = tool.parameters?.required?.includes(k) ? ' (required)' : '';
          const desc = typeof v?.description === 'string' ? v.description.split('\n')[0] : '';
          return `    ${k}: ${v?.type || 'any'}${req} — ${desc}`;
        })
        .join('\n')
    : '    (no parameters)';
  const raw = tool.description ?? '';
  const desc = raw.length > 200 ? `${raw.substring(0, 200)}...` : raw;
  return `${tool.name}: ${desc}\n  Parameters:\n${params}`;
}

/**
 * 直连调用路径的缺参拦截 —— 命中返回"给模型的回执 + 该记的 trace", 没命中返回 null。
 *
 * 为什么整块放这里而不是写在 runner 里: runner.ts 已经是"改一处要手写四遍"的量级
 * (4400+ 行, 有文件大小棘轮盯着), 新增的判断一律落在被调用方, 调用点只留两行。
 *
 * `success: true` 是刻意的, 与 call_tool 同款语义: 这是模型把参数填错了、不是执行
 * 失败, 不该在时间线上弹红卡; 把参数表回给它, 它下一步就能补齐 —— 比崩了再善后
 * 省一整轮。trace 里仍然记 success: false + MissingRequiredArgs, 那是给我们排查看的。
 */
export function rejectMissingRequiredArgs(
  tool: Pick<Tool, 'name' | 'description' | 'parameters'>,
  args: unknown,
  trace: { common: Record<string, unknown>; startedAt: number },
): { output: string; success: true } | null {
  const missing = findMissingRequiredArgs(tool, args);
  if (missing.length === 0) return null;
  const output = buildMissingRequiredArgsMessage(tool, missing);
  cliLogger.warn('RUNNER',
    `[ARGS_GUARD] ${tool.name} 缺必填参数 [${missing.join(', ')}] — 未执行, 已回 schema`);
  appendToolTrace({
    ...(trace.common as any),
    rawOutputPreview: output,
    success: false,
    durationMs: Date.now() - trace.startedAt,
    errorName: 'MissingRequiredArgs',
    errorMsg: `missing: ${missing.join(', ')}`,
  });
  return { output, success: true };
}

/** 缺参时回给模型的整条提示 —— 说清缺什么 + 附上参数表, 让它一步补齐。 */
export function buildMissingRequiredArgsMessage(
  tool: Pick<Tool, 'name' | 'description' | 'parameters'>,
  missing: string[],
): string {
  return `Tool "${tool.name}" missing required argument(s): ${missing.join(', ')}.\n\n`
    + formatToolSchemaForModel(tool);
}

export function normalizeFinishReason(raw: string): string {
  switch (raw) {
    case 'max_tokens':            // 部分中转 / vLLM 系直接透传 Anthropic 写法
    case 'max_output_tokens':
    case 'model_length':          // vLLM 老版本
      return 'length';
    case 'sensitive':             // 智谱 GLM
    case 'refusal':
    case 'safety':                // Gemini (原生适配器把 finishReason 转小写透传)
    case 'recitation':
    case 'prohibited_content':
    case 'blocklist':
    case 'spii':
      return 'content_filter';
    case 'function_call':         // 旧版 OpenAI functions 协议
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'eos':
      return 'stop';
    default:
      return raw;
  }
}

export function findTruncatedToolCallId(
  finishReason: string,
  toolCalls: ReadonlyArray<{ id?: string; function?: { arguments?: string } } | undefined>,
): string | undefined {
  if (toolCalls.length === 0) return undefined;
  const last = toolCalls[toolCalls.length - 1];
  /* content_filter 同样是"说到一半被掐断", 最后一个调用的参数一样可能是半截的。
   * 空串 = 流断了、连结束原因都没收到 (没配 retryOnIncompleteStream 的 profile 不重试,
   * 直接把已收到的交上来): 这时只看最后一个调用的参数本身是不是完整 JSON —— 下游的
   * JSON 自愈会补引号补括号, 放过去就是半个文件写盘。 */
  const cut = finishReason === 'length' || finishReason === 'content_filter'
    || (finishReason === '' && !isCompleteJson(last?.function?.arguments));
  if (!cut) return undefined;
  const id = last?.id;
  return typeof id === 'string' && id ? id : undefined;
}

function isCompleteJson(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;   // 无参调用
  try { JSON.parse(raw); return true; } catch { return false; }
}

/** 被截断的调用不执行, 如实告诉模型原因和该怎么做; 不是被截断的那个返回 null。 */
export function rejectTruncatedToolCall(
  toolName: string,
  toolCallId: string | undefined,
  finishReason: string,
  toolCalls: ReadonlyArray<{ id?: string; function?: { arguments?: string } } | undefined>,
): { output: string; success: false } | null {
  if (!toolCallId || toolCallId !== findTruncatedToolCallId(finishReason, toolCalls)) return null;
  if (finishReason === '') {
    cliLogger.warn('RUNNER', `[ARGS_GUARD] ${toolName} 流中断、参数不是完整 JSON — 未执行`);
    return {
      output:
        `Error: this ${toolName} call was NOT executed. The connection to the model dropped while you were `
        + 'still writing its arguments, so they are incomplete (nothing was written or changed). '
        + 'Re-issue the call.',
      success: false,
    };
  }
  if (finishReason === 'content_filter') {
    cliLogger.warn('RUNNER', `[ARGS_GUARD] ${toolName} 参数被上游内容过滤截断 — 未执行`);
    return {
      output:
        `Error: this ${toolName} call was NOT executed. The provider's content filter stopped your response `
        + 'while you were still writing its arguments, so they are incomplete (nothing was written or changed). '
        + 'Re-issue the call if it is still needed.',
      success: false,
    };
  }
  cliLogger.warn('RUNNER', `[ARGS_GUARD] ${toolName} 参数在输出上限处被截断 — 未执行`);
  return {
    output: `Error: this ${toolName} call was NOT executed. Your response hit the model's max output tokens `
      + 'while you were still writing its arguments, so they were cut off mid-way (nothing was written or changed). '
      + 'This is an output-length limit of this single response, not a limit of the tool. '
      + 'Re-issue the call with shorter arguments: e.g. create the file with the first part, then add the rest '
      + 'with further edits, each in its own response, keeping every call complete.',
    success: false,
  };
}
