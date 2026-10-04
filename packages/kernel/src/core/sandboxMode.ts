/**
 * SandboxMode 全局状态 — 权限**范围**控制
 *
 * 提供:
 *   - 读: getCurrentSandboxMode() — toolRiskEvaluator / prompt 注入 / agent 自省 用
 *   - 写: setCurrentSandboxMode() — CLI 命令 / UI 切换 / agenticRuntime 启动配置 用
 *   - 重置: resetSandboxMode() — /clear / 测试用
 *
 * 设计:
 *   - module-level singleton, 当前进程整轮共享 (后续可改 per-session 但本期不做)
 *   - 默认值 = WORKSPACE_WRITE (跟现有"无 sandbox enforcement"行为最接近)
 *   - 写时记录前后值变化, 触发监听器 (供 prompt 重建 / UI 提示)
 *
 * 跟 AgentMode 的关系:
 *   AgentMode 控制审批节奏 (ask/agent/auto), 跟本 module 正交.
 *   SandboxMode 是硬约束 — read-only 下 write 直接被 evaluateToolRisk 拦, 不走审批.
 */

import { cliLogger } from '../platform/cliLogger.js';
import { SandboxMode, DEFAULT_SANDBOX_MODE } from '../types/permissions.js';
import { createSessionScopedStore, currentSessionScopeId } from './sessionScope.js';

export { SandboxMode, DEFAULT_SANDBOX_MODE } from '../types/permissions.js';

// ============================================================================
// State
// ============================================================================

/* Store the mode per session while retaining the default bucket for callers
 * that do not establish an explicit session scope. */
const modeStore = createSessionScopedStore<SandboxMode>(() => DEFAULT_SANDBOX_MODE);

type ChangeListener = (next: SandboxMode, prev: SandboxMode) => void;
const listeners = new Set<ChangeListener>();

// ============================================================================
// API
// ============================================================================

/**
 * 获取当前 sandbox mode. 默认 WORKSPACE_WRITE.
 */
export function getCurrentSandboxMode(): SandboxMode {
  return modeStore.get();
}

/**
 * 设置 sandbox mode. 触发监听器 (prompt 重建 / UI 提示等).
 * 同 mode 重复 set 不触发 listener (no-op for ==).
 *
 * @returns 是否真的改变了 (true=改了 false=同 mode)
 */
export function setCurrentSandboxMode(mode: SandboxMode): boolean {
  const prev = modeStore.get();
  if (mode === prev) return false;
  modeStore.set(mode);
  cliLogger.info('SANDBOX_MODE', `Sandbox mode changed: ${prev} → ${mode} (scope=${currentSessionScopeId()})`);
  for (const listener of listeners) {
    try {
      listener(mode, prev);
    } catch (err: any) {
      cliLogger.warn('SANDBOX_MODE', `Listener threw: ${err?.message ?? err}`);
    }
  }
  return true;
}

/**
 * 重置到默认 (WORKSPACE_WRITE). /clear / 新 session 时调.
 */
export function resetSandboxMode(): void {
  setCurrentSandboxMode(DEFAULT_SANDBOX_MODE);
}

/**
 * 订阅 mode 变化. 返回 unsubscribe 函数.
 * 用途: prompt section 监听后清 cache; UI 监听后刷新状态条.
 */
export function onSandboxModeChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================================
// 判定 helper (供 toolRiskEvaluator / 其他模块用, 不必到处 import enum)
// ============================================================================

/**
 * 当前模式下, 给定 tool category 是否被 sandbox 直接拒?
 * READ_ONLY 模式下 write / execute / system / network 全拒;
 * WORKSPACE_WRITE 模式下不拒 (具体路径限制由其它机制, 如 risk evaluator path 规则);
 * DANGER_FULL_ACCESS 模式下不拒.
 *
 * @returns true=应该直接拒 (不进 risk evaluator / approval), false=走正常流程
 */
export function isCategoryBlockedBySandbox(
  category: 'read' | 'write' | 'execute' | 'network' | 'system',
  mode: SandboxMode = getCurrentSandboxMode(),
): boolean {
  if (mode === SandboxMode.READ_ONLY) {
    return category !== 'read';
  }
  /* WORKSPACE_WRITE / DANGER_FULL_ACCESS — 不在 category 级别 block, 由细粒度规则处理 */
  return false;
}

/** 仅测试用: 完全重置 state + listeners */
export function __resetSandboxModeForTests(): void {
  modeStore.clearAll();
  listeners.clear();
}
