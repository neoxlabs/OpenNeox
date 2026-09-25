/**
 * Neox Tools - Code Interpreter and more
 */

// Core exports
export { CodeInterpreter, executeCode, defaultInterpreter } from './code-interpreter.js';

// Tool wrappers
export {
  createCodeInterpreterTool,
  defaultCodeInterpreter,
  restrictedCodeInterpreter,
  executePython,
  executeJavaScript,
  executeBash,
} from './tool-wrappers.js';

// Terminal tools (Electron UI only)
export { terminalTools, createTerminalTools } from './terminal/index.js';

// Editor and debug tools (Electron UI only)
export { editorTools, createEditorTools } from './editor/index.js';

// Guarded write tools (multi-agent mode)
export {
  wrapWithWriteLock,
  wrapWithWriteLockForAgent,
  wrapWriteTools,
  setCurrentAgentId,
  getCurrentAgentId,
  enableWriteLock,
  disableWriteLock,
  isWriteLockEnabled,
  releaseAllLocksForCurrentAgent,
  getWriteLockStats,
} from './guardedWriteTools.js';

// Types
export type {
  CodeExecutionConfig,
  CodeExecutionResult,
  SupportedLanguage,
  LanguageRuntime,
} from './types.js';

