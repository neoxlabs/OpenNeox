/**
 * NeoxSdkTool  kernel Tool 适配
 *
 * SDK 侧的 tool() 产出的 NeoxSdkTool 已经带好 JSONSchema,
 * 这里把它折成 kernel runtime 能吃的 Tool 形态.
 */

import type { AnyNeoxSdkTool } from '../tool.js';
import type { Tool as SdkTool } from '../types.js';

/* 返回类型用 SDK 自己的结构类型而不是 kernel 的 —— kernel 没发到 npm,
 * 让它出现在 .d.ts 里会把所有 TS 用户卡在 TS2307。结构上两者兼容。 */
export function sdkToolToKernelTool(sdk: AnyNeoxSdkTool): SdkTool {
  const schema = sdk.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: sdk.name,
    description: sdk.description,
    parameters: {
      type: 'object',
      properties: (schema.properties ?? {}) as Record<string, any>,
      required: schema.required,
    },
    function: async (args: unknown, context?: { signal?: AbortSignal }) => {
      const signal = context?.signal ?? new AbortController().signal;
      const output = await sdk.invoke(args, {
        signal,
        logger: createSilentLogger(),
      });
      return stringifyToolOutput(output);
    },
    group: sdk.config.dangerous ? 'execute' : 'read',
    parallelSafety: sdk.config.dangerous ? 'unsafe' : 'safe',
    isReadOnly: !sdk.config.dangerous,
  };
}

/* 向后兼容: 老名字保留作 alias, 内部 codebase 老 import 不至于一改全炸 */
export const sdkToolToCoreTool = sdkToolToKernelTool;

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function createSilentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
