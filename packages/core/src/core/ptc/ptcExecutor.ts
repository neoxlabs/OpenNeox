/**
 * PTC Executor — 主执行器
 *
 * 串联 ToolBinder + Sandbox，提供统一的执行入口
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createToolBindings } from './ptcToolBinder.js';
import { executeInSandbox, type SandboxResult, type ToolCallRecord } from './ptcSandbox.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface PTCExecuteOptions {
  script: string;
  description?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface PTCExecuteResult {
  output: string;
  success: boolean;
  toolCallCount: number;
  toolCalls: ToolCallRecord[];
  durationMs: number;
  error?: string;
}

export class PTCExecutor {
  private tools: Tool[];

  constructor(tools: Tool[]) {
    this.tools = tools;
  }

  async execute(options: PTCExecuteOptions): Promise<PTCExecuteResult> {
    const { script, description, timeout, signal } = options;

    cliLogger.info('PTC', `Executing script${description ? `: ${description}` : ''}`, {
      scriptLength: script.length,
    });

    const bindings = createToolBindings(this.tools);
    const bindingCount = Object.keys(bindings).length;
    cliLogger.debug('PTC', `${bindingCount} tool bindings created`);

    let result: SandboxResult;
    try {
      result = await executeInSandbox(script, bindings, { timeout, signal });
    } catch (err: any) {
      return {
        output: `[PTC Fatal] ${err.message}`,
        success: false,
        toolCallCount: 0,
        toolCalls: [],
        durationMs: 0,
        error: err.message,
      };
    }

    cliLogger.info('PTC', `Script completed`, {
      toolCalls: result.toolCallCount,
      durationMs: result.durationMs,
      hasError: !!result.error,
    });

    return {
      output: result.output,
      success: !result.error,
      toolCallCount: result.toolCallCount,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs,
      error: result.error,
    };
  }
}
