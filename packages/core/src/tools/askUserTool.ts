/**
 * AskUserQuestion Tool - 向用户提问并等待回答
 *
 * 工作流：
 * 1. LLM 调用 ask_user 工具，传入问题和选项
 * 2. 工具函数注册 pending question + 调用 UI 回调显示 SelectMenu
 * 3. 用户选择后，UI 调用 resolveUserQuestion() 解除 Promise
 * 4. 工具函数返回用户的选择作为 tool output
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getPendingAskUserStore } from '../runtime/store/PendingAskUserStore.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionInput {
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
}

// ============================================================================
// 全局回调注册表
// ============================================================================

interface PendingQuestion {
  resolve: (answer: string) => void;
  questions: AskUserQuestionInput[];
}

const pendingQuestions = new Map<string, PendingQuestion>();

const ASK_UNANSWERED_LIMIT = Math.max(1, Number(process.env.NEOX_ASK_USER_MAX_UNANSWERED) || 2);
const unansweredBySession = new Map<string, number>();

function askScopeKey(sessionId?: string | null): string {
  return sessionId || getCurrentChatSessionId() || '__default__';
}
const askBlockedSessions = new Set<string>();

/** 没人答 (超时 / 中断 / 用户取消) —— 这一轮禁止再产生副作用 */
function blockSideEffects(sessionId?: string | null): void {
  askBlockedSessions.add(askScopeKey(sessionId));
}
/** 这个会话当前是不是"问完没人答"的状态 */
export function isAskSideEffectBlocked(sessionId?: string | null): boolean {
  return askBlockedSessions.has(askScopeKey(sessionId));
}
/** 新一轮用户输入 / 用户答了 —— 解除 */
export function clearAskSideEffectBlock(sessionId?: string | null): void {
  askBlockedSessions.delete(askScopeKey(sessionId));
}
/** 仅供测试: 直接把闸落下 (生产路径只有超时 / 中断 / 用户取消三处会落闸) */
export function __blockAskSideEffectsForTest(sessionId?: string | null): void {
  blockSideEffects(sessionId);
}

/** 用户真的答了 —— 他在, 额度重置 */
export function noteAskAnswered(sessionId?: string | null): void {
  unansweredBySession.delete(askScopeKey(sessionId));
  clearAskSideEffectBlock(sessionId);
}
/** 超时 / 中断 / 拒绝 —— 连续没答的次数 +1 */
function noteAskUnanswered(sessionId?: string | null): number {
  const key = askScopeKey(sessionId);
  const next = (unansweredBySession.get(key) ?? 0) + 1;
  unansweredBySession.set(key, next);
  return next;
}
let latestPendingId: string | null = null;

/* P0: 用户切换时清空 pending — 防 B 登入后 resolveUserQuestion 误解 A 的待答问题.
 * 模块级 Map 不带 userId, 必须在 user 切换边沿统一清. */
import { onUserIdChange } from '@neoxlabs/platform/utils/config.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';
onUserIdChange((next, prev) => {
  void next; void prev;
  if (pendingQuestions.size === 0 && latestPendingId === null) return;
  /* reject 所有等待中的 Promise — 让 agent loop 不挂死 */
  for (const [, pq] of pendingQuestions) {
    try { pq.resolve('[cancelled: user switched]'); } catch { /* ignore */ }
  }
  pendingQuestions.clear();
  latestPendingId = null;
});

export interface AskUserUICallbackOptions {
  timeoutSec?: number;
}

let onQuestionReady:
  | ((id: string, questions: AskUserQuestionInput[], options?: AskUserUICallbackOptions) => string | undefined | void)
  | null = null;

/**
 * UI 层调用：注册问题就绪回调.
 *
 * 回调返回值 (新增):
 *   · sessionId 字符串 → askUserTool 把 (toolCallId, sessionId, questions) 持久化到磁盘
 *   · undefined / void → 不持久化 (test / CLI 模式)
 */
export function setAskUserUICallback(
  callback:
    | ((id: string, questions: AskUserQuestionInput[], options?: AskUserUICallbackOptions) => string | undefined | void)
    | null,
): void {
  onQuestionReady = callback;
}

export type AskUserExpireReason = 'timeout' | 'aborted';
type AskUserExpireCallback = (
  toolCallId: string, sessionId: string, timeoutSec: number, reason: AskUserExpireReason,
) => void;
let onTimeoutCallback: AskUserExpireCallback | null = null;

export function setAskUserTimeoutCallback(cb: AskUserExpireCallback | null): void {
  onTimeoutCallback = cb;
}

/**
 * UI 层调用：用户完成选择后解除阻塞.
 *
 * 返回值:
 *   - 'resolved': 内存里命中 pending Promise, 已 resolve. 工具会返回 formatted answer.
 *   - 'not_found': 内存里没有. 调用方 (server bridge) 应当走磁盘 resume 路径
 *     (consume PendingAskUserStore + append tool_result + chat({isResume:true})).
 *
 * 注意: 'not_found' 不代表答案丢了 — 只代表"内存 Promise 没了, 走另一条路".
 */
export type ResolveStatus = 'resolved' | 'not_found';

const STOP_AND_ASK_MESSAGE = (why: string): string =>
  `${why}。**本轮到此为止**: 不要替用户拍板, 不要再调用任何会改文件 / 跑命令 / 产生副作用的工具。`
  + `直接结束回复, 用一两句话说明你卡在哪、需要用户给什么信息即可 —— 用户回来看到这句话再决定。`
  + `(用户如果想让你自己判断, 他会点"拒绝/让 AI 判断"。)`;

export function resolveUserQuestion(
  toolCallId: string,
  answers: Record<string, string>,
): ResolveStatus {
  const id = toolCallId || latestPendingId;
  if (!id) return 'not_found';
  const pending = pendingQuestions.get(id);
  if (!pending) return 'not_found';

  if (answers && (answers as any).__dismiss__) {
    /* 主动取消也是"没答" —— 跟超时一起计数, 否则用户连点几次 ✕ 模型还会一直问 */
    const streak = noteAskUnanswered(null);
    pending.resolve(JSON.stringify({
      status: 'dismissed',
      unansweredStreak: streak,
      message: STOP_AND_ASK_MESSAGE('用户取消了这个问题(没有作答)')
        + (streak >= ASK_UNANSWERED_LIMIT
          ? ' 注意: 已经连续没人回应, 不要再调 ask_user —— 自己拍板并说明假设。'
          : ''),
    }));
    pendingQuestions.delete(id);
    if (latestPendingId === id) latestPendingId = null;
    getPendingAskUserStore()?.delete(id);
    return 'resolved';
  }

  const formatted = formatAnswers(pending.questions, answers);
  /* 用户真的答了 = 他在 —— 重问额度清零 */
  noteAskAnswered(null);
  pending.resolve(formatted);
  pendingQuestions.delete(id);
  if (latestPendingId === id) latestPendingId = null;
  /* 内存命中 = 答案已通过 Promise 送入 agentLoop, disk row 不再需要 */
  getPendingAskUserStore()?.delete(id);
  return 'resolved';
}

/**
 * 把一组用户答案按 askUserTool 的标准格式拼回 tool_result body.
 * resume 路径用 — 跨进程拿到磁盘记录的 questions + UI 提交的 answers, 拼成
 * 跟正常 in-memory 路径一模一样的 string.
 */
export function formatAnswersForResume(
  questions: AskUserQuestionInput[],
  answers: Record<string, string>,
): string {
  return formatAnswers(questions, answers);
}

// ============================================================================
// 工具定义
// ============================================================================

let callCounter = 0;

export const askUserTool: Tool = {
  name: 'ask_user',
  description: `Ask the user a question and wait for the answer. Use it when you need confirmation, a choice between approaches, or a stated preference.

When to use:
- The user needs to pick between several approaches
- You need to confirm the implementation direction
- You need information only the user has

Argument format:
{"questions":[{"question":"Which one do you want?","options":["Option A","Option B","Option C"]}]}

- questions: array of questions (1-4)
- question: the question text
- options: array of option strings, e.g. ["Option 1", "Option 2"]`,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of options, e.g. ["Option A", "Option B"]',
            },
          },
          required: ['question'],
        },
        description: 'List of questions (1-4)',
      },
    },
    required: ['questions'],
  },
  async function(args: any, context?: { signal?: AbortSignal }): Promise<string> {
    const questions: AskUserQuestionInput[] = normalizeAskUserArgs(args);
    if (questions.length === 0) {
      /* 缺问题不是工具坏 — 让模型按建议补参数重试 */
      return JSON.stringify({
        status: 'success',
        skipped: true,
        reason: 'no_questions',
        message: 'ask_user 需要至少一个 question。请按 {"questions":[{"question":"...","options":["A","B"]}]} 格式重试。',
      });
    }

    const askScope = askScopeKey(null);
    const unanswered = unansweredBySession.get(askScope) ?? 0;
    if (unanswered >= ASK_UNANSWERED_LIMIT) {
      return JSON.stringify({
        status: 'refused',
        reason: 'user_not_responding',
        unansweredStreak: unanswered,
        message: `用户已经连续 ${unanswered} 次没有回应 (超时/中断/拒绝) —— 他现在不在。`
          + '不要再问了: 按你自己的判断选一条最稳妥的路继续推进, '
          + '并在回复里用一两句写清你替他做了什么假设、哪些地方需要他回来后确认。',
      });
    }

    const toolCallId = `ask_user_${++callCounter}_${Date.now()}`;

    return new Promise<string>((resolve) => {
      pendingQuestions.set(toolCallId, { resolve, questions });
      latestPendingId = toolCallId;

      /* 持久化 + cleanup 由这两个 helper 兜底, 所有"返回 / 中断"路径必走 cleanup */
      const persistedStore = getPendingAskUserStore();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
        pendingQuestions.delete(toolCallId);
        if (latestPendingId === toolCallId) latestPendingId = null;
        persistedStore?.delete(toolCallId);
      };

      const timeoutSecForUI = (() => {
        const n = Number(process.env.NEOX_ASK_USER_TIMEOUT_SEC);
        return Number.isFinite(n) ? Math.floor(n) : 300;
      })();

      // 通知 UI 层显示交互界面
      let sessionId: string | undefined;
      if (onQuestionReady) {
        try {
          /* 回调返回值: 关联 sessionId. 拿到就持久化, 让服务重启后用户的 submit 能走
           * resume 路径. callback 内部异常仍走原有"UI 回调炸了 → 转用文字提问"分支. */
          const rv = onQuestionReady(toolCallId, questions, { timeoutSec: timeoutSecForUI });
          if (typeof rv === 'string' && rv) sessionId = rv;
        } catch (error) {
          /* UI 回调炸了 — 清理状态并让模型转用文字提问继续推进 */
          resolve(JSON.stringify({
            status: 'success',
            skipped: true,
            reason: 'ui_callback_failed',
            error: error instanceof Error ? error.message : String(error),
            message: '交互 UI 回调抛错了。请改成用普通对话向用户提问后等待用户输入。',
          }));
          cleanup();
          return;
        }

        /* 拿到 sessionId 才持久化 — 无 sessionId 的环境 (test) 退化为内存模式 */
        if (sessionId && persistedStore) {
          persistedStore.record({ toolCallId, sessionId, questions });
        }
      } else {
        /* 当前 runtime 没注册 UI 回调(headless/CLI/test 场景) —
           这不是错误,工具实现本身是好的,只是当前没有 UI 通道呈现选项。
           告诉模型改用普通对话提问。*/
        resolve(JSON.stringify({
          status: 'success',
          skipped: true,
          reason: 'no_interactive_ui',
          message: 'ask_user 需要 UI 交互通道,当前 runtime 未注册(常见于 headless/CLI/自动测试)。请直接在回复里用自然语言向用户提问并等用户下一轮输入。',
          questions_received: questions.map(q => ({ question: q.question, options: q.options.map(o => o.label) })),
        }));
        cleanup();
        return;
      }

      const timeoutSec = timeoutSecForUI;
      if (timeoutSec > 0) {
        timeoutId = setTimeout(() => {
          if (pendingQuestions.has(toolCallId)) {
            if (sessionId && onTimeoutCallback) {
              try { onTimeoutCallback(toolCallId, sessionId, timeoutSec, 'timeout'); } catch { /* ignore UI callback err */ }
            }
            const streak = noteAskUnanswered(sessionId);
            blockSideEffects(sessionId);   /* 文字劝阻不够, 见 askBlockedSessions 注释 */
            resolve(JSON.stringify({
              status: 'expired',
              timeoutSec,
              unansweredStreak: streak,
              message: STOP_AND_ASK_MESSAGE(`用户未在 ${timeoutSec} 秒内回应`)
                + (streak >= ASK_UNANSWERED_LIMIT
                  ? ' 注意: 已经连续没人回应, 不要再调 ask_user —— 自己拍板并说明假设。'
                  : ''),
            }));
            cleanup();
          }
        }, timeoutSec * 1000);
      }

      // abort 处理 — 只有用户主动 Ctrl+C 才能取消，不设超时
      if (context?.signal) {
        context.signal.addEventListener('abort', () => {
          if (pendingQuestions.has(toolCallId)) {
            /* 先告诉 UI 这个问题已经作废, 再 resolve 给模型 —— 顺序跟 timeout 分支一致。 */
            if (sessionId && onTimeoutCallback) {
              try { onTimeoutCallback(toolCallId, sessionId, timeoutSec, 'aborted'); } catch { /* ignore UI callback err */ }
            }
            noteAskUnanswered(sessionId);
            blockSideEffects(sessionId);
            resolve('[用户中断]');
            cleanup();
          }
        }, { once: true });
      }
    });
  },
};

// ============================================================================
// 辅助函数
// ============================================================================

function normalizeAskUserArgs(args: any): AskUserQuestionInput[] {
  if (!args || typeof args !== 'object') return [];

  // Case 1 & 2: 标准 questions 数组
  if (Array.isArray(args.questions) && args.questions.length > 0) {
    return args.questions.map(normalizeQuestion).filter(Boolean) as AskUserQuestionInput[];
  }

  // Case 3 & 4: 单题扁平格式 {question: "...", options?: [...]}
  if (typeof args.question === 'string') {
    const q = normalizeQuestion(args);
    return q ? [q] : [];
  }

  return [];
}

function normalizeQuestion(raw: any): AskUserQuestionInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question) return null;

  const options: AskUserOption[] = normalizeOptions(raw.options);
  return {
    question,
    options,
    multiSelect: raw.multiSelect === true,
  };
}

function normalizeOptions(raw: any): AskUserOption[] {
  if (!Array.isArray(raw)) return [];
  const result: AskUserOption[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      // 新格式: ["选项A", "选项B"]
      if (item.trim()) result.push({ label: item.trim() });
    } else if (item && typeof item === 'object' && typeof item.label === 'string') {
      // 旧格式: [{label: "选项A", description: "说明"}]
      result.push({
        label: item.label.trim(),
        ...(item.description ? { description: String(item.description) } : {}),
      });
    }
  }
  return result;
}

function formatAnswers(
  questions: AskUserQuestionInput[],
  answers: Record<string, string>,
): string {
  const parts: string[] = [];
  for (const q of questions) {
    const answer = answers[q.question] || '(未回答)';
    parts.push(`Q: ${q.question}\nA: ${answer}`);
  }
  return parts.join('\n\n');
}
