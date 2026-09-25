import {
  getDefaultThinkingStatus as getSharedDefaultThinkingStatus,
  resetDefaultThinkingStatusRotation,
} from '@neoxlabs/platform/shared/defaultThinkingStatus.js';

/**
 * 动态状态推断工具
 * 根据工具调用和上下文推断显示的状态文本
 */


/**
 * 轮换索引（按类别存储）
 */
const categoryIndex: Record<string, number> = {};

/**
 * 获取随机或轮换的状态文本
 */
function getStatusFromList(statuses: string[], category: string, rotate: boolean = true): string {
  if (!categoryIndex[category]) {
    categoryIndex[category] = 0;
  }

  const index = categoryIndex[category] % statuses.length;
  const text = statuses[index];

  if (rotate) {
    categoryIndex[category] = (index + 1) % statuses.length;
  }

  return text;
}

/**
 * 根据工具调用推断状态（核心函数）
 * @param toolName - 工具名称
 * @param toolInput - 工具参数（可选）
 * @returns 推断的状态文本
 */
export function inferStatusFromTool(
  toolName: string,
  toolInput?: Record<string, unknown>
): string {
  return getToolRunningStatus(toolName, (toolInput || {}) as Record<string, any>);
}

/** 推理阶段不再按关键词猜状态 (见文件头), 恒返回 null = 保持 Thinking */
export function inferStatusFromText(_text: string): string | null {
  return null;
}

/**
 * 获取默认的 thinking 状态（带轮换）
 */
export function getDefaultThinkingStatus(): string {
  /* CLI 状态行固定说 Thinking —— 共享的那份会轮换 Thinking/Processing/Pondering/Contemplating,
   * 同一件事每次换个说法, 读的人会以为状态变了。 */
  void getSharedDefaultThinkingStatus;
  return 'Thinking…';
}

/**
 * 重置轮换索引（在新会话开始时调用）
 */
export function resetStatusRotation(): void {
  Object.keys(categoryIndex).forEach(key => {
    categoryIndex[key] = 0;
  });
  resetDefaultThinkingStatusRotation();
}


// ==================== 场景化状态文本 ====================

/**
 * 流式传输状态
 */
const STREAMING_STATUSES = [
  'Streaming...',
  'Receiving data...',
  'Downloading...',
  'Fetching...',
];

/**
 * 重试状态
 */
const RETRY_STATUSES: Record<string, string[]> = {
  rateLimit: ['Rate limited, waiting...', 'Cooling down...', 'Pausing...'],
  timeout: ['Timed out, retrying...', 'Reconnecting...', 'Trying again...'],
  network: ['Network issue, reconnecting...', 'Connection lost, retrying...'],
  default: ['Retrying...', 'Trying again...', 'Recovering...'],
};

/**
 * 完成状态
 */
const COMPLETE_STATUSES = [
  'Complete!',
  'Done!',
  'Finished!',
  'All done!',
];

/**
 * 错误状态
 */
const ERROR_STATUSES = [
  'Error occurred',
  'Something went wrong',
  'Failed',
];

/**
 * 工具结果状态
 */
const TOOL_RESULT_STATUSES: Record<string, { success: string[]; error: string[] }> = {
  'Grep': {
    success: ['Found matches!', 'Search complete', 'Results ready'],
    error: ['No matches found', 'Search failed'],
  },
  'Read': {
    success: ['File loaded', 'Content ready', 'Read complete'],
    error: ['Failed to read', 'File not found'],
  },
  'Edit': {
    success: ['Changes saved', 'File updated', 'Edit complete'],
    error: ['Edit failed', 'Could not save'],
  },
  'Write': {
    success: ['File created', 'Write complete', 'Saved!'],
    error: ['Write failed', 'Could not create'],
  },
  'Bash': {
    success: ['Command done', 'Executed!', 'Processing result...'],
    error: ['Command failed', 'Exit with error'],
  },
  'Task': {
    success: ['Agent step done', 'Subtask done', 'Continuing...'],
    error: ['Agent failed', 'Task error'],
  },
  'task': {
    success: ['Agent step done', 'Subtask done', 'Continuing...'],
    error: ['Agent failed', 'Task error'],
  },
  'explore': {
    success: ['Explore step done', 'Scan done', 'Continuing...'],
    error: ['Explore failed', 'Scan error'],
  },
  'execute_shell': {
    success: ['Shell step done', 'Command done', 'Continuing...'],
    error: ['Shell failed', 'Command error'],
  },
  'default': {
    success: ['Step done', 'Continuing...', 'Next step...'],
    error: ['Failed', 'Error'],
  },
};

/**
 * 获取流式传输状态
 */
export function getStreamingStatus(toolName?: string, chars?: number): string {
  if (toolName && chars !== undefined) {
    return `Preparing ${toolDisplayVerb(toolName)}…`;
  }
  return getStatusFromList(STREAMING_STATUSES, 'streaming');
}

/** 工具名 → 状态行上的动词 (跟时间线卡片同一套: Read / Search / Bash / Edit …) */
export function toolDisplayVerb(toolName: string): string {
  const n = (toolName || '').toLowerCase();
  if (/^(readfile|read|read_file|smart_read)$/.test(n)) return 'Read';
  if (/^(search|grep)$/.test(n)) return 'Search';
  if (/^(search_files|glob|find_files)$/.test(n)) return 'Glob';
  if (/^(show_tree|smart_tree|list_directory|ls)$/.test(n)) return 'List';
  if (/^(edit|edit_file|multi_edit)$/.test(n)) return 'Edit';
  if (/^(write|write_file)$/.test(n)) return 'Write';
  if (/^(bash|execute_bash|execute_shell|execute_command|shell)$/.test(n)) return 'Bash';
  if (/^(web_search|websearch)$/.test(n)) return 'Web Search';
  if (/^(web_fetch|webfetch)$/.test(n)) return 'Fetch';
  if (/^(explore|agent|task)$/.test(n)) return 'agents';
  return toolName;
}

export function getToolRunningStatus(toolName: string, args: Record<string, any> = {}): string {
  const verb = toolDisplayVerb(toolName);
  const short = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const base = (p: unknown) => (typeof p === 'string' ? p.split(/[\\/]/).pop() || p : '');
  switch (verb) {
    case 'Read': {
      const p = args.path || args.file_path || (Array.isArray(args.paths) ? `${args.paths.length} files` : '');
      return `Reading ${short(base(p) || String(p))}…`;
    }
    case 'Search': return `Searching "${short(String(args.pattern || args.query || ''), 32)}"…`;
    case 'Glob': return `Finding ${short(String(args.pattern || args.glob || 'files'), 32)}…`;
    case 'List': return 'Listing files…';
    case 'Edit': return `Editing ${short(base(args.path || args.file_path) || 'file')}…`;
    case 'Write': return `Writing ${short(base(args.path || args.file_path) || 'file')}…`;
    case 'Bash': return `Running ${short(String(args.command || args.code || 'command').split('\n')[0]!)}`;
    case 'Web Search': return `Searching the web…`;
    case 'Fetch': return `Fetching ${short(String(args.url || 'page'))}…`;
    case 'agents': return 'Agents working…';
    default: return `Running ${verb}…`;
  }
}

/**
 * 获取重试状态
 */
export function getRetryStatus(type: 'rateLimit' | 'timeout' | 'network' | 'default' = 'default'): string {
  const statuses = RETRY_STATUSES[type] || RETRY_STATUSES['default'];
  return getStatusFromList(statuses, `retry_${type}`);
}

/**
 * 获取完成状态
 */
export function getCompleteStatus(): string {
  return getStatusFromList(COMPLETE_STATUSES, 'complete');
}

/**
 * 获取错误状态
 */
export function getErrorStatus(): string {
  return getStatusFromList(ERROR_STATUSES, 'error');
}

/**
 * 获取工具结果状态
 */
export function getToolResultStatus(toolName: string, success: boolean, resultLength?: number): string {
  /* 工具跑完, 接下来是模型在读结果 —— 就说 Thinking。以前从一张表里随机挑 "Shell step done (12B)" /
   * "Continuing..." / "Next step...", 同一件事每次说法不一样, 还带着没人关心的字节数。 */
  if (success) return 'Thinking…';
  void resultLength;
  const normalizedToolName = (toolName || '').toLowerCase();
  const statuses =
    TOOL_RESULT_STATUSES[toolName] ||
    TOOL_RESULT_STATUSES[normalizedToolName] ||
    TOOL_RESULT_STATUSES['default'];
  const list = success ? statuses.success : statuses.error;
  const baseStatus = getStatusFromList(list, `result_${toolName}_${success}`);

  // 如果有结果长度，附加信息
  if (success && resultLength !== undefined && resultLength > 0) {
    const sizeStr = resultLength >= 1024
      ? `${(resultLength / 1024).toFixed(1)}KB`
      : `${resultLength}B`;
    return `${baseStatus} (${sizeStr})`;
  }

  return baseStatus;
}

/**
 * 获取文件操作状态
 */
export function getFileOperationStatus(operation: 'read' | 'edit' | 'write' | 'generate', filePath: string): string {
  const fileName = filePath.split('/').pop() || filePath;
  const shortName = fileName.length > 20 ? fileName.slice(0, 17) + '...' : fileName;

  switch (operation) {
    case 'read':
      return `Reading ${shortName}...`;
    case 'edit':
      return `Editing ${shortName}...`;
    case 'write':
      return `Writing ${shortName}...`;
    case 'generate':
      return `Generating ${shortName}...`;
    default:
      return `Processing ${shortName}...`;
  }
}
