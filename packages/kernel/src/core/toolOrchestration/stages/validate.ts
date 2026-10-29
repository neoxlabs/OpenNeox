/**
 * Stage 1 — validate
 *
 * 职责:
 *   1. 解析 tool_call.function.name(含别名解析,经 ctx.resolveAlias)
 *   2. 在 ctx.tools 中找到对应 Tool 定义
 *   3. JSON.parse tool_call.function.arguments
 *   4. 标准化 args 为 Record<string, unknown>
 *
 * 不做 schema 校验(留给具体 tool 实现或未来 Zod 集成), 只做结构性解析。
 */

import type { Tool, ToolCall } from '../../../types/index.js';
import { block, ok, type StageResult } from '../types.js';
import type { ToolUseContext } from '../types.js';
import { tryFixToolArgsJson } from '../../runnerOutputSelfHeal.js';

export interface ValidatedCall {
  tool: Tool;
  resolvedName: string;
  args: Record<string, unknown>;
}

export function runValidateStage(
  toolCall: ToolCall,
  ctx: ToolUseContext,
): StageResult<ValidatedCall> {
  const rawName = toolCall.function?.name ?? '';
  if (!rawName) {
    return block('unknown_tool', 'Tool call missing function.name');
  }

  // 先试直接匹配, 再试 alias
  let tool = ctx.tools.find((t) => t.name === rawName);
  let resolvedName = rawName;

  if (!tool) {
    const aliased = ctx.resolveAlias(rawName);
    if (aliased) {
      tool = ctx.tools.find((t) => t.name === aliased);
      resolvedName = aliased;
    }
  }

  if (!tool) {
    return block(
      'unknown_tool',
      `Tool not found: ${rawName}. Available: ${ctx.tools.map((t) => t.name).slice(0, 20).join(', ')}${ctx.tools.length > 20 ? ', ...' : ''}`,
    );
  }

  // 参数解析
  const rawArgs = toolCall.function?.arguments ?? '{}';
  let args: Record<string, unknown>;
  if (typeof rawArgs !== 'string') {
    // 有些 provider 直接给 object; 兼容之
    args = (rawArgs && typeof rawArgs === 'object'
      ? (rawArgs as Record<string, unknown>)
      : {});
  } else {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
      args = {};
    } else {
      const parsed = parseArgsWithSelfHeal(trimmed);
      if (parsed instanceof Error) {
        return block(
          'invalid_args',
          `Invalid JSON arguments for "${rawName}": ${parsed.message}`,
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return block(
          'invalid_args',
          `Invalid JSON arguments for "${rawName}": expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
        );
      }
      args = parsed as Record<string, unknown>;
    }
  }

  return ok<ValidatedCall>({ tool, resolvedName, args });
}

/**
 * JSON.parse + 自修复 — 与 runner 写 memory 层 (runner.ts [SELF_HEAL]) 同一条修复路径。
 * 此前 validate 对坏 JSON 直接 block 而 runner 层会先 tryFixToolArgsJson, 同一个截断
 * args 走不同入口结局不同; 现在两层行为一致: 先修 (trailing comma / 未闭合括号引号),
 * 修不动才报错。返回 Error = 彻底解析失败。
 */
function parseArgsWithSelfHeal(trimmed: string): unknown | Error {
  try {
    return JSON.parse(trimmed);
  } catch (err: any) {
    const fixed = tryFixToolArgsJson(trimmed);
    if (fixed !== null) {
      try {
        return JSON.parse(fixed);
      } catch {
        /* 修复版仍坏 → 报原始错误 */
      }
    }
    return new Error(err?.message ?? 'parse failed');
  }
}
