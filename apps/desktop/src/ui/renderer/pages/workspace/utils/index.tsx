/**
 * WorkspacePage 工具函数
 */

import React from 'react';
import type { DarkModePreference } from '../../../../state/appStore';
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import type { Session, ChatMessage } from '../../../../shared/ipc';
import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import Icons from '../../../components/Icons';
import { stripToolHintHeader } from '../../../modules/agent-timeline/toolResultHint';

// ==================== ID 生成 ====================
export const createId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ==================== 常量 ====================
export const TIMELINE_PAGE_SIZE = 80;
export const TIMELINE_BATCH_SIZE = 80;

// ==================== 主题相关 ====================
export const getThemeIcon = (preference: DarkModePreference) => {
  switch (preference) {
    case 'auto': return <Icons.AutoTheme />;
    case 'light': return <Icons.Sun />;
    default: return <Icons.Moon />;
  }
};

export const getThemeTitle = (preference: DarkModePreference) => {
  switch (preference) {
    case 'auto': return 'Auto Mode (click to toggle)';
    case 'light': return 'Light Mode (click for Dark)';
    default: return 'Dark Mode (click for Light)';
  }
};

// ==================== 时间格式化 ====================
export const formatElapsedTime = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  const tenths = Math.floor((ms % 1000) / 100);
  return `${seconds}.${tenths}s`;
};

// ==================== Timeline 格式化 ====================
export const formatTimelineDetail = (value: unknown, maxLength = 600): string => {
  if (value === undefined || value === null) {
    return '';
  }

  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

export const formatToolCallDetail = (
  toolName: string,
  args: Record<string, unknown> | undefined,
  targetPath?: string,
  equivalentCommand?: string,
): string => {
  const lines: string[] = [];

  if (toolName === 'show_tree') {
    const directory =
      (args && typeof args.directory === 'string' && args.directory.trim()) ||
      targetPath ||
      '.';
    const rawDepth = (args as Record<string, unknown>)?.max_depth ?? (args as Record<string, unknown>)?.maxDepth;
    const depth =
      typeof rawDepth === 'number'
        ? rawDepth
        : rawDepth !== undefined && !Number.isNaN(Number(rawDepth))
          ? Number(rawDepth)
          : undefined;

    lines.push(`正在查找目录 ${directory}`);
    lines.push(depth !== undefined ? `使用 tree 命令，最大层级 ${depth}` : '使用 tree 命令查看目录结构');
    if (equivalentCommand) {
      lines.push(`💻 ${equivalentCommand}`);
    }
    return lines.join('\n');
  }

  const argsText = formatTimelineDetail(args);
  if (argsText && argsText !== '{}' && argsText !== '[]') {
    lines.push(argsText);
  }
  if (targetPath) {
    lines.push(`📄 ${targetPath}`);
  }
  if (equivalentCommand) {
    lines.push(`💻 ${equivalentCommand}`);
  }

  return lines.join('\n');
};

export type StructuredToolResult = {
  type?: string;
  status?: string;
  tool?: string;
  summary?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  file_path?: string;
};

export const parseStructuredToolOutput = (output?: string): StructuredToolResult | null => {
  if (!output) return null;
  const trimmed = stripToolHintHeader(output.trim());
  if (!trimmed.startsWith('{')) return null;

  // Fast path:完整 JSON 直接 parse.
  if (trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as StructuredToolResult;
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.type !== 'string' || typeof parsed.status !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // Fallback:被 MAX_TOOL_OUTPUT_PREVIEW(12000) 截断的 ToolResult JSON 末尾
  // 往往是 "..." 卡在 content 字段里.用正则抢救出 type/status/tool/summary
  // 和 "content":"..."(到被截的位置),至少让 UI 能显示 content 段而不是原始 JSON.
  try {
    const typeMatch = trimmed.match(/"type"\s*:\s*"(ephemeral|contextual|summarized)"/);
    const statusMatch = trimmed.match(/"status"\s*:\s*"(success|already_done|error)"/);
    if (!typeMatch || !statusMatch) return null;
    const toolMatch = trimmed.match(/"tool"\s*:\s*"([^"]+)"/);
    const summaryMatch = trimmed.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const contentStart = trimmed.search(/"content"\s*:\s*"/);
    let content: string | undefined;
    if (contentStart >= 0) {
      const tail = trimmed.slice(contentStart).replace(/^"content"\s*:\s*"/, '');
      // 反转义 \n \t \" 等(尽力而为)
      content = tail
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return {
      type: typeMatch[1],
      status: statusMatch[1],
      tool: toolMatch?.[1] ?? '',
      summary: summaryMatch?.[1] ? summaryMatch[1].replace(/\\"/g, '"') : '',
      content,
    } as StructuredToolResult;
  } catch {
    return null;
  }
};

export const formatToolResultDetail = (
  _toolName: string,
  output?: string,
  resultLength?: number,
  outputTruncated?: boolean,
): string => {
  if (!output) {
    return '';
  }

  const structured = parseStructuredToolOutput(output);
  if (structured) {
    if (typeof structured.content === 'string' && structured.content.trim()) {
      return structured.content;
    }
    if (typeof structured.error === 'string' && structured.error.trim()) {
      return structured.error;
    }
    if (typeof structured.summary === 'string' && structured.summary.trim()) {
      return structured.summary;
    }
    return '';
  }

  const visible = output;
  const hiddenChars = resultLength ? Math.max(resultLength - visible.length, 0) : 0;

  if (outputTruncated && hiddenChars > 0) {
    return `${visible}\n\n… 还有 ${hiddenChars.toLocaleString()} 个字符未显示`;
  }

  if (outputTruncated && hiddenChars === 0) {
    return `${visible}\n\n… 输出已截断`;
  }

  if (!outputTruncated && hiddenChars > 0) {
    return `${visible}\n\n… 还有 ${hiddenChars.toLocaleString()} 个字符未显示`;
  }

  return visible;
};

// ==================== 语言检测 ====================
export const detectLanguageFromPath = (filepath: string): string => {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust',
    c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    rb: 'ruby', php: 'php', swift: 'swift', scala: 'scala',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
    dockerfile: 'dockerfile',
  };
  return languageMap[ext] || 'plaintext';
};

// ==================== 数据清理 ====================
export const sanitizeTimelineEntries = (entries: TimelineEntry[] = []): TimelineEntry[] => {
  return (entries || []).filter(Boolean);
};

export const sanitizeSessionData = (session: Session): Session => {
  const dedupedMessages: ChatMessage[] = [];
  let lastAssistantText: string | null = null;

  for (const msg of session.messages) {
    if (msg.role === 'assistant') {
      const text = (msg.text || '').trim();
      if (!text) {
        continue;
      }
      if (text === lastAssistantText) {
        continue;
      }
      lastAssistantText = text;
      dedupedMessages.push(msg);
    } else {
      lastAssistantText = null;
      dedupedMessages.push(msg);
    }
  }

  const sanitizedTimeline = sanitizeTimelineEntries(session.timeline || []);

  return {
    ...session,
    messages: dedupedMessages,
    timeline: sanitizedTimeline,
  };
};

// ==================== 类型定义 ====================
export interface MemoryStatus {
  tokensUsed: number;
  contextWindow?: number;
  state?: string;
  pressure?: number;
  byType?: Record<string, { count: number; tokens: number }>;
  breakdown?: ContextTokenBreakdown;
}

export interface LatestRequestUsage {
  inputTokens: number;
  billableInputTokens?: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  breakdown?: ContextTokenBreakdown;
  /** 首字到末字 (ms) —— 上下文弹窗算输出速度; 纯工具回合 / 打点缺失时没有 */
  generationMs?: number;
  /** 发出请求到首字 (ms) */
  firstTokenMs?: number;
}
