/**
 * Sandbox mode public facade — 给 CLI / UI / 外部业务方用.
 *
 * 实际 state + 逻辑在 kernel/core/sandboxMode.ts; 此文件只 re-export, 让 cli
 * (它只依赖 @neoxlabs/core) 不必直接 dep kernel.
 */

export {
  SandboxMode,
  DEFAULT_SANDBOX_MODE,
  getCurrentSandboxMode,
  setCurrentSandboxMode,
  resetSandboxMode,
  onSandboxModeChange,
  isCategoryBlockedBySandbox,
} from '@neoxlabs/kernel';
