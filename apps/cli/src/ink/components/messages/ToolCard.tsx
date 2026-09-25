import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import { trimEmptyEdgeLines } from './lineUtils.js';
import { compactLabel } from '../../utils/compactProgress.js';
import { describeTool } from '../../utils/describeTool.js';
import { NeoxTheme } from '../../theme.js';
import { Step, StepResult, ToolTitle, moreLines, sanitizeOutputLine } from './step.js';
import { getDisplayWidth } from '../../../i18n/index.js';
import { GradientBar, splitBatteryText } from '../../brand/GradientBar.js';

// Tool card type definitions
type ToolType =
  | 'tool_call' | 'tool_result' | 'tool_error'
  | 'file_update' | 'command_exec' | 'command_running'
  | 'code_exec' | 'web_search' | 'web_fetch'
  | 'readfile' | 'search' | 'search_files' | 'show_tree'
  | 'mcp_tool' | 'use_skill' | 'compacting'
  | 'todo' | 'task' | 'ask_user'
  // Cron scheduling
  | 'cron_create' | 'cron_delete' | 'cron_list'
  // Task management
  | 'task_create' | 'task_update' | 'task_list' | 'task_get' | 'task_stop'
  // Plan mode
  | 'plan_enter' | 'plan_exit'
  // Worktree
  | 'worktree_enter' | 'worktree_exit'
  // Network
  | 'network_analysis' | 'network_mode_select'
  | 'network_bidding' | 'network_negotiation'
  | 'network_dag' | 'network_node_start'
  | 'network_node_complete' | 'network_node_fail'
  | 'network_replan' | 'network_peer_review'
  | 'network_progress' | 'ccb_review'
  | 'git_status' | 'git_diff' | 'git_log' | 'git_commit' | 'git_running'
  | 'ptc_running' | 'ptc_complete' | 'ptc_error'
  | 'memory_read' | 'memory_write' | 'memory_running'
  // Bash session 管理 + agent 自主 pacing + 上下文预算相关工具类型
  | 'bash_output' | 'bash_kill' | 'schedule_wakeup' | 'context_status';

interface ToolStyle { icon: string; color: string; prefix: string; }

const TOOL_STYLES: Record<ToolType, ToolStyle> = {
  'tool_call': { icon: '●', color: 'yellow', prefix: 'Tool' },
  'tool_result': { icon: '✓', color: 'green', prefix: 'Result' },
  'tool_error': { icon: '✗', color: 'red', prefix: 'Error' },
  'file_update': { icon: '●', color: 'blue', prefix: 'Edit' },
  'command_exec': { icon: '●', color: 'yellow', prefix: 'Shell' },
  'command_running': { icon: '●', color: 'cyan', prefix: 'Shell' },
  'code_exec': { icon: '●', color: 'yellow', prefix: 'Code' },
  'web_search': { icon: '●', color: 'cyan', prefix: 'Search' },
  'web_fetch': { icon: '●', color: 'cyan', prefix: 'Fetch' },
  'readfile': { icon: '●', color: 'cyan', prefix: 'Read' },
  'search': { icon: '●', color: 'cyan', prefix: 'Grep' },
  'search_files': { icon: '●', color: 'cyan', prefix: 'Glob' },
  'show_tree': { icon: '●', color: 'cyan', prefix: 'Tree' },
  'mcp_tool': { icon: '●', color: 'magenta', prefix: 'MCP' },
  'use_skill': { icon: '●', color: 'magenta', prefix: 'Skill' },
  'compacting': { icon: '●', color: 'magenta', prefix: 'Compact' }, // prefix 运行时被 compactLabel() 覆盖
  'todo': { icon: '●', color: 'magenta', prefix: 'Todo' },
  'task': { icon: '●', color: 'yellow', prefix: 'Task' },
  'ask_user': { icon: '●', color: 'green', prefix: 'Ask' },
  'network_analysis': { icon: '●', color: 'cyan', prefix: 'Analysis' },
  'network_mode_select': { icon: '●', color: 'blue', prefix: 'Mode' },
  'network_bidding': { icon: '●', color: 'yellow', prefix: 'Bidding' },
  'network_negotiation': { icon: '●', color: 'magenta', prefix: 'Negotiate' },
  'network_dag': { icon: '●', color: 'blue', prefix: 'DAG' },
  'network_node_start': { icon: '●', color: 'blue', prefix: 'Node' },
  'network_node_complete': { icon: '✓', color: 'green', prefix: 'Node' },
  'network_node_fail': { icon: '✗', color: 'red', prefix: 'Node' },
  'network_replan': { icon: '●', color: 'yellow', prefix: 'Replan' },
  'network_peer_review': { icon: '●', color: 'magenta', prefix: 'Review' },
  'network_progress': { icon: '●', color: 'blue', prefix: 'Progress' },
  'ccb_review': { icon: '●', color: 'cyan', prefix: 'CCB' },
  'git_status': { icon: '●', color: 'green', prefix: 'Git Status' },
  'git_diff': { icon: '●', color: 'yellow', prefix: 'Git Diff' },
  'git_log': { icon: '●', color: 'cyan', prefix: 'Git Log' },
  'git_commit': { icon: '●', color: 'green', prefix: 'Git Commit' },
  'git_running': { icon: '●', color: 'cyan', prefix: 'Git' },
  'ptc_running': { icon: '✦', color: 'magenta', prefix: 'PTC' },
  'ptc_complete': { icon: '✓', color: 'green', prefix: 'PTC' },
  'ptc_error': { icon: '✗', color: 'red', prefix: 'PTC' },
  'memory_read': { icon: '●', color: 'cyan', prefix: 'Memory' },
  'memory_write': { icon: '●', color: 'green', prefix: 'Memory' },
  'memory_running': { icon: '●', color: 'cyan', prefix: 'Memory' },
  /* Use the shared neutral symbol set and tool-family colors for consistent
   * status semantics across terminal cards. */
  'bash_output': { icon: '●', color: 'cyan', prefix: 'BashOut' },
  'bash_kill': { icon: '✗', color: 'red', prefix: 'BashKill' },
  'schedule_wakeup': { icon: '✦', color: 'magenta', prefix: 'Wakeup' },
  'context_status': { icon: '●', color: 'blue', prefix: 'Context' },
  // Cron scheduling
  'cron_create': { icon: '✦', color: 'magenta', prefix: 'Cron' },
  'cron_delete': { icon: '✗', color: 'red', prefix: 'Cron' },
  'cron_list': { icon: '●', color: 'cyan', prefix: 'Cron' },
  // Task management
  'task_create': { icon: '▣', color: 'blue', prefix: 'Task' },
  'task_update': { icon: '✓', color: 'green', prefix: 'Task' },
  'task_list': { icon: '●', color: 'cyan', prefix: 'Tasks' },
  'task_get': { icon: '●', color: 'cyan', prefix: 'Task' },
  'task_stop': { icon: '✗', color: 'red', prefix: 'Task' },
  // Plan mode
  'plan_enter': { icon: '✦', color: 'yellow', prefix: 'Plan' },
  'plan_exit': { icon: '▶', color: 'green', prefix: 'Plan' },
  // Worktree
  'worktree_enter': { icon: '●', color: 'blue', prefix: 'Worktree' },
  'worktree_exit': { icon: '✓', color: 'green', prefix: 'Worktree' },
};

export interface ToolCardProps {
  type: ToolType | string;
  message: string;
  details?: string;
  timestamp?: Date;
  isStreaming?: boolean;
  isComplete?: boolean;
  sourceLabel?: string;
  memoryAction?: string;
  memorySearchQuery?: string;
}

// ── Diff helpers (Claude Code style) ──

interface ParsedDiffLine {
  type: 'header' | 'add' | 'remove' | 'context' | 'unknown';
  lineNum: number;
  content: string;
}

/**
 * 解析 unified diff 行的类型、行号和内容
 * 格式：type:lineNum:content
 */
function parseDiffLine(line: string): ParsedDiffLine {
  // 新格式: type:lineNum:content
  const m = line.match(/^([HCR+\-]):(\d+):(.*)$/s);
  if (m) {
    const typeMap: Record<string, ParsedDiffLine['type']> = {
      'H': 'header', '+': 'add', '-': 'remove', 'C': 'context',
    };
    return { type: typeMap[m[1]] || 'unknown', lineNum: parseInt(m[2], 10), content: m[3] };
  }
  // 兼容旧格式 type:content (无行号)
  if (line.startsWith('H:')) return { type: 'header', lineNum: 0, content: line.slice(2) };
  if (line.startsWith('+:')) return { type: 'add', lineNum: 0, content: line.slice(2) };
  if (line.startsWith('-:')) return { type: 'remove', lineNum: 0, content: line.slice(2) };
  if (line.startsWith('C:')) return { type: 'context', lineNum: 0, content: line.slice(2) };
  return { type: 'unknown', lineNum: 0, content: line };
}

function countDiffChanges(lines: string[], message?: string): { added: number; removed: number } {
  // 1) 权威数字在 message 里: "Edited path (new file) +209 -0"
  if (message) {
    const fromMsg = message.match(/\+(\d+)\s+-(\d+)\b/);
    if (fromMsg) {
      return { added: parseInt(fromMsg[1], 10), removed: parseInt(fromMsg[2], 10) };
    }
  }
  // 2) hunk 头: "H:0:@@ +1,209 @@" / "H:0:@@ -10,3 +10,12 @@"
  //    startWriteFile 预览只塞 15 行 +: , 但 @@ 里带真实总行数 — 不能用预览行数当 Added
  for (const l of lines) {
    const body = l.replace(/^H:\d+:/, '');
    const hunk = body.match(/^@@\s+(?:-(\d+)(?:,(\d+))?\s+)?\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunk) {
      const removed = hunk[1] != null ? (hunk[2] != null ? parseInt(hunk[2], 10) : 1) : 0;
      const added = hunk[4] != null ? parseInt(hunk[4], 10) : 1;
      return { added, removed };
    }
  }
  // 3) 兜底: 数预览里的 +/- 行 (截断预览时会偏小)
  let added = 0, removed = 0;
  for (const l of lines) {
    if (/^\+:\d+:/.test(l) || l.startsWith('+:')) added++;
    else if (/^-:\d+:/.test(l) || l.startsWith('-:')) removed++;
  }
  return { added, removed };
}

function extractJsonBlock(lines: string[]): string | null {
  let started = false, depth = 0, inStr = false, esc = false;
  const buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!started) { if (!t || !(t.startsWith('{') || t.startsWith('['))) continue; started = true; }
    buf.push(line);
    for (const ch of line) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;
    }
    if (started && depth === 0) return buf.join('\n');
  }
  return null;
}

// ── Param extraction ──

function parseParams(detailLines: string[]): Record<string, any> | null {
  if (!detailLines.length) return null;
  try {
    const idx = detailLines.findIndex(l => l === 'args:');
    if (idx >= 0 && idx < detailLines.length - 1) {
      const rest = detailLines.slice(idx + 1);
      const jb = extractJsonBlock(rest);
      if (jb) return JSON.parse(jb);
      return JSON.parse(rest.join('\n'));
    }
    const full = detailLines.join('\n');
    if (full.startsWith('{')) return JSON.parse(full);
  } catch {}
  return null;
}

/** Build a single-line summary for the tool call */
function buildSummary(type: string, message: string, params: Record<string, any> | null): string {
  // Read: show file path
  if (type === 'readfile' && params) {
    const p = params.file_path || params.path || '';
    const parts: string[] = [];
    if (params.offset !== undefined) parts.push(`L${params.offset}`);
    if (params.limit !== undefined) parts.push(`${params.limit} lines`);
    return parts.length ? `${p} (${parts.join(', ')})` : p;
  }
  // Grep/Glob: show pattern
  if (type === 'search' && params) {
    const pat = params.pattern || '';
    const path = params.path || '';
    return path ? `"${pat}" in ${path}` : `"${pat}"`;
  }
  if (type === 'search_files' && params) {
    const pat = params.pattern || params.glob || '';
    const path = params.path || '';
    return path ? `${pat} in ${path}` : pat;
  }
  // Edit: show file path
  if (type === 'file_update') {
    const m = message.match(/^(?:Editing|Writing|Creating|Updating|Updated)\s+(.+)$/i);
    return m ? m[1] : message;
  }
  // Web fetch: show URL + method
  if (type === 'web_fetch' && params) {
    const url = params.url || '';
    const method = params.method || 'GET';
    return method !== 'GET' ? `${method} ${url}` : url;
  }
  // Web search: show query
  if (type === 'web_search' && params) {
    return params.query || params.q || message;
  }
  // Show tree / list directory: show path
  if (type === 'show_tree' && params) {
    return params.path || params.directory || message;
  }
  // Git tools
  if (type === 'git_status') return 'status';
  if (type === 'git_diff' && params) return params.file || params.path || 'diff';
  if (type === 'git_log' && params) return params.file || `${params.count || 10} commits`;
  if (type === 'git_commit' && params) return params.message || message;
  // Generic: try to extract a meaningful primary value
  if (params) {
    // Common param names that represent the "target"
    const primaryKeys = ['path', 'file_path', 'directory', 'file', 'name', 'command', 'query', 'url', 'pattern'];
    for (const k of primaryKeys) {
      if (params[k] && typeof params[k] === 'string') {
        const v = params[k] as string;
        return v.length > 100 ? v.slice(0, 97) + '…' : v;
      }
    }
  }
  return message;
}

/** Format params as human-readable key-value lines for the second row */
function formatParamLines(params: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const display = s.length > 80 ? s.slice(0, 77) + '…' : s;
    lines.push(`${k}: ${display}`);
  }
  return lines;
}

// ── Shell helpers ──

function parseShellMsg(msg: string): { command: string; exitCode?: number; timeout?: string } {
  const m = msg.match(/^\$\s*([\s\S]+?)(?:\s+\(((?:timeout=|exit=|bg)[^()]*)\))?$/);
  if (m) {
    const meta = m[2] || '';
    const exitM = meta.match(/exit=(\d+)/);
    // 提取 timeout 并格式化为人类可读
    const timeoutM = meta.match(/timeout=(\d+)s/);
    let timeout: string | undefined;
    if (timeoutM) {
      const secs = parseInt(timeoutM[1], 10);
      if (secs >= 60) timeout = `${Math.floor(secs / 60)}m`;
      else timeout = `${secs}s`;
    }
    return { command: m[1].trim(), exitCode: exitM ? parseInt(exitM[1], 10) : undefined, timeout };
  }
  return { command: msg.replace(/^\$\s*/, ''), exitCode: undefined };
}

// ── Main component ──

export const ToolCard: React.FC<ToolCardProps> = ({
  type, message, details, timestamp, isStreaming = false, isComplete = false, sourceLabel, memoryAction, memorySearchQuery,
}) => {
  const style = TOOL_STYLES[type as ToolType] || TOOL_STYLES['tool_call'];
  const prefix = type === 'compacting' ? compactLabel() : style.prefix;
  const detailLines = details ? trimEmptyEdgeLines(details.split('\n')) : [];
  const params = parseParams(detailLines);
  const isFileUpdate = type === 'file_update';
  const isShell = type === 'command_exec' || type === 'command_running';
  const isShellRunning = type === 'command_running';

  // ── Shell rendering — Claude Code 风格树枝结构 ──
  if (isShell) {
    const info = parseShellMsg(message);
    const isError = !!info.exitCode;
    const allLines = details ? details.split('\n') : [];

    // 解析输出：过滤掉工具格式化噪音（━━━, ▸ 工作目录 等），提取 stdout/stderr 核心内容
    let stdoutLines: string[] = [];
    let stderrLines: string[] = [];
    let section: 'none' | 'stdout' | 'stderr' = 'none';
    for (const line of allLines) {
      const t = line.trim();
      // 跳过分隔线和工具格式化行
      if (/^[━─═]{3,}/.test(t)) continue;
      if (/^[▸▹►]/.test(t)) continue;
      if (/^[✓!✗]\s*(执行成功|执行完成|执行失败)/.test(t)) continue;
      if (/^\(无输出\)/.test(t)) continue;

      // 检测 section 标记
      if (/^◦?\s*(?:标准输出|stdout)\s*[:：(]/i.test(t)) { section = 'stdout'; continue; }
      if (/^◦?\s*(?:错误输出|标准错误|stderr)\s*[:：(]/i.test(t)) { section = 'stderr'; continue; }
      if (/^(?:stderr|STDERR)[:：]/i.test(t)) { section = 'stderr'; continue; }
      if (/^(?:stdout|STDOUT)[:：]/i.test(t)) { section = 'stdout'; continue; }

      if (!t) continue;

      if (section === 'stderr') {
        stderrLines.push(line);
      } else if (section === 'stdout') {
        stdoutLines.push(line);
      } else {
        // 未标记的行 — 按 error 状态分配
        if (isError) stderrLines.push(line);
        else stdoutLines.push(line);
      }
    }

    /* 输出只留头几行: stderr 在前 (出错时最该看的), 截断的给 "+N lines"。
     * 运行中显示最后几行 (进度在尾巴上)。 */
    const MAX_LINES = 6;
    const clip = (l: string) => l;  // 宽度由 StepResult oneLine 按终端宽截, 这里不再按字符数截
    const resultLines: React.ReactNode[] = [];
    if (isShellRunning) {
      const tail = (details || '').split('\n').filter((l: string) => l.trim() && !/^cwd:/.test(l)).slice(-5);
      for (const l of tail) resultLines.push(clip(l));
    } else {
      for (const l of stderrLines.slice(0, MAX_LINES)) {
        resultLines.push(<Text color={NeoxTheme.functional.error} wrap="truncate-end">{sanitizeOutputLine(l)}</Text>);
      }
      const room = Math.max(2, MAX_LINES - Math.min(stderrLines.length, MAX_LINES));
      for (const l of stdoutLines.slice(0, room)) resultLines.push(clip(l));
      const hidden = Math.max(0, stderrLines.length - MAX_LINES) + Math.max(0, stdoutLines.length - room);
      if (hidden > 0) resultLines.push(moreLines(hidden));
      /* 转后台的命令: 卡片提交时只有一句 "Running... 0s" 定格在那儿, 像卡死了 —— 说清楚它去哪了 */
      const onlyProgress = resultLines.length > 0 && resultLines.every(l => typeof l === 'string' && /^Running\.\.\.\s*\d/.test(l));
      if (/\(.*\bbg\b.*\)\s*$/.test(message) || onlyProgress) {
        resultLines.length = 0;
        resultLines.push(<Text color={NeoxTheme.text.dim}>在后台运行 · 底栏 tab 查看</Text>);
      }
      if (resultLines.length === 0) resultLines.push('(no output)');
    }

    /* run_tests / run_lint / run_format 也走这张卡, 但它们的 "命令" 是一句摘要 ("run_tests succeeded (354ms)"),
     * 原来画成 "Bash(run_tests succeeded (354ms)) ⎿ run_tests succeeded (354ms)" —— 动词错、同一句说两遍。 */
    const structured = /^\$?\s*run_(tests|lint|format|build|typecheck)\s+(succeeded|failed)\b(.*)$/i.exec((info.command || message || '').trim());
    if (structured && !isShellRunning) {
      const verb = { tests: 'Test', lint: 'Lint', format: 'Format', build: 'Build', typecheck: 'Typecheck' }[structured[1]!.toLowerCase()] ?? 'Run';
      const ok = structured[2]!.toLowerCase() === 'succeeded';
      const outcome = `${ok ? 'passed' : 'failed'}${structured[3]!.trim() ? ' ' + structured[3]!.trim() : ''}`;
      const extra = resultLines.filter(l => !(typeof l === 'string' && /^run_\w+\s+(succeeded|failed)/i.test(l)));
      return (
        <Step tone={ok ? 'success' : 'error'} title={<ToolTitle verb={verb} />}>
          <StepResult lines={[outcome, ...extra.slice(0, 5)]} oneLine color={ok ? undefined : NeoxTheme.functional.error} />
        </Step>
      );
    }
    const rawCmd = info.command || '';
    const cmdLines = rawCmd.split('\n').filter(l => l.trim());
    const cmdText = cmdLines.length > 1 ? `${cmdLines[0]!.trim()} …` : rawCmd.trim();
    const cmdInline = true;
    const suffix = (
      <>
        {info.exitCode ? <Text color={NeoxTheme.functional.error}>{`  exit ${info.exitCode}`}</Text> : null}
        {info.timeout ? <Text color={NeoxTheme.text.dim}>{`  timeout ${info.timeout}`}</Text> : null}
      </>
    );
    return (
      <Step
        tone={isShellRunning ? 'running' : isError ? 'error' : 'success'}
        title={<ToolTitle verb="Bash" target={cmdInline ? cmdText : undefined} suffix={suffix} />}
      >
        {!cmdInline ? <Box marginLeft={3}><Text color={NeoxTheme.text.secondary} wrap="wrap">{cmdText}</Text></Box> : null}
        <StepResult lines={resultLines} oneLine />
      </Step>
    );
  }

  // ── PTC rendering ──
  const isPTC = type === 'ptc_running' || type === 'ptc_complete' || type === 'ptc_error';
  if (isPTC) {
    // 解析 meta: [PTC: 4 tool calls, 33ms]
    const metaMatch = message.match(/^\[PTC(?:\s*Error)?:\s*(\d+)\s*(?:tool\s*)?calls?,\s*(\d+)ms\]/);
    const toolCallsCount = metaMatch ? metaMatch[1] : '?';
    const duration = metaMatch ? metaMatch[2] : '?';
    const isPTCRunning = type === 'ptc_running';
    const isPTCError = type === 'ptc_error';

    // 从 details 中分离工具调用行和输出行
    const allLines = (details || message.replace(/^\[PTC.*?\]\n?/, '')).split('\n');
    const toolCallLines: { name: string; ms: string }[] = [];
    const outputLines: string[] = [];
    for (const line of allLines) {
      const tcMatch = line.match(/^\s{2}(\S+)\s+\((\d+)ms\)$/);
      if (tcMatch) {
        toolCallLines.push({ name: tcMatch[1], ms: tcMatch[2] });
      } else if (line.trim()) {
        outputLines.push(line);
      }
    }

    // 工具全名映射
    const toolFullName = (name: string): string => {
      const map: Record<string, string> = {
        readfile: 'Read File', read: 'Read File', smart_read: 'Smart Read',
        search: 'Grep', search_files: 'Glob', search_symbol: 'Search Symbol',
        write_file: 'Write File', edit_file: 'Edit File',
        execute_command: 'Shell', list_directory: 'List Dir',
        show_tree: 'Tree', smart_tree: 'Smart Tree',
        web_search: 'Web Search', web_fetch: 'Web Fetch',
        deep_research: 'Deep Research',
        git_status: 'Git Status', git_diff: 'Git Diff',
        git_log: 'Git Log', git_commit: 'Git Commit',
        git_blame: 'Git Blame', git_branch_list: 'Git Branch',
        analyze_code: 'Analyze Code', get_definitions: 'Definitions',
        get_references: 'References',
      };
      return map[name] || name;
    };

    const maxOutput = 6;
    const displayOutput = outputLines.slice(0, maxOutput);
    const moreCount = outputLines.length - maxOutput;

    const lines: React.ReactNode[] = [
      ...toolCallLines.map(tc => (
        <Text><Text color={NeoxTheme.text.secondary}>{toolFullName(tc.name)}</Text><Text color={NeoxTheme.text.dim}>{` · ${tc.ms}ms`}</Text></Text>
      )),
      ...displayOutput,
      ...(moreCount > 0 ? [moreLines(moreCount)] : []),
    ];
    return (
      <Step
        tone={isPTCRunning ? 'running' : isPTCError ? 'error' : 'success'}
        title={<ToolTitle verb="Script" target={`${toolCallsCount} calls · ${duration}ms`} suffix={sourceLabel ? <Text color={NeoxTheme.text.dim}>{`  ${sourceLabel}`}</Text> : null} />}
      >
        <StepResult lines={lines} oneLine />
      </Step>
    );
  }

  // ── Memory rendering ──
  const isMemory = type === 'memory_read' || type === 'memory_write' || type === 'memory_running';
  if (isMemory) {
    const raw = details || '';
    const action = memoryAction || '';
    const isUpdateProject = action === 'update_project';
    const isSearch = action === 'search';
    const isRead = action === 'read' || type === 'memory_read';
    const isWrite = action === 'write';

    // 解析分区：名称、条数、第一条摘要
    const parseSections = (text: string) => {
      const lines = text.split('\n');
      const secs: { name: string; count: number; preview: string }[] = [];
      let curIdx = -1;
      for (const line of lines) {
        const t = line.trim();
        const secMatch = t.match(/^(?:#{2,3}\s+|📄\s*|📌\s*|📊\s*|📏\s*|💡\s*|📦\s*)(.+)/);
        if (secMatch) {
          secs.push({ name: secMatch[1].replace(/\s*\(.*\)$/, '').trim(), count: 0, preview: '' });
          curIdx = secs.length - 1;
        } else if (curIdx >= 0 && t && /^\d+\.\s|^-\s/.test(t)) {
          secs[curIdx].count++;
          if (!secs[curIdx].preview) {
            secs[curIdx].preview = t.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/\[.*?\]\s*$/, '').trim();
          }
        }
      }
      return secs;
    };

    // search: header 行合并显示搜索条件 + 匹配数
    let headerExtra: React.ReactNode = null;
    const memoryLines: { left: string; right?: string }[] = [];

    if (raw && (isRead || isSearch)) {
      const sections = parseSections(raw);
      if (isSearch) {
        const total = sections.reduce((s, sec) => s + sec.count, 0);
        const q = memorySearchQuery ? `"${memorySearchQuery}"` : '';
        headerExtra = (
          <>
            {q && <Text color={NeoxTheme.text.secondary}> {q}</Text>}
            <Text color={NeoxTheme.text.dim}> · {total} 条匹配</Text>
          </>
        );
      }
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const isLast = i === sections.length - 1;
        const branch = isLast ? '└─' : '├─';
        const countStr = sec.count > 0 ? ` (${sec.count})` : '';
        const preview = sec.preview ? sec.preview.slice(0, 50) : '';
        memoryLines.push({ left: `${branch} ${sec.name}${countStr}`, right: preview });
      }
      if (sections.length === 0 && raw.trim()) {
        const useful = raw.split('\n').filter(l => l.trim()).slice(0, 2);
        for (const l of useful) {
          memoryLines.push({ left: l.trim().slice(0, 100) });
        }
      }
    } else if (raw && isUpdateProject) {
      const pathMatch = raw.match(/(\S+\.md)/);
      const filePath = pathMatch ? pathMatch[1] : 'project.md';
      const secs = parseSections(raw);
      headerExtra = <Text color={NeoxTheme.text.secondary}> {filePath}</Text>;
      for (let i = 0; i < secs.length; i++) {
        const s = secs[i];
        const isLast = i === secs.length - 1;
        const branch = isLast ? '└─' : '├─';
        const countStr = s.count > 0 ? ` (${s.count})` : '';
        const preview = s.preview ? s.preview.slice(0, 50) : '';
        memoryLines.push({ left: `${branch} ${s.name}${countStr}`, right: preview });
      }
    } else if (raw && isWrite) {
      const firstLine = raw.split('\n').find(l => l.trim() && !l.startsWith('#'));
      if (firstLine) {
        memoryLines.push({ left: firstLine.trim().slice(0, 100) });
      }
    }

    return (
      <Step
        tone={isStreaming ? 'running' : 'success'}
        title={
          <Text wrap="wrap">
            <Text bold>{message}</Text>
            {headerExtra}
            {sourceLabel ? <Text color={NeoxTheme.text.dim}>{`  ${sourceLabel}`}</Text> : null}
          </Text>
        }
      >
        <StepResult lines={memoryLines.map(line => (
          <Text wrap="truncate-end">
            <Text color={NeoxTheme.text.secondary}>{line.left.replace(/^[├└]─\s*/, '')}</Text>
            {line.right ? <Text color={NeoxTheme.text.dim}>{`  ${line.right}`}</Text> : null}
          </Text>
        ))} />
      </Step>
    );
  }

  // ── File update (diff) rendering — Claude Code 风格 ──
  if (isFileUpdate) {
    const { added, removed } = countDiffChanges(detailLines, message);
    const editMatch = message.match(/^Edited\s+(.+?)(?:\s+@(\d+))?\s+/);
    const filePath = editMatch ? editMatch[1] : buildSummary(type, message, params);

    // 过滤掉噪音 header (---/+++/@@), 但保留 "... (N more lines)" 截断提示
    const parsedLines = detailLines
      .map(parseDiffLine)
      .filter(dl => {
        if (dl.type !== 'header') return true;
        return /\(\d+\s+more lines?\)/i.test(dl.content) || /^\.\.\./.test(dl.content.trim());
      });

    // 行号宽度
    let maxLn = 0;
    for (const pl of parsedLines) { if (pl.lineNum > maxLn) maxLn = pl.lineNum; }
    const lnW = Math.max(String(maxLn).length, 3);

    /* 标题: Edit(path) / Write(path) —— 新文件叫 Write; 结果第一行是 +N −M (真实总数, 不是预览行数),
     * 下面是带行号的 diff, 超过 MAX_DIFF 行折叠。 */
    const isNewFile = /\(new file\)/i.test(message) || /^(Writing|Creating)\b/i.test(message);
    const MAX_DIFF = 14;
    const diffShown = parsedLines.slice(0, MAX_DIFF);
    const stat = (
      <Text>
        <Text color={NeoxTheme.functional.success}>{`+${added}`}</Text>
        <Text color={NeoxTheme.text.dim}> </Text>
        <Text color={NeoxTheme.functional.error}>{`−${removed}`}</Text>
      </Text>
    );
    const diffLines: React.ReactNode[] = [stat];
    for (const dl of diffShown) {
      if (dl.type === 'header') { diffLines.push(dl.content.trim()); continue; }
      const ln = dl.lineNum > 0 ? String(dl.lineNum).padStart(lnW) : ' '.repeat(lnW);
      const color = dl.type === 'add' ? NeoxTheme.functional.success
        : dl.type === 'remove' ? NeoxTheme.functional.error : NeoxTheme.text.dim;
      const mark = dl.type === 'add' ? '+' : dl.type === 'remove' ? '-' : ' ';
      /* 行号 + 标记是一栏定宽, 代码另一栏 —— 长行折下来对齐到代码列, 不再从行号底下冒出来;
       * 代码里的 tab 展开成空格 (tab 按 0 宽算, 终端却画 8 列, 行会被终端再折一次, 见 sanitizeOutputLine) */
      diffLines.push(
        <Box>
          <Box width={lnW + 3} flexShrink={0}><Text color={color}>{`${ln} ${mark} `}</Text></Box>
          <Box flexGrow={1} flexShrink={1}><Text color={color} wrap="wrap">{sanitizeOutputLine(dl.content)}</Text></Box>
        </Box>,
      );
    }
    if (parsedLines.length > MAX_DIFF) diffLines.push(moreLines(parsedLines.length - MAX_DIFF));

    return (
      <Step
        tone={isStreaming ? 'running' : 'success'}
        title={<ToolTitle verb={isNewFile ? 'Write' : 'Edit'} target={filePath} suffix={sourceLabel ? <Text color={NeoxTheme.text.dim}>{`  ${sourceLabel}`}</Text> : null} />}
      >
        <StepResult lines={diffLines} />
      </Step>
    );
  }

  // ── 压缩: 进行中 = 品牌渐变进度条 + 阶段; 完成 = 一句结果 ──
  if (type === 'compacting') {
    const zh = prefix === '压缩';
    const failed = /fail|失败/i.test(message);
    const done = isComplete && !isStreaming;
    const skipped = done && /无需压缩|未获收益|no\s*compaction|gained\s*nothing|not\s*needed/i.test(message);
    const bar = splitBatteryText(message);
    const title = failed ? (zh ? '上下文压缩失败' : 'Compaction failed')
      : skipped ? (zh ? '上下文没有压缩' : 'Context not compacted')
      : done ? (zh ? '上下文已压缩' : 'Context compacted')
      : (zh ? '正在压缩上下文' : 'Compacting context');
    const lines: React.ReactNode[] = [];
    if (bar) {
      lines.push(
        <Text>
          <GradientBar cells={bar.cells} />
          {bar.rest ? <Text color={NeoxTheme.text.dim}>{'  ' + bar.rest}</Text> : null}
        </Text>,
      );
    } else if (message.trim() && !(done && detailLines.length > 0 && /^(完成|done)$/i.test(message.trim()))) {
      lines.push(message.trim());
    }
    if (done && detailLines.length > 0) {
      lines.push(...detailLines.slice(0, 2).map(l => (l.length > 160 ? l.slice(0, 159) + '…' : l)));
    }
    return (
      <Step tone={failed ? 'error' : done ? 'success' : 'running'} title={<Text bold>{title}</Text>}>
        <StepResult lines={lines} color={failed ? NeoxTheme.functional.error : undefined} />
      </Step>
    );
  }

  // ── Tool error: extract readable message ──
  if (type === 'tool_error') {
    let errorMsg = message;
    // Try to parse JSON error object
    try {
      const parsed = JSON.parse(message);
      errorMsg = parsed.message || parsed._message || parsed.error || message;
    } catch {
      // Try to extract _message: field from flat text
      const msgMatch = message.match(/_message:\s*(.+?)(?:\s+_|$)/);
      if (msgMatch) errorMsg = msgMatch[1].trim();
    }
    return (
      <Step
        tone="error"
        title={
          <Text wrap="wrap" color={NeoxTheme.functional.error}>
            {sourceLabel ? <Text color={NeoxTheme.text.dim}>{`${sourceLabel} · `}</Text> : null}
            {errorMsg}
          </Text>
        }
      />
    );
  }

  // ── Git diff rendering ──
  // details 或 message 可能包含 JSON（{content: "diff --git..."}）或原始 diff 文本
  const gitDiffContent = (() => {
    if (type !== 'git_diff') return null;
    const src = details || message || '';
    // 尝试解析 JSON
    if (src.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(src);
        return parsed.content || parsed.diff || parsed.output || null;
      } catch { /* not JSON */ }
    }
    // 原始 diff 文本
    if (src.includes('diff --git') || src.includes('@@')) return src;
    return null;
  })();

  if (type === 'git_diff' && gitDiffContent) {
    const rawLines = gitDiffContent.split('\n');

    // 解析 diff：提取文件名和 hunk 内容（跳过所有噪音行）
    type DiffFile = { path: string; lines: { type: 'add' | 'remove' | 'context'; num: number; content: string }[] };
    const files: DiffFile[] = [];
    let cur: DiffFile | null = null;
    let ln = 0;

    for (const raw of rawLines) {
      if (raw.startsWith('diff --git')) {
        const m = raw.match(/b\/(.+)$/);
        cur = { path: m ? m[1] : raw, lines: [] };
        files.push(cur);
        continue;
      }
      if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
      if (raw.startsWith('@@')) {
        const m = raw.match(/\+(\d+)/);
        ln = m ? parseInt(m[1], 10) : 1;
        continue; // 不显示 @@ 行
      }
      if (!cur) continue;
      if (raw.startsWith('+')) {
        cur.lines.push({ type: 'add', num: ln++, content: raw.slice(1) });
      } else if (raw.startsWith('-')) {
        cur.lines.push({ type: 'remove', num: ln, content: raw.slice(1) });
      } else {
        cur.lines.push({ type: 'context', num: ln++, content: raw.slice(1) || raw });
      }
    }

    if (files.length > 0) {
      let totalAdd = 0, totalRm = 0;
      for (const f of files) for (const l of f.lines) {
        if (l.type === 'add') totalAdd++;
        else if (l.type === 'remove') totalRm++;
      }

      const MAX_DIFF = 14;
      return (
        <Box flexDirection="column">
          {files.map((file, fi) => {
            const maxLn = Math.max(...file.lines.map(l => l.num), 0);
            const lnW = Math.max(String(maxLn).length, 3);
            let fAdd = 0, fRm = 0;
            for (const l of file.lines) { if (l.type === 'add') fAdd++; else if (l.type === 'remove') fRm++; }
            const lines: React.ReactNode[] = [
              <Text>
                <Text color={NeoxTheme.functional.success}>{`+${fAdd}`}</Text>
                <Text> </Text>
                <Text color={NeoxTheme.functional.error}>{`−${fRm}`}</Text>
              </Text>,
            ];
            for (const dl of file.lines.slice(0, MAX_DIFF)) {
              const lnStr = dl.num > 0 ? String(dl.num).padStart(lnW) : ' '.repeat(lnW);
              if (dl.type === 'add') lines.push(<Text color={NeoxTheme.functional.success} wrap="wrap">{`${lnStr} + ${dl.content}`}</Text>);
              else if (dl.type === 'remove') lines.push(<Text color={NeoxTheme.functional.error} wrap="wrap">{`${lnStr} - ${dl.content}`}</Text>);
              else lines.push(<Text color={NeoxTheme.text.dim} wrap="wrap">{`${lnStr}   ${dl.content}`}</Text>);
            }
            if (file.lines.length > MAX_DIFF) lines.push(moreLines(file.lines.length - MAX_DIFF));
            return (
              <Step key={fi} tone="success" title={<ToolTitle verb="Diff" target={file.path} />}>
                <StepResult lines={lines} />
              </Step>
            );
          })}
        </Box>
      );
    }
  }

  // ── Generic tool: name on first line, params on second line ──
  // 尝试从 JSON message 中提取有意义的摘要
  let summary: string;
  if (isComplete) {
    // 尝试解析 JSON 结果，提取 summary/status
    let parsed: any = null;
    try { parsed = JSON.parse(message); } catch { /* not JSON */ }
    if (parsed && typeof parsed === 'object') {
      // advice:context_status;summary/status/message/result:通用
      const s = parsed.advice || parsed.summary || parsed.status || parsed.message || parsed.result;
      summary = typeof s === 'string' ? s : message.slice(0, 200);
    } else {
      summary = message;
    }
  } else {
    summary = buildSummary(type, message, params);
  }
  const paramLines = (!isComplete && params && summary === message) ? formatParamLines(params) : [];
  const normalizedSummary = summary.trim();
  let summaryRemoved = false;
  const resultDetailLines = (isComplete && details)
    ? trimEmptyEdgeLines(details.split('\n'))
      .filter(line => {
        if (!summaryRemoved && line.trim() === normalizedSummary) {
          summaryRemoved = true;
          return false;
        }
        return true;
      })
    : [];
  /* 已知的只读/网络工具走 describeTool (跟聚合组同一套说法): Glob(package.json) ⎿ 5 files。
   * 其它工具: 动词取 TOOL_STYLES 的 prefix, 括号里是摘要, 参数/结果明细挂 ⎿ 下面。 */
  const desc = describeTool(type, message, details);
  const failed = desc.failed || /✗\s*ERROR/.test(message);
  const tone = isStreaming ? 'running' : failed ? 'error' : 'success';
  const src = sourceLabel ? <Text color={NeoxTheme.text.dim}>{`  ${sourceLabel}`}</Text> : null;

  if (desc.category !== 'other') {
    return (
      <Step tone={tone} title={<ToolTitle verb={desc.verb} target={desc.target} suffix={src} />}>
        {desc.result ? <StepResult lines={[desc.result]} color={failed ? NeoxTheme.functional.error : undefined} /> : null}
      </Step>
    );
  }

  /* 看后台命令输出: 结果是一整坨 JSON (pid/command/status/content…), 原来原样挂在 ⎿ 后面。
   * 拆成 BashOutput(命令) ⎿ 输出尾巴几行 + 状态。 */
  if (type === 'bash_output') {
    /* 标题摘要是截断过的 JSON, 完整的在 details —— 哪个解得开用哪个 */
    let o: any = null;
    for (const s of [details, message]) {
      const t = (s || '').trim();
      if (!t.startsWith('{')) continue;
      try { o = JSON.parse(t); break; } catch { /* 截断的, 试下一个 */ }
    }
    if (o && typeof o === 'object') {
      const out = String(o.content ?? '').split('\n').filter((l: string) => l.trim());
      const state = o.error ? String(o.error)
        : o.status === 'running' ? `running${o.uptime_sec ? ` · ${o.uptime_sec}s` : ''}`
          : `${o.status ?? 'done'}${o.exit_code !== undefined && o.exit_code !== null ? ` · exit ${o.exit_code}` : ''}`;
      const tail = out.slice(-4);
      const lines = [...(out.length > 4 ? [moreLines(out.length - 4)] : []), ...tail, state];
      return (
        <Step tone={o.error || (o.exit_code && o.exit_code !== 0) ? 'error' : tone} title={<ToolTitle verb="BashOutput" target={String(o.display_name || o.command || o.pid || '')} suffix={src} />}>
          <StepResult lines={lines} oneLine />
        </Step>
      );
    }
  }

  let verb = prefix;
  let text = summary.trim();
  const named = text.match(/^([a-z][a-z0-9_]{2,40}):\s+(.+)$/s);
  if (named) {
    verb = named[1]!.split('_').map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
    text = named[2]!.trim();
  }
  const readable = (l: string): string => {
    const t = l.trim();
    if (!t.startsWith('{')) return l;
    try {
      const o = JSON.parse(t);
      const v = o.advice || o.summary || o.message || o.result || o.error || o.status;
      return typeof v === 'string' ? v : l;
    } catch { return l; }
  };
  text = readable(text);
  const firstLine = text.split('\n')[0]!;
  const inTitle = getDisplayWidth(firstLine) <= 48 && !text.includes('\n');
  /* 结果行也去掉 "工具名: " 前缀; 跟第一行开头相同的 (同一句话的长版本) 不再重复 */
  const head = firstLine.trim().slice(0, 40);
  const body = resultDetailLines.map(readable)
    .map(l => (named && l.startsWith(`${named[1]}: `) ? l.slice(named[1]!.length + 2) : l))
    .filter(l => l.trim() && !(head && l.trim().startsWith(head)));
  const MAX_RESULT = 5;
  const all = [...paramLines, ...(inTitle ? [] : text.split('\n')), ...body];
  const lines: string[] = [
    ...all.slice(0, MAX_RESULT),
    ...(all.length > MAX_RESULT ? [moreLines(all.length - MAX_RESULT)] : []),
  ];
  return (
    <Step tone={tone} title={<ToolTitle verb={verb} target={inTitle && firstLine && firstLine !== verb ? firstLine : undefined} suffix={src} />}>
      <StepResult lines={lines} oneLine color={failed ? NeoxTheme.functional.error : undefined} />
    </Step>
  );
};

export type { ToolType };
export { TOOL_STYLES };
