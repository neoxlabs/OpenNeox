/**
 * ReportToConductorTool — 成员 agent → Conductor (父会话) 单向上报 (Team P1 §3.4)
 *
 * 通路: 子 agent 调本工具 → agentMessageBus.send(父 sessionId) 入队 →
 *   父会话 runner 每轮循环顶部 receive → 以 <agent-message> reminder 注入
 *   (kernel runner.ts, 走 memory.appendReminder, 不打穿前缀缓存)。
 *
 * 范围 (P1): 只上行, 星型拓扑 — 不开放 sibling 直连, 不开放子 agent 再委派
 *   (ALWAYS_EXCLUDED 不变)。主→子的 send_message 现货不动。
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { agentMessageBus } from '@neoxlabs/kernel';

export interface ReportToConductorToolOptions {
  /** Conductor (父会话) sessionId — bus 投递目标 */
  conductorSessionId: string;
  /** 本 agent 的会话 id — bus fromSessionId (元数据) */
  agentSessionId: string;
  /** 本 agent 显示名 (如 "Agent-1") — Conductor 端 reminder 的 from 属性 */
  agentId: string;
}

const REPORT_KINDS = ['question', 'progress', 'blocker'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export function createReportToConductorTool(opts: ReportToConductorToolOptions): Tool {
  return {
    name: 'report_to_conductor',
    description: `Report a message back to the main agent (the Conductor) that dispatched you. It is seen at the start of that agent's next loop.

When to use:
- question: the task constraints are ambiguous, or you found two approaches and cannot pick — asking costs less than guessing or grinding
- progress: a milestone in a long task is done (e.g. "the interface is settled"), so the Conductor can coordinate work that depends on you
- blocker: you hit something you cannot resolve within your permissions or toolset (missing dependency, broken environment) — report early instead of timing out

Note: this is one-way. **Send it and keep working — do not stop and wait for a reply.** Do not report things you can reasonably decide yourself.`,
    group: 'agent',
    resultType: 'ephemeral',
    parallelSafety: 'safe',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...REPORT_KINDS],
          description: 'Message kind: question = a question / progress = a progress milestone / blocker = a hard blocker',
        },
        content: {
          type: 'string',
          description: 'Message body — specific and self-contained (the Conductor cannot see your intermediate steps, so include the context it needs)',
        },
      },
      required: ['kind', 'content'],
    },
    async function(args: any) {
      const kind = String(args?.kind ?? '').trim().toLowerCase() as ReportKind;
      const content = typeof args?.content === 'string' ? args.content.trim() : '';

      if (!REPORT_KINDS.includes(kind)) {
        return `[ERROR] kind 必须是 ${REPORT_KINDS.join(' / ')} 之一 (收到 "${args?.kind}")`;
      }
      if (!content) {
        return '[ERROR] content 不能为空 — 写清楚要上报什么';
      }

      try {
        agentMessageBus.send({
          fromSessionId: opts.agentSessionId,
          fromAgentName: opts.agentId,
          toSessionId: opts.conductorSessionId,
          messageType: kind,
          payload: content,
        });
      } catch (err: any) {
        /* 典型失败: Conductor inbox 未注册 (父会话 runner 尚未/已不在跑)。
         * 不抛出 — 让子 agent 知道没送达并继续自主推进, 而不是整轮 tool 失败。 */
        return `[ERROR] 上报未送达 (${err?.message || err})。继续按当前理解推进任务, 并在最终总结里写明这个问题。`;
      }

      return JSON.stringify({
        status: 'reported',
        kind,
        message: '已上报 Conductor, 它会在下一轮循环看到。继续你的任务, 不要等待回复。',
      });
    },
  };
}
