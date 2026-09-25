/**
 * Guardrails 执行器
 *
 * 负责执行 Input, Output, Tool Guardrails 检查
 * 支持并行执行,成本优化
 */

import type {
  InputGuardrail,
  InputGuardrailResult,
  OutputGuardrail,
  OutputGuardrailResult,
  ToolInputGuardrail,
  ToolOutputGuardrail,
  ToolGuardrailResult,
  ToolInputGuardrailData,
  ToolOutputGuardrailData,
  Message,
  RunContext
} from '../types/index.js';

import {
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  ToolGuardrailTripwireTriggered
} from './guardrail-exceptions.js';

/**
 * Guardrails 执行器
 */
export class GuardrailsExecutor {
  /**
   * 执行 Input Guardrails (并行)
   *
   * @description
   * 所有 Input Guardrails 并行执行,任何一个触发 tripwire 都会抛出异常
   *
   * @param guardrails - Input Guardrails 列表
   * @param context - 运行时上下文
   * @param agentName - Agent 名称
   * @param input - 用户输入
   * @throws InputGuardrailTripwireTriggered 如果检查失败
   */
  static async runInputGuardrails(
    guardrails: InputGuardrail[],
    context: RunContext,
    agentName: string,
    input: string | Message[]
  ): Promise<InputGuardrailResult[]> {
    if (guardrails.length === 0) {
      return [];
    }

    // 并行执行所有 Input Guardrails
    const promises = guardrails.map(async (guardrail) => {
      const startTime = Date.now();

      try {
        const output = await guardrail.guardrail_function(context, agentName, input);

        const result: InputGuardrailResult = {
          guardrail,
          output,
          execution_time_ms: Date.now() - startTime
        };

        // 检查是否触发 tripwire
        if (output.tripwire_triggered) {
          throw new InputGuardrailTripwireTriggered(result);
        }

        return result;
      } catch (error) {
        // 如果已经是 GuardrailTripwireTriggered 异常,直接抛出
        if (error instanceof InputGuardrailTripwireTriggered) {
          throw error;
        }

        // 其他错误包装为 Guardrail 失败
        const result: InputGuardrailResult = {
          guardrail,
          output: {
            tripwire_triggered: true,
            output_info: {
              error: error instanceof Error ? error.message : String(error),
              reason: 'Guardrail execution failed'
            }
          },
          execution_time_ms: Date.now() - startTime
        };

        throw new InputGuardrailTripwireTriggered(result);
      }
    });

    // 等待所有 Guardrails 完成（如果任何一个失败,会立即抛出异常）
    return await Promise.all(promises);
  }

  /**
   * 执行 Output Guardrails (并行)
   *
   * @description
   * 所有 Output Guardrails 并行执行,任何一个触发 tripwire 都会抛出异常
   *
   * @param guardrails - Output Guardrails 列表
   * @param context - 运行时上下文
   * @param agentName - Agent 名称
   * @param output - Agent 输出
   * @throws OutputGuardrailTripwireTriggered 如果检查失败
   */
  static async runOutputGuardrails(
    guardrails: OutputGuardrail[],
    context: RunContext,
    agentName: string,
    output: any
  ): Promise<OutputGuardrailResult[]> {
    if (guardrails.length === 0) {
      return [];
    }

    // 并行执行所有 Output Guardrails
    const promises = guardrails.map(async (guardrail) => {
      const startTime = Date.now();

      try {
        const guardrailOutput = await guardrail.guardrail_function(
          context,
          agentName,
          output
        );

        const result: OutputGuardrailResult = {
          guardrail,
          agent_output: output,
          output: guardrailOutput,
          execution_time_ms: Date.now() - startTime
        };

        // 检查是否触发 tripwire
        if (guardrailOutput.tripwire_triggered) {
          throw new OutputGuardrailTripwireTriggered(result);
        }

        return result;
      } catch (error) {
        if (error instanceof OutputGuardrailTripwireTriggered) {
          throw error;
        }

        const result: OutputGuardrailResult = {
          guardrail,
          agent_output: output,
          output: {
            tripwire_triggered: true,
            output_info: {
              error: error instanceof Error ? error.message : String(error),
              reason: 'Guardrail execution failed'
            }
          },
          execution_time_ms: Date.now() - startTime
        };

        throw new OutputGuardrailTripwireTriggered(result);
      }
    });

    return await Promise.all(promises);
  }

  /**
   * 执行 Tool Input Guardrails (顺序执行)
   *
   * @description
   * Tool Guardrails 顺序执行,因为需要根据行为类型决定是否继续
   *
   * @param guardrails - Tool Input Guardrails 列表
   * @param data - 工具输入数据
   * @returns Guardrail 结果（如果允许继续）
   * @throws ToolGuardrailTripwireTriggered 如果行为是 raise_exception
   */
  static async runToolInputGuardrails(
    guardrails: ToolInputGuardrail[],
    data: ToolInputGuardrailData
  ): Promise<{
    results: ToolGuardrailResult[];
    should_execute: boolean;
    rejection_message?: string;
  }> {
    const results: ToolGuardrailResult[] = [];

    for (const guardrail of guardrails) {
      const startTime = Date.now();

      try {
        const output = await guardrail.guardrail_function(data);

        const result: ToolGuardrailResult = {
          guardrail,
          output,
          execution_time_ms: Date.now() - startTime
        };

        results.push(result);

        // 检查行为类型
        if (output.behavior.type === 'raise_exception') {
          throw new ToolGuardrailTripwireTriggered(result);
        }

        if (output.behavior.type === 'reject_content') {
          return {
            results,
            should_execute: false,
            rejection_message: output.behavior.message
          };
        }

        // allow - 继续下一个 guardrail
      } catch (error) {
        if (error instanceof ToolGuardrailTripwireTriggered) {
          throw error;
        }

        const result: ToolGuardrailResult = {
          guardrail,
          output: {
            output_info: {
              error: error instanceof Error ? error.message : String(error)
            },
            behavior: { type: 'raise_exception' }
          },
          execution_time_ms: Date.now() - startTime
        };

        throw new ToolGuardrailTripwireTriggered(result);
      }
    }

    return {
      results,
      should_execute: true
    };
  }

  /**
   * 执行 Tool Output Guardrails (顺序执行)
   *
   * @param guardrails - Tool Output Guardrails 列表
   * @param data - 工具输出数据
   * @returns Guardrail 结果
   * @throws ToolGuardrailTripwireTriggered 如果行为是 raise_exception
   */
  static async runToolOutputGuardrails(
    guardrails: ToolOutputGuardrail[],
    data: ToolOutputGuardrailData
  ): Promise<{
    results: ToolGuardrailResult[];
    should_use_output: boolean;
    replacement_message?: string;
  }> {
    const results: ToolGuardrailResult[] = [];

    for (const guardrail of guardrails) {
      const startTime = Date.now();

      try {
        const output = await guardrail.guardrail_function(data);

        const result: ToolGuardrailResult = {
          guardrail,
          output,
          execution_time_ms: Date.now() - startTime
        };

        results.push(result);

        if (output.behavior.type === 'raise_exception') {
          throw new ToolGuardrailTripwireTriggered(result);
        }

        if (output.behavior.type === 'reject_content') {
          return {
            results,
            should_use_output: false,
            replacement_message: output.behavior.message
          };
        }
      } catch (error) {
        if (error instanceof ToolGuardrailTripwireTriggered) {
          throw error;
        }

        const result: ToolGuardrailResult = {
          guardrail,
          output: {
            output_info: {
              error: error instanceof Error ? error.message : String(error)
            },
            behavior: { type: 'raise_exception' }
          },
          execution_time_ms: Date.now() - startTime
        };

        throw new ToolGuardrailTripwireTriggered(result);
      }
    }

    return {
      results,
      should_use_output: true
    };
  }
}
