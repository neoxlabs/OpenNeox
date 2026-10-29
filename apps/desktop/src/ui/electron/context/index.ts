/**
 * Electron main 进程的 scope/context 基础设施.
 *
 * 架构:
 *   - `AppScope` (一个, 全局)
 *     - `ProjectScope` (每个 BrowserWindow 一个, parent = AppScope)
 *       - 持有 AgentBridge / TerminalService / DebugService / SemanticBridge / ...
 *
 * 主 entry: `main.ts` 里创建一次 `AppScope` + `ProjectManager`, 之后所有
 * "打开新项目" 都走 `projectManager.openProject(path)`.
 */

export { AppScope } from './AppScope.js';
export { ProjectScope } from './ProjectScope.js';
export { ProjectManager } from './ProjectManager.js';
export { ProjectService } from './ProjectService.js';
export type {
  ProjectManagerOptions,
  BrowserWindowFactory,
  ProjectServiceBootstrap,
} from './ProjectManager.js';

export { OwnedIdsTracker } from './OwnedIdsTracker.js';
export type { OwnedIdKind } from './OwnedIdsTracker.js';

export {
  PROJECT_MANAGER,
  OWNED_IDS_TRACKER,
  AGENT_BRIDGE,
  TERMINAL_SERVICE,
  DEBUG_SERVICE,
  DEBUGGER_MANAGER,
  SEMANTIC_BRIDGE,
  EMBEDDING_BRIDGE,
  TS_SERVER_BRIDGE,
  PROJECT_STARTUP_COORDINATOR,
  SKILL_REGISTRY,
  RUN_PROCESS_MANAGER,
} from './tokens.js';
