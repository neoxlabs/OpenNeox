/**
 * Guardrail 异常类
 *
 * 当 Guardrail 检查失败时抛出的异常
 */

import type {
  InputGuardrailResult,
  OutputGuardrailResult,
  ToolGuardrailResult
} from '../types/guardrails';

/**
 * Guardrail Tripwire 基础异常
 */
export class GuardrailTripwireTriggered extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailTripwireTriggered';
  }
}

/**
 * Input Guardrail Tripwire 异常
 *
 * @description
 * 当输入检查失败时抛出
 * - 用户输入违反安全规则
 * - 检测到恶意内容
 * - 超出配额限制等
 */
export class InputGuardrailTripwireTriggered extends GuardrailTripwireTriggered {
  /** Guardrail 检查结果 */
  public readonly guardrail_result: InputGuardrailResult;

  constructor(result: InputGuardrailResult) {
    const message = `Input guardrail "${result.guardrail.name}" triggered: ${
      result.output.output_info?.reason || 'Safety check failed'
    }`;

    super(message);
    this.name = 'InputGuardrailTripwireTriggered';
    this.guardrail_result = result;
  }

  /**
   * 获取详细信息
   */
  getDetails() {
    return {
      guardrail_name: this.guardrail_result.guardrail.name,
      execution_time_ms: this.guardrail_result.execution_time_ms,
      output_info: this.guardrail_result.output.output_info
    };
  }
}

/**
 * Output Guardrail Tripwire 异常
 *
 * @description
 * 当输出检查失败时抛出
 * - Agent 输出包含敏感信息
 * - 输出格式不符合要求
 * - 检测到有害内容等
 */
export class OutputGuardrailTripwireTriggered extends GuardrailTripwireTriggered {
  /** Guardrail 检查结果 */
  public readonly guardrail_result: OutputGuardrailResult;

  /** Agent 输出（已被阻止） */
  public readonly blocked_output: any;

  constructor(result: OutputGuardrailResult) {
    const message = `Output guardrail "${result.guardrail.name}" triggered: ${
      result.output.output_info?.reason || 'Output safety check failed'
    }`;

    super(message);
    this.name = 'OutputGuardrailTripwireTriggered';
    this.guardrail_result = result;
    this.blocked_output = result.agent_output;
  }

  /**
   * 获取详细信息
   */
  getDetails() {
    return {
      guardrail_name: this.guardrail_result.guardrail.name,
      execution_time_ms: this.guardrail_result.execution_time_ms,
      output_info: this.guardrail_result.output.output_info,
      blocked_output: this.blocked_output
    };
  }
}

/**
 * Tool Guardrail Tripwire 异常
 *
 * @description
 * 当工具检查失败时抛出
 * - 工具调用违反安全规则
 * - 检测到危险操作
 * - 工具输出包含敏感信息等
 */
export class ToolGuardrailTripwireTriggered extends GuardrailTripwireTriggered {
  /** Guardrail 检查结果 */
  public readonly guardrail_result: ToolGuardrailResult;

  constructor(result: ToolGuardrailResult) {
    const message = `Tool guardrail "${result.guardrail.name}" triggered: ${
      result.output.output_info?.reason || 'Tool safety check failed'
    }`;

    super(message);
    this.name = 'ToolGuardrailTripwireTriggered';
    this.guardrail_result = result;
  }

  /**
   * 获取详细信息
   */
  getDetails() {
    return {
      guardrail_name: this.guardrail_result.guardrail.name,
      execution_time_ms: this.guardrail_result.execution_time_ms,
      output_info: this.guardrail_result.output.output_info,
      behavior: this.guardrail_result.output.behavior
    };
  }
}
