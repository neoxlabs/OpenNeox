
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { BackgroundAgentManager } from './backgroundAgent.js';

export interface SendMessageToolOptions {
  backgroundManager: BackgroundAgentManager;
}

export function createSendMessageTool(opts: SendMessageToolOptions): Tool {
  return {
    name: 'send_message',
    description: `Send a message to a running or completed background agent.

Use this to:
- Send follow-up instructions to a running agent
- Check on a running agent's progress
- Retrieve a completed agent's result

The "to" field accepts either the agent's name (if specified at launch) or its agentId (e.g. "Agent-1").`,
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Agent name or ID (e.g. "researcher" or "Agent-1")',
        },
        message: {
          type: 'string',
          description: 'The message content to send',
        },
      },
      required: ['to', 'message'],
    },
    async function(args: any) {
      const to: string = args.to;
      const message: string = args.message;

      if (!to || !message) {
        return '[ERROR] 需要提供 to 和 message 参数';
      }

      const task = opts.backgroundManager.resolveAgent(to);
      if (!task) {
        const active = opts.backgroundManager.listActive();
        const all = opts.backgroundManager.listAll();
        const nameRegistry = opts.backgroundManager.getNameRegistry();

        let hint = `未找到 agent "${to}"。`;
        if (all.length > 0) {
          const agentList = all.map(a => {
            const name = Array.from(nameRegistry.entries()).find(([, id]) => id === a.agentId)?.[0];
            return `- ${a.agentId}${name ? ` (name: "${name}")` : ''} [${a.status}]: ${a.description}`;
          }).join('\n');
          hint += `\n\n可用 agents:\n${agentList}`;
        } else {
          hint += ' 当前没有后台 agent。';
        }
        return hint;
      }

      if (task.status === 'running') {
        const delivery = opts.backgroundManager.deliverMessage(task.agentId, message);
        if (delivery.accepted) {
          const deliveryStatus = delivery.injected ? 'injected' : 'queued';
          const deliveryMessage = delivery.injected
            ? `消息已投递，将在 ${task.agentId} 的下一轮对话开始时处理。`
            : `消息已暂存，待 ${task.agentId} runtime 就绪后会在下一轮对话开始时处理。`;
          return JSON.stringify({
            type: 'ephemeral',
            status: 'success',
            tool: 'send_message',
            summary: `已向 ${task.agentId} 发送后续消息`,
            content: deliveryMessage,
            metadata: {
              agentId: task.agentId,
              name: task.name,
              agentStatus: 'running',
              delivery: deliveryStatus,
              queuePosition: delivery.queuePosition,
              pendingCount: delivery.pendingCount,
              progress: {
                toolUseCount: task.progress.toolUseCount,
                elapsed: task.progress.elapsed,
              },
            },
            success: true,
            agentId: task.agentId,
            name: task.name,
            delivery: deliveryStatus,
            message: deliveryMessage,
            queuePosition: delivery.queuePosition,
            pendingCount: delivery.pendingCount,
            progress: {
              toolUseCount: task.progress.toolUseCount,
              elapsed: task.progress.elapsed,
            },
          });
        }
        return JSON.stringify({
          type: 'ephemeral',
          status: 'error',
          tool: 'send_message',
          summary: `无法向 ${task.agentId} 发送消息`,
          error: `[ERROR] 无法向 ${to} 投递消息`,
          metadata: {
            agentId: task.agentId,
            name: task.name,
            agentStatus: 'running',
          },
          success: false,
          agentId: task.agentId,
          name: task.name,
        });
      }

      if (task.status === 'completed') {
        const result = task.result?.substring(0, 5000) || '(no output)';
        return JSON.stringify({
          type: 'ephemeral',
          status: 'success',
          tool: 'send_message',
          summary: `${task.agentId} 已完成，返回最终结果`,
          content: result,
          metadata: {
            agentId: task.agentId,
            name: task.name,
            agentStatus: 'completed',
            duration: task.progress.elapsed,
            toolUseCount: task.progress.toolUseCount,
          },
          success: true,
          agentId: task.agentId,
          name: task.name,
          result,
          duration: task.progress.elapsed,
          toolUseCount: task.progress.toolUseCount,
        });
      }

      return JSON.stringify({
        type: 'ephemeral',
        status: 'error',
        tool: 'send_message',
        summary: `${task.agentId} 当前不可接收消息`,
        error: task.error || `Agent ${task.status}`,
        metadata: {
          agentId: task.agentId,
          name: task.name,
          agentStatus: task.status,
        },
        success: false,
        agentId: task.agentId,
        name: task.name,
      });
    },
  };
}
