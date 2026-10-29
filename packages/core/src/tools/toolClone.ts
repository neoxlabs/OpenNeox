import type { Tool } from '@neoxlabs/kernel/types/index.js';

/** 复制工具对象, 保留 getter (description / parameters 里的动态描述) 不提前求值。 */
export function cloneToolPreservingAccessors<T extends Tool>(tool: T, patch?: Partial<T>): T {
  const descriptors = Object.getOwnPropertyDescriptors(tool);
  const clone = Object.create(Object.getPrototypeOf(tool) as object, descriptors) as T;
  if (patch) {
    for (const key of Object.keys(patch) as (keyof T)[]) {
      Object.defineProperty(clone, key, {
        value: patch[key], enumerable: true, configurable: true, writable: true,
      });
    }
  }
  return clone;
}
