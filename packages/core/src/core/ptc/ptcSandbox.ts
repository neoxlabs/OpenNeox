/**
 * PTC Sandbox — Node.js VM 沙箱执行 JS 脚本
 *
 * 安全边界：
 * - vm.createContext 隔离全局作用域
 * - 超时保护（默认 60s）
 * - AbortSignal 支持
 * - 输出大小限制
 */

import vm from 'node:vm';
import type { ToolBinding } from './ptcToolBinder.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 15_000;

export interface SandboxOptions {
  timeout?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

export interface ToolCallRecord {
  name: string;
  durationMs: number;
}

export interface SandboxResult {
  output: string;
  returnValue: any;
  error?: string;
  toolCallCount: number;
  toolCalls: ToolCallRecord[];
  durationMs: number;
}

/**
 * 在 VM 沙箱中执行 PTC 脚本
 */
export async function executeInSandbox(
  code: string,
  toolBindings: Record<string, ToolBinding>,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const startTime = Date.now();

  const logs: string[] = [];
  let toolCallCount = 0;
  const toolCalls: ToolCallRecord[] = [];
  let totalLogChars = 0;

  // 构建沙箱全局对象
  const globals: Record<string, any> = {
    // console.log 捕获
    console: {
      log: (...args: any[]) => {
        const line = args.map(a =>
          typeof a === 'string' ? a : JSON.stringify(a, null, 2)
        ).join(' ');
        totalLogChars += line.length;
        if (totalLogChars <= maxOutput) {
          logs.push(line);
        }
      },
      error: (...args: any[]) => {
        const line = '[ERROR] ' + args.map(String).join(' ');
        logs.push(line);
      },
      warn: (...args: any[]) => {
        const line = '[WARN] ' + args.map(String).join(' ');
        logs.push(line);
      },
    },

    // 基础 JS 能力
    Promise,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    JSON,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Date,
    Math,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
  };

  // 注入工具函数
  for (const [name, binding] of Object.entries(toolBindings)) {
    globals[name] = async (args: any) => {
      if (options.signal?.aborted) {
        throw new Error('Script aborted');
      }
      toolCallCount++;
      const t0 = Date.now();
      const result = await binding.fn(args);
      toolCalls.push({ name, durationMs: Date.now() - t0 });
      return result;
    };
  }

  const context = vm.createContext(globals);

  // 包装成 async IIFE
  const wrappedCode = `(async () => {\n${code}\n})()`;

  try {
    const script = new vm.Script(wrappedCode, {
      filename: 'ptc_script.js',
    });

    const returnValue = await script.runInNewContext(context, { timeout });

    // 处理返回值
    let output = logs.join('\n');
    if (returnValue !== undefined && returnValue !== null) {
      const retStr = typeof returnValue === 'string'
        ? returnValue
        : JSON.stringify(returnValue, null, 2);
      if (output) output += '\n\n[Return Value]\n' + retStr;
      else output = retStr;
    }

    // 截断
    if (output.length > maxOutput) {
      output = output.substring(0, maxOutput) + `\n\n... (truncated, ${output.length} chars total)`;
    }

    return {
      output: output || '(no output)',
      returnValue,
      toolCallCount,
      toolCalls,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const output = logs.length > 0 ? logs.join('\n') + '\n\n' : '';
    return {
      output: output + `[Script Error] ${err.message}`,
      returnValue: undefined,
      error: err.message,
      toolCallCount,
      toolCalls,
      durationMs: Date.now() - startTime,
    };
  }
}
