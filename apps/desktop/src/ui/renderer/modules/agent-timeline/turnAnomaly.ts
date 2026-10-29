
import type { TimelineEntry } from '../../utils/workspaceUtils';

/** 用户主动停止时落的那条「已停止」notice 的 id 前缀 (useStreamHandler 里生成)。 */
export const INTERRUPTED_NOTICE_ID_PREFIX = 'timeline-interrupted-';

/**
 * 这条 entry 是不是"异常态" —— 全端唯一判据。
 *   · runner_error  —— 这一轮没跑成 / 超时 / 空响应 / 没收到回复, 全是兜底产出的卡;
 *   · 「已停止」notice —— 用户按停止后补的那条 log。
 */
export function isAnomalyEntry(entry: TimelineEntry | null | undefined): boolean {
  if (!entry) return false;
  if (entry.type === 'runner_error') return true;
  if ((entry as { reconnectAttempt?: number }).reconnectAttempt !== undefined) return true;
  return entry.type === 'log' && String(entry.id ?? '').startsWith(INTERRUPTED_NOTICE_ID_PREFIX);
}

/** 这条异常是不是"传输层正在自己重连" —— 异常区要用转圈 + (n/m) 的样子渲染。 */
export function isReconnectEntry(entry: TimelineEntry | null | undefined): boolean {
  return !!entry && (entry as { reconnectAttempt?: number }).reconnectAttempt !== undefined;
}

/**
 * 当前这一轮的异常态 —— 最后一条用户消息之后的那些, 按时间线原序, 不合并不去重。
 *
 * 为什么只取最后一轮: 异常区回答的是"现在还有什么没好", 上一轮的错误跟现在无关
 * (而且那一轮的错误卡在跑成时就已经被 settleTurnErrorEntries 删掉了)。
 * 找不到用户消息锚点 (极早期 / 历史回放) 就扫全量 —— 那种情况整条 timeline 约等于本轮。
 */
function isToolFailureEntry(entry: TimelineEntry): boolean {
  if (entry?.type !== 'tool_error') return false;
  if ((entry as { interrupted?: boolean }).interrupted === true) return false;
  if ((entry as { blockedBy?: string }).blockedBy) return false;
  const text = `${entry.errorMessage ?? ''}\n${entry.detail ?? ''}\n${entry.output ?? ''}`;
  /* 这两类在界面上已经被降级成中性了, 不该再去异常区喊一遍 */
  if (/is not available \(it may not exist|deferred\/mode-restricted|call tool_search once|is not in the current toolset/i.test(text)) return false;
  if (/"type"\s*:\s*"ephemeral"[^}]*"final"\s*:\s*false|"final"\s*:\s*false[^}]*"type"\s*:\s*"ephemeral"/.test(text)) return false;
  if (isReadonlyProbeMiss(entry)) return false;
  if (isToolGuidanceEntry(entry)) return false;
  return true;
}

export function isToolGuidanceEntry(entry: TimelineEntry | null | undefined): boolean {
  if (!entry) return false;
  if (entry.type !== 'tool_error' && entry.type !== 'runner_error') return false;
  if ((entry as { toolGuidance?: boolean }).toolGuidance === true) return true;
  const e = entry as { errorMessage?: string; detail?: string; output?: string };
  for (const raw of [e.errorMessage, e.detail, e.output]) {
    if (hasToolGuidanceFlag(raw)) return true;
  }
  return false;
}

/** 原始 JSON 字符串形态的"不是故障"标记 (完整或被截成前缀的)。
 *  顶层字段未转义, 所以 `"guidance":true` 只会命中顶层那一个, 不会命中 verify_hint 里被转义的文字。 */
const GUIDANCE_FLAG_RE = /"(?:guidance|precondition)"\s*:\s*true\b/;

export function hasToolGuidanceFlag(raw: unknown): boolean {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as { guidance?: unknown; precondition?: unknown };
    return o.guidance === true || o.precondition === true;
  }
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  if (!t.startsWith('{')) return false;
  try {
    const o = JSON.parse(t) as { guidance?: unknown; precondition?: unknown };
    /* 只认布尔真 —— 上游随手塞的 "true" 字符串不该有静音故障的权力 */
    return !!o && typeof o === 'object' && (o.guidance === true || o.precondition === true);
  } catch {
    /* 被截断过: 标记排在回执最前面 (createEphemeralResult), 前缀里认 */
    return GUIDANCE_FLAG_RE.test(t);
  }
}

/** 只读探查类工具 —— 找不到东西是它们的正常结果之一, 不是故障。 */
const READONLY_PROBE_TOOLS = /^(search|grep|glob|find|search_files|list_directory|list_dir|list_files|ls|read_file|readfile|read|stat|file_info|file_stat|show_tree|smart_tree|tree|head|tail)$/i;
const NOT_FOUND_TEXT = /ENOENT|ENOTDIR|no such file or directory|not found|does not exist|no matches|未找到|没有找到|不存在/i;

export function isReadonlyProbeMiss(entry: TimelineEntry | null | undefined): boolean {
  if (!entry) return false;
  if (!READONLY_PROBE_TOOLS.test(String((entry as { toolName?: string }).toolName ?? ''))) return false;
  const e = entry as { errorMessage?: string; detail?: string; output?: string };
  return NOT_FOUND_TEXT.test(`${e.errorMessage ?? ''}\n${e.detail ?? ''}\n${e.output ?? ''}`);
}

export function pickCurrentTurnAnomalies(entries: readonly TimelineEntry[]): TimelineEntry[] {
  if (!entries || entries.length === 0) return [];
  let anchor = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === 'user_message') { anchor = i; break; }
  }
  const scope = anchor >= 0 ? entries.slice(anchor + 1) : entries;
  return scope.filter((e, i) => (isAnomalyEntry(e) && !isSettledReconnect(e)) || (isToolFailureEntry(e) && !agentMovedOnAfter(scope, i)));
}

function isSettledReconnect(entry: TimelineEntry): boolean {
  return isReconnectEntry(entry) && entry.pending !== true && entry.level !== 'error';
}

function agentMovedOnAfter(scope: readonly TimelineEntry[], index: number): boolean {
  for (let j = index + 1; j < scope.length; j++) {
    const e = scope[j];
    if (!e || isAnomalyEntry(e)) continue;
    if (e.type === 'tool_error' || e.type === 'log' || e.type === 'thinking') continue;
    return true;
  }
  return false;
}
