import { cliLogger } from '../platform/cliLogger.js';
import { buildPerformanceHint } from './runnerHintUtils.js';
import type { Message } from '../types/index.js';

type SystemMemory = {
  appendReminder: (text: string) => void;
  getAll?: () => Message[];
};

type ToolUsageAdvisorLike = {
  analyze: (iteration: number, requireMutation?: boolean) => string | null | undefined;
};

type ToolMetric = {
  name: string;
  duration: number;
  success: boolean;
};

export type MidRunCheck = (ctx: { task: string; iteration: number; recent: string }) => Promise<string | null>;
const midRunChecks = new Map<string, MidRunCheck>();
const MID_RUN_CHECKS_CAP = 500;

export function setMidRunCheck(sessionId: string, check: MidRunCheck | null): void {
  if (!sessionId) return;
  midRunChecks.delete(sessionId);
  if (!check) return;
  midRunChecks.set(sessionId, check);
  /* 子 agent 会话一个接一个, 只留最近的一批 (Map 按插入序) */
  if (midRunChecks.size > MID_RUN_CHECKS_CAP) midRunChecks.delete(midRunChecks.keys().next().value!);
}

/** 长任务才查: 第 10、20、30… 轮 */
const MID_RUN_CHECK_EVERY = 10;

export const SILENT_TOOL_CALLS_NUDGE = 6;

/** 自用户最后一条消息以来, 末尾有多少条「只调工具、没写字」的助手消息 */
export function silentToolCallStreak(messages: Message[]): number {
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') break;
    if (m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (text.length >= 4) break;
    if (m.tool_calls?.length) streak++;
  }
  return streak;
}

const LANGUAGE_DRIFT_REMINDER = {
  zh: '你刚才给用户看的那段话是英文的。用户用中文提问 —— 接下来的进度说明和最后的结论都用中文。',
  en: 'Your last message to the user was not in English. The user wrote in English — keep progress notes and the final answer in English.',
} as const;
const LANGUAGE_DRIFT_MAX_PER_TURN = 2;

export function languageDriftReminder(messages: Message[]): string | null {
  let expected: 'zh' | 'en' | null = null;
  let lastText: string | null = null;
  let reminded = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'user') {
      /* 没标记的 user 是工具图片注入这类, 不是用户那句话, 继续往前找 */
      const tag = text.match(/<reply-language>([\s\S]*?)<\/reply-language>/);
      if (!tag) continue;
      expected = /[㐀-鿿]/.test(tag[1]) ? 'zh' : 'en';
      break;
    }
    if (m.role === 'assistant' && lastText === null && text.trim().length >= 20) lastText = text;
    if (text.includes(LANGUAGE_DRIFT_REMINDER.zh) || text.includes(LANGUAGE_DRIFT_REMINDER.en)) reminded++;
  }
  if (!expected || !lastText || reminded >= LANGUAGE_DRIFT_MAX_PER_TURN) return null;
  const prose = lastText.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const han = (prose.match(/[㐀-鿿]/g) ?? []).length;
  const words = (prose.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (han + words < 8) return null;
  const actual = han >= words ? 'zh' : 'en';
  return actual === expected ? null : LANGUAGE_DRIFT_REMINDER[expected];
}

export const BATCH_REMINDER = 'Before writing: changes that do not depend on each other go in ONE call — write_file files=[...] for several new files, edit edits=[...] for several existing files.';
const MUTATION_TOOLS = new Set(['edit', 'write_file', 'edit_batch', 'write', 'edit_file']);

export function batchingReminder(messages: Message[], requireMutation: boolean): string | null {
  if (!requireMutation) return null;
  const rounds: Array<Array<{ name: string; target: string }>> = [];
  let reminded = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = typeof m.content === 'string' ? m.content : '';
    if (text.includes(BATCH_REMINDER)) reminded++;
    if (m.role === 'user' && /<reply-language>/.test(text)) break;
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    rounds.unshift(m.tool_calls.map((c) => {
      let target = '';
      try { target = String(JSON.parse(String(c.function.arguments ?? '{}')).file_path ?? ''); } catch { /* 参数不是 JSON */ }
      return { name: c.function.name, target };
    }));
  }
  if (reminded >= 2) return null;
  const isMutation = (r: Array<{ name: string }>) => r.some((c) => MUTATION_TOOLS.has(c.name));
  const wrote = rounds.some(isMutation);
  if (!wrote) return reminded === 0 && rounds.length >= 2 ? BATCH_REMINDER : null;
  const [a, b] = rounds.slice(-2);
  const singleWrite = (r?: Array<{ name: string; target: string }>) => r?.length === 1 && MUTATION_TOOLS.has(r[0].name);
  return singleWrite(a) && singleWrite(b) && a[0].target !== b[0].target ? BATCH_REMINDER : null;
}

/** 最近几次动作的简述, 给跑偏检查看 (工具名 + 参数开头 + 最近一句话) */
function recentActions(messages: Message[]): string {
  const lines: string[] = [];
  for (let i = messages.length - 1; i >= 0 && lines.length < 10; i--) {
    const m = messages[i];
    if (m.role === 'user') break;
    if (m.role !== 'assistant') continue;
    for (const c of m.tool_calls ?? []) lines.push(`${c.function.name} ${String(c.function.arguments ?? '').slice(0, 120)}`);
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (text) lines.push(`said: ${text.slice(0, 200)}`);
  }
  return lines.reverse().join('\n');
}

export async function injectIterationAdvisories(options: {
  iteration: number;
  toolMetricsHistory: ToolMetric[];
  memory: SystemMemory;
  toolUsageAdvisor: ToolUsageAdvisorLike;
  requireMutation?: boolean;
  sessionId?: string;
  task?: string;
}): Promise<void> {
  const { iteration, toolMetricsHistory, memory, toolUsageAdvisor } = options;

  if (iteration > 0 && iteration % 5 === 0) {
    const perfHint = buildPerformanceHint(toolMetricsHistory);
    if (perfHint) {
      // 顺序追加到对话尾部 → 不进顶层 system 块, 保住前缀缓存 (见文件顶部说明)
      memory.appendReminder(perfHint);
      if (process.env.CLI_DEBUG_CONSOLE === '1') {
        console.log('[Runner] Performance hint injected:', perfHint);
      }
    }
  }

  const toolAdvice = toolUsageAdvisor.analyze(iteration, options.requireMutation ?? true);
  if (toolAdvice) {
    memory.appendReminder(toolAdvice);
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('TOOL_ADVISOR', 'Usage advice injected', {
        advice: toolAdvice.slice(0, 100),
      });
    }
  }

  const messages = memory.getAll?.() ?? [];

  /* 很久没说话 (规则, 零成本): 用户只看到一串工具卡, 不知道 agent 在干嘛。
   * 恰好等于阈值才发 —— 每段沉默只提醒一次, 不需要额外状态。 */
  if (silentToolCallStreak(messages) === SILENT_TOOL_CALLS_NUDGE) {
    memory.appendReminder(
      'The user has not seen a message from you for a while — only tool cards. '
      + 'In your next reply, say in one line what you are doing and why, then continue.',
    );
  }

  const drift = languageDriftReminder(messages);
  if (drift) memory.appendReminder(drift);

  const batch = batchingReminder(messages, options.requireMutation ?? true);
  if (batch) memory.appendReminder(batch);

  /* 跑偏检查 (宿主登记, 通常是 Jev): 只在长任务里, 每 10 轮一次。失败 / 超时 = 不插。 */
  const check = options.sessionId ? midRunChecks.get(options.sessionId) : undefined;
  if (check && options.task && iteration >= MID_RUN_CHECK_EVERY && iteration % MID_RUN_CHECK_EVERY === 0) {
    try {
      const reminder = await check({ task: options.task, iteration, recent: recentActions(messages) });
      if (reminder) memory.appendReminder(reminder);
    } catch { /* 检查失败不影响这一轮 */ }
  }
}
