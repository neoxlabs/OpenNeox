/**
 * Neox Agent SDK · 公共类型定义
 *
 * SDK 侧的契约。Tool / Message 等通用类型从 kernel re-export, 让用户写
 * tool/message 时 import 一个 SDK 包就够, 不用知道 kernel.
 */

// ============================================================================
// 核心契约
// ============================================================================

export type ThinkingMode = 'auto' | 'high' | 'off';

/** 权限决策 —— PermissionHandler 的返回值 */
export interface PermissionDecision {
  approved: boolean;
  /** 是否缓存本次决定，使同一 run 内的同类工具调用免于重复询问。 */
  remember?: boolean;
  /** 拒绝理由; 会回喂给模型, 让它换一条路而不是原地重试 */
  reason?: string;
}

/** 一次待审批的工具调用 */
export interface PermissionRequest {
  tool: string;
  input: unknown;
  /** 工具是否被标记为 dangerous */
  dangerous: boolean;
  /** kernel 的风险评级 (若可用) */
  risk?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * 自定义审批逻辑。返回 approved:false 时, reason 会回喂给模型。
 *
 * @example
 *   permission: async ({ tool, input }) => ({ approved: await askUser(tool, input) })
 */
export type PermissionHandler = (
  req: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

/**
 * 权限模式:
 *   · 'auto'      放行普通工具; 标记 dangerous / 高风险的仍会被拒 (默认)
 *   · 'readonly'  只放行只读工具 (tool 的 readOnly, 未声明时按 !dangerous 推断)
 *   · 'ask'       必须同时提供 PermissionHandler, 否则构造时即报错
 *   · Handler     完全自定义
 */
export type PermissionMode = 'auto' | 'ask' | 'readonly' | PermissionHandler;

export type StopReason = 'end_turn' | 'max_steps' | 'tool_error' | 'aborted' | 'permission_denied';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Step {
  index: number;
  toolCalls: Array<{ tool: string; input: unknown; output?: unknown; error?: string }>;
  textDelta?: string;
  thinkingDelta?: string;
  durationMs: number;
}

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; tool: string; input: unknown; id: string }
  | { type: 'tool_result'; tool: string; output: unknown; id: string }
  | { type: 'tool_error'; tool: string; error: string; id: string }
  | { type: 'thinking'; delta: string }
  | { type: 'step_start'; step: number }
  | { type: 'step_end'; step: number }
  | { type: 'permission_request'; tool: string; input: unknown; id: string }
  | { type: 'done'; usage: TokenUsage; stopReason: StopReason }
  | { type: 'error'; error: Error };

export type AgentEventHandler = (event: AgentEvent) => void;

// ============================================================================
// 公开结构类型
//
// 这里原本是 `export type { Tool, Message } from '@openneox/kernel'`。
// 后果: 编译出的 dist/types.d.ts 里留下对 '@openneox/kernel' 的类型引用, 而 kernel
// **从未发布到 npm** —— 装了 SDK 的 TypeScript 用户一律 TS2307 "Cannot find module
// '@openneox/kernel'"。运行时没事(bundle 已把 kernel 内联), 但类型层直接崩。
//
// 改成 SDK 自己声明的结构类型: 只暴露公共面需要的字段, 与 kernel 保持结构兼容
// (kernel 的 Tool/Message 是它的超集), 内部适配器仍按 kernel 真类型工作。
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 一条对话消息 —— AgentResult.messages 的元素 */
export interface Message {
  role: MessageRole;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type?: string; function?: { name: string; arguments: string } }>;
  reasoning_content?: string;
  [key: string]: unknown;
}

/** 模型看到的工具契约 (JSONSchema 形态)。用 `tool()` 构造, 一般不用手写。 */
export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  function: (
    args: any,
    context?: { signal?: AbortSignal; toolCallId?: string },
  ) => string | Promise<string>;
  [key: string]: unknown;
}
