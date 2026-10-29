/**
 * Service tokens —— 所有 app/project 级服务的 token 在这里统一声明
 *
 * 约定:
 *   - Token 名字就是 class 名
 *   - 每个 token 绑定一个唯一 service class
 *   - APP_ 前缀的是 app 级, PROJECT_ 或直接写也表示 project 级
 */

import { createServiceToken } from '../../../ide/scope/index.js';
import type { ServiceToken } from '../../../ide/scope/index.js';

// ═══════════════════════════════════════════════════════════════════
// App 级 service tokens
// ═══════════════════════════════════════════════════════════════════

// Forward declaration: 真实类型在各自 service 文件里, 这里只给 token
import type { ProjectManager } from './ProjectManager.js';
export const PROJECT_MANAGER: ServiceToken<ProjectManager> =
  createServiceToken<ProjectManager>('ProjectManager');

// ═══════════════════════════════════════════════════════════════════
// Project 级 service tokens
// ═══════════════════════════════════════════════════════════════════

import type { OwnedIdsTracker } from './OwnedIdsTracker.js';
export const OWNED_IDS_TRACKER: ServiceToken<OwnedIdsTracker> =
  createServiceToken<OwnedIdsTracker>('OwnedIdsTracker');

// Per-project service tokens. 类型显式导入, 不用 any.
import type { RunProcessManager } from '../services/runProcessManager.js';
export const RUN_PROCESS_MANAGER: ServiceToken<RunProcessManager> =
  createServiceToken<RunProcessManager>('RunProcessManager');

import type { TerminalService } from '../../../platform-electron/terminalService.js';
export const TERMINAL_SERVICE: ServiceToken<TerminalService> =
  createServiceToken<TerminalService>('TerminalService');

import type { DebugService } from '../services/debugService.js';
export const DEBUG_SERVICE: ServiceToken<DebugService> =
  createServiceToken<DebugService>('DebugService');

import type { DebuggerManager } from '../../../ide/debug/index.js';
export const DEBUGGER_MANAGER: ServiceToken<DebuggerManager> =
  createServiceToken<DebuggerManager>('DebuggerManager');

import type { SemanticBridge } from '../services/semanticBridge.js';
export const SEMANTIC_BRIDGE: ServiceToken<SemanticBridge> =
  createServiceToken<SemanticBridge>('SemanticBridge');

import type { EmbeddingBridge } from '../services/embeddingBridge.js';
export const EMBEDDING_BRIDGE: ServiceToken<EmbeddingBridge> =
  createServiceToken<EmbeddingBridge>('EmbeddingBridge');

import type { TsServerBridge } from '../services/tsServerBridge.js';
export const TS_SERVER_BRIDGE: ServiceToken<TsServerBridge> =
  createServiceToken<TsServerBridge>('TsServerBridge');

import type { AgentBridge } from '../services/agentBridge.js';
export const AGENT_BRIDGE: ServiceToken<AgentBridge> =
  createServiceToken<AgentBridge>('AgentBridge');

import type { ProjectStartupCoordinator } from '../services/projectStartupCoordinator.js';
export const PROJECT_STARTUP_COORDINATOR: ServiceToken<ProjectStartupCoordinator> =
  createServiceToken<ProjectStartupCoordinator>('ProjectStartupCoordinator');

import type { SkillRegistry } from '@neoxlabs/core/skills/index.js';
export const SKILL_REGISTRY: ServiceToken<SkillRegistry> =
  createServiceToken<SkillRegistry>('SkillRegistry');
