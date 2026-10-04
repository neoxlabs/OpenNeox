
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const IS_DEBUG = process.env.CLI_DEBUG === '1' || process.env.NEOX_DEBUG === '1';

/**
 * 静默 catch — 替代 `catch {}`
 *
 * 仅在 DEBUG 模式下记录，零生产开销。
 *
 * 用法：
 * ```ts
 * // 旧代码
 * try { ... } catch { }
 *
 * // 新代码
 * try { ... } catch (e) { silentCatch('MODULE', 'operation', e); }
 * ```
 */
export function silentCatch(module: string, operation: string, error?: unknown): void {
  if (!IS_DEBUG) return;
  const msg = error instanceof Error ? error.message : String(error ?? 'unknown');
  cliLogger.debug(module, `[silent catch] ${operation}: ${msg}`);
}

/**
 * 日志 catch — 替代 bare catch with important errors
 *
 * 始终记录（warn 级别），用于不应该静默的 catch。
 */
export function logCatch(module: string, operation: string, error?: unknown): void {
  const msg = error instanceof Error ? error.message : String(error ?? 'unknown');
  cliLogger.warn(module, `[catch] ${operation}: ${msg}`);
}

/**
 * 安全执行 — 包装可能抛异常的代码
 *
 * 用法：
 * ```ts
 * // 旧代码
 * let result;
 * try { result = JSON.parse(str); } catch { result = null; }
 *
 * // 新代码
 * const result = safeExec(() => JSON.parse(str), null, 'JSON', 'parse');
 * ```
 */
export function safeExec<T>(
  fn: () => T,
  fallback: T,
  module?: string,
  operation?: string,
): T {
  try {
    return fn();
  } catch (e) {
    if (IS_DEBUG && module) {
      silentCatch(module, operation || 'safeExec', e);
    }
    return fallback;
  }
}

/**
 * 安全异步执行
 */
export async function safeExecAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  module?: string,
  operation?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (IS_DEBUG && module) {
      silentCatch(module, operation || 'safeExecAsync', e);
    }
    return fallback;
  }
}
