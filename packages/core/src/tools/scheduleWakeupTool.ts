/**
 * schedule_wakeup — 自主 pacing 工具
 *
 * Agent 显式声明"N 秒后把我叫醒继续处理 X",替代错误的 sleep 轮询模式。
 *
 * 典型用法:
 *   1. 启动后台 bash:execute_shell(command=..., background=true) 拿到 pid
 *   2. 做别的事 / 回答用户
 *   3. 若没别的事干 → schedule_wakeup(delaySeconds=270, reason="check bun build", prompt="check bash_output(pid=X)")
 *   4. 270s 后 agent 的下一轮 user message 前缀会出现 <scheduled-wakeup>...</scheduled-wakeup>
 *   5. agent 按 prompt 执行,比如 bash_output(pid) 看日志
 *
 * Cache 边界建议(prompt 里教):
 *   · <5 分钟(快 poll):用 60-270s,保证 prompt cache TTL(5 分钟)不失效
 *   · 5 分钟-1 小时:用 1200-1800s(一次 cache miss 换长等)
 *   · 禁用 300s 附近 — cache 刚好过期,成本最高
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  getScheduledWakeupRegistry,
  MIN_WAKEUP_SECONDS,
  MAX_WAKEUP_SECONDS,
} from '../runtime/shell/scheduledWakeupRegistry.js';
import { getBackgroundTaskNotifier } from '../runtime/shell/backgroundTaskNotifier.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';

interface ScheduleWakeupArgs {
  delaySeconds: number;
  reason: string;
  prompt: string;
}

export const scheduleWakeupTool: Tool = {
  name: 'schedule_wakeup',
  aliases: ['ScheduleWakeup', 'schedule-wakeup', 'wakeup_self', 'self_schedule'],
  description: `Schedule yourself to be woken up after N seconds with a specific prompt. Replaces sleep-and-poll antipatterns.

WHEN TO USE:
- You started a long-running background task with execute_shell(background=true) and want to check its output later without blocking this session
- You're waiting for an external condition (CI pipeline, user action, API rate limit window) that can't be actively polled
- The user is not waiting for an immediate reply and it's fine to pause

WHEN NOT TO USE:
- If the user is actively waiting → just respond now
- If you can check a condition synchronously (run a check command, read a file) → do that, don't sleep
- For recurring tasks → use cron_create instead (one-shot vs periodic)

HOW TO PICK delaySeconds (prompt-cache TTL is ~5 min):
- Under 5 minutes: use 60-270s. Cache stays warm → next wake is cheap.
- 5 minutes to 1 hour: use 1200-3600s (20-60 min). You pay one cache miss anyway, so amortize it over a long wait.
- AVOID 300s (the cache-miss cliff — you pay full re-tokenization cost for the shortest possible "long" wait).

WHAT HAPPENS:
On wake-up your next user turn will be prefixed with <scheduled-wakeup><reason>...</reason><elapsed-seconds>N</elapsed-seconds><prompt>...</prompt></scheduled-wakeup>. Follow the prompt.

PARAMETERS:
- delaySeconds (required, 60-3600): seconds from now; values outside the range are clamped.
- reason (required): short telemetry string, shown back to you on wake.
- prompt (required): the exact instruction for your wake-up action (e.g. "run bash_output(pid=12345) and summarize what happened").`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      delaySeconds: {
        type: 'number',
        description: `Seconds from now to wake up. Clamped to [${MIN_WAKEUP_SECONDS}, ${MAX_WAKEUP_SECONDS}].`,
      },
      reason: {
        type: 'string',
        description: 'Short telemetry string, shown to you on wake-up. Be specific.',
      },
      prompt: {
        type: 'string',
        description: 'Exact instruction to execute when woken up (e.g. "bash_output(pid=12345) then summarize").',
      },
    },
    required: ['delaySeconds', 'reason', 'prompt'],
  },

  async function(args: ScheduleWakeupArgs): Promise<string> {
    const delay = Number(args?.delaySeconds);
    if (!Number.isFinite(delay)) {
      return JSON.stringify({
        status: 'success',
        skipped: true,
        reason: 'invalid_delay',
        message: `Invalid delaySeconds: ${args?.delaySeconds}. Pass a number in seconds (clamped to [${MIN_WAKEUP_SECONDS},${MAX_WAKEUP_SECONDS}]).`,
      });
    }
    const reason = String(args?.reason ?? '').trim();
    const prompt = String(args?.prompt ?? '').trim();
    if (!reason) {
      return JSON.stringify({
        status: 'success',
        skipped: true,
        reason: 'missing_reason',
        message: 'reason is required (short telemetry string shown back on wake-up).',
      });
    }
    if (!prompt) {
      return JSON.stringify({
        status: 'success',
        skipped: true,
        reason: 'missing_prompt',
        message: 'prompt is required (the instruction to execute on wake-up).',
      });
    }

    /* 优先用 chat sessionId(bridge.chat 入口设的稳定 ALS),
       fallback 到 bgTaskNotifier(agentLoop 内为 processId)。
       wakeup 注册要的是 chat 维度,这样 60s 后 trigger handler 才能找到对应会话 */
    const sessionId =
      getCurrentChatSessionId() ?? getBackgroundTaskNotifier().getCurrentSessionId();
    if (!sessionId) {
      /* 工具按设计要 session 才能挂回唤;在 headless / 单测 / 外部脚本里调,
         没 session 是预期场景而非错误,告诉模型"安排不了,继续干你的活"即可。*/
      return JSON.stringify({
        status: 'success',
        skipped: true,
        reason: 'no_active_session',
        message: 'schedule_wakeup needs an active session to dispatch the wake-up; current runtime has none (headless/CLI/test). Continue inline instead of relying on a future wake-up.',
      });
    }

    const registry = getScheduledWakeupRegistry();
    const { id, dueAt, clamped } = registry.schedule({
      sessionId,
      delaySeconds: delay,
      reason,
      prompt,
    });

    return JSON.stringify({
      wakeup_id: id,
      due_at_ms: dueAt,
      due_at_iso: new Date(dueAt).toISOString(),
      clamped,
      effective_delay_seconds: Math.round((dueAt - Date.now()) / 1000),
      message: `Wakeup scheduled${clamped ? ' (delaySeconds was clamped to [60,3600])' : ''}. You will be woken up with the prompt you provided. For now, continue with other work or hand control back to the user.`,
    });
  },
};
