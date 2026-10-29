
export const estimateOutputTokens = (text: string): number => {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xAC00 && code <= 0xD7AF)) {
      tokens += 0.67;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
};

export const formatCompactTokens = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.floor(value));
};

export const parseCompactCount = (text: string): number => {
  const normalized = (text || '').trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized.endsWith('k')) {
    const base = Number(normalized.slice(0, -1));
    return Number.isFinite(base) ? Math.max(0, Math.round(base * 1000)) : 0;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  read: 'readfile',
  read_file: 'readfile',
  smart_read: 'readfile',
  read_multiple_files: 'readfile',
  write: 'write_file',
  edit: 'edit_file',
  glob: 'search_files',
  grep: 'search',
  tree: 'show_tree',
  bash: 'execute_bash',
  shell: 'execute_shell',
  execute: 'execute_shell',
  execute_command: 'execute_shell',
  run_command: 'execute_shell',
  command_exec: 'execute_shell',
  exec_command: 'execute_shell',
  websearch: 'web_search',
  webfetch: 'web_fetch',
};

/** Surface 工具 — 产出物在右栏 SurfacePanel 渲染, 不要在 timeline 出裸 marker JSON 卡片. */
export const SURFACE_TOOLS = new Set([
  'open_surface',
  'update_surface',
  'close_surface',
  'edit_plan',     // 注: 不是 update_plan(那是 Codex 风格的 step list 工具)
  'update_todos',
]);

/**
 * 把 surface 工具的 marker JSON 输出转成一行友好摘要, 给 timeline 卡片 detail 用.
 * 不能解析就返回 null, 让上层走默认渲染.
 */
export function summarizeSurfaceOutput(toolName: string, output?: string): string | null {
  if (!output || typeof output !== 'string') return null;
  if (!output.includes('__neox_surface_event__')) return null;
  let payload: any;
  try { payload = JSON.parse(output); } catch { return null; }
  if (!payload || payload.__neox_surface_event__ !== true) return null;

  const action = payload.action as string | undefined;
  if (action === 'open' && payload.surface) {
    const s = payload.surface;
    const title = s.title ? ` · ${s.title}` : '';
    return `打开 ${s.kind}${title}`;
  }
  if (action === 'close') {
    return '关闭 surface';
  }
  if (action === 'update' && payload.patch) {
    const keys = Object.keys(payload.patch);
    return `更新 surface (${keys.join(', ') || 'patch'})`;
  }
  if (action === 'plan_op' && payload.planOp) {
    const op = payload.planOp;
    switch (op.kind) {
      case 'content':            return `plan · 全量替换 (${op.content?.length ?? 0} 字)`;
      case 'append':             return `plan · 追加 (${op.text?.length ?? 0} 字)`;
      case 'replace_section':    return `plan · 替换章节「${op.heading || ''}」`;
      case 'set_section_status': return `plan · 「${op.heading || ''}」→ ${op.status || ''}`;
      case 'add_note':           return `plan · 笔记: ${(op.text || '').slice(0, 40)}${(op.text || '').length > 40 ? '…' : ''}`;
      default:                   return 'plan · 更新';
    }
  }
  if (action === 'todo_replace' && Array.isArray(payload.todoItems)) {
    const items = payload.todoItems;
    const done = items.filter((i: any) => i.status === 'done').length;
    const inProg = items.filter((i: any) => i.status === 'in_progress').length;
    const pending = items.filter((i: any) => i.status === 'pending').length;
    const skipped = items.filter((i: any) => i.status === 'skipped').length;
    const parts = [`${items.length} 项`];
    if (done) parts.push(`${done} 完成`);
    if (inProg) parts.push(`${inProg} 进行`);
    if (pending) parts.push(`${pending} 待办`);
    if (skipped) parts.push(`${skipped} 跳过`);
    return `todos · ${parts.join(' · ')}`;
  }
  return null;
}

export const normalizeToolName = (toolName?: string): string | undefined => {
  if (!toolName) return toolName;
  if (toolName.startsWith('mcp__')) return toolName;
  const lower = toolName.toLowerCase();
  return TOOL_NAME_ALIASES[lower] || lower;
};

export const resolveToolCallId = (event: any): string | undefined => {
  const candidate = event?.toolId || event?.id || event?.toolCallId;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
};

export const normalizeErrorMessage = (message?: string): string => {
  if (!message) return '';
  return message.split('\n')[0].trim();
};

export const extractStreamText = (payload: any, keys: string[]): string => {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'string') {
      if (value) return value;
      continue;
    }
    if (!value) continue;

    if (Array.isArray(value)) {
      const merged = value.map((item: any) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        if (typeof item.delta === 'string') return item.delta;
        if (typeof item.message === 'string') return item.message;
        return '';
      }).join('');
      if (merged) return merged;
      continue;
    }

    if (typeof value === 'object') {
      if (typeof value.text === 'string' && value.text) return value.text;
      if (typeof value.content === 'string' && value.content) return value.content;
      if (typeof value.delta === 'string' && value.delta) return value.delta;
      if (typeof value.message === 'string' && value.message) return value.message;
    }
  }
  return '';
};

export const mergeReasoningDelta = (existing: string, incoming: string): { content: string; appended: string } => {
  const prev = existing || '';
  const next = incoming || '';
  if (!next) return { content: prev, appended: '' };
  if (!prev) return { content: next, appended: next };
  if (next === prev) return { content: prev, appended: '' };

  // Some providers emit cumulative text instead of true deltas.
  if (next.startsWith(prev)) {
    return { content: next, appended: next.slice(prev.length) };
  }
  if (prev.endsWith(next)) {
    return { content: prev, appended: '' };
  }

  const maxOverlap = Math.min(prev.length, next.length);
  let overlap = 0;
  for (let i = maxOverlap; i >= 1; i--) {
    if (prev.slice(-i) === next.slice(0, i)) {
      overlap = i;
      break;
    }
  }
  if (overlap > 0) {
    const appended = next.slice(overlap);
    return { content: prev + appended, appended };
  }

  return { content: prev + next, appended: next };
};

export const isLikelyDuplicateError = (left?: string, right?: string): boolean => {
  const leftText = normalizeErrorMessage(left);
  const rightText = normalizeErrorMessage(right);
  if (!leftText || !rightText) return false;
  return leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText);
};

export const isCompletionLogMessage = (message?: string): boolean => {
  const normalized = (message || '').trim();
  if (!normalized) return false;
  if (/^\[WRITE_CARD\]\s/i.test(normalized)) return true;
  return /^task complete\b/i.test(normalized) || /^✓\s*run completed\b/i.test(normalized) || /^run completed\b/i.test(normalized);
};

export function normalizeToolArgsForUi(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}


export function compactUiText(value: unknown, max = 72): string {
  const raw = typeof value === 'string' ? value : '';
  const text = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function pickToolArgText(args: Record<string, any> | undefined, keys: string[], max = 72): string {
  if (!args || typeof args !== 'object') return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return compactUiText(value, max);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

export function compactUiUrl(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const path = (u.pathname || '').replace(/\/+$/, '');
    const text = path && path !== '/' ? `${u.host}${path}` : u.host;
    return compactUiText(text, 72);
  } catch {
    return compactUiText(raw.replace(/^https?:\/\//, ''), 72);
  }
}

export function formatBrowserToolCallDetail(toolName: string, args: Record<string, any> | undefined): string | undefined {
  if (!/^browser[_-]/i.test(toolName || '')) return undefined;
  const action = toolName.replace(/^browser[_-]/i, '').toLowerCase();
  const target = pickToolArgText(args, [
    'name', 'label', 'placeholder', 'selector', 'locator', 'target', 'textSelector',
    'ariaLabel', 'roleName', 'alt', 'title', 'text',
  ], 64);
  const value = pickToolArgText(args, ['value', 'input', 'content', 'text', 'keys'], 72);
  const url = pickToolArgText(args, ['url', 'href'], 120);

  if (/^(type|fill|keyboard_type|press_keys|input)$/.test(action)) {
    if (value && target && value !== target) return `输入「${value}」到「${target}」`;
    if (value) return `输入「${value}」`;
    if (target) return `输入到「${target}」`;
  }
  if (/^(click|double_click|hover|check|uncheck|select)$/.test(action)) {
    if (target) return `点击「${target}」`;
  }
  if (/^(navigate|goto|open|open_url)$/.test(action)) {
    if (url) return `打开「${compactUiUrl(url)}」`;
  }
  if (/screenshot/.test(action)) return '截图';
  if (/aria|tree/.test(action)) return '读取页面结构';
  if (/eval|script/.test(action)) return '执行页面脚本';
  return target || (url ? `打开「${compactUiUrl(url)}」` : undefined);
}
