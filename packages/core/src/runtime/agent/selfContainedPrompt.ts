/**
 * 自包含 prompt 构建器：worker 只接收完成任务所需的上下文，保持任务边界清晰并复用 prompt cache。
 */

// ─── 类型 ───

export interface SelfContainedPromptOptions {
  /** 任务描述（3-5 个词，用于 UI 标签） */
  description: string;
  /** 详细任务指令（必须自包含，不引用对话历史） */
  prompt: string;
  /** 工作目录 */
  workDir: string;
  /** 可选：worktree 通知 */
  worktreeNotice?: string;
  /** 可选：允许的工具 */
  allowedTools?: string[];
  /** 可选：禁止的工具 */
  disallowedTools?: string[];
  /** 可选：最大迭代次数 */
  maxTurns?: number;
  /** 可选：Agent 类型名 */
  agentType?: string;
  /** 可选：模型覆盖 */
  model?: string;
  /** 可选：是否后台执行 */
  background?: boolean;
}

/** 构建包含环境、工具限制和完成标准的 worker 完整任务上下文。 */
export function buildSelfContainedPrompt(options: SelfContainedPromptOptions): string {
  const sections: string[] = [];

  // 系统前缀（所有 worker 共享，cache 友好）
  sections.push('# Agent Task Assignment');
  sections.push('');
  sections.push('You are a specialized agent executing a specific task.');
  sections.push('You have NO access to the parent conversation — this prompt is your complete context.');
  sections.push('Execute the task precisely. Do not ask questions. Do not explain your reasoning unless instructed.');
  sections.push('');

  // 工作环境
  sections.push(`## Environment`);
  sections.push(`Working directory: ${options.workDir}`);
  if (options.agentType) {
    sections.push(`Agent type: ${options.agentType}`);
  }
  if (options.maxTurns) {
    sections.push(`Max iterations: ${options.maxTurns}`);
  }
  sections.push('');

  // Worktree 通知
  if (options.worktreeNotice) {
    sections.push(options.worktreeNotice);
    sections.push('');
  }

  // 工具限制
  if (options.allowedTools && options.allowedTools.length > 0) {
    sections.push(`## Tool Restriction`);
    sections.push(`You may ONLY use these tools: ${options.allowedTools.join(', ')}`);
    sections.push('');
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    sections.push(`## Disallowed Tools`);
    sections.push(`Do NOT use: ${options.disallowedTools.join(', ')}`);
    sections.push('');
  }

  // 任务指令（核心部分）
  sections.push('## Task');
  sections.push('');
  sections.push(options.prompt);

  return sections.join('\n');
}

/**
 * 构建 task-notification XML（agent 完成后的通知格式）
 *
 * 使用 XML 包装任务标识、状态、摘要、结果和可选用量，让 coordinator 区分通知与用户消息。
 */
export function buildTaskNotification(params: {
  taskId: string;
  agentId?: string;
  status: 'completed' | 'failed' | 'killed';
  summary: string;
  result: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
}): string {
  const { taskId, agentId, status, summary, result, usage } = params;
  const lines = [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
  ];
  if (agentId) {
    lines.push(`<agent-id>${agentId}</agent-id>`);
  }
  lines.push(`<status>${status}</status>`);
  lines.push(`<summary>${escapeXml(summary)}</summary>`);
  lines.push(`<result>${escapeXml(result)}</result>`);
  if (usage) {
    lines.push('<usage>');
    if (usage.totalTokens !== undefined) lines.push(`  <total_tokens>${usage.totalTokens}</total_tokens>`);
    if (usage.toolUses !== undefined) lines.push(`  <tool_uses>${usage.toolUses}</tool_uses>`);
    if (usage.durationMs !== undefined) lines.push(`  <duration_ms>${usage.durationMs}</duration_ms>`);
    lines.push('</usage>');
  }
  lines.push('</task-notification>');
  return lines.join('\n');
}

/**
 * 解析 task-notification XML
 */
export function parseTaskNotification(text: string): {
  taskId: string;
  agentId?: string;
  status: string;
  summary: string;
  result: string;
} | null {
  const match = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!match) return null;

  const content = match[1];
  const extract = (tag: string): string => {
    const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : '';
  };

  return {
    taskId: extract('task-id'),
    agentId: extract('agent-id') || undefined,
    status: extract('status'),
    summary: extract('summary'),
    result: extract('result'),
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
