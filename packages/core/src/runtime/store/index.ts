/**
 * Agent OS Store — 统一导出
 *
 * 所有持久化模块从这里导出。
 * 使用 createAgentStores() 工厂函数一次性创建所有 store 实例。
 */

export { AgentStore } from './AgentStore.js';
export type { AgentRecord, AgentState, AgentType, CreateAgentOpts } from './AgentStore.js';

export { ProgressStore } from './ProgressStore.js';
export type { ProgressRecord, ProgressInput } from './ProgressStore.js';

export { MessageStore } from './MessageStore.js';
export type { AgentMessageRecord, AgentMsgType, SendMessageInput } from './MessageStore.js';

export { TaskStore } from './TaskStore.js';
export type { TaskRecord, TaskState, CreateTaskOpts } from './TaskStore.js';

export { TaskBoardService } from './TaskBoardService.js';
export type { TaskBoardItem } from './TaskBoardService.js';

export { AgentRegistryStore } from './AgentRegistryStore.js';
export type { RegisteredAgent, AgentMemoryEntry, RegisterAgentOpts } from './AgentRegistryStore.js';

export { OrganizationConfigService } from './OrganizationConfigService.js';
export type { OrgConfig, DepartmentConfig, MemberConfig, OrgDefaults } from './OrganizationConfigService.js';

export { InterruptedRunStore } from './InterruptedRunStore.js';
export type { InterruptedRunRecord, RecordStartOpts } from './InterruptedRunStore.js';

export { BackgroundProcessStore } from './BackgroundProcessStore.js';
export type { BackgroundProcessRecord, BackgroundProcessState, UpsertBackgroundProcessOpts } from './BackgroundProcessStore.js';

export { AGENT_SCHEMA_VERSION, AGENT_SCHEMA_SQL } from '@neoxlabs/platform/runtime/store/schema.js';

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { AgentStore } from './AgentStore.js';
import { ProgressStore } from './ProgressStore.js';
import { MessageStore } from './MessageStore.js';
import { TaskStore } from './TaskStore.js';
import { TaskBoardService } from './TaskBoardService.js';
import { AgentRegistryStore } from './AgentRegistryStore.js';
import { InterruptedRunStore } from './InterruptedRunStore.js';
import { BackgroundProcessStore } from './BackgroundProcessStore.js';

export interface AgentStores {
  agents: AgentStore;
  progress: ProgressStore;
  messages: MessageStore;
  tasks: TaskStore;
  taskBoard: TaskBoardService;
  registry: AgentRegistryStore;
  interruptedRuns: InterruptedRunStore;
  backgroundProcesses: BackgroundProcessStore;
}

/**
 * 工厂函数：一次性创建所有 store 实例，共享 db 和 workspacePath
 */
export function createAgentStores(db: NeoxDatabase, workspacePath: string): AgentStores {
  const agents = new AgentStore(db, workspacePath);
  const progress = new ProgressStore(db, workspacePath);
  const messages = new MessageStore(db, workspacePath);
  const tasks = new TaskStore(db, workspacePath);
  const taskBoard = new TaskBoardService(tasks, agents, progress);
  const registry = new AgentRegistryStore(db, workspacePath);
  const interruptedRuns = new InterruptedRunStore(db, workspacePath);
  const backgroundProcesses = new BackgroundProcessStore(db, workspacePath);

  return { agents, progress, messages, tasks, taskBoard, registry, interruptedRuns, backgroundProcesses };
}

