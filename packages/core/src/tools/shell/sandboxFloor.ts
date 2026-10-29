/**
 * Guarded assistant and work modes run inside an AsyncLocalStorage sandbox
 * floor. The wrapper scopes the floor per tool call and respects an explicit
 * danger-full-access selection; code mode does not install the floor.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface SandboxFloor {
  /** 谁抬的地板 (上屏/日志用): 'assistant' | 'work'。 */
  mode: string;
  /** 人话理由。 */
  reason: string;
}

const floorStore = new AsyncLocalStorage<SandboxFloor>();

/** 当前调用链上是否挂着地板。 */
export function getSandboxFloor(): SandboxFloor | undefined {
  return floorStore.getStore();
}

/** 在地板下执行 —— 包住 shell 工具的 function 调用。 */
export async function runWithSandboxFloor<T>(
  floor: SandboxFloor,
  task: () => T | Promise<T>,
): Promise<T> {
  return floorStore.run(floor, async () => await task());
}
