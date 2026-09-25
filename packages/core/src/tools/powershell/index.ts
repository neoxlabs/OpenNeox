/**
 * PowerShell Tool — 模块导出
 */

export { createPowerShellTool } from './powershellTool.js';
export { createRuntimePowerShellTool } from './runtimePowerShellTool.js';
export { findPowerShell, getPowerShellEdition, isPowerShellToolEnabled, resetDetectionCache } from './powershellDetection.js';
export { buildPowerShellToolDescription } from './powershellPrompt.js';
export {
  analyzePowerShellSecurity,
  isReadOnlyCommand,
  getDestructiveCommandWarning,
  isGitInternalPath,
  resolveToCanonical,
  shouldNeverAutoAllow,
} from './powershellSecurity.js';
export {
  validatePowerShellForSandbox,
  warnPowerShellBackgroundSyntax,
  preCheckPowerShellCommand,
  analyzePowerShellRisks,
} from './powershellGuards.js';
