/**
 * Connect ErrorPatternMemory to orchestration post hooks.
 *
 * Success resets the tool's failure streak; failure records the output, args,
 * and iteration through the same orchestration path.
 */

import type { ErrorPatternMemory } from '../../reasoning/errorPatternMemory.js';
import type { PostToolSuccessHook, PostToolFailureHook } from '../types.js';

export function createErrorPatternSuccessHook(
  memory: ErrorPatternMemory,
): PostToolSuccessHook {
  return {
    name: 'errorPatternMemory.success',
    async run(toolName) {
      memory.recordSuccess(toolName);
    },
  };
}

export interface CreateErrorPatternFailureHookOptions {
  memory: ErrorPatternMemory;
  /** 当前迭代号(memory 内部记账用); 调用方每轮传入最新值 */
  getIteration: () => number;
}

export function createErrorPatternFailureHook(
  opts: CreateErrorPatternFailureHookOptions,
): PostToolFailureHook {
  const { memory, getIteration } = opts;
  return {
    name: 'errorPatternMemory.failure',
    async run(toolName, args, errorOutput) {
      memory.recordFailure(toolName, errorOutput, args, getIteration());
    },
  };
}
