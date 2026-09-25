
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { randomUUID } from 'crypto';
import { onUserIdChange } from '@neoxlabs/platform/utils/config.js';

// ==================== Types ====================

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'stopped';

export interface ManagedTask {
  id: string;
  sessionId: string;
  subject: string;
  description: string;
  activeForm?: string;     // Present continuous form for spinner
  status: TaskStatus;
  owner?: string;
  blocks: string[];        // Task IDs this task blocks
  blockedBy: string[];     // Task IDs blocking this task
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ==================== Typed Args Interfaces ====================

interface TaskCreateArgs {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

interface TaskGetArgs {
  taskId: string;
}

interface TaskUpdateArgs {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
}

interface TaskOutputArgs {
  taskId: string;
}

interface TaskStopArgs {
  taskId: string;
}

// ==================== In-memory store (per session) ====================

const taskStore = new Map<string, ManagedTask>();
let taskCounter = 0;

// Listener for UI updates
let onTasksUpdated: (() => void) | null = null;

export function setTaskUpdateCallback(callback: (() => void) | null): void {
  onTasksUpdated = callback;
}

function notifyUpdate(): void {
  if (onTasksUpdated) onTasksUpdated();
}

// ==================== Task CRUD ====================

function createTask(sessionId: string, data: {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}): ManagedTask {
  taskCounter++;
  const id = String(taskCounter);
  const now = Date.now();

  const task: ManagedTask = {
    id,
    sessionId,
    subject: data.subject,
    description: data.description,
    activeForm: data.activeForm,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    metadata: data.metadata,
    createdAt: now,
    updatedAt: now,
  };

  taskStore.set(id, task);
  notifyUpdate();
  return task;
}

function getTask(taskId: string): ManagedTask | null {
  return taskStore.get(taskId) || null;
}

function listTasks(): ManagedTask[] {
  return [...taskStore.values()].sort((a, b) => parseInt(a.id) - parseInt(b.id));
}

function updateTask(taskId: string, updates: Partial<Pick<ManagedTask,
  'subject' | 'description' | 'activeForm' | 'status' | 'owner' | 'metadata'
>>): ManagedTask | null {
  const task = taskStore.get(taskId);
  if (!task) return null;

  if (updates.subject !== undefined) task.subject = updates.subject;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.owner !== undefined) task.owner = updates.owner;
  if (updates.metadata !== undefined) {
    task.metadata = { ...task.metadata, ...updates.metadata };
    // Null values delete keys
    for (const [k, v] of Object.entries(updates.metadata)) {
      if (v === null && task.metadata) delete task.metadata[k];
    }
  }
  task.updatedAt = Date.now();

  notifyUpdate();
  return task;
}

function deleteTask(taskId: string): boolean {
  const deleted = taskStore.delete(taskId);
  if (deleted) {
    // Remove from blocks/blockedBy references
    for (const task of taskStore.values()) {
      task.blocks = task.blocks.filter(id => id !== taskId);
      task.blockedBy = task.blockedBy.filter(id => id !== taskId);
    }
    notifyUpdate();
  }
  return deleted;
}

function addBlockRelation(blockerId: string, blockedId: string): boolean {
  const blocker = taskStore.get(blockerId);
  const blocked = taskStore.get(blockedId);
  if (!blocker || !blocked) return false;

  if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
  if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
  notifyUpdate();
  return true;
}

// ==================== Session reset ====================

export function resetTaskStore(): void {
  taskStore.clear();
  taskCounter = 0;
}

/* 用户切换时清掉 agent 任务表 — A 留下的 todo 不该出现在 B 的 UI 里 */
onUserIdChange((next, prev) => {
  void next; void prev;
  resetTaskStore();
  notifyUpdate();
});

export function getActiveTaskCount(): number {
  let count = 0;
  for (const task of taskStore.values()) {
    if (task.status === 'in_progress') count++;
  }
  return count;
}

export function getTaskSummary(): { total: number; pending: number; inProgress: number; completed: number } {
  let pending = 0, inProgress = 0, completed = 0;
  for (const task of taskStore.values()) {
    if (task.status === 'pending') pending++;
    else if (task.status === 'in_progress') inProgress++;
    else if (task.status === 'completed') completed++;
  }
  return { total: taskStore.size, pending, inProgress, completed };
}

// ==================== Tool Definitions ====================

// Default session ID (will be overridden by runtime)
let currentSessionId = 'default';
export function setCurrentSessionId(id: string): void {
  currentSessionId = id;
}

export const taskCreateTool: Tool = {
  name: 'task_create',
  description: 'Create a new task to track work progress. Tasks help organize complex multi-step work and show progress to the user. Use for tasks requiring 3+ steps.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Brief, actionable task title in imperative form (e.g., "Fix authentication bug")',
      },
      description: {
        type: 'string',
        description: 'Detailed description of what needs to be done',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form for spinner display (e.g., "Fixing authentication bug")',
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata to attach to the task',
      },
    },
    required: ['subject', 'description'],
  },

  async function(args: TaskCreateArgs): Promise<string> {
    const { subject, description, activeForm, metadata } = args;
    const task = createTask(currentSessionId, { subject, description, activeForm, metadata });
    return JSON.stringify({
      task: { id: task.id, subject: task.subject },
      message: `Task #${task.id} created: ${subject}`,
    });
  },
};

export const taskGetTool: Tool = {
  name: 'task_get',
  description: 'Get full details of a task by its ID, including description, status, and dependencies.',
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to retrieve',
      },
    },
    required: ['taskId'],
  },

  async function(args: TaskGetArgs): Promise<string> {
    const task = getTask(args.taskId);
    if (!task) {
      return JSON.stringify({ task: null, message: `Task "${args.taskId}" not found` });
    }
    return JSON.stringify({
      task: {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        owner: task.owner,
        blocks: task.blocks,
        blockedBy: task.blockedBy,
        metadata: task.metadata,
      },
    });
  },
};

export const taskUpdateTool: Tool = {
  name: 'task_update',
  description: 'Update a task\'s status, description, or dependencies. Set status to "in_progress" when starting work, "completed" when done. Use "deleted" to remove a task.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to update',
      },
      subject: {
        type: 'string',
        description: 'New task title',
      },
      description: {
        type: 'string',
        description: 'New task description',
      },
      activeForm: {
        type: 'string',
        description: 'New spinner text',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'New task status',
      },
      owner: {
        type: 'string',
        description: 'Assign task to an agent',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that cannot start until this one completes',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this one can start',
      },
      metadata: {
        type: 'object',
        description: 'Metadata keys to merge (set value to null to delete key)',
      },
    },
    required: ['taskId'],
  },

  async function(args: TaskUpdateArgs): Promise<string> {
    const { taskId, status, addBlocks, addBlockedBy, ...rest } = args;

    // Handle deletion
    if (status === 'deleted') {
      const deleted = deleteTask(taskId);
      return JSON.stringify({
        success: deleted,
        taskId,
        message: deleted ? `Task #${taskId} deleted` : `Task "${taskId}" not found`,
      });
    }

    const task = getTask(taskId);
    if (!task) {
      return JSON.stringify({ success: false, error: `Task "${taskId}" not found` });
    }

    const updatedFields: string[] = [];
    const updates: Partial<Pick<ManagedTask, 'subject' | 'description' | 'activeForm' | 'status' | 'owner' | 'metadata'>> = {};

    if (rest.subject !== undefined) { updates.subject = rest.subject; updatedFields.push('subject'); }
    if (rest.description !== undefined) { updates.description = rest.description; updatedFields.push('description'); }
    if (rest.activeForm !== undefined) { updates.activeForm = rest.activeForm; updatedFields.push('activeForm'); }
    if (rest.owner !== undefined) { updates.owner = rest.owner; updatedFields.push('owner'); }
    if (rest.metadata !== undefined) { updates.metadata = rest.metadata; updatedFields.push('metadata'); }
    if (status !== undefined) { updates.status = status; updatedFields.push('status'); }

    const result = updateTask(taskId, updates);

    // Handle block relations
    if (addBlocks) {
      for (const blockedId of addBlocks) addBlockRelation(taskId, blockedId);
    }
    if (addBlockedBy) {
      for (const blockerId of addBlockedBy) addBlockRelation(blockerId, taskId);
    }

    const statusChange = status ? { from: task.status, to: status } : undefined;

    return JSON.stringify({
      success: !!result,
      taskId,
      updatedFields,
      statusChange,
      message: result
        ? `Task #${taskId} updated: ${updatedFields.join(', ')}`
        : `Failed to update task "${taskId}"`,
    });
  },
};

export const taskListTool: Tool = {
  name: 'task_list',
  description: 'List all tasks in the current session with their status and dependencies.',
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {},
  },

  async function(): Promise<string> {
    const tasks = listTasks();
    const completedIds = new Set(
      tasks.filter(t => t.status === 'completed').map(t => t.id)
    );

    const taskList = tasks
      .filter(t => t.status !== 'completed' || true) // Show all
      .map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blockedBy: t.blockedBy.filter(id => !completedIds.has(id)),
      }));

    return JSON.stringify({ tasks: taskList, total: taskList.length });
  },
};

export const taskOutputTool: Tool = {
  name: 'task_output',
  description: 'Get the output/result of a completed task inline. Useful for retrieving results of tasks that ran in the background.',
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to get output from',
      },
    },
    required: ['taskId'],
  },

  async function(args: TaskOutputArgs): Promise<string> {
    const task = getTask(args.taskId);
    if (!task) {
      return JSON.stringify({ error: `Task "${args.taskId}" not found` });
    }

    if (task.status === 'in_progress' || task.status === 'pending') {
      return JSON.stringify({
        taskId: task.id,
        status: task.status,
        message: `Task #${task.id} is still ${task.status}. Wait for it to complete before reading output.`,
      });
    }

    return JSON.stringify({
      taskId: task.id,
      subject: task.subject,
      status: task.status,
      output: task.metadata?.output || null,
      result: task.metadata?.result || null,
      error: task.metadata?.error || null,
      completedAt: task.updatedAt,
      message: task.metadata?.output
        ? `Task #${task.id} output retrieved`
        : `Task #${task.id} has no stored output (status: ${task.status})`,
    });
  },
};

export const taskStopTool: Tool = {
  name: 'task_stop',
  description: 'Stop/cancel a running task by its ID.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to stop',
      },
    },
    required: ['taskId'],
  },

  async function(args: TaskStopArgs): Promise<string> {
    const { taskId } = args;
    const task = getTask(taskId);

    if (!task) {
      return JSON.stringify({ error: `Task "${taskId}" not found` });
    }

    if (task.status !== 'in_progress') {
      return JSON.stringify({ error: `Task #${taskId} is not running (status: ${task.status})` });
    }

    updateTask(taskId, { status: 'stopped' });

    return JSON.stringify({
      taskId,
      message: `Task #${taskId} stopped: ${task.subject}`,
    });
  },
};
