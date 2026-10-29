/**
 * Host Introspection Tools
 *
 * Client Agent 专属工具集，用于感知和控制 Neox CLI 宿主
 */

import type { HostContext } from './hostContext.js';
import type { HostEventType } from './protocol.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ParameterDefinition>;
  execute: (ctx: HostContext, args: Record<string, unknown>) => Promise<unknown>;
}

interface ParameterDefinition {
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  items?: { type: string };
}

/**
 * Host Introspection Tools 定义
 */
export const hostIntrospectionTools: ToolDefinition[] = [
  // ==================== 状态查询类 ====================

  {
    name: 'host_get_status',
    description: '获取 Neox CLI 宿主的当前运行状态，包括是否正在执行任务、当前模式、内存使用等',
    parameters: {},
    execute: async (ctx) => {
      return ctx.getStatus();
    },
  },

  {
    name: 'host_get_agents',
    description: '获取当前正在运行的所有 Agent 信息，包括主 Agent 和 Worker Agent',
    parameters: {},
    execute: async (ctx) => {
      return ctx.getAgents();
    },
  },

  {
    name: 'host_get_activity',
    description: '获取最近的执行活动记录，包括工具调用、消息等',
    parameters: {
      limit: {
        type: 'number',
        description: '返回的记录数量',
        default: 10,
      },
    },
    execute: async (ctx, args) => {
      const limit = (args.limit as number) || 10;
      return ctx.getActivity(limit);
    },
  },

  {
    name: 'host_get_session',
    description: '获取当前会话的摘要信息，包括消息数、Token 使用、最近的对话内容',
    parameters: {},
    execute: async (ctx) => {
      return ctx.getSession();
    },
  },

  {
    name: 'host_get_system',
    description: '获取系统信息，包括平台、工作目录、Git 状态等',
    parameters: {},
    execute: async (ctx) => {
      return ctx.getSystem();
    },
  },

  // ==================== 控制类 ====================

  {
    name: 'host_interrupt',
    description: '中断当前正在执行的任务',
    parameters: {
      reason: {
        type: 'string',
        description: '中断原因（可选）',
        required: false,
      },
    },
    execute: async (ctx, args) => {
      const reason = args.reason as string | undefined;
      return ctx.interrupt(reason);
    },
  },

  {
    name: 'host_send_command',
    description: '向主 Agent 发送命令或消息，会加入执行队列',
    parameters: {
      text: {
        type: 'string',
        description: '要发送的命令或消息',
        required: true,
      },
      priority: {
        type: 'string',
        description: '优先级',
        enum: ['normal', 'high'],
        default: 'normal',
      },
    },
    execute: async (ctx, args) => {
      const text = args.text as string;
      const priority = (args.priority as 'normal' | 'high') || 'normal';
      return ctx.sendCommand(text, priority);
    },
  },

  {
    name: 'host_subscribe',
    description: '订阅宿主事件，实现实时感知',
    parameters: {
      events: {
        type: 'array',
        description: '要订阅的事件类型列表',
        items: { type: 'string' },
        required: true,
      },
    },
    execute: async (ctx, args) => {
      const events = args.events as HostEventType[];
      const clientId = args._clientId as string; // 内部传入
      const callback = args._callback as (event: { type: HostEventType; data: unknown }) => void;

      const subscriptionId = ctx.subscribe(clientId, events, callback);
      return { subscriptionId };
    },
  },

  {
    name: 'host_unsubscribe',
    description: '取消事件订阅',
    parameters: {
      events: {
        type: 'array',
        description: '要取消订阅的事件类型列表（不传则取消所有）',
        items: { type: 'string' },
        required: false,
      },
    },
    execute: async (ctx, args) => {
      const events = args.events as HostEventType[] | undefined;
      const clientId = args._clientId as string;

      const success = ctx.unsubscribe(clientId, events);
      return { success };
    },
  },
];

/**
 * 获取工具定义（用于 Agent 初始化）
 */
export function getHostToolDefinitions(): Array<{
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}> {
  return hostIntrospectionTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(tool.parameters)
          .filter(([key]) => !key.startsWith('_')) // 过滤内部参数
          .map(([key, param]) => [
            key,
            {
              type: param.type,
              description: param.description,
              ...(param.enum ? { enum: param.enum } : {}),
              ...(param.default !== undefined ? { default: param.default } : {}),
              ...(param.items ? { items: param.items } : {}),
            },
          ])
      ),
      required: Object.entries(tool.parameters)
        .filter(([key, param]) => param.required && !key.startsWith('_'))
        .map(([key]) => key),
    },
  }));
}

/**
 * 执行工具
 */
export async function executeHostTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: HostContext
): Promise<unknown> {
  const tool = hostIntrospectionTools.find(t => t.name === toolName);

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // 填充默认值
  const filledArgs = { ...args };
  for (const [key, param] of Object.entries(tool.parameters)) {
    if (filledArgs[key] === undefined && param.default !== undefined) {
      filledArgs[key] = param.default;
    }
  }

  // 验证必填参数
  for (const [key, param] of Object.entries(tool.parameters)) {
    if (param.required && filledArgs[key] === undefined) {
      throw new Error(`Missing required parameter: ${key}`);
    }
  }

  return tool.execute(ctx, filledArgs);
}

/**
 * 获取工具名称列表
 */
export function getHostToolNames(): string[] {
  return hostIntrospectionTools.map(t => t.name);
}
