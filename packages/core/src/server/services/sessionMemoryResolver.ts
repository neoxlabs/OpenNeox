import type { AgenticRuntime } from '../../runtime/agenticRuntime.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';

export function resolveSessionMemory(
  singleRuntime: AgenticRuntime | null,
  fallbackMemory: ShortTermMemory,
  sessionId: string,
) {
  return singleRuntime?.getSessionMemory(sessionId) ?? fallbackMemory;
}
