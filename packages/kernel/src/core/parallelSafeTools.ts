/**
 * Parallel-safe tool names — 并发执行安全的工具名单(canonical 单点)
 *
 * This module is the single source of truth for orchestration and runner
 * callers; parallel-safe tools may run concurrently without shared conflicts.
 *
 * 语义:
 *   "parallel-safe" = 工具不会修改主工作区文件系统 OR 有独立 side-effect scope
 *   (例如任务 Agent 在自己的 context 里运行)。此类工具在同一个 LLM 响应内
 *   可以 `Promise.all` 并行执行而不会互相干扰。
 */

export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set<string>([
  // ── 文件只读 ──────────────────────────────────────────────
  'readfile',
  'read_file',
  'smart_read',
  'read_multiple_files',

  // ── 搜索(文件名 / 内容) ───────────────────────────────
  'search',
  'search_files',
  'grep',
  'glob',

  // ── 目录树 / 代码分析(只读) ───────────────────────────
  'list_directory',
  'show_tree',
  'analyze_code',
  'search_symbol',
  'get_definitions',
  'get_references',

  // ── Git 只读 ─────────────────────────────────────────────
  'git_status',
  'git_diff',
  'git_blame',
  'git_branch_list',

  // ── Web 只读 ─────────────────────────────────────────────
  'web_search',
  'web_fetch',

  // ── 团队协作只读 ────────────────────────────────────────
  'read_team_board',
  'read_peers_status',

  // ── 进程观测 ────────────────────────────────────────────
  'list_processes',
  'read_process_output',
  //  后台 bash task 观测 — 读 processManager 输出缓冲,纯只读
  'bash_output',
  //  ManagedTask 元数据查询 — 读 SQLite task 行
  'task_output',
  'task_get',
  'task_list',
  //  agent 自查预算 — 纯只读 snapshot
  'context_status',
  //  自主 pacing — 只创建一个定时器,不改任何工作区状态
  'schedule_wakeup',

  // ── Memory / Recall 只读 ───────────────────────────────
  'recall',

  // ── Agent 子代理 ─────────────────────────────────────────
  // 每个 taskagent 跑在自己的 context 里, 对主对话无副作用, 并行安全
  'agent',
  // Explore agents use independent sessions and a read-only tool set.
  'explore',
]);

/**
 * 判断工具名是否属于并发安全集合(大小写不敏感)
 */
export function isParallelSafeTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  return PARALLEL_SAFE_TOOLS.has(toolName.toLowerCase());
}
