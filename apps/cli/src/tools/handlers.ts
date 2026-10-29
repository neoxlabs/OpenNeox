/**
 * Tool Call Handlers
 * Handles displaying tool calls and results in the UI
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getLanguage } from '../i18n/index.js';
import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { WebSearchResultItem, GrepMatchItem } from '../cliTypes.js';
import { inferStatusFromTool } from '../ink/utils/statusInference.js';
import {
  resolveUserQuestion,
  setAskUserUICallback,
  type AskUserQuestionInput,
} from '@neoxlabs/core/tools/askUserTool.js';

type StructuredToolOutput = {
  type?: string;
  status?: string;
  summary?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

function parseStructuredToolOutput(output: string): StructuredToolOutput | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as StructuredToolOutput;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.type !== 'string') return null;
    return parsed;
  } catch (err: any) {
    cliLogger.debug('TOOL_UI', `Structured output parse failed: ${err?.message}`);
    return null;
  }
}

function formatSearchQuerySummary(args: Record<string, any> | undefined): string {
  if (!args) return '';
  const orParts: string[] = [];
  const andParts: string[] = [];
  const notParts: string[] = [];

  if (args.pattern || args.query) {
    orParts.push(args.pattern || args.query);
  }
  if (Array.isArray(args.keywords)) {
    orParts.push(...args.keywords);
  }
  if (Array.isArray(args.queries)) {
    for (const item of args.queries) {
      if (!item?.pattern) continue;
      const op = (item.op || 'or').toLowerCase();
      if (op === 'and') {
        andParts.push(item.pattern);
      } else if (op === 'not') {
        notParts.push(item.pattern);
      } else {
        orParts.push(item.pattern);
      }
    }
  }

  const segments: string[] = [];
  if (orParts.length > 0) {
    segments.push(orParts.join(' OR '));
  }
  if (andParts.length > 0) {
    segments.push(`AND ${andParts.join(' + ')}`);
  }
  if (notParts.length > 0) {
    segments.push(`NOT ${notParts.join(' + ')}`);
  }
  return segments.join(' ');
}

export function handleToolCallStart(
  uiController: InkUIAdapter | null,
  toolName: string,
  args: Record<string, any>,
  sourceLabel?: string
): void {
  if (!uiController) return;

  if (toolName.toLowerCase() === 'call_tool' && args?.name) {
    toolName = args.name;
    args = args.args || {};
  }

  const dynamicStatus = inferStatusFromTool(toolName, args);
  uiController.updateStatus(dynamicStatus, 'tool_call');

  if (process.env.CLI_DEBUG === '1') {
    const argsKeys = Object.keys(args).join(',');
    cliLogger.debug('TOOL_UI', `handleToolCallStart: tool=${toolName} sourceLabel=${sourceLabel} argsKeys=${argsKeys}`);
  }

  const normalizedName = toolName.toLowerCase();

  // Plan tools are rendered by dedicated plan_update/verify flows
  // Skip generic tool cards to avoid noisy/duplicated UI entries
  if (normalizedName === 'update_plan' || normalizedName === 'verify_step') {
    return;
  }

  if (normalizedName === 'ask_user') {
    return;
  }

  // Web search tools
  if (normalizedName === 'web_search' || normalizedName.includes('websearch')) {
    uiController.addWebSearchResult({
      query: args.query || args.q || '',
      status: 'searching',
      sourceLabel,
    });
    return;
  }

  // Web fetch tools
  if (normalizedName === 'web_fetch' || normalizedName.includes('webfetch')) {
    uiController.addWebFetchResult({
      url: args.url || '',
      status: 'fetching',
      sourceLabel,
    });
    return;
  }

  // Read file tools (readfile, read)
  if (normalizedName === 'readfile' || normalizedName === 'read') {
    uiController.addReadFileResult({
      filePath: args.path || args.file_path || '',
      startLine: args.start_line || args.offset,
      numLines: args.num_lines || args.limit,
      status: 'reading',
      sourceLabel,
    });
    return;
  }

  // Search tools (search, grep)
  if (normalizedName === 'search' || normalizedName === 'grep') {
    const patternSummary = formatSearchQuerySummary(args) || args.pattern || args.query || '';
    const mode = args.mode || 'content';
    const regexUsed = Array.isArray(args.keywords)
      ? false
      : Array.isArray(args.queries)
        ? args.queries.some((q: any) => q?.regex !== false)
        : true;

    const outputPath = args.path || args.file_path || '.';
    if (mode === 'files') {
      uiController.addSearchFilesResult({
        pattern: patternSummary,
        path: outputPath,
        status: 'searching',
        sourceLabel,
      });
    } else {
      uiController.addSearchResult({
        pattern: patternSummary,
        filePath: outputPath,
        contextLines: args.context_lines,
        mode,
        regex: regexUsed,
        caseInsensitive: args.case_insensitive,
        status: 'searching',
        sourceLabel,
      });
    }
    return;
  }

  // Search/glob files tools
  if (normalizedName === 'search_files' || normalizedName === 'glob') {
    uiController.addSearchFilesResult({
      pattern: args.pattern || '',
      path: args.path,
      status: 'searching',
      sourceLabel,
    });
    return;
  }

  // Directory tree tools
  if (normalizedName === 'show_tree' || normalizedName === 'list_directory' || normalizedName === 'smart_tree') {
    uiController.addShowTreeResult({
      path: args.directory || args.path || '.',
      maxDepth: args.max_depth,
      mode: args.mode,
      status: 'loading',
      sourceLabel,
    });
    return;
  }

  // Shell command tools
  if (normalizedName === 'execute_bash' || normalizedName === 'execute_shell' || normalizedName === 'bash') {
    uiController.addCommandExecResult({
      command: args.command || args.code || '',
      cwd: args.cwd,
      timeout: args.timeout,
      background: args.run_in_background,
      status: 'running',
      sourceLabel,
    });
    return;
  }

  // Code execution tools
  if (normalizedName === 'execute_python' || normalizedName === 'execute_js' || normalizedName === 'execute_javascript') {
    uiController.addCodeExecResult({
      toolName: toolName,
      code: args.code,
      cwd: args.cwd,
      status: 'running',
      sourceLabel,
    });
    return;
  }


  // PTC tool
  if (normalizedName === 'ptc_execute') {
    const ptcEntryKey = typeof args?.__toolId === 'string' ? `ptc_${args.__toolId}` : undefined;
    const desc = args.description || args.script?.substring(0, 80) || 'Executing script';
    uiController.addPTCResult({
      status: 'running',
      description: desc,
      entryKey: ptcEntryKey,
      sourceLabel,
    });
    return;
  }

  // Memory tools (legacy + unified)
  if (normalizedName === 'read_memory' || normalizedName === 'save_memory' || normalizedName === 'update_project_memory' || normalizedName === 'memory') {
    const opLabel = normalizedName === 'memory'
      ? `Memory ${args.action || 'read'}`
      : normalizedName === 'read_memory' ? 'Read Memory'
      : normalizedName === 'save_memory' ? 'Save Memory'
      : 'Update Project Memory';
    const catStr = args.category || args.write_category ? ` [${args.category || args.write_category}]` : '';
    uiController.addMemoryResult({
      operation: normalizedName,
      action: args.action,
      status: 'running',
      text: `${opLabel}${catStr}`,
      sourceLabel,
    });
    return;
  }

  // Cron tools
  if (normalizedName === 'cron_create' || normalizedName === 'cron_delete' || normalizedName === 'cron_list') {
    const cronType = normalizedName === 'cron_create' ? 'cron_create'
      : normalizedName === 'cron_delete' ? 'cron_delete' : 'cron_list';
    const text = normalizedName === 'cron_create'
      ? `Schedule: ${args.cron || ''} → ${(args.prompt || '').substring(0, 60)}`
      : normalizedName === 'cron_delete'
        ? `Delete job: ${args.id || ''}`
        : 'List scheduled jobs';
    uiController.addEntry({
      type: cronType,
      text,
      details: args.prompt ? `prompt: ${args.prompt}` : undefined,
      isStreaming: true,
      sourceLabel,
    });
    return;
  }

  // Task management tools
  if (normalizedName.startsWith('task_')) {
    const taskType = normalizedName as 'task_create' | 'task_update' | 'task_list' | 'task_get' | 'task_stop';
    let text = '';
    switch (normalizedName) {
      case 'task_create': text = `Create: ${args.subject || ''}`; break;
      case 'task_update': text = `Update #${args.taskId || ''}${args.status ? ' → ' + args.status : ''}`; break;
      case 'task_list': text = 'List tasks'; break;
      case 'task_get': text = `Get #${args.taskId || ''}`; break;
      case 'task_stop': text = `Stop #${args.taskId || ''}`; break;
      default: text = normalizedName;
    }
    uiController.addEntry({
      type: taskType,
      text,
      isStreaming: true,
      sourceLabel,
    });
    return;
  }

  // Plan mode tools
  if (normalizedName === 'enter_plan_mode' || normalizedName === 'exit_plan_mode') {
    const planType = normalizedName === 'enter_plan_mode' ? 'plan_enter' : 'plan_exit';
    const text = normalizedName === 'enter_plan_mode'
      ? 'Entering plan mode...'
      : 'Presenting plan for approval...';
    uiController.addEntry({
      type: planType,
      text,
      isStreaming: true,
      sourceLabel,
    });
    return;
  }

  // Worktree tools
  if (normalizedName === 'enter_worktree' || normalizedName === 'exit_worktree') {
    const wtType = normalizedName === 'enter_worktree' ? 'worktree_enter' : 'worktree_exit';
    const text = normalizedName === 'enter_worktree'
      ? `Create worktree${args.name ? ': ' + args.name : ''}`
      : `Exit worktree (${args.action || 'keep'})`;
    uiController.addEntry({
      type: wtType,
      text,
      isStreaming: true,
      sourceLabel,
    });
    return;
  }

  // Git tools
  if (normalizedName.startsWith('git_')) {
    uiController.addGitResult({
      subcommand: normalizedName.replace('git_', ''),
      args,
      status: 'running',
      sourceLabel,
    });
    return;
  }

  // Task tool (sync task-agent, assistant mode)
  if (normalizedName === 'task') {
    const role = args.role ? `[${args.role}]` : '[scout]';
    const model = args.model || '';
    const task = args.description || '';
    const text = task ? task.substring(0, 120) : 'Sub-agent task';
    const metaParts: string[] = [role];
    if (model) metaParts.push(model);
    uiController.addAssistantToolEntry('task', text, {
      result: 'pending',
      sourceLabel,
      details: metaParts.join(' · '),
    });
    return;
  }

  // Assistant / Cooperate tools (legacy compatibility + Agent OS process tools)
  const ASSISTANT_TOOLS = [
    // Legacy (cooperate mode)
    'spawn_agent', 'delegate_task', 'query_agent', 'send_message', 'wait_result', 'wait_all', 'terminate_agent',
    // New Agent OS tools
    'spawn_process', 'list_processes', 'read_process_output', 'kill_process', 'pause_process', 'resume_process', 'wait_process', 'send_to_process',
    // Team orchestration
    'create_team',
  ];
  if (ASSISTANT_TOOLS.includes(normalizedName)) {
    const targetAgent = args.agent_id || args.agentId || args.target || args.pid || '';
    const task = args.task || args.description || args.message || '';
    let text = '';
    let details: string | undefined;

    if (normalizedName === 'spawn_agent' || normalizedName === 'spawn_process') {
      const role = args.role ? `[${args.role}]` : '';
      const model = args.model || args.modelName || '';
      text = task ? task.substring(0, 120) : `Spawn ${role}`;
      const metaParts: string[] = [];
      if (role) metaParts.push(role);
      if (model) metaParts.push(model);
      if (metaParts.length) details = metaParts.join(' · ');
    } else if (normalizedName === 'list_processes') {
      text = 'Listing processes';
    } else if (normalizedName === 'read_process_output') {
      text = targetAgent ? `Reading output: ${targetAgent}` : 'Reading process output';
    } else if (normalizedName === 'wait_all' || normalizedName === 'wait_process') {
      const ids = args.agent_ids || args.agentIds || [];
      text = ids.length > 0 ? `Waiting ${ids.length} agents: ${ids.join(', ')}` : targetAgent ? `Waiting ${targetAgent}` : 'Waiting result';
    } else if (normalizedName === 'wait_result') {
      text = targetAgent ? `Waiting ${targetAgent}` : 'Waiting result';
    } else if (normalizedName === 'delegate_task') {
      text = task ? task.substring(0, 120) : `→ ${targetAgent}`;
      if (args.model) details = args.model;
    } else if (normalizedName === 'kill_process') {
      text = targetAgent ? `Kill ${targetAgent}` : 'Kill process';
      if (args.reason) details = args.reason;
    } else if (normalizedName === 'send_to_process') {
      text = targetAgent ? `Send → ${targetAgent}` : 'Send to process';
      if (args.message) details = String(args.message).substring(0, 80);
    } else if (normalizedName === 'pause_process') {
      text = targetAgent ? `⏸ Pause ${targetAgent}` : 'Pause process';
      if (args.reason) details = args.reason;
    } else if (normalizedName === 'resume_process') {
      text = targetAgent ? `▶ Resume ${targetAgent}` : 'Resume process';
    } else if (normalizedName === 'create_team') {
      const goal = args.goal || '';
      const mode = args.mode ? `[${args.mode}]` : '';
      text = goal ? goal.substring(0, 120) : 'Creating team';
      if (mode) details = `Mode: ${mode}`;
    } else {
      text = task || `→ ${targetAgent || normalizedName}`;
    }

    uiController.addAssistantToolEntry(normalizedName, text, {
      targetAgentId: targetAgent,
      taskId: args.task_id || args.taskId,
      result: 'pending',
      sourceLabel,
      details,
    });
    return;
  }

  // Write file tools
  // 与 edit_file 一致：由 write_file_stream 负责最终渲染，避免开始/完成双卡片重复
  if (normalizedName === 'write_file' || normalizedName === 'write') {
    return;
  }

  // Edit file tools - skip here, handled by edit_file_stream event in runtimeEvents.ts
  if (normalizedName === 'edit_file' || normalizedName === 'edit') {
    return;
  }

  if (normalizedName === 'explore' || normalizedName === 'task') {
    return;
  }

  // Default: use generic tool call display
  uiController.addToolCall(toolName, args);
}

export function handleToolOutput(
  uiController: InkUIAdapter | null,
  toolName: string,
  output: string,
  success: boolean,
  args?: Record<string, any>,
  sourceLabel?: string
): void {
  if (!uiController) return;

  if (toolName.toLowerCase() === 'call_tool' && args?.name) {
    toolName = args.name;
    args = args.args || {};
  }

  const normalizedName = toolName.toLowerCase();

  // Plan tools are rendered by dedicated plan_update/verify flows
  // Skip generic tool result cards to avoid noisy/duplicated UI entries
  if (normalizedName === 'update_plan' || normalizedName === 'verify_step') {
    return;
  }

  // ask_user 结果由交互式 SelectMenu 处理，跳过通用 tool result 卡片
  if (normalizedName === 'ask_user') {
    return;
  }

  if (normalizedName === 'explore' || normalizedName === 'task') {
    return;
  }

  // Edit file tools - parse the ephemeral result
  if (normalizedName === 'edit_file' || normalizedName === 'edit') {
    try {
      const result = JSON.parse(output);

      // Check the actual status from the result
      if (result.status === 'success') {
        // Edit succeeded - diff already displayed by edit_file_stream event
        // Just show a simple success message
        uiController.addEditFileResult({
          filePath: result.file_path || args?.file_path || '',
          status: 'completed',
          summary: result.summary || 'Edit completed successfully',
          replacements: result.metadata?.replacements || 1,
          sourceLabel,
        });
      } else if (result.status === 'already_done') {
        // Already in target state
        uiController.addEditFileResult({
          filePath: result.file_path || args?.file_path || '',
          status: 'completed',
          summary: result.summary || 'Edit already applied',
          alreadyDone: true,
          sourceLabel,
        });
      } else {
        // Edit failed - show error details
        uiController.addEditFileResult({
          filePath: result.file_path || args?.file_path || '',
          status: 'error',
          error: result.summary || result.error || 'Edit failed',
          sourceLabel,
        });
      }
    } catch (err: any) {
      cliLogger.debug('TOOL_UI', `Edit result parse failed: ${err?.message}`);
      // Fallback if output is not JSON
      if (success) {
        uiController.addEditFileResult({
          filePath: args?.file_path || '',
          status: 'completed',
          summary: 'Edit completed',
          sourceLabel,
        });
      } else {
        uiController.addEditFileResult({
          filePath: args?.file_path || '',
          status: 'error',
          error: output,
          sourceLabel,
        });
      }
    }
    return;
  }

  // Write file tools - 统一由 write_file_stream/tool_call_end 渲染，避免双链路重复
  if (normalizedName === 'write_file' || normalizedName === 'write') {
    return;
  }

  // Web search tools
  if (normalizedName === 'web_search' || normalizedName.includes('websearch')) {
    if (success) {
      try {
        const results = parseWebSearchResults(output);
        uiController.addWebSearchResult({
          query: args?.query || args?.q || '',
          /* 解析不出来 (输出被截断 / 格式没见过) 就不报条数, 别写成 "0 results" 误导 */
          results: results.length ? results : undefined,
          status: 'completed',
          sourceLabel,
        });
      } catch (err: any) {
        cliLogger.debug('TOOL_UI', `Web search result parse failed: ${err?.message}`);
        uiController.addWebSearchResult({
          query: args?.query || args?.q || '',
          status: 'completed',
          sourceLabel,
        });
      }
    } else {
      uiController.addWebSearchResult({
        query: args?.query || '',
        status: 'error',
        error: output,
        sourceLabel,
      });
    }
    return;
  }

  // Web fetch tools
  if (normalizedName === 'web_fetch' || normalizedName.includes('webfetch')) {
    if (success) {
      uiController.addWebFetchResult({
        url: args?.url || '',
        contentLength: output.length,
        contentPreview: output.slice(0, 500),
        status: 'completed',
        sourceLabel,
      });
    } else {
      uiController.addWebFetchResult({
        url: args?.url || '',
        status: 'error',
        error: output,
        sourceLabel,
      });
    }
    return;
  }

  // Read file tools (readfile, read)
  if (normalizedName === 'readfile' || normalizedName === 'read') {
    if (success) {
      const lines = output.split('\n');
      uiController.addReadFileResult({
        /* readfile 支持 paths=[...] 一次读多个 —— 只取 path/file_path 时卡片上写的是 "file" */
        filePath: args?.path || args?.file_path || '',
        filePaths: Array.isArray(args?.paths) ? args.paths : undefined,
        totalLines: lines.length,
        fileSize: output.length >= 1024 ? `${(output.length / 1024).toFixed(1)}KB` : `${output.length} chars`,
        preview: output.slice(0, 1000),
        status: 'completed',
        sourceLabel,
      });
    } else {
      uiController.addReadFileResult({
        filePath: args?.path || args?.file_path || '',
        filePaths: Array.isArray(args?.paths) ? args.paths : undefined,
        status: 'error',
        error: output,
        sourceLabel,
      });
    }
    return;
  }

  // Search tools
  if (normalizedName === 'search') {
    const parsed = parseStructuredToolOutput(output);
    const content = parsed?.content && typeof parsed.content === 'string' ? parsed.content : output;
    const metadata = parsed?.metadata as { mode?: string; files?: string[]; strategy?: string; regex?: boolean; path?: string; command?: string } | undefined;
    const isFileMode = args?.mode === 'files' || metadata?.mode === 'files';
    const patternSummary = formatSearchQuerySummary(args) || args?.pattern || args?.query || '';
    const mode = metadata?.mode || args?.mode || (isFileMode ? 'files' : 'content');
    const regexUsed = metadata?.regex ??
      (Array.isArray(args?.keywords)
        ? false
        : Array.isArray(args?.queries)
          ? args.queries.some((q: any) => q?.regex !== false)
          : true);
    const caseInsensitive = args?.case_insensitive;
    const outputPath = args?.path || args?.file_path || metadata?.path || '';
    const executedCommand = metadata?.command;
    if (success) {
      if (isFileMode) {
        const files = metadata?.files || content.split('\n').filter(l => l.trim().startsWith('  ')).map(l => l.trim());
        uiController.addSearchFilesResult({
          pattern: patternSummary,
          path: outputPath,
          fileCount: files.length,
          files: files.slice(0, 30),
          status: 'completed',
          mode,
          strategy: metadata?.strategy,
          regex: regexUsed,
          caseInsensitive,
          command: executedCommand,
          sourceLabel,
        });
      } else {
        const matches = parseGrepMatches(content);
        const summary = parseGrepFileSummary(content);
        const details = summary.entries.length > 0
          ? formatGrepFileSummaryLine(summary.entries)
          : undefined;
        uiController.addSearchResult({
          pattern: patternSummary,
          filePath: outputPath,
          matchCount: summary.matchCount ?? matches.length,
          details,
          status: 'completed',
          mode,
          strategy: metadata?.strategy,
          regex: regexUsed,
          caseInsensitive,
          command: executedCommand,
          sourceLabel,
        });
      }
    } else {
      if (isFileMode) {
        uiController.addSearchFilesResult({
          pattern: patternSummary,
          path: outputPath,
          status: 'error',
          error: content,
          mode,
          strategy: metadata?.strategy,
          regex: regexUsed,
          caseInsensitive,
          command: executedCommand,
          sourceLabel,
        });
      } else {
        uiController.addSearchResult({
          pattern: patternSummary,
          filePath: outputPath,
          status: 'error',
          error: content,
          mode,
          strategy: metadata?.strategy,
          regex: regexUsed,
          caseInsensitive,
          command: executedCommand,
          sourceLabel,
        });
      }
    }
    return;
  }

  // Search/glob files tools
  if (normalizedName === 'search_files' || normalizedName === 'glob') {
    if (success) {
      /* 输出带表头 ("✓ 找到 2 个文件" / "▸ 目录" / "▸ 模式") —— 原来按非空行数算, 找到 2 个显示 "5 files";
       * 没找到时还带一段建议, 显示成六七个。总数以表头为准, 清单只取缩进的文件行。 */
      const files = output.split('\n').filter(l => /^ {2}\S/.test(l) && !/^\s*\.\.\. /.test(l)).map(l => l.trim());
      const total = /找到\s*(\d+)\s*个文件|Found\s+(\d+)\s+files?/i.exec(output);
      const fileCount = /未找到匹配|No files? (?:found|matched)/i.test(output) ? 0
        : total ? Number(total[1] ?? total[2]) : files.length;
      uiController.addSearchFilesResult({
        pattern: args?.pattern || '',
        path: args?.path,
        fileCount,
        files: files.slice(0, 30),
        status: 'completed',
        sourceLabel,
      });
    } else {
      uiController.addSearchFilesResult({
        pattern: args?.pattern || '',
        status: 'error',
        error: output,
        sourceLabel,
      });
    }
    return;
  }

  // Directory tree tools
  if (normalizedName === 'show_tree' || normalizedName === 'list_directory' || normalizedName === 'smart_tree') {
    if (success) {
      uiController.addShowTreeResult({
        path: args?.directory || args?.path || '.',
        mode: args?.mode,
        maxDepth: args?.max_depth,
        content: output,
        totalChars: output.length,
        status: 'completed',
        sourceLabel,
      });
    } else {
      uiController.addShowTreeResult({
        path: args?.directory || args?.path || '.',
        mode: args?.mode,
        maxDepth: args?.max_depth,
        status: 'error',
        error: output,
        sourceLabel,
      });
    }
    return;
  }

  // Shell command tools
  if (normalizedName === 'execute_bash' || normalizedName === 'execute_shell' || normalizedName === 'bash') {
    if (success) {
      uiController.addCommandExecResult({
        command: args?.command || args?.code || '',
        cwd: args?.cwd,
        output: output,
        exitCode: 0,
        status: 'completed',
        sourceLabel,
      });
    } else {
      let exitCode: number | undefined;
      const exitMatch = output.match(/退出码:\s*(\d+)/);
      if (exitMatch) exitCode = parseInt(exitMatch[1], 10);
      uiController.addCommandExecResult({
        command: args?.command || args?.code || '',
        cwd: args?.cwd,
        output: output,
        exitCode: exitCode || 1,
        status: 'error',
        error: output,
        sourceLabel,
      });
    }
    return;
  }

  // Code execution tools
  if (normalizedName === 'execute_python' || normalizedName === 'execute_js' || normalizedName === 'execute_javascript') {
    if (success) {
      uiController.addCodeExecResult({
        toolName: toolName,
        code: args?.code,
        output: output,
        exitCode: 0,
        status: 'completed',
        sourceLabel,
      });
    } else {
      uiController.addCodeExecResult({
        toolName: toolName,
        code: args?.code,
        status: 'error',
        error: output,
        sourceLabel,
      });
    }
    return;
  }


  // PTC tool
  if (normalizedName === 'ptc_execute') {
    const ptcEntryKey = typeof args?.__toolId === 'string' ? `ptc_${args.__toolId}` : undefined;
    const desc = args?.description || args?.script?.substring(0, 80) || '';
    if (success) {
      uiController.addPTCResult({
        status: 'completed',
        description: desc,
        entryKey: ptcEntryKey,
        output,
        sourceLabel,
      });
    } else {
      uiController.addPTCResult({
        status: 'error',
        description: desc,
        entryKey: ptcEntryKey,
        error: output,
        sourceLabel,
      });
    }
    return;
  }

  // Memory tools (legacy + unified)
  if (normalizedName === 'read_memory' || normalizedName === 'save_memory' || normalizedName === 'update_project_memory' || normalizedName === 'memory') {
    const opLabel = normalizedName === 'memory'
      ? `Memory ${args?.action || 'read'}`
      : normalizedName === 'read_memory' ? 'Read Memory'
      : normalizedName === 'save_memory' ? 'Save Memory'
      : 'Update Project Memory';
    const catStr = args?.category || args?.write_category ? ` [${args.category || args.write_category}]` : '';
    uiController.addMemoryResult({
      operation: normalizedName,
      action: args?.action,
      status: success ? 'completed' : 'error',
      text: `${opLabel}${catStr}`,
      output: success ? output : undefined,
      error: success ? undefined : output,
      searchQuery: args?.query || args?.keyword || args?.search_query,
      sourceLabel,
    });
    return;
  }

  // Git tools
  if (normalizedName.startsWith('git_')) {
    const subcommand = normalizedName.replace('git_', '');
    let parsed: any = {};
    try { parsed = JSON.parse(output); } catch (err: any) { cliLogger.debug('TOOL_UI', `Git output parse failed: ${err?.message}`); }

    if (success) {
      uiController.addGitResult({
        subcommand,
        args,
        status: 'completed',
        output: parsed.data || parsed.output || output,
        summary: parsed.summary || parsed._summary,
        sourceLabel,
      });
    } else {
      uiController.addGitResult({
        subcommand,
        args,
        status: 'error',
        error: parsed.error || parsed._message || parsed.summary || output,
        sourceLabel,
      });
    }
    return;
  }

  // Task tool output (sync task-agent, assistant mode)
  if (normalizedName === 'task') {
    const isError = output.startsWith('[ERROR]');
    const role = args?.role ? `[${args.role}]` : '[scout]';
    const preview = output.substring(0, 300).replace(/\n/g, ' ');
    const text = isError ? preview : (preview || 'Task completed');
    const details = output.length > 300 ? output.substring(0, 600) : undefined;
    uiController.addAssistantToolEntry('task', text, {
      result: isError ? 'error' : 'success',
      sourceLabel,
      details: details ? `${role}\n${details}` : role,
    });
    return;
  }

  // Assistant tools (legacy + new Agent OS)
  const ASSISTANT_TOOLS_OUT = [
    // Legacy (cooperate mode)
    'spawn_agent', 'delegate_task', 'query_agent', 'send_message', 'wait_result', 'wait_all', 'terminate_agent',
    // New Agent OS tools
    'spawn_process', 'list_processes', 'read_process_output', 'kill_process', 'pause_process', 'resume_process', 'wait_process', 'send_to_process',
    // Team orchestration
    'create_team',
  ];
  if (ASSISTANT_TOOLS_OUT.includes(normalizedName)) {
    let parsed: any = {};
    try { parsed = JSON.parse(output); } catch (err: any) { cliLogger.debug('TOOL_UI', `Assistant tool output parse failed: ${err?.message}`); }

    // 格式化不同 assistant 工具的输出
    let text = '';
    let details: string | undefined;
    let targetAgent = args?.agent_id || args?.agentId || parsed.agentId || parsed.agent_id || parsed.pid || args?.pid || '';

    if (normalizedName === 'spawn_agent' || normalizedName === 'spawn_process') {
      // spawn_agent/spawn_process: {agentId/pid, status, model, role, note}
      targetAgent = parsed.agentId || parsed.pid || targetAgent;
      const role = parsed.role ? ` (${parsed.role})` : '';
      const model = parsed.model ? ` → ${parsed.model}` : '';
      text = `${targetAgent}${role}${model}`;
      if (parsed.reason || parsed.note) details = parsed.reason || parsed.note;
    } else if (normalizedName === 'list_processes') {
      const processes = parsed.processes || [];
      text = `${processes.length} processes`;
      if (processes.length > 0) {
        details = processes.map((p: any) => `${p.state === 'running' ? '●' : '○'} ${p.pid}: ${p.task}`).join('\n');
      }
    } else if (normalizedName === 'read_process_output') {
      text = output.length > 120 ? output.substring(0, 120) + '…' : output;
    } else if (normalizedName === 'wait_all' || normalizedName === 'wait_result' || normalizedName === 'wait_process') {
      // wait_all: {results: {agent-1: {success, output}, agent-2: ...}}
      const results = parsed.results || parsed;
      const entries = Object.entries(results);
      if (entries.length > 0) {
        const lines = entries.map(([agentId, r]: [string, any]) => {
          const icon = r?.success ? '✓' : '✗';
          const snippet = (r?.output || r?.error || '').substring(0, 80).replace(/\n/g, ' ');
          return `${icon} ${agentId}: ${snippet}${snippet.length >= 80 ? '…' : ''}`;
        });
        text = `${entries.length} results collected`;
        details = lines.join('\n');
      } else {
        text = output.length > 120 ? output.substring(0, 120) + '…' : (output || 'Completed');
      }
    } else if (normalizedName === 'delegate_task') {
      // delegate_task: {success, output, summary}
      text = parsed.summary || (parsed.output || '').substring(0, 120) || 'Task completed';
      if (parsed.output && parsed.output.length > 120) {
        details = parsed.output.substring(0, 300);
      }
    } else if (normalizedName === 'query_agent') {
      // query_agent: {agentId, status, progress, currentTask}
      const status = parsed.status || 'unknown';
      const task = parsed.currentTask || '';
      text = `${targetAgent}: ${status}${task ? ' — ' + task : ''}`;
    } else if (normalizedName === 'kill_process') {
      text = parsed.success ? `Killed ${targetAgent}` : `Failed to kill ${targetAgent}`;
      if (parsed.reason) details = parsed.reason;
    } else if (normalizedName === 'send_to_process') {
      text = parsed.success ? `Sent to ${targetAgent}` : `Failed to send to ${targetAgent}`;
    } else if (normalizedName === 'pause_process') {
      text = parsed.success ? `⏸ Paused ${targetAgent}` : `Failed to pause ${targetAgent}`;
      if (parsed.note) details = parsed.note;
    } else if (normalizedName === 'resume_process') {
      text = parsed.success ? `▶ Resumed ${targetAgent}` : `Failed to resume ${targetAgent}`;
      if (parsed.note) details = parsed.note;
    } else if (normalizedName === 'create_team') {
      const teamId = parsed.teamId || '';
      text = teamId ? `Team created: ${teamId}` : (parsed.note || 'Team created');
      if (parsed.note) details = parsed.note;
    } else {
      // send_message, terminate_agent, etc.
      text = parsed.summary || parsed.message || parsed.status || output.substring(0, 120);
    }

    uiController.addAssistantToolEntry(normalizedName, text, {
      targetAgentId: targetAgent,
      taskId: args?.task_id || args?.taskId || parsed.taskId,
      result: success ? 'success' : 'error',
      sourceLabel,
      details,
    });
    return;
  }

  // Default: use generic tool result display
  if (success) {
    uiController.addToolResult(output, false);
  } else {
    uiController.addToolError(toolName, output);
  }
}

/**
 * Parse web search results from output
 */
export function parseWebSearchResults(output: string): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];

  // Try JSON parse first
  try {
    let parsed = JSON.parse(output);
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
      const queue: any[] = [parsed];
      let found: any[] | null = null;
      for (let guard = 0; queue.length && guard < 50 && !found; guard++) {
        const o = queue.shift();
        for (const v of Object.values(o ?? {})) {
          if (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && (x.url || x.link))) { found = v; break; }
          if (v && typeof v === 'object' && !Array.isArray(v)) queue.push(v);
        }
      }
      if (found) parsed = found;
    }
    if (Array.isArray(parsed)) {
      return parsed.map(r => ({
        title: r.title || r.name || '',
        url: r.url || r.link || '',
        description: r.description || r.snippet || '',
        hostname: r.hostname || (r.url ? new URL(r.url).hostname : ''),
      }));
    }
  } catch (err: any) {
    cliLogger.debug('TOOL_UI', `Web search JSON parse failed, trying text format: ${err?.message}`);
  }

  // Parse text format
  const lines = output.split('\n');
  let current: Partial<WebSearchResultItem> = {};

  for (const line of lines) {
    const titleMatch = line.match(/^\s*(?:\[\]|📄)?\s*\d+\.\s*(.+)$/);
    if (titleMatch) {
      if (current.title && current.url) {
        results.push(current as WebSearchResultItem);
      }
      current = { title: titleMatch[1].trim() };
      continue;
    }

    const urlMatch = line.match(/^🔗\s*(.+)$/) || line.match(/^https?:\/\/\S+/);
    if (urlMatch && current.title) {
      const url = urlMatch[1] || urlMatch[0];
      current.url = url.trim();
      try {
        current.hostname = new URL(current.url).hostname;
      } catch (err: any) {
        cliLogger.debug('TOOL_UI', `URL hostname parse failed: ${err?.message}`);
        current.hostname = current.url;
      }
      continue;
    }

    const descMatch = line.match(/^\s*(?:\[\.\]|📝)\s*(.+)$/);
    if (descMatch && current.title) {
      current.description = descMatch[1].trim();
      continue;
    }

    const hostMatch = line.match(/^\s*(?:\[@\]|🌐)\s*(.+)$/);
    if (hostMatch && current.title) {
      current.hostname = hostMatch[1].trim();
    }
  }

  // Add last result
  if (current.title && current.url) {
    results.push(current as WebSearchResultItem);
  }

  return results;
}

/**
 * Parse grep matches from output
 */
export function parseGrepMatches(output: string): GrepMatchItem[] {
  const matches: GrepMatchItem[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Match format: "▶  123 │ content" or "    123 │ content" or "file:123:content"
    const prefixMatch = line.match(/^([▶▸► ])\s*(\d+)\s*│\s*(.*)$/);
    if (prefixMatch) {
      matches.push({
        lineNumber: parseInt(prefixMatch[2], 10),
        content: prefixMatch[3],
        isMatch: prefixMatch[1] !== ' ',
      });
      continue;
    }

    // Standard grep format: "filename:123:content"
    const grepMatch = line.match(/^[^:]+:(\d+):(.*)$/);
    if (grepMatch) {
      matches.push({
        lineNumber: parseInt(grepMatch[1], 10),
        content: grepMatch[2],
        isMatch: true,
      });
    }
  }

  return matches;
}

interface GrepFileSummaryEntry {
  module?: string;
  path: string;
  count: number;
}

interface GrepFileSummary {
  filesSearched?: number;
  filesWithMatches?: number;
  matchCount?: number;
  entries: GrepFileSummaryEntry[];
}

function parseGrepFileSummary(output: string): GrepFileSummary {
  const lines = output.split('\n');
  const summary: GrepFileSummary = { entries: [] };

  for (const line of lines) {
    const filesLine = line.match(/^文件:\s*(\d+)\s+已搜索,\s*(\d+)\s+有匹配/);
    if (filesLine) {
      summary.filesSearched = parseInt(filesLine[1], 10);
      summary.filesWithMatches = parseInt(filesLine[2], 10);
      continue;
    }

    const matchLine = line.match(/^匹配:\s*(\d+)/);
    if (matchLine) {
      summary.matchCount = parseInt(matchLine[1], 10);
      continue;
    }

    const fileHeader = line.match(/^▸\s*\[([^\]]+)\]\s+(.+)\s+\((\d+)\s*处\)/);
    if (fileHeader) {
      summary.entries.push({
        module: fileHeader[1].trim(),
        path: fileHeader[2].trim(),
        count: parseInt(fileHeader[3], 10),
      });
      continue;
    }

    const fileList = line.match(/^\s*\[([^\]]+)\]\s+(.+?):\s*(\d+)/);
    if (fileList) {
      summary.entries.push({
        module: fileList[1].trim(),
        path: fileList[2].trim(),
        count: parseInt(fileList[3], 10),
      });
    }
  }

  return summary;
}

function formatGrepFileSummaryLine(entries: GrepFileSummaryEntry[]): string {
  const lines: string[] = [];
  const maxItems = 20;

  for (let i = 0; i < entries.length; i++) {
    if (lines.length >= maxItems) {
      lines.push(`... +${entries.length - lines.length} more files`);
      break;
    }

    const entry = entries[i];
    const label = entry.module
      ? `[${entry.module}] ${entry.path} (${entry.count} 处)`
      : `${entry.path} (${entry.count} 处)`;

    lines.push(label);
  }

  // ToolCard 会用 split('\n') 分割成多行显示
  return lines.join('\n');
}

// ============================================================================
// AskUser 交互式问答
// ============================================================================

/**
 * 初始化 ask_user 工具的 UI 回调
 * CLI 启动时调用，注册 onQuestionReady 回调
 */
export function initAskUserUI(uiController: InkUIAdapter): void {
  setAskUserUICallback((pendingId, questions) => {
    showAskUserQuestions(uiController, pendingId, questions, 0, {});
  });
}

/**
 * 逐个显示问题的 SelectMenu，收集所有答案后 resolve 工具 Promise
 */
function showAskUserQuestions(
  uiController: InkUIAdapter,
  pendingId: string,
  questions: AskUserQuestionInput[],
  index: number,
  collectedAnswers: Record<string, string>,
): void {
  if (index >= questions.length) {
    resolveUserQuestion(pendingId, collectedAnswers);
    return;
  }

  const q = questions[index];
  const progress = questions.length > 1 ? ` (${index + 1}/${questions.length})` : '';

  const choices = q.options.map((opt) => ({
    title: opt.label,
    value: opt.label,
    description: opt.description,
  }));

  uiController.promptSelect({
    message: `${q.question}${progress}`,
    choices,
    /* 同 remoteInteractionFlows: 表头别写死英文 */
    header: (q as any).header || (getLanguage() === 'zh' ? '需要你决定' : 'Ask User'),
    allowTextInput: true,
  }).then((value) => {
    const answer = value || '(跳过)';
    const newAnswers = { ...collectedAnswers, [q.question]: answer };

    uiController.addUserMessage(`Q: ${q.question}\nA: ${answer}`);

    showAskUserQuestions(uiController, pendingId, questions, index + 1, newAnswers);
  });
}
