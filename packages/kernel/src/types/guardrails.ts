/**
 * Guardrails 类型定义
 *
 * 提供三种类型的安全防护:
 * 1. Input Guardrails - 输入验证
 * 2. Output Guardrails - 输出验证
 * 3. Tool Guardrails - 工具调用验证
 */

import type { Message } from './index.js';
import type { RunContext } from './index.js';
import type { Tool } from './index.js';

// ============================================================================
// Guardrail 核心类型
// ============================================================================

/**
 * Guardrail 函数输出
 *
 * @description
 * 所有 Guardrail 函数必须返回此类型
 * - output_info: 可选的检查详情
 * - tripwire_triggered: 是否触发绊线(触发则停止执行)
 */
export interface GuardrailFunctionOutput {
  /** 检查详情（可选） */
  output_info?: any;

  /** 是否触发绊线（true = 停止执行） */
  tripwire_triggered: boolean;
}

// ============================================================================
// Input Guardrails (输入防护)
// ============================================================================

/**
 * Input Guardrail 函数签名
 *
 * @param context - 运行时上下文
 * @param agentName - Agent 名称
 * @param input - 用户输入（字符串或消息列表）
 * @returns Guardrail 检查结果
 */
export type InputGuardrailFunction = (
  context: RunContext,
  agentName: string,
  input: string | Message[]
) => Promise<GuardrailFunctionOutput> | GuardrailFunctionOutput;

/**
 * Input Guardrail 定义
 */
export interface InputGuardrail {
  /** Guardrail 名称（用于日志和追踪） */
  name: string;

  /** Guardrail 函数 */
  guardrail_function: InputGuardrailFunction;
}

/**
 * Input Guardrail 结果
 */
export interface InputGuardrailResult {
  /** 执行的 Guardrail */
  guardrail: InputGuardrail;

  /** 检查输出 */
  output: GuardrailFunctionOutput;

  /** 执行时间（毫秒） */
  execution_time_ms: number;
}

// ============================================================================
// Output Guardrails (输出防护)
// ============================================================================

/**
 * Output Guardrail 函数签名
 *
 * @param context - 运行时上下文
 * @param agentName - Agent 名称
 * @param output - Agent 输出
 * @returns Guardrail 检查结果
 */
export type OutputGuardrailFunction = (
  context: RunContext,
  agentName: string,
  output: any
) => Promise<GuardrailFunctionOutput> | GuardrailFunctionOutput;

/**
 * Output Guardrail 定义
 */
export interface OutputGuardrail {
  /** Guardrail 名称 */
  name: string;

  /** Guardrail 函数 */
  guardrail_function: OutputGuardrailFunction;
}

/**
 * Output Guardrail 结果
 */
export interface OutputGuardrailResult {
  /** 执行的 Guardrail */
  guardrail: OutputGuardrail;

  /** Agent 输出 */
  agent_output: any;

  /** 检查输出 */
  output: GuardrailFunctionOutput;

  /** 执行时间（毫秒） */
  execution_time_ms: number;
}

// ============================================================================
// Tool Guardrails (工具防护)
// ============================================================================

/**
 * Tool 上下文（工具调用信息）
 */
export interface ToolContext {
  /** 工具名称 */
  tool_name: string;

  /** 工具输入参数 */
  tool_input: Record<string, any>;

  /** 工具调用 ID */
  tool_call_id?: string;
}

/**
 * Tool Input Guardrail 数据
 */
export interface ToolInputGuardrailData {
  /** 运行时上下文 */
  context: RunContext;

  /** 工具上下文 */
  tool_context: ToolContext;

  /** Agent 名称 */
  agent_name: string;

  /** 工具定义 */
  tool: Tool;
}

/**
 * Tool Output Guardrail 数据
 */
export interface ToolOutputGuardrailData extends ToolInputGuardrailData {
  /** 工具执行输出 */
  output: any;
}

/**
 * Tool Guardrail 行为类型
 */
export type ToolGuardrailBehavior =
  | { type: 'allow' }  // 允许执行
  | { type: 'reject_content'; message: string }  // 拒绝并返回消息
  | { type: 'raise_exception' };  // 抛出异常,停止执行

/**
 * Tool Guardrail 函数输出
 */
export interface ToolGuardrailFunctionOutput {
  /** 检查详情 */
  output_info?: any;

  /** 行为类型 */
  behavior: ToolGuardrailBehavior;
}

/**
 * Tool Input Guardrail 函数签名
 */
export type ToolInputGuardrailFunction = (
  data: ToolInputGuardrailData
) => Promise<ToolGuardrailFunctionOutput> | ToolGuardrailFunctionOutput;

/**
 * Tool Output Guardrail 函数签名
 */
export type ToolOutputGuardrailFunction = (
  data: ToolOutputGuardrailData
) => Promise<ToolGuardrailFunctionOutput> | ToolGuardrailFunctionOutput;

/**
 * Tool Input Guardrail 定义
 */
export interface ToolInputGuardrail {
  /** Guardrail 名称 */
  name: string;

  /** Guardrail 函数 */
  guardrail_function: ToolInputGuardrailFunction;
}

/**
 * Tool Output Guardrail 定义
 */
export interface ToolOutputGuardrail {
  /** Guardrail 名称 */
  name: string;

  /** Guardrail 函数 */
  guardrail_function: ToolOutputGuardrailFunction;
}

/**
 * Tool Guardrail 结果
 */
export interface ToolGuardrailResult {
  /** 执行的 Guardrail */
  guardrail: ToolInputGuardrail | ToolOutputGuardrail;

  /** 检查输出 */
  output: ToolGuardrailFunctionOutput;

  /** 执行时间（毫秒） */
  execution_time_ms: number;
}

// ============================================================================
// 工具类：简化创建 Guardrail 输出
// ============================================================================

/**
 * 创建允许的 Tool Guardrail 输出
 */
export function allowToolGuardrail(output_info?: any): ToolGuardrailFunctionOutput {
  return {
    output_info,
    behavior: { type: 'allow' }
  };
}

/**
 * 创建拒绝的 Tool Guardrail 输出
 */
export function rejectToolGuardrail(
  message: string,
  output_info?: any
): ToolGuardrailFunctionOutput {
  return {
    output_info,
    behavior: { type: 'reject_content', message }
  };
}

/**
 * 创建抛异常的 Tool Guardrail 输出
 */
export function raiseExceptionToolGuardrail(
  output_info?: any
): ToolGuardrailFunctionOutput {
  return {
    output_info,
    behavior: { type: 'raise_exception' }
  };
}
