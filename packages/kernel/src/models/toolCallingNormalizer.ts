/**
 * Tool Calling Normalizer — 三种 wire format 内部统一 ToolCall 的双向转换层
 *
 *  D14 创建. audit 报告 D14: "Claude tool_use / OpenAI function_calls /
 * Gemini function_calls 三种 wire format 各 adapter 直接当 tool_calls 用, 无统一转换层,
 * 无 unit test"。每加一个 provider 工具调用都得在 4+ 处贴胶布, 而且错了也没人发现。
 *
 * 内部格式 = OpenAI tool_calls 形态 (Neox runner 已经按此约定运转):
 *   interface InternalToolCall {
 *     id: string;
 *     type: 'function';
 *     function: { name: string; arguments: string };  // arguments 是 JSON 字符串
 *   }
 *
 * 三种 wire format 的差异:
 *   - OpenAI: { id, type: 'function', function: { name, arguments } } — 零转换 (内部就是它)
 *   - Claude: { type: 'tool_use', id, name, input: {...} } — input 是 object 要 stringify
 *   - Gemini: { functionCall: { name, args: {...} } } — 没 id, 要造一个
 *
 * 设计原则:
 *   1. 转换器只做格式翻译, 不做 schema 校验 (校验留给 sanitizeToolPairs 之类)
 *   2. 失败时不抛, 返回 null — adapter 调用方根据需要决定是 skip 还是 fallback raw
 *   3. id 缺失时合成 (随机 + 时间戳), 保证回写 wire format 时能配对 tool_result
 */

import { randomBytes } from 'node:crypto';

export interface InternalToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

function makeId(): string {
  return `call_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/* ─────────────────────────  Claude ─────────────────────────────────── */

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function fromClaudeToolUse(block: ClaudeToolUseBlock): InternalToolCall | null {
  if (!block || block.type !== 'tool_use' || !block.name) return null;
  const argsStr = block.input !== undefined ? JSON.stringify(block.input) : '{}';
  return {
    id: block.id ?? makeId(),
    type: 'function',
    function: {
      name: block.name,
      arguments: argsStr,
    },
  };
}

export function toClaudeToolUse(tc: InternalToolCall): ClaudeToolUseBlock {
  let input: Record<string, unknown> = {};
  try {
    input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
  } catch {
    /* 非法 JSON — 包成 _raw 字段, 至少不丢内容; downstream 应正常 tool_error */
    input = { _raw: tc.function.arguments };
  }
  return {
    type: 'tool_use',
    id: tc.id,
    name: tc.function.name,
    input,
  };
}

/* ─────────────────────────  OpenAI ─────────────────────────────────── */

export interface OpenAIToolCall {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export function fromOpenAIToolCall(tc: OpenAIToolCall): InternalToolCall | null {
  if (!tc?.function?.name) return null;
  return {
    id: tc.id ?? makeId(),
    type: 'function',
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments ?? '{}',
    },
  };
}

/* OpenAI 形态就是内部形态, 反向是 identity */
export function toOpenAIToolCall(tc: InternalToolCall): InternalToolCall {
  return tc;
}

/* ─────────────────────────  Gemini ─────────────────────────────────── */

export interface GeminiFunctionCall {
  /** Gemini 是嵌套 functionCall.name / args 形态; 官方 API 的 id 在 functionCall 内 */
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  /** 部分 SDK 把 id 单独发出来 (response_id 或 callId) */
  id?: string;
}

/**
 * args → JSON 字符串规范化 (从 gemini.ts 上移, 单一实现):
 * Gemini 偶发把 args 给成字符串 (裸值或已 stringify 的 JSON), 也可能是 null。
 */
export function normalizeFunctionArgs(args: unknown): string {
  if (args === null || args === undefined) {
    return '{}';
  }
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) {
      return '{}';
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return trimmed;
    }
    return JSON.stringify({ value: trimmed });
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

export function fromGeminiFunctionCall(g: GeminiFunctionCall): InternalToolCall | null {
  const name = g?.functionCall?.name;
  if (!name) return null;
  return {
    id: g.functionCall?.id ?? g.id ?? makeId(),
    type: 'function',
    function: {
      name,
      arguments: normalizeFunctionArgs(g.functionCall?.args),
    },
  };
}

export function toGeminiFunctionCall(tc: InternalToolCall): GeminiFunctionCall {
  let args: Record<string, unknown> = {};
  try {
    args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
  } catch {
    args = { _raw: tc.function.arguments };
  }
  return {
    id: tc.id,
    functionCall: {
      name: tc.function.name,
      args,
    },
  };
}

/* ─────────────────────────  统一入口  ───────────────────────────────── */

export type ToolCallWireFormat = 'openai-function' | 'anthropic-blocks' | 'gemini-function';

export function fromWireFormat(format: ToolCallWireFormat, raw: unknown): InternalToolCall | null {
  switch (format) {
    case 'anthropic-blocks':
      return fromClaudeToolUse(raw as ClaudeToolUseBlock);
    case 'openai-function':
      return fromOpenAIToolCall(raw as OpenAIToolCall);
    case 'gemini-function':
      return fromGeminiFunctionCall(raw as GeminiFunctionCall);
    default:
      return null;
  }
}

export function toWireFormat(format: ToolCallWireFormat, tc: InternalToolCall): unknown {
  switch (format) {
    case 'anthropic-blocks':
      return toClaudeToolUse(tc);
    case 'openai-function':
      return toOpenAIToolCall(tc);
    case 'gemini-function':
      return toGeminiFunctionCall(tc);
    default:
      return tc;
  }
}
