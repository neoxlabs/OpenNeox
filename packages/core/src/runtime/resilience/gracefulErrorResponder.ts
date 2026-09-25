/**
 * GracefulErrorResponder — 用户态错误降级回复
 *
 * 核心设计原则：
 *   1. 用户不应该看到空白或技术堆栈
 *   2. 不同错误类型给不同的友好指引
 *   3. Worker 失败也要通知用户
 *   4. 回复风格和 Neox 人格一致（友好、口语化）
 *
 * 错误分类复用 agentResiliencePolicy.classifyError()，
 * 在此基础上映射到用户可读的降级回复。
 */

import { classifyError, type ErrorCategory } from './agentResiliencePolicy.js';

// ============================================================================
// Types
// ============================================================================

export interface GracefulErrorReply {
  /** 用户可见的友好文案（markdown） */
  userMessage: string;
  /** 是否建议用户重试 */
  suggestRetry: boolean;
  /** 可选的操作建议 */
  actionHint?: string;
  /** 错误分类 */
  category: ErrorCategory;
  /** 错误严重等级 */
  severity: 'transient' | 'config' | 'fatal';
}

export interface WorkerFailureNotice {
  /** 进程 ID */
  pid: string;
  /** 任务摘要 */
  taskSummary: string;
  /** 用户可见消息 */
  userMessage: string;
  /** 是否正在自动重试 */
  willRetry: boolean;
  /** 重试次数 */
  retryAttempt?: number;
}

// ============================================================================
// 错误分类 → 降级回复模板
// ============================================================================

const REPLY_TEMPLATES: Record<ErrorCategory, (detail: string) => GracefulErrorReply> = {
  rate_limit: (_d) => ({
    userMessage: '⏳ 模型服务触发了速率限制，我已经尝试自动重试但仍未成功。',
    suggestRetry: true,
    actionHint: '你可以稍等几秒后重新发消息，或者用 `neox provider` 切换到其他模型。',
    category: 'rate_limit',
    severity: 'transient',
  }),
  server_error: (_d) => ({
    userMessage: '🔧 模型服务端暂时出了问题（5xx），我已尝试重试但未能恢复。',
    suggestRetry: true,
    actionHint: '通常几分钟后会自动恢复。你也可以切换模型继续工作。',
    category: 'server_error',
    severity: 'transient',
  }),
  network: (_d) => ({
    userMessage: '🌐 网络连接出现问题，无法连接到模型服务。',
    suggestRetry: true,
    actionHint: '请检查网络连接，确认后重新发消息即可。如果使用代理，请确认代理配置正确。',
    category: 'network',
    severity: 'transient',
  }),
  token_limit: (_d) => ({
    userMessage: '📦 对话内容太长，超出了模型的上下文窗口限制。',
    suggestRetry: false,
    actionHint: '建议开启新对话，或者把复杂任务拆分成较小的步骤。',
    category: 'token_limit',
    severity: 'config',
  }),
  auth: (d) => ({
    userMessage: '🔑 API 密钥验证失败，无法使用当前模型。',
    suggestRetry: false,
    actionHint: '请用 `neox provider` 命令检查你的 API Key 配置是否正确。',
    category: 'auth',
    severity: 'config',
  }),
  unknown: (d) => ({
    userMessage: '😵 遇到了一个意外错误，我暂时无法完成这个请求。',
    suggestRetry: true,
    actionHint: '你可以重新发消息再试一次。如果问题持续，请检查终端日志。',
    category: 'unknown',
    severity: 'fatal',
  }),
};

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 根据 Error 对象生成用户友好的降级回复
 */
export function buildGracefulReply(error: Error): GracefulErrorReply {
  const category = classifyError(error);
  const template = REPLY_TEMPLATES[category];
  return template(error.message);
}

/**
 * 将 GracefulErrorReply 格式化为用户可见的完整文案
 * 返回的文本可以直接作为 assistant 回复推送给用户
 */
export function formatGracefulReply(reply: GracefulErrorReply): string {
  const lines: string[] = [reply.userMessage];

  if (reply.actionHint) {
    lines.push('');
    lines.push(`💡 ${reply.actionHint}`);
  }

  if (reply.suggestRetry) {
    lines.push('');
    lines.push('_你可以直接重新发消息，我会立即重新处理。_');
  }

  return lines.join('\n');
}

/**
 * 根据 Error 直接生成格式化的降级文案
 * 快捷方法 = buildGracefulReply + formatGracefulReply
 */
export function buildGracefulText(error: Error): string {
  return formatGracefulReply(buildGracefulReply(error));
}

// ============================================================================
// Worker 失败通知
// ============================================================================

/**
 * 为 Worker 进程失败生成用户可见的通知消息
 */
export function buildWorkerFailureNotice(opts: {
  pid: string;
  task: string;
  error: string;
  willRetry: boolean;
  retryAttempt?: number;
}): WorkerFailureNotice {
  const taskSummary = opts.task.length > 60 ? opts.task.slice(0, 57) + '...' : opts.task;
  const errorCategory = classifyError(new Error(opts.error));

  let userMessage: string;

  if (opts.willRetry) {
    userMessage = `⚠️ 后台进程 \`${opts.pid}\`（${taskSummary}）遇到问题，正在自动重试（第 ${opts.retryAttempt} 次）...`;
  } else {
    // 根据错误类型给不同描述
    switch (errorCategory) {
      case 'rate_limit':
        userMessage = `⚠️ 后台进程 \`${opts.pid}\` 因速率限制失败：${taskSummary}。你可以稍后用 \`spawn_process\` 重新启动。`;
        break;
      case 'auth':
        userMessage = `🔑 后台进程 \`${opts.pid}\` 因 API 密钥问题失败：${taskSummary}。请检查 Provider 配置后重试。`;
        break;
      case 'token_limit':
        userMessage = `📦 后台进程 \`${opts.pid}\` 因上下文过长失败：${taskSummary}。建议拆分为更小的任务。`;
        break;
      case 'network':
        userMessage = `🌐 后台进程 \`${opts.pid}\` 因网络问题失败：${taskSummary}。网络恢复后可重新启动。`;
        break;
      default:
        userMessage = `❌ 后台进程 \`${opts.pid}\` 执行失败：${taskSummary}\n> ${opts.error.slice(0, 120)}`;
        break;
    }
  }

  return {
    pid: opts.pid,
    taskSummary,
    userMessage,
    willRetry: opts.willRetry,
    retryAttempt: opts.retryAttempt,
  };
}

// ============================================================================
// agentLoop 退出原因 → 降级文案 (budget 耗尽等)
// ============================================================================

/**
 * 为 agentLoop 非正常退出生成降级文案
 */
export function buildExitReasonText(
  exitReason: string,
  context?: { toolCalls?: number; durationMs?: number; lastError?: string }
): string | null {
  switch (exitReason) {
    case 'stop':
    case 'aborted':
      return null; // 正常退出，无需降级文案

    case 'budget_tokens':
      return '📊 本次对话使用的 token 数量达到了安全上限。你可以继续发消息，我会在新的上下文中继续工作。';

    case 'budget_time':
      return `⏰ 本次执行时间达到了上限（${context?.durationMs ? Math.round(context.durationMs / 1000 / 60) + ' 分钟' : '上限'}）。你可以继续发消息让我接着做。`;

    case 'budget_tools':
      return `🔧 工具调用次数达到了安全上限（${context?.toolCalls || '上限'}次）。如果任务还没完成，请再发消息让我继续。`;

    case 'error':
      if (context?.lastError) {
        return buildGracefulText(new Error(context.lastError));
      }
      return '😵 执行过程中遇到了问题，暂时无法继续。你可以重新发消息再试一次。';

    default:
      return null;
  }
}
