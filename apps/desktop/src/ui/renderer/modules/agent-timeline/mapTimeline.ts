import type { TimelineEntry } from '../../utils/workspaceUtils';
import { dropDuplicatedSubStepText } from './dropDuplicatedSubStepText';
import { isReadonlyProbeMiss, isToolGuidanceEntry } from './turnAnomaly';
import { aggregateTurnChanges } from './aggregateTurnChanges';
import { isExternalAgentTool, externalAgentMeta } from './externalAgentTools';
import type {
  TimelineItem,
  TimelineStep,
  TimelineMessage,
  StepStatus,
  StepIconKind,
  StepContent,
  DiffLine,
  SearchHit,
  PlanStepRow,
  PlanItemStatus,
  AskUserQuestion,
  WebResult,
  CodeLine,
  TimelineDensity,
} from './types';
import { getTimelineStepPresentation } from './timelinePresentation';
import { computerToolTitle, computerCardContent } from './computerTimelineCard';
import { browserToolTitle, browserCardContent } from './browserTimelineCard';
import { deepResearchToolTitle, deepResearchCardContent, deepResearchLiveContent } from './deepResearchTimelineCard';
import { getShowReasoningPreference } from './timelinePreferences';
import { buildSeenImagesContent } from './seenImagesContent';
import { displayWorkspacePath } from '../../utils/pathUtils';
import { getGlobalLanguage } from '../../hooks/useI18n';
import { ERROR_CODES, ERROR_CODE_ALIASES, ErrorCategory } from '@neoxlabs/kernel/types/errors.js';
import { pluginLogoFromToolName } from '../../pages/plugins/pluginBrandAssets.js';
import { parseDataResult } from './dataResult';
import { editHunkLines } from './editHunkLines';
import { PLAIN_TOOL_LABEL_ZH, PLAIN_TOOL_LABEL_EN, PLAIN_HIDDEN_TOOL_NAMES, CODE_TOOL_LABEL_EN, CODE_TOOL_LABEL_ZH_EXTRA } from './toolLabelMaps';
import { plainWorkTitle, plainWorkContentForTool, isProcessScript } from './workPlainPresentation';
import { TOOL_TO_ICON } from './mapTimelineIcons';
import { dropPilotPatrolNoise } from './pilotPatrolFilter';
import { bashOutputTitle, bashOutputContent, parseBashOutputJson, type BashOutputResult } from './bashOutputStep';
import { unwrapContextualOutput } from './unwrapToolOutput';
import { buildSkillContent, skillTitleName } from './skillContent';
import { buildToolCardContent } from './toolCards/buildToolCard';
import { buildSessionPeerContent } from './sessionPeerStep';
import { sheetRowTitle, colToNum, numToCol } from './sheetRowTitle';

function _getUiLanguage(): string { return getGlobalLanguage(); }

function normalizeTs(ts: number | null | undefined): number {
  if (ts == null || ts <= 0) return Number.MAX_SAFE_INTEGER;
  if (ts < 1e12) return ts * 1000; /* 秒 → 毫秒 */
  return ts;
}

/* ============================================================
 * mapTimeline — TimelineEntry[] → TimelineItem[]
 *
 *   · 消息 row: user_message / assistant_message / agent_message / assistant_prefix
 *   · tool row (通用): 其它全部 type, 按 toolName/type 挑 icon + title
 *   · 专属 content: terminal / search / diff / plan / thinking / error / code
 *   · SKIP: 只跳 edit_file 的 stream delta (file_stream / edit_file_stream)
 *
 *   批量调用 (batchId) 自动聚合为 ParallelGroup.
 * ============================================================ */

/* ---------- 格式化 ---------- */
const pad = (n: number) => n.toString().padStart(2, '0');

function formatHms(ms?: number): string | undefined {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return undefined;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

/** 完成的思考行标题:「思考了 8 秒」/「Thought for 8s」。不到 1 秒不写时长 (返回 undefined, 退回「思考」)。 */
function formatThoughtFor(ms: number | undefined, zh: boolean): string | undefined {
  if (!ms || !Number.isFinite(ms) || ms < 1000) return undefined;
  const s = Math.round(ms / 1000);
  if (s < 60) return zh ? `思考了 ${s} 秒` : `Thought for ${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (zh) return rs === 0 ? `思考了 ${m} 分钟` : `思考了 ${m} 分 ${rs} 秒`;
  return rs === 0 ? `Thought for ${m}m` : `Thought for ${m}m ${rs}s`;
}

type ClockFormatters = { time: Intl.DateTimeFormat; day: Intl.DateTimeFormat };
let _clockLocale: string | null = null;
let _clockFmt: ClockFormatters | null = null;
let _clockTodayStart = 0;
let _clockTodayEnd = 0;
let _clockMemo = new Map<number, string>();
/* 长会话 1000 条上限, 4000 足够覆盖且不会无限涨 */
const CLOCK_MEMO_MAX = 4000;

function _clockFormatters(locale: string, isZh: boolean): ClockFormatters {
  if (_clockLocale !== locale || !_clockFmt) {
    _clockLocale = locale;
    _clockFmt = {
      /* 中文用 24h + 冒号; 英文保持 12h AM/PM — 与老实现逐字段一致 */
      time: new Intl.DateTimeFormat(locale, isZh
        ? { hour: '2-digit', minute: '2-digit', hour12: false }
        : { hour: 'numeric', minute: '2-digit', hour12: true }),
      day: new Intl.DateTimeFormat(locale, isZh
        ? { month: 'long', day: 'numeric' }
        : { weekday: 'long' }),
    };
    _clockMemo = new Map();
  }
  return _clockFmt;
}

/** 今日边界 [start, end)。跨午夜后自动重建并清记忆 (昨天的条目要改带日期显示)。 */
function _ensureTodayWindow(): void {
  const now = Date.now();
  if (now >= _clockTodayStart && now < _clockTodayEnd) return;
  const d = new Date(now);
  _clockTodayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  /* 用 +1 天再取零点, 正确处理夏令时 (直接 +86400000 会在 DST 切换日偏 1 小时) */
  _clockTodayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  _clockMemo = new Map();
}

function formatClock(ts?: number): string | undefined {
  if (!ts || !Number.isFinite(ts)) return undefined;
  const isZh = _getUiLanguage() === 'zh';
  const locale = isZh ? 'zh-CN' : 'en-US';
  const fmt = _clockFormatters(locale, isZh);
  _ensureTodayWindow();
  const hit = _clockMemo.get(ts);
  if (hit !== undefined) return hit;
  const time = fmt.time.format(ts);
  const out = ts >= _clockTodayStart && ts < _clockTodayEnd
    ? time
    : `${fmt.day.format(ts)} ${time}`;
  if (_clockMemo.size >= CLOCK_MEMO_MAX) _clockMemo.clear();
  _clockMemo.set(ts, out);
  return out;
}

/** 测试用复位 */
export function __resetFormatClockCacheForTests(): void {
  _clockLocale = null;
  _clockFmt = null;
  _clockTodayStart = 0;
  _clockTodayEnd = 0;
  _clockMemo = new Map();
}

const TYPE_DEFAULTS: Record<string, { zh: string; en: string; iconKind: StepIconKind }> = {
  thinking:                  { zh: '思考中',        en: 'Thinking',           iconKind: 'thinking' },
  tool_call:                 { zh: '工具调用',      en: 'Tool call',          iconKind: 'task' },
  generate_image:            { zh: '生成图片',      en: 'Generate image',     iconKind: 'generate' },
  tool_result:               { zh: '工具结果',      en: 'Tool result',        iconKind: 'task' },
  tool_error:                { zh: '工具错误',      en: 'Tool error',         iconKind: 'task' },
  edit_file:                 { zh: '编辑文件',      en: 'Edit file',          iconKind: 'edit' },
  file_stream:               { zh: '写入文件',      en: 'Write file',         iconKind: 'edit' },
  plan:                      { zh: '执行计划',      en: 'Plan',               iconKind: 'task' },
  plan_update:               { zh: '计划更新',      en: 'Plan update',        iconKind: 'task' },
  context_compaction:        { zh: '上下文压缩',    en: 'Context compaction', iconKind: 'summary' },
  target_continuation:       { zh: 'Target 续跑',  en: 'Target continuing',  iconKind: 'summary' },
  log:                       { zh: '日志',          en: 'Log',                iconKind: 'summary' },
  runner_error:              { zh: '这一轮没跑成',  en: 'This turn failed',   iconKind: 'task' },

  worker_status:             { zh: 'Worker',        en: 'Worker',             iconKind: 'generate' },
  dag_execution:             { zh: 'DAG 执行',      en: 'DAG execution',      iconKind: 'task' },
  explore_status:            { zh: '探索',          en: 'Explore',            iconKind: 'search' },
  ask_user:                  { zh: '询问用户',      en: 'Ask user',           iconKind: 'task' },
  agent_delegation:          { zh: '任务派发',      en: 'Delegation',         iconKind: 'generate' },

  network_bidding:           { zh: '任务竞标',      en: 'Task bidding',       iconKind: 'generate' },
  network_agent_bid:         { zh: '子任务出价',    en: 'Subtask bid',        iconKind: 'generate' },
  network_negotiation:       { zh: '协商',          en: 'Negotiation',        iconKind: 'generate' },
  network_negotiation_message: { zh: '协商消息',    en: 'Negotiation message', iconKind: 'generate' },
  network_dag_topology:      { zh: '任务拓扑',      en: 'Task topology',      iconKind: 'task' },
  network_replan:            { zh: '重新规划',      en: 'Replan',             iconKind: 'task' },
  network_task_analysis:     { zh: '任务分析',      en: 'Task analysis',      iconKind: 'thinking' },
  network_agent_execution:   { zh: '子任务执行',    en: 'Subtask execution',  iconKind: 'generate' },
  network_mode_select:       { zh: '模式选择',      en: 'Mode select',        iconKind: 'task' },

  cron_create:               { zh: 'Cron 创建',     en: 'Cron create',        iconKind: 'summary' },
  cron_delete:               { zh: 'Cron 删除',     en: 'Cron delete',        iconKind: 'summary' },
  cron_list:                 { zh: 'Cron 列表',     en: 'Cron list',          iconKind: 'summary' },
  task_create:               { zh: '任务创建',      en: 'Task create',        iconKind: 'task' },
  task_update:               { zh: '任务更新',      en: 'Task update',        iconKind: 'task' },
  task_list:                 { zh: '任务列表',      en: 'Task list',          iconKind: 'task' },
  task_get:                  { zh: '任务查询',      en: 'Task get',           iconKind: 'task' },
  task_stop:                 { zh: '任务停止',      en: 'Task stop',          iconKind: 'task' },
  plan_enter:                { zh: '进入 Plan 模式', en: 'Enter Plan mode',   iconKind: 'task' },
  plan_exit:                 { zh: '退出 Plan 模式', en: 'Exit Plan mode',    iconKind: 'task' },
  model_switch:              { zh: '切换模型',      en: 'Switched model',     iconKind: 'task' },
  worktree_enter:            { zh: '进入 Worktree', en: 'Enter worktree',     iconKind: 'project' },
  worktree_exit:             { zh: '退出 Worktree', en: 'Exit worktree',      iconKind: 'project' },

  turn_summary:              { zh: '本轮改动',      en: 'Turn changes',       iconKind: 'diff' },
};

/** TYPE_DEFAULTS 的语言感知取值 — timeline 标题唯一合法入口 */
function typeDefaultTitle(type: string): string | undefined {
  const def = TYPE_DEFAULTS[type];
  if (!def) return undefined;
  return _getUiLanguage() === 'zh' ? def.zh : def.en;
}

function normalizedToolName(entry: TimelineEntry): string {
  return (entry.toolName || '').toLowerCase();
}

function isReadFileToolName(toolName?: string): boolean {
  const t = (toolName || '').toLowerCase().replace(/[\s-]+/g, '_');
  return (
    t === 'read' ||
    t === 'readfile' ||
    t === 'read_file' ||
    t === 'smart_read' ||
    t === 'read_multiple_files' ||
    t === 'multi_read' ||
    t === 'batch_readfile' ||
    t === 'batch_read_file' ||
    /(^|_)read(file|_file)?$/.test(t)
  );
}

function isBatchReadFileEntry(entry: TimelineEntry): boolean {
  return isReadFileToolName(normalizedToolName(entry)) && (entry.isBatch || (entry.batchTotal ?? 0) > 1);
}

/* ---------- 解包 contextual ToolResult JSON ---------- *
 * 大量工具用 `return JSON.stringify(createContextualResult(...))` 的模式,
 * entry.output 拿到的就是序列化后的 ToolResult 字符串. UI 需要先解包
 * 才能拿到真正的 content/summary, 否则会把 JSON 原文当 code 渲染. */
/* tool 名 → [zh, en] label, 给 error title 友好展示用 (P2 商业化打磨 — 不再 dump raw JSON). */
const TOOL_LABEL_FOR_ERROR: Record<string, [string, string]> = {
  edit: ['编辑', 'Edit'],
  edit_file: ['编辑', 'Edit'],
  write: ['写入', 'Write'],
  write_file: ['写入', 'Write'],
  readfile: ['读取', 'Read'],
  read: ['读取', 'Read'],
  search: ['搜索', 'Search'],
  shell: ['执行命令', 'Command'],
  bash: ['执行命令', 'Command'],
  agent: ['子代理', 'Agent'],
  ask_user: ['询问用户', 'Ask user'],
};

/** "<工具>失败" / "<Tool> failed" — error title 的语言感知拼装 */
function toolFailedTitle(tool?: string): string {
  const isZh = _getUiLanguage() === 'zh';
  const pair = tool ? TOOL_LABEL_FOR_ERROR[tool] : undefined;
  if (isZh) return `${pair ? pair[0] : '工具'}失败`;
  return `${pair ? pair[1] : 'Tool'} failed`;
}

function pickIconKind(entry: TimelineEntry): StepIconKind {
  /* log + reconnectAttempt → 重连/重试中, 用 retry 线性图标 */
  if (entry.type === 'log' && entry.reconnectAttempt !== undefined) {
    return 'retry';
  }
  if (
    entry.type === 'tool_call' ||
    entry.type === 'tool_result' ||
    entry.type === 'tool_error' ||
    entry.type === 'file_stream'
  ) {
    const t = normalizedToolName(entry);
    if (t.startsWith('mcp__')) return 'generate';
    const mapped = TOOL_TO_ICON[t];
    if (mapped) return mapped;
    if (isPluginToolName(t)) return 'plugin';
    if (/(bash|shell|exec|command|run)/i.test(t)) return 'terminal';
    if (/(grep|search|find|glob)/i.test(t)) return 'search';
    if (/(web|fetch|http|url)/i.test(t)) return 'web';
    if (/(edit|write|patch)/i.test(t)) return 'edit';
    if (/(read|open|file|tree|list|ls)/i.test(t)) return 'file';
    if (/(db|database|sql|query)/i.test(t)) return 'database';
  }
  const def = TYPE_DEFAULTS[entry.type];
  if (def) return def.iconKind;
  return 'task';
}

/**
 * 这是插件 (官方连接器) 提供的工具吗。
 *
 * 判据是**插件命名空间** (pluginBrandAssets 的 NAMESPACES: gcal_ / slack_ / linear_ …),
 * 但内置工具先排除 —— 有内置中文名或图标映射的一律不算, 免得 `github_*` 这类跟插件同名前缀的
 * 内置工具被划走。
 */
export function isPluginToolName(t: string): boolean {
  if (!t || t.startsWith('mcp__')) return false;
  if (TOOL_TO_ICON[t] || CODE_TOOL_LABEL_ZH[t] || CODE_TOOL_LABEL_EN[t] || PLAIN_TOOL_LABEL_ZH[t]) return false;
  return !!pluginLogoFromToolName(t);
}

/* ---------- status ----------
 * 严格身份判定下, pending=true 的 entry 必然对应一个真实未收敛的 tool call:
 *   · awaitingApproval=true → 等用户点同意, UI 区分态 'awaiting' (跟工具真在跑分开)
 *   · 否则 → 'running' (工具真在执行)
 * 5min STALE_PENDING_TIMEOUT_MS 兜底已删 — 配 useStreamHandler 的 toolCallIdSet 身份链路,
 * pending 永远会被对应 toolId 的 tool_result/edit_file_stream/approval_cancelled 清掉,
 * 不需要超时假装"已完成". */
/* 高负载 / 线路熔断 —— 判据走 kernel 的 category(经别名解析), 跟 ErrorView 里 isHighLoad
 * 是同一套口径; 按码前缀判会漏掉 system.busy 这类 (网关和 kernel 是两张词表). */
export function isHighLoadEntry(entry: TimelineEntry): boolean {
  const code = (entry as { errorCode?: string }).errorCode;
  if (!code) return false;
  const def = ERROR_CODES[code] ?? (ERROR_CODE_ALIASES[code] ? ERROR_CODES[ERROR_CODE_ALIASES[code]] : undefined);
  return def?.category === ErrorCategory.RETRYABLE_RATE_LIMIT;
}

/** 额度/配额用尽 (FATAL_LIMIT) —— 跟高负载一样, 是预期内的状态而不是故障.
 *  判据同样走 kernel category(经别名解析), 别按码前缀猜: 网关和 kernel 是两套词表. */
export function isQuotaLimitEntry(entry: TimelineEntry): boolean {
  const code = (entry as { errorCode?: string }).errorCode;
  if (!code) return false;
  const def = ERROR_CODES[code] ?? (ERROR_CODE_ALIASES[code] ? ERROR_CODES[ERROR_CODE_ALIASES[code]] : undefined);
  return def?.category === ErrorCategory.FATAL_LIMIT;
}

/** 搜索族工具 —— "没搜到"对它们是**结果**, 不是故障。 */
const SEARCH_FAMILY_TOOLS = new Set(['search', 'grep', 'search_files', 'glob', 'find', 'ripgrep']);
/** 没匹配 / 路径不存在 的判据 (只对搜索族生效)。 */
const NO_RESULT_RE = /ENOENT|no such file or directory|no matches|0 matches|not found|未找到|没有找到|没有匹配/i;

export function isNoResultEntry(entry: TimelineEntry): boolean {
  const tool = normalizedToolName(entry);
  if (!SEARCH_FAMILY_TOOLS.has(tool)) return false;
  const text = `${entry.errorMessage ?? ''}\n${entry.detail ?? ''}\n${entry.output ?? ''}`;
  return NO_RESULT_RE.test(text);
}

export function isTurnFatalEntry(entry: TimelineEntry): boolean {
  if (entry.type === 'runner_error') return true;
  /* 工具自己报的错 —— agent 读得到, 换个做法就是了 */
  if (entry.type === 'tool_error') return false;
  const code = (entry as { errorCode?: string }).errorCode;
  if (!code) return false;
  const def = ERROR_CODES[code] ?? (ERROR_CODE_ALIASES[code] ? ERROR_CODES[ERROR_CODE_ALIASES[code]] : undefined);
  switch (def?.category) {
    case ErrorCategory.FATAL_AUTH:      /* 登录没了 —— 不重登什么都干不了 */
    case ErrorCategory.FATAL_LIMIT:     /* 额度到顶 */
    case ErrorCategory.FATAL_CONTEXT:   /* 上下文爆了 */
    case ErrorCategory.RETRYABLE_STREAM:
    case ErrorCategory.RETRYABLE_NETWORK: /* 连不上 */
    case ErrorCategory.INTERNAL:
      return true;
    default:
      return false;
  }
}

export function pickStatus(entry: TimelineEntry): StepStatus {
  if ((entry as any).interrupted === true || (entry as any).errorReason === 'interrupted') return 'interrupted';
  /* 没搜到 → 正常完成, 不染红 (见 isNoResultEntry) */
  if (isNoResultEntry(entry)) return 'done';
  /* 「换个工具」是内部路由指令, 不是故障 (见 isToolRoutingHintEntry) */
  if (isToolRoutingHintEntry(entry)) return 'done';
  if (entry.blockedBy) return 'done';
  if (entry.type === 'tool_error' || entry.type === 'runner_error') return 'failed';
  if ((entry as any).errorCode || entry.errorMessage) return 'failed';
  if (entry.level === 'error') return 'failed';
  if (entry.success === false) return 'failed';
  if (entry.type === 'edit_file' && entry.editIsComplete === true && entry.editStreaming !== true) return 'done';
  /* 子 agent error 优先级提到 pending 之前 — 避免 agentStatus='error' + pending=true
     被误判成 running 而掩盖错误。这 4 路并列, 任一 error/failed 立即返回 failed。 */
  if (entry.agentStatus === 'error') return 'failed';
  if (entry.workerStatus === 'failed') return 'failed';
  if (entry.exploreStatus === 'error') return 'failed';
  if (entry.delegationStatus === 'error') return 'failed';
  if (entry.pending === true) {
    if (entry.awaitingApproval === true) return 'awaiting';
    return 'running';
  }
  if (entry.agentStatus === 'running' || entry.agentStatus === 'waiting') return 'running';
  if (entry.workerStatus === 'running') return 'running';
  if (entry.exploreStatus === 'running') return 'running';
  if (entry.delegationStatus === 'running') return 'running';
  if (entry.commandStatus === 'running') return 'running';
  return 'done';
}

/* ---------- title + desc ---------- */

/* Work 白话表 / PLAIN_HIDDEN_TOOL_NAMES / CODE_TOOL_LABEL_EN → ./toolLabelMaps */
export { PLAIN_HIDDEN_TOOL_NAMES };

const CODE_TOOL_LABEL_ZH: Record<string, string> = {
  ...CODE_TOOL_LABEL_ZH_EXTRA,
  execute_shell:      '执行命令',
  execute_bash:       '执行命令',
  run_shell:          '执行命令',
  run_command:        '执行命令',
  bash:               '执行命令',
  shell:              '执行命令',
  exec:               '执行命令',
  read_file:          '读取文件',
  readfile:           '读取文件',
  read:               '读取文件',
  smart_read:         '读取文件',
  read_multiple_files: '读取文件',
  write_file:         '写入文件',
  write:              '写入文件',
  edit:               '编辑文件',
  edit_file:          '编辑文件',
  multi_edit:         '编辑文件',
  search:             '搜索',
  search_files:       '搜索',
  grep:               '搜索',
  glob:               '搜索',
  knowledge_search:   '知识检索',
  tool_search:        '工具检索',
  unpack:             '加载工具',
  call_tool:          '调用工具',
  web_search:         '网络搜索',
  deep_research:      '深度调研',
  web_fetch:          '打开网页',
  websearch:          '网络搜索',
  webfetch:           '打开网页',
  show_tree:          '目录树',
  tree:               '目录树',
  list_directory:     '列目录',
  ls:                 '列目录',
  memory:             '记忆',
  save_memory:        '保存记忆',
  get_memory:         '读取记忆',
  delete_memory:      '删除记忆',
  update_memory:      '更新记忆',
  use_skill:          '使用技能',
  save_skill:         '存成技能',
  update_plan:        '更新计划',
  set_plan:           '更新计划',
  run_tests:          '运行测试',
  run_lint:           '代码检查',
  run_format:         '格式化',
  explore:            '探索',
  agent:              '子代理',
  ask_user:           '询问用户',


  /* 文件 */
  delete_file:        '删除文件',
  rename_file:        '改名',
  create_directory:   '新建文件夹',
  edit_batch:         '批量编辑',
  read_document:      '读取文档',
  sensitive_read:     '读取敏感文件',
  smart_tree:         '目录树',

  /* shell / 终端 */
  bash_output:        '查看输出',
  bash_kill:          '停止进程',
  execute_code:       '执行代码',
  execute_python:     '执行 Python',
  execute_javascript: '执行 JavaScript',
  terminal_create:    '新建终端',
  terminal_execute:   '终端执行',
  terminal_destroy:   '关闭终端',
  run_dev_server:     '启动开发服务',
  bind_run_config:    '绑定运行配置',
  register_run_config: '保存服务配置',

  /* git */
  git_status:         'Git 状态',
  git_diff:           'Git 改动',
  git_commit:         'Git 提交',
  git_branch:         'Git 分支',
  git_branch_list:    'Git 分支列表',
  git_blame:          'Git 溯源',

  /* 代码智能 */
  analyze_code:       '分析代码',
  search_symbol:      '查找符号',
  get_definitions:    '查看定义',
  get_references:     '查找引用',
  read_lints:         '读取诊断',
  build_index:        '建立索引',
  index_stats:        '索引统计',

  /* 计划 / 任务 / 目标 */
  enter_plan_mode:    '进入计划模式',
  exit_plan_mode:     '退出计划模式',
  edit_plan:          '编辑计划',
  plan_block:         '计划分块',
  plan_target:        '规划目标',
  update_todos:       '更新待办',
  task_create:        '新建任务',
  task_get:           '查看任务',
  task_list:          '任务列表',
  task_output:        '任务输出',
  task_stop:          '停止任务',
  task_update:        '更新任务',
  list_pending_tasks: '待办任务',
  finalize_task:      '收尾任务',
  activate_target:    '激活目标',
  continue_target:    '继续目标',
  pause_target:       '暂停目标',
  abandon_target:     '放弃目标',
  check_target_done:  '检查目标完成',
  ptc_execute:        '执行 PTC',

  /* worktree */
  enter_worktree:     '进入 worktree',
  exit_worktree:      '退出 worktree',

  /* 浏览器 / 画布 */
  browser:            '浏览器',
  browser_run:        '操作网页',
  check_page:         '检查网页',
  browser_replay:     '复跑录好的操作',
  browser_navigate:   '打开网页',
  open_surface:       '打开画布',
  update_surface:     '更新画布',
  close_surface:      '关闭画布',
  browser_list_surfaces: '列出画布',

  /* 知识 / 记忆 / 用户 */
  knowledge_add:      '写入知识库',
  update_profile:     '更新画像',

  /* 图像 */
  generate_image:     '生成图片',
  edit_image:         '编辑图片',

  /* 调度 / 定时 */
  cron_create:        '新建定时',
  cron_list:          '定时列表',
  cron_delete:        '删除定时',
  schedule_reminder:  '设置提醒',
  schedule_wakeup:    '设置唤醒',
  monitor_start:      '开始监控',
  monitor_poll:       '轮询监控',
  monitor_list:       '监控列表',
  monitor_stop:       '停止监控',

  /* Neox 自身 */
  neox_config:        'Neox 配置',
  read_neox_config:   '读取配置',
  write_neox_config:  '写入配置',
  neox_export_config: '导出配置',
  neox_diagnose:      'Neox 诊断',
  neox_health_check:  'Neox 体检',
  neox_list_models:   '模型列表',
  neox_switch_model:  '切换模型',
  neox_mcp_manage:    '管理 MCP',
  add_neox_provider:  '添加服务商',
  list_neox_providers: '服务商列表',
  remove_neox_provider: '删除服务商',
  set_default_neox_provider: '设为默认服务商',
  context_status:     '上下文状态',
  service_scan:       '扫描服务',
  service_adopt:      '接管服务',

  /* 调试器 */
  start_debug_session: '启动调试',
  stop_debug_session:  '停止调试',
  set_breakpoint:      '设置断点',
  remove_breakpoint:   '删除断点',
  list_breakpoints:    '断点列表',
  clear_breakpoints:   '清空断点',
  debug_continue:      '继续执行',
  debug_step_into:     '步入',
  debug_step_over:     '单步',
  debug_step_out:      '步出',
  evaluate_expression: '求值',
  get_variables:       '查看变量',
  get_stack_trace:     '调用栈',
  java_debug_launch:   'Java 启动调试',
  java_debug_attach:   'Java 附加调试',
  java_debug_stop:     'Java 停止调试',
  java_debug_continue: 'Java 继续执行',
  java_debug_step_into: 'Java 步入',
  java_debug_step_over: 'Java 单步',
  java_debug_step_out:  'Java 步出',
  java_debug_set_breakpoint: 'Java 设置断点',
  java_debug_evaluate:  'Java 求值',
  java_debug_get_variables: 'Java 查看变量',
  java_debug_get_stack_trace: 'Java 调用栈',

  /* 办公三件套 */
  create_slides:       '生成幻灯片',
  list_slide_templates: '幻灯片模板',
  import_style:        '提取 PPT 风格',
  deck_begin:          '新建演示',
  deck_add_slide:      '添加幻灯片',
  deck_export:         '导出演示',
  sheet_new_workbook:  '新建工作簿',
  sheet_write_range:   '写入单元格',
  sheet_get_range:     '读取单元格',
  sheet_describe:      '查看表格',
  sheet_export:        '导出表格',
  sheet_export_file:   '导出表格文件',
  word_create:         '新建文档',
  word_describe:       '查看文档',
  word_export:         '导出文档',
  word_to_pdf:         '导出 PDF',
  word_get_paragraphs: '读取段落',
  word_insert_paragraph: '插入段落',
  word_edit_paragraph: '编辑段落',
  word_delete_paragraph: '删除段落',
  word_replace_text:   '替换文本',
  word_get_table:      '读取表格',
  word_get_tables:     '表格列表',
  word_set_cell:       '写入表格',
  word_format_text:    '设置文字格式',
  word_insert_image:   '插入图片',
  word_insert_table:   '插入表格',
  sheet_set_cells:     '写入单元格',
  pptx_read:           '读取演示',
  pptx_replace_text:   '替换演示文字',

  /* 生活模式 */
  get_weather:         '查天气',
  calendar_add:        '添加日程',
  calendar_events:     '查看日程',
  contacts_search:     '查找联系人',
  send_imessage:       '发送信息',
  apple_reminders:     '提醒事项',
};

export function zhToolLabel(name: string): string | undefined {
  const n = name.toLowerCase();
  return PLAIN_TOOL_LABEL_ZH[n] ?? CODE_TOOL_LABEL_ZH[n];
}

function displayToolName(rawName?: string): string {
  if (!rawName) return '';
  if (rawName.startsWith('mcp__')) return rawName.replace(/^mcp__/, '');
  const isZh = _getUiLanguage() === 'zh';
  /* Work 模式: 白话映射优先, 命中就用. 未命中的 tool 走原格式 (罕见工具能兜底).
   * 语言判断走 i18n singleton (document.documentElement.lang 可能空). */
  if (_renderCtx?.agentMode === 'work') {
    const table = isZh ? PLAIN_TOOL_LABEL_ZH : PLAIN_TOOL_LABEL_EN;
    const hit = table[rawName.toLowerCase()];
    if (hit) return hit;
  }
  /* Code 模式: 常见工具动词也走双语映射, 跟 TYPE_DEFAULTS 标题语言一致 */
  const codeTable = isZh ? CODE_TOOL_LABEL_ZH : CODE_TOOL_LABEL_EN;
  const codeHit = codeTable[rawName.toLowerCase()];
  if (codeHit) return codeHit;
  const words = rawName.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function stripLeadingEmoji(s: string): string {
  if (!s) return s;
  /* 匹配开头的 emoji + 变体选择符 + 零宽连接符 + 多余空白. 用 Unicode 属性
   * (\p{Extended_Pictographic}) 覆盖各种符号 / emoji / 杂项符号. */
  return s.replace(/^(\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*\s*)+/u, '').trim();
}

function shortenPath(p?: string, max = 64): string {
  return displayWorkspacePath(p || '', _renderCtx?.workspacePath, { max, headSegments: 1, tailSegments: 3 });
}

/** 优先剥掉 workspace 前缀变成项目内相对路径, 然后再走 shortenPath 长度兜底.
 *  用户不关心 /Users/<name>/Code/<org>/<repo>/ 这一段, 只看项目内 path. */
function relAndShorten(p?: string, max = 48): string {
  return displayWorkspacePath(p || '', _renderCtx?.workspacePath, { max, headSegments: 1, tailSegments: 3 });
}


const TITLE_ARG_CLIP = 200;

/**
 * URL 折叠到 host+path 短串: 去掉 protocol/query/fragment。
 * 长度只做防爆兜底 (TITLE_ARG_CLIP), 显示截断交给 CSS。
 */
function compactUrl(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.host;
    const path = (u.pathname || '').replace(/\/+$/, '');
    const compact = path && path !== '/' ? `${host}${path}` : host;
    return compact.length > TITLE_ARG_CLIP ? compact.slice(0, TITLE_ARG_CLIP - 1) + '…' : compact;
  } catch {
    /* 不是合法 URL, 当字符串处理 */
    const s = raw.replace(/^https?:\/\//, '');
    return s.length > TITLE_ARG_CLIP ? s.slice(0, TITLE_ARG_CLIP - 1) + '…' : s;
  }
}

/**
 * shell 命令折叠到一行可读: 把多余空白压成单空格, 跳过纯 `cd <path>` 段
 * (只是切目录, 不是真干活)。长度只做防爆兜底, 显示截断交给 CSS。
 */
function compactShellCommand(raw: string): string {
  if (!raw) return '';
  let s = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  /* 去掉 leading "cd /xxx && " — 切目录不是关键操作, 真命令在后面 */
  while (/^cd\s+\S+\s*&&\s*/.test(s)) {
    s = s.replace(/^cd\s+\S+\s*&&\s*/, '').trim();
  }
  if (!s) {
    /* 只有 cd 没别的, 把原文 clip 一下当 fallback */
    s = String(raw).replace(/\s+/g, ' ').trim();
  }
  if (s.length > TITLE_ARG_CLIP) s = s.slice(0, TITLE_ARG_CLIP - 1) + '…';
  return s;
}

function summarizeProse(raw: string | undefined, max = 120): string {
  if (!raw) return '';
  /* 换行是最强的语义边界 — 先取第一个非空行, 再在行内断句 */
  const firstLine = String(raw).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const s = firstLine.replace(/\s+/g, ' ');
  if (!s) return '';
  /* 第一子句 (太短的 <12 字符继续吞下一句):
   * 全角句读 (。！？；) 后面通常没空格, 直接断; 半角 .!?; 要求后跟空白/结尾,
   * 免得 "v1.2" / "e.g." 被误切. */
  const m = s.match(/^[\s\S]{12,}?(?:[。．！？；]|[.!?;](?=\s|$))/);
  const clause = (m ? m[0] : s).trim();
  return clause.length > max ? clause.slice(0, max - 1) + '…' : clause;
}


function compactBrowserText(value: unknown, max = 64): string {
  const text = typeof value === 'string' ? value : '';
  const normalized = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 1) + '…' : normalized;
}

function pickBrowserArg(args: Record<string, any> | undefined, keys: string[]): string {
  if (!args || typeof args !== 'object') return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return compactBrowserText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function formatBrowserStepDesc(toolName: string, args: Record<string, any> | undefined): string | undefined {
  if (!/^browser[_-]/i.test(toolName || '')) return undefined;
  const isZh = _getUiLanguage() === 'zh';
  const action = toolName.replace(/^browser[_-]/i, '').toLowerCase();
  const target = pickBrowserArg(args, [
    'name', 'label', 'placeholder', 'selector', 'locator', 'target', 'textSelector',
    'ariaLabel', 'roleName', 'alt', 'title', 'text',
  ]);
  const value = pickBrowserArg(args, ['value', 'input', 'content', 'text', 'keys']);
  const url = pickBrowserArg(args, ['url', 'href']);

  if (/^(type|fill|keyboard_type|press_keys|input)$/.test(action)) {
    if (value && target && value !== target) return isZh ? `输入「${value}」到「${target}」` : `Type "${value}" into "${target}"`;
    if (value) return isZh ? `输入「${value}」` : `Type "${value}"`;
    if (target) return isZh ? `输入到「${target}」` : `Type into "${target}"`;
  }
  if (/^(click|double_click|hover|check|uncheck|select)$/.test(action)) {
    if (target) return isZh ? `点击「${target}」` : `Click "${target}"`;
  }
  if (/^(navigate|goto|open|open_url)$/.test(action)) {
    if (url) return isZh ? `打开「${compactUrl(url)}」` : `Open "${compactUrl(url)}"`;
  }
  if (/screenshot/.test(action)) return isZh ? '截图' : 'Screenshot';
  if (target || url) {
    return target || (isZh ? `打开「${compactUrl(url)}」` : `Open "${compactUrl(url)}"`);
  }
  return undefined;
}

function buildTitle(entry: TimelineEntry): string {
  /* tool 型按 toolName + target */
  if (
    entry.type === 'tool_call' ||
    entry.type === 'tool_result' ||
    entry.type === 'edit_file' ||
    entry.type === 'file_stream'
  ) {
    let effToolName = entry.toolName || '';
    let effArgs = entry.toolArgs as Record<string, unknown> | undefined;
    if (/^call_tool$/i.test(effToolName)) {
      const inner =
        (typeof effArgs?.name === 'string' && effArgs.name) ||
        (typeof effArgs?.tool === 'string' && effArgs.tool) ||
        (typeof effArgs?.tool_name === 'string' && effArgs.tool_name) ||
        '';
      if (inner) {
        effToolName = inner;
        const innerArgs = effArgs?.args ?? effArgs?.arguments ?? (effArgs as any)?.input;
        if (innerArgs && typeof innerArgs === 'object') effArgs = innerArgs as Record<string, unknown>;
      }
    }
    const name = displayToolName(effToolName);

    const toolKey = effToolName.toLowerCase();

    /* Work: 每一步说"在干什么事", 不说调了哪个工具 —— 见 workPlainPresentation.ts */
    if (_renderCtx?.agentMode === 'work') {
      const plain = plainWorkTitle(toolKey, toolKey === 'use_skill' ? { ...effArgs, name: skillTitleName(entry) } : effArgs, _getUiLanguage() === 'zh');
      if (plain) return plain;
    }

    if (/^tool_search$/.test(toolKey)) {
      const args = effArgs;
      const q = typeof args?.query === 'string' ? args.query.trim() : '';
      const pack = typeof args?.pack === 'string' ? args.pack.trim() : '';
      const toolsArr = Array.isArray(args?.tools)
        ? args.tools.filter((t: any) => typeof t === 'string').join(', ')
        : '';
      const obj = q || (pack ? `pack:${pack}` : '') || toolsArr;
      if (name && obj) return `${name} · ${obj.length > TITLE_ARG_CLIP ? obj.slice(0, TITLE_ARG_CLIP - 1) + '…' : obj}`;
    }

    /* 搜索类工具: pattern 是关键信息, targetPath 通常是默认 "." 没意义.
     *   之前 search(pattern="AGENTS.md", mode="files") 显示成 "Search · ."
     *   关键的 pattern 被埋在 args 里看不见, 跟同时跑的 explore 卡片视觉重复.
     *   现在优先取 pattern / query / keywords[] 拼到副标题. */
    if (/^(search|search_files|grep|glob|knowledge_search)$/.test(toolKey)) {
      const args = effArgs;
      const pattern =
        (typeof args?.pattern === 'string' && args.pattern) ||
        (typeof args?.query === 'string' && args.query) ||
        (Array.isArray(args?.keywords) ? args.keywords.filter((k: any) => typeof k === 'string').join(',') : '') ||
        '';
      if (name && pattern) return `${name} · ${shortenPath(pattern, TITLE_ARG_CLIP)}`;
    }

    /* 统一 memory 工具 (action: read/write/search/update_project) — 之前光秃 "Memory" 行,
     * 现在拼上动作对象 (topic/query/category). */
    if (/^memory$/.test(toolKey)) {
      const args = effArgs;
      const action = typeof args?.action === 'string' ? args.action : '';
      const isZhUi = _getUiLanguage() === 'zh';
      const actionLabel: Record<string, [string, string]> = {
        read: ['读取记忆', 'Read memory'],
        write: ['保存记忆', 'Save memory'],
        search: ['搜索记忆', 'Search memory'],
        update_project: ['更新项目记忆', 'Update project memory'],
      };
      const head = actionLabel[action] ? (isZhUi ? actionLabel[action][0] : actionLabel[action][1]) : name;
      const obj =
        (typeof args?.topic === 'string' && args.topic) ||
        (typeof args?.search_query === 'string' && args.search_query) ||
        (typeof args?.query === 'string' && args.query) ||
        (typeof args?.section === 'string' && args.section) ||
        (typeof args?.module_path === 'string' && args.module_path) ||
        (typeof args?.category === 'string' && args.category) ||
        '';
      if (head && obj) return `${head} · ${obj.length > TITLE_ARG_CLIP ? obj.slice(0, TITLE_ARG_CLIP - 1) + '…' : obj}`;
      if (head) return head;
    }

    if (toolKey === 'bash_output') {
      const t = bashOutputTitle(effArgs, bashOutputOf(entry.output), _getUiLanguage() === 'zh');
      if (t) return t;
    }

    /* shell / bash / exec 类: 折叠行只显示 "Execute shell" 信息量为 0,
       把 args.command(或 cmd / shell_command 别名)第一段拼到标题. */
    if (/^(execute_shell|execute_bash|run_shell|run_command|bash|shell|exec)$/i.test(toolKey)) {
      const args = effArgs;
      const rawCmd =
        (typeof args?.command === 'string' && args.command) ||
        (typeof args?.cmd === 'string' && args.cmd) ||
        (typeof args?.shell_command === 'string' && args.shell_command) ||
        '';
      const cmd = compactShellCommand(rawCmd);
      if (name && cmd) return `${name} · ${cmd}`;
    }

    /* Computer Use —— 裸「Computer run」对用户是零信息, 文案在 computerTimelineCard.ts */
    const computerTitle = computerToolTitle(toolKey, effArgs, _getUiLanguage() === 'zh');
    if (computerTitle) return computerTitle;

    /* 浏览器脚本 —— 同上, 文案在 browserTimelineCard.ts */
    const browserTitle = browserToolTitle(toolKey, effArgs, _getUiLanguage() === 'zh');
    if (browserTitle) return browserTitle;

    /* web_search — 把 query 拼上 */
    if (/^web_search$|^websearch$|^web-search$/i.test(toolKey)) {
      const args = effArgs;
      const q =
        (typeof args?.query === 'string' && args.query) ||
        (typeof args?.q === 'string' && args.q) ||
        (typeof args?.keyword === 'string' && args.keyword) ||
        '';
      if (name && q) return `${name} · ${q.length > TITLE_ARG_CLIP ? q.slice(0, TITLE_ARG_CLIP - 1) + '…' : q}`;
      if (name) return name;
    }

    /* web_fetch — 把 url 的 host+path 拼上 */
    if (/^web_fetch$|^webfetch$|^web-fetch$|^http_fetch$|^fetch$/i.test(toolKey)) {
      const args = effArgs;
      const url = (typeof args?.url === 'string' && args.url) || '';
      if (name && url) return `${name} · ${compactUrl(url)}`;
      if (name) return name;
    }

    /* save_memory / get_memory / delete_memory / list_memory — 显示名字 */
    if (/^(save_memory|set_memory|get_memory|delete_memory|update_memory)$/i.test(toolKey)) {
      const args = entry.toolArgs as Record<string, unknown> | undefined;
      const id =
        (typeof args?.name === 'string' && args.name) ||
        (typeof args?.key === 'string' && args.key) ||
        (typeof args?.title === 'string' && args.title) ||
        '';
      if (name && id) return `${name} · ${shortenPath(id, TITLE_ARG_CLIP)}`;
    }

    /* load_instructions — 运行时合成卡, 标题直接说人话, 不要 "Load instructions · /abs/path" */
    if (/^load_instructions$/i.test(toolKey)) {
      return _getUiLanguage() === 'zh' ? '加载项目指令' : 'Loaded project instructions';
    }

    /* use_skill — 显示 skill 名 */
    if (/^use_skill$|^useskill$|^save_skill$/i.test(toolKey)) {
      const skill = skillTitleName(entry);
      if (name && skill) return `${name} · ${shortenPath(skill, TITLE_ARG_CLIP)}`;
    }

    /* run_tests / run_lint / run_format — preset 或 command 任一 */
    if (/^(run_tests|run_lint|run_format)$/i.test(toolKey)) {
      const args = entry.toolArgs as Record<string, unknown> | undefined;
      const preset = typeof args?.preset === 'string' ? args.preset : '';
      const cmd = typeof args?.command === 'string' ? args.command : '';
      const tag = cmd
        ? compactShellCommand(cmd)
        : (preset ? preset : '');
      if (name && tag) return `${name} · ${tag}`;
    }

    if (/^(update_plan|set_plan|plan)$/i.test(toolKey)) {
      const args = entry.toolArgs as Record<string, unknown> | undefined;
      const stepArr = Array.isArray(args?.steps) ? (args!.steps as any[]) : [];
      const steps = stepArr.length;
      const done = stepArr.filter((x) => {
        const st = typeof x === 'object' && x ? (x as any).status : undefined;
        return st === 'completed' || st === 'done';
      }).length;
      const goal =
        (typeof args?.goal === 'string' && args.goal) ||
        (typeof args?.title === 'string' && args.title) ||
        '';
      const zh = _getUiLanguage() === 'zh';
      /* 有进度就显示 "2/4 步", 全未开始才退回 "4 步" */
      const stepsLabel = steps
        ? (done > 0 ? (zh ? `${done}/${steps} 步` : `${done}/${steps} steps`)
                    : (zh ? `${steps} 步` : `${steps} steps`))
        : '';
      if (name && goal) return `${name} · ${summarizeProse(goal, TITLE_ARG_CLIP)}${stepsLabel ? ` · ${stepsLabel}` : ''}`;
      if (name && stepsLabel) return `${name} · ${stepsLabel}`;
    }

    if (/^(open_surface|update_surface|close_surface|edit_plan|update_todos)$/i.test(toolKey)) {
      const args = entry.toolArgs as Record<string, unknown> | undefined;
      const isZhUi = _getUiLanguage() === 'zh';
      if (toolKey === 'open_surface' && args) {
        const kind = typeof args.kind === 'string' ? args.kind : '';
        const title = typeof args.title === 'string' ? stripLeadingEmoji(args.title) : '';
        if (kind && title) return `${title} · ${kind}`;
        if (kind) return isZhUi ? `打开 ${kind}` : `Open ${kind}`;
      }
      if (toolKey === 'edit_plan' && args) {
        const op = typeof args.op === 'string' ? args.op : '';
        const heading = typeof args.heading === 'string' ? stripLeadingEmoji(args.heading) : '';
        const opLabel: Record<string, [string, string]> = {
          content: ['全量替换', 'Replace all'],
          append: ['追加', 'Append'],
          replace_section: ['替换章节', 'Replace section'],
          set_section_status: ['设置状态', 'Set status'],
          add_note: ['添加笔记', 'Add note'],
        };
        const label = opLabel[op] ? (isZhUi ? opLabel[op][0] : opLabel[op][1]) : 'plan';
        if (heading) return `${label} · ${heading}`;
        return `plan · ${label}`;
      }
      if (toolKey === 'update_todos' && args) {
        const items = Array.isArray(args.items) ? args.items : [];
        if (items.length > 0) return isZhUi ? `待办清单 · ${items.length} 项` : `Todos · ${items.length} items`;
      }
      if (toolKey === 'update_surface') return isZhUi ? '更新 surface' : 'Update surface';
      if (toolKey === 'close_surface') return isZhUi ? '关闭 surface' : 'Close surface';
    }

    if (toolKey === 'finalize_task') {
      const isZhUi = _getUiLanguage() === 'zh';
      const t = typeof effArgs?.title === 'string' ? effArgs.title : '';
      if (t) return isZhUi ? `办完了 · ${t.slice(0, 60)}` : `Done · ${t.slice(0, 60)}`;
      return isZhUi ? '沉淀成果' : 'Save outcome';
    }
    if (toolKey === 'schedule_reminder') {
      const isZhUi = _getUiLanguage() === 'zh';
      const t = typeof effArgs?.title === 'string' ? effArgs.title : '';
      let w = typeof effArgs?.when === 'string' ? effArgs.when : '';
      /* 模型可能给 "today 20:00" / "tomorrow 8am" 这种英文相对时间, 中文界面里不协调.
       * 简单替换关键字, 保住可读性 (数字时间保持原样) */
      if (w && isZhUi) {
        w = w.replace(/\btoday\b/gi, '今天')
             .replace(/\btomorrow\b/gi, '明天')
             .replace(/\byesterday\b/gi, '昨天')
             .replace(/\bnext\s+week\b/gi, '下周')
             .replace(/\b(\d{1,2})\s*(?::(\d{2}))?\s*am\b/gi, (_m, h, min) => `${h}:${min || '00'}`)
             .replace(/\b(\d{1,2})\s*(?::(\d{2}))?\s*pm\b/gi, (_m, h, min) => `${((Number(h) % 12) + 12)}:${min || '00'}`)
             .trim();
      }
      const head = isZhUi ? '提醒' : 'Reminder';
      if (t && w) return `${head} · ${t.slice(0, 40)} (${w})`;
      if (t) return `${head} · ${t.slice(0, 60)}`;
      return isZhUi ? '定时提醒' : 'Scheduled reminder';
    }
    if (toolKey === 'list_pending_tasks') {
      return _getUiLanguage() === 'zh' ? '查看未办事项' : 'Check pending tasks';
    }

    /* call_tool — 嵌套调用,显示被调工具名 */
    if (/^call_tool$/i.test(toolKey)) {
      const args = entry.toolArgs as Record<string, unknown> | undefined;
      const inner =
        (typeof args?.tool === 'string' && args.tool) ||
        (typeof args?.tool_name === 'string' && args.tool_name) ||
        (typeof args?.name === 'string' && args.name) ||
        '';
      if (name && inner) return `${name} · ${inner}`;
    }

    /* git_diff / git_blame — 如果指了 file/path 显示 */
    if (/^git_(diff|blame|log)$/i.test(toolKey)) {
      const args = entry.toolArgs as Record<string, unknown> | undefined;
      const f =
        (typeof args?.file === 'string' && args.file) ||
        (typeof args?.path === 'string' && args.path) ||
        (typeof args?.file_path === 'string' && args.file_path) ||
        '';
      if (name && f) return `${name} · ${shortenPath(f)}`;
    }

    if (isBatchReadFileEntry(entry)) {
      const targets = Array.isArray(entry.batchTargets)
        ? entry.batchTargets.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];
      const names = targets.map((x) => x.replace(/\\/g, '/').split('/').pop() || x).filter(Boolean);
      if (name && names.length) return `${name} · ${names.slice(0, 4).join('、')}`;
    }

    if (isReadFileToolName(toolKey)) {
      const a = effArgs;
      const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const f = s(a?.file_path) || s(a?.filePath) || s(a?.path) || s(a?.file) || entry.targetPath || '';
      if (name && f) {
        const offset = n(a?.offset) ?? n(a?.start_line);
        const limit = n(a?.limit) ?? n(a?.line_count);
        const endLine = n(a?.end_line);
        /* 三种写法都归一成 "起-止": offset+limit / offset+end_line / 只有 limit (从头读) */
        let range = '';
        if (offset != null && endLine != null && endLine >= offset) range = `${offset}-${endLine}`;
        else if (offset != null && limit != null && limit > 0) range = `${offset}-${offset + limit - 1}`;
        else if (offset != null) range = `${offset}+`;
        else if (limit != null && limit > 0) range = `1-${limit}`;
        return `${name} · ${relAndShorten(f)}${range ? ` · ${range}` : ''}`;
      }
    }

    const sheetTitle = name ? sheetRowTitle(toolKey, name, effArgs as Record<string, unknown> | undefined, _getUiLanguage() === 'zh') : undefined;
    if (sheetTitle) return sheetTitle;
    const target = entry.editFilePath || (entry as any).filePath || entry.targetPath || '';
    if (name && target) return `${name} · ${relAndShorten(target)}`;
    /* 兜底再兜一层 toolArgs 的路径 — 上面那串 entry 字段是后端填的, 不是每条链路都填。
     * 任何"对某个文件做某事"的工具 (读/写/改/删/移动/格式化…) 都能因此拿到对象名,
     * 而不是留一行只有动词没有宾语的摘要。 */
    if (name) {
      const a = effArgs;
      const argPath =
        (typeof a?.file_path === 'string' && a.file_path) ||
        (typeof a?.filePath === 'string' && a.filePath) ||
        (typeof a?.path === 'string' && a.path) ||
        (typeof a?.file === 'string' && a.file) ||
        '';
      if (argPath.trim()) return `${name} · ${relAndShorten(argPath.trim())}`;
      return name;
    }
    if (target) return `${_getUiLanguage() === 'zh' ? '写入' : 'Write'} · ${relAndShorten(target)}`;
  }

  if (entry.type === 'tool_error' || entry.type === 'runner_error') {
    /* 没搜到 ≠ 搜索失败 —— 标题跟着中性化, 别让红字和中性状态打架 (见 isNoResultEntry)。 */
    if (isNoResultEntry(entry)) {
      return _getUiLanguage() === 'zh' ? '没有搜到' : 'No matches';
    }
    const msg = entry.errorMessage || entry.detail;
    if (isToolRoutingHintEntry(entry)) {
      return _getUiLanguage() === 'zh' ? '换用可用工具' : 'Switching tool';
    }
    if (isToolGuidanceEntry(entry)) {
      const s = unwrapContextualOutput(entry.errorMessage || entry.output || entry.detail)?.summary?.trim();
      if (s) return s.length > 60 ? `${s.slice(0, 60)}…` : s;
      return _getUiLanguage() === 'zh' ? '按要求调整' : 'Adjusting input';
    }
    if (isReadonlyProbeMiss(entry)) {
      const zh = _getUiLanguage() === 'zh';
      const t = String(entry.toolName ?? '').toLowerCase();
      if (/^(list_directory|list_dir|list_files|ls|show_tree|smart_tree|tree)$/.test(t)) {
        return zh ? '目录不存在' : 'Directory not found';
      }
      if (/^(read_file|readfile|read|stat|file_info|file_stat|head|tail)$/.test(t)) {
        return zh ? '文件不存在' : 'File not found';
      }
      return zh ? '没搜到' : 'No matches';
    }
    if (msg) {
      const unwrapped = unwrapContextualOutput(typeof msg === 'string' ? msg : undefined);
      if (unwrapped && unwrapped.status === 'error' && unwrapped.summary) {
        return toolFailedTitle(unwrapped.tool);
      }
    }
    /* 高负载不是"执行器错误" —— 卡片本身已经是琥珀色的"当前使用人数较多",
     * 头上再顶一行红色的"执行器错误"等于同一件事说了两种严重程度, 用户信更吓人的那个. */
    if (isHighLoadEntry(entry)) {
      return _getUiLanguage() === 'zh' ? '服务繁忙' : 'Service busy';
    }
    /* 额度用尽同理 —— 卡片正文已经把"额度用完了 / 怎么继续"说清楚了, 头上再顶一行
     * 红色的「执行器错误」等于同一件事说了两种严重程度, 用户会信更吓人的那个。 */
    if (isQuotaLimitEntry(entry)) {
      return _getUiLanguage() === 'zh' ? '额度已用尽' : 'Quota exhausted';
    }
    if (entry.toolName) {
      return toolFailedTitle(entry.toolName);
    }
    return typeDefaultTitle(entry.type) || (_getUiLanguage() === 'zh' ? '错误' : 'Error');
  }

  /* log: 优先用 entry.title (handleStreamRetry 等会写明确的"重连/限流/超时"), 没有再用默认 "日志".
   *   这条之前缺失, 导致重试期间 timeline 永远只显示 "日志", 用户看不到正在干啥. */
  if (entry.type === 'log' && entry.title) {
    return String(entry.title).split('\n')[0].slice(0, 120);
  }

  if (entry.type === 'plan' || entry.type === 'plan_update') {
    const isZhUi = _getUiLanguage() === 'zh';
    const baseTitle = entry.planTitle || typeDefaultTitle(entry.type) || (isZhUi ? '计划' : 'Plan');
    const steps = Array.isArray((entry as any).planSteps) ? (entry as any).planSteps as Array<{ content?: string; status?: string }> : [];
    const parts: string[] = [baseTitle];

    if (steps.length) {
      const done = steps.filter((x) => x.status === 'completed').length;
      const current = steps.find((x) => x.status === 'in_progress' || x.status === 'verifying')
        ?? steps.find((x) => x.status === 'pending');
      const failed = steps.find((x) => x.status === 'failed' || x.status === 'blocked');
      parts.push(`${done}/${steps.length}`);
      if (failed?.content) {
        parts.push(`${isZhUi ? '受阻' : 'blocked'}: ${summarizeProse(failed.content, TITLE_ARG_CLIP)}`);
      } else if (done === steps.length) {
        parts.push(isZhUi ? '已完成' : 'done');
      } else if (current?.content) {
        /* 当前这步才是用户想知道的 —— 不用引号包, 避免和标题里的引号打架 */
        parts.push(`${isZhUi ? '当前' : 'now'}: ${summarizeProse(current.content, TITLE_ARG_CLIP)}`);
      }
    }
    /* frozen 只做弱提示: 它解释"这张卡为什么不动了", 但不该顶掉进度信息 */
    if ((entry as any).planFrozen) parts.push(isZhUi ? '已被新计划替换' : 'superseded');
    return parts.join(' · ');
  }

  if (entry.type === 'worker_status' && entry.workerTask) {
    return `Worker · ${summarizeProse(entry.workerTask)}`;
  }
  if (entry.type === 'agent_delegation') {
    const role = entry.delegationRoleName || entry.delegationRole || '';
    const task = entry.delegationTask ? summarizeProse(entry.delegationTask) : '';
    const model = entry.delegationModel && entry.delegationModelInherited === false ? entry.delegationModel.replace(/^claude-/, '') : '';
    if (model) return `${_getUiLanguage() === 'zh' ? '交给' : 'To'} ${model}${task ? ` · ${task}` : role ? ` · ${role}` : ''}`;
    if (role && task) return `${role} · ${task}`;
    if (role) return `Agent · ${role}`;
    if (task) return `${typeDefaultTitle('agent_delegation')} · ${task}`;
    return typeDefaultTitle('agent_delegation')!;
  }
  if (entry.type === 'explore_status') {
    const role = entry.exploreRole || '';
    const task = entry.exploreTask ? summarizeProse(entry.exploreTask) : '';
    if (role && task) return `${role} · ${task}`;
    if (role) return `${typeDefaultTitle('explore_status')} · ${role}`;
    if (task) return `${typeDefaultTitle('explore_status')} · ${task}`;
    return typeDefaultTitle('explore_status')!;
  }

  /* ask_user — 取第一个问题 (自然语言, 走散文摘要不走路径缩短) */
  if (entry.type === 'ask_user' && entry.askUserQuestions?.length) {
    const head = _getUiLanguage() === 'zh' ? '询问' : 'Ask';
    return `${head} · ${summarizeProse(entry.askUserQuestions[0].question)}`;
  }

  /* 一般 tool_error 前面已处理过 */
  const defTitle = typeDefaultTitle(entry.type);
  if (defTitle) return defTitle;
  return entry.title || entry.description || entry.type;
}

/** 折叠行只放一行预览: 取首个非空行, 超长截断。正文该有的全文留给展开后的卡片。 */
function oneLinePreview(text: string, max = 120): string | undefined {
  const first = text.split('\n').map(s => s.trim()).find(Boolean);
  if (!first) return undefined;
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

function buildDesc(entry: TimelineEntry): string | undefined {
  const args = entry.toolArgs;
  const t = normalizedToolName(entry);

  if (isBatchReadFileEntry(entry)) {
    const isZh = _getUiLanguage() === 'zh';
    const targets = Array.isArray(entry.batchTargets)
      ? entry.batchTargets.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const names = targets.map((x) => x.split(/[\/]/).pop() || x).filter(Boolean);
    if (names.length > 0) {
      const shown = names.slice(0, 3).join(isZh ? '、' : ', ');
      const more = names.length > 3 ? (isZh ? ` 等 ${names.length} 个文件` : ` +${names.length - 3} more`) : '';
      return isZh ? `已读取 ${shown}${more}` : `Read ${shown}${more}`;
    }
    if (entry.batchTotal) {
      const n = `${entry.batchCompleted ?? entry.batchTotal}/${entry.batchTotal}`;
      return isZh ? `已读取 ${n} 个文件` : `Read ${n} files`;
    }
  }

  /* 这些专属 content 自带 desc, row 层不重复 */
  if (/(bash|shell|exec|command|run)/i.test(t)) return undefined;
  if (/(grep|search|find|glob)/i.test(t)) return undefined;

  if (args && typeof args === 'object') {
    const browserDesc = formatBrowserStepDesc(t, args as Record<string, any>);
    if (browserDesc) return browserDesc;
    if (typeof args.command === 'string') return args.command;
    if (typeof args.pattern === 'string') return `/${args.pattern}/`;
    if (typeof args.query === 'string') return args.query;
    if (typeof args.url === 'string') return compactUrl(args.url);
  }
  if (entry.equivalentCommand) return entry.equivalentCommand;
  if (entry.type === 'plan_update' && entry.planExplanation) return entry.planExplanation;
  if (entry.type === 'log') {
    if (entry.reconnectAttempt !== undefined) return entry.reconnectErrorCode || entry.description;
    return entry.detail || entry.description;
  }
  if (entry.type === 'worker_status' && entry.workerSummary) return oneLinePreview(entry.workerSummary);
  if (entry.type === 'agent_delegation') {
    const preview = entry.delegationSummary || entry.delegationError;
    if (preview) return oneLinePreview(preview);
  }
  if (entry.type === 'context_compaction' && entry.compactionFinalTokens != null) {
    const orig = entry.compactionOriginalTokens ?? 0;
    const fin = entry.compactionFinalTokens ?? 0;
    const saved = Math.max(0, orig - fin);
    return _getUiLanguage() === 'zh'
      ? `节省 ${saved} tokens · ${orig} → ${fin}`
      : `Saved ${saved} tokens · ${orig} → ${fin}`;
  }
  return undefined;
}

/* ---------- content: diff (edit_file / file_stream=write_file) ----------
 *
 * Cursor-style 三层一致架构:
 *   1. mapTimeline 的 coalesce pass 把 (turn, filePath) 同组的 edit_file/file_stream entry
 *      合并到 anchor entry (其它隐藏); group 数据放 _renderCtx.coalesceGroupByAnchor.
 *   2. 这里如果当前 entry 是 anchor → 拉 group + turn_summary 里的 refinedLines:
 *      a. 流式期间 (group.streaming=true) → 用最新一次 edit 的 raw hunk 渲染 (用户能看到 agent 在动)
 *      b. 完成后, turn_summary 已经 refined → 用 refinedLines 展示净 diff, 统计仍用工具累计口径
 *      c. 完成但 turn_summary 还在 async refine → 用 raw hunks 兜底 (~100ms 后切到 refined)
 *   3. 隐藏的非 anchor 不会走到这里 (mapTimeline 已经 filter).
 *
 * 不参与 coalesce 的场景 (e.g. delete / rename) 走原来的 raw hunk 渲染. */
function buildDiffContent(entry: TimelineEntry): StepContent | undefined {
  const failed = entry.type === 'tool_error'
    || entry.success === false
    || entry.level === 'error';
  if (failed) return undefined;

  const coalesceGroupByAnchor = _renderCtx && (_renderCtx as any).coalesceGroupByAnchor as
    | Map<string, { anchorId: string; turnId: string; filePath: string; entries: TimelineEntry[]; streaming: boolean }>
    | undefined;
  const group = coalesceGroupByAnchor?.get(entry.id);

  if (group) {
    return buildCoalescedFileChangeContent(group);
  }

  /* file_stream (write_file 单次, 没被 coalesce — 通常 delete 流之类不会走 file_stream, 但保留兜底) */
  if (entry.type === 'file_stream') {
    const file = (entry as any).filePath || entry.targetPath || entry.editFilePath || '';
    if (!file) return undefined;
    const body =
      (entry as any).codeContent ||
      entry.editNewString ||
      (typeof entry.output === 'string' && entry.output.includes('\n') ? entry.output : '') ||
      '';
    if (!body) return undefined;
    let raw = String(body).split('\n');
    while (raw.length > 0 && raw[0] === '') raw.shift();
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    const lines: DiffLine[] = raw.map((text, i) => ({ kind: 'add', newNo: i + 1, text }));
    return { type: 'diff', file, addCount: raw.length, delCount: 0, lines, streaming: entry.pending === true };
  }

  if (entry.type !== 'edit_file') return undefined;
  const file = entry.editFilePath || entry.targetPath || '';
  if (!file) return undefined;
  return buildRawHunkDiffContent(entry, file);
}

/* 按单条 entry 的 editHunks 渲染原始 hunk diff — coalesce 流式期 / 历史会话兜底用 */
function buildRawHunkDiffContent(entry: TimelineEntry, file: string): StepContent | undefined {
  const lines: DiffLine[] = [];
  let addCount = 0;
  let delCount = 0;
  const hunks = entry.editHunks && entry.editHunks.length > 0
    ? entry.editHunks
    : [{
        oldString: entry.editOldString,
        newString: entry.editNewString,
        startLine: entry.editStartLine,
      }];
  for (const h of hunks) {
    const startLine = h.startLine ?? 1;
    if (entry.editHunks && entry.editHunks.length > 0) {
      lines.push({ kind: 'hunk', text: `@@ -${startLine} +${startLine} @@` });
    }
    const d = editHunkLines(h.oldString ?? '', h.newString ?? '', startLine);
    lines.push(...d.lines); addCount += d.add; delCount += d.del;
  }
  return {
    type: 'diff',
    file,
    addCount,
    delCount,
    lines,
    streaming: entry.editStreaming,
    editHunks: hunks.map(h => ({
      oldString: h.oldString,
      newString: h.newString,
      startLine: h.startLine,
    })),
  };
}

/* file_stream entry → 全 add 渲染 (codeContent split). 不用 editHunks. */
function buildFileStreamRawContent(entry: TimelineEntry, file: string): StepContent | undefined {
  const body =
    (entry as any).codeContent ||
    entry.editNewString ||
    (typeof entry.output === 'string' && entry.output.includes('\n') ? entry.output : '') ||
    '';
  if (!body) return undefined;
  let raw = String(body).split('\n');
  while (raw.length > 0 && raw[0] === '') raw.shift();
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  if (raw.length === 0) return undefined;
  const lines: DiffLine[] = raw.map((text, i) => ({ kind: 'add', newNo: i + 1, text }));
  const fallbackContent = raw.join('\n');
  return {
    type: 'diff',
    file,
    addCount: raw.length,
    delCount: 0,
    lines,
    streaming: entry.pending === true,
    editHunks: fallbackContent
      ? [{ oldString: '', newString: fallbackContent, startLine: 1, newLineCount: raw.length }]
      : undefined,
    fallbackContent: fallbackContent || undefined,
    /* 覆盖已有文件时工具会留快照 —— 带上 id, Undo 才有得可走 (oldString 这里恒为空). */
    previousSnapshotId: (entry as any).previousSnapshotId || undefined,
  };
}

/* 统一的"按 entry 类型挑 raw 渲染器" — coalesce / 单卡 fallback 共享.
 * file_stream → codeContent 全 add; edit_file → editHunks. */
function buildEntryRawContent(entry: TimelineEntry, file: string): StepContent | undefined {
  if (entry.type === 'file_stream') return buildFileStreamRawContent(entry, file);
  if (entry.type === 'edit_file') return buildRawHunkDiffContent(entry, file);
  return undefined;
}

/* coalesce anchor 的渲染: 一文件一卡, 优先 refined 净 diff, 流式 / 无 refined 时 raw 兜底.
 * raw 兜底必须按 entry 类型派发 (file_stream vs edit_file), 不能假设都是 edit_file. */
function buildCoalescedFileChangeContent(group: {
  anchorId: string;
  turnId: string;
  filePath: string;
  entries: TimelineEntry[];
  streaming: boolean;
}): StepContent | undefined {
  const file = group.filePath;
  const lastEntry = group.entries[group.entries.length - 1];

  /* 流式期: 最近一次 entry 的 raw 渲染 — 让用户看到 agent 正在做什么 */
  if (group.streaming) {
    const raw = buildEntryRawContent(lastEntry, file);
    if (!raw || raw.type !== 'diff') return raw;
    return { ...raw, streaming: true, coalescedCount: group.entries.length } as any;
  }

  /* 非流式: 尝试从同 turn 的 turn_summary entry 里拉 refinedLines (Monaco 净 diff) */
  const refined = lookupRefinedDiffFor(group);
  if (refined) {
    return {
      type: 'diff',
      file,
      addCount: refined.addCount,
      delCount: refined.delCount,
      lines: refined.lines,
      streaming: false,
      coalescedCount: group.entries.length,
      /* editHunks 用所有 group entries 的 hunks 并集 — surface DiffEditor 还是能反向 apply */
      editHunks: group.entries.flatMap((e) =>
        (e.editHunks ?? []).map((h) => ({
          oldString: h.oldString,
          newString: h.newString,
          startLine: h.startLine,
          previewTruncated: (h as any).previewTruncated,
        })),
      ),
      previousSnapshotId: group.entries
        .map((e) => (e as any).previousSnapshotId)
        .find((id): id is string => typeof id === 'string' && !!id),
      fallbackContent: refined.delCount === 0 && refined.addCount > 0
        ? refined.lines.filter((l) => l.kind === 'add').map((l) => l.text).join('\n')
        : undefined,
    } as any;
  }

  /* 没 refined: 用最后一条 entry 的 raw 兜底, 等 refine 完成后 mapTimeline 重跑会切上来.
   * 关键: file_stream 走 codeContent 渲染 (raw hunks 为空), edit_file 走 hunks. */
  const fallback = buildEntryRawContent(lastEntry, file);
  if (!fallback || fallback.type !== 'diff') return fallback;
  return {
    ...fallback,
    coalescedCount: group.entries.length,
    /* 快照 id 可能挂在组内**任意一条** entry 上 (tool_result 按 byToolId/byPath 匹配,
     * 未必是 lastEntry) —— 只读 lastEntry 会漏, 跟上面 refined 分支同样做组级查找。 */
    previousSnapshotId: (fallback as any).previousSnapshotId
      || group.entries
        .map((e) => (e as any).previousSnapshotId)
        .find((id): id is string => typeof id === 'string' && !!id),
  } as any;
}

/* 从最近的 turn_summary entry 里, 找匹配 (turnId, filePath) 的 refinedLines */
function lookupRefinedDiffFor(group: { turnId: string; filePath: string }): {
  addCount: number;
  delCount: number;
  lines: DiffLine[];
} | undefined {
  if (!_renderCtx) return undefined;
  const ctx = _renderCtx;
  const entries = ctx.entries;
  /* 反向找最近一条匹配 turnId 的 turn_summary entry, 而且必须 summaryRefined=true */
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'turn_summary') continue;
    if (e.summaryTurnId !== group.turnId) continue;
    if (!(e as any).summaryRefined) return undefined;
    const change = (e.summaryChanges ?? []).find((c) => c.path === group.filePath);
    if (!change) return undefined;
    const rl = (change as any).refinedLines as DiffLine[] | undefined;
    if (!rl || rl.length === 0) return undefined;

    let addCount = change.addCount || 0;
    let delCount = change.delCount || 0;
    const userIdx = ctxIndexOfId(e.summaryTurnId);
    const summaryIdx = ctxIndexOfId(e.id);
    if (userIdx >= 0 && summaryIdx > userIdx) {
      const fresh = aggregateTurnChanges(entries.slice(userIdx, summaryIdx), ctx.workspacePath);
      const target = normalizeChangePathForDedup(group.filePath, ctx.workspacePath);
      const freshChange = fresh?.changes.find((c) =>
        normalizeChangePathForDedup(c.path, ctx.workspacePath) === target,
      );
      if (freshChange) {
        addCount = freshChange.addCount;
        delCount = freshChange.delCount;
      }
    }
    return { addCount, delCount, lines: rl };
  }
  return undefined;
}

/* bash_output (等后台进程输出) 的标题 / 内容在 bashOutputStep.ts; 这里只负责剥上下文外壳 */
function bashOutputOf(output: unknown): BashOutputResult | undefined {
  return parseBashOutputJson(typeof output === 'string' ? (unwrapContextualOutput(output)?.content ?? output) : output);
}

function buildBashOutputContent(entry: TimelineEntry): StepContent | undefined {
  if (normalizedToolName(entry) !== 'bash_output') return undefined;
  return bashOutputContent({
    r: bashOutputOf(entry.output),
    args: entry.toolArgs as Record<string, unknown> | undefined,
    rawOutput: entry.output,
    toolCallId: entry.toolCallId,
    pending: entry.pending,
  });
}

/* ---------- content: terminal ---------- */
function buildTerminalContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (!/(bash|shell|exec|command|run)/i.test(t) && !entry.commandCode) return undefined;

  const command = (() => {
    if (entry.commandCode) return entry.commandCode;
    const args = entry.toolArgs;
    if (args && typeof args === 'object' && typeof args.command === 'string') return args.command;
    if (entry.equivalentCommand) return entry.equivalentCommand;
    return undefined;
  })();

  if (!command && !entry.output && !entry.commandRawOutput) return undefined;
  // 终端 UI 读 raw stdout(commandRawOutput), 不是 LLM 看的格式化壳(output).
  // 三层兜底:
  //   1. entry.commandRawOutput  — handleShellOutputStream 流式累积 / handleToolResult 壳里挖
  //   2. 在线剥 background 壳    — formatBackgroundProcessStarted/Completed 模板, 挖 raw output
  //   3. 在线剥 foreground 壳    — formatForegroundOutput 那种 "▸ 工作目录 / ◦ stdout:" 模板
  //   4. 直接用 entry.output     — 既没 commandRawOutput 又不是壳格式, 当作 raw 显示
  //
  // 用户诉求: 卡片就显示真实终端输出, 不要看到 "Started in background. // First Ns of output..."
  // 这种 LLM-facing 模板. 任何壳都要剥, 剥完是空就显示空.
  let terminalOutput = entry.commandRawOutput;
  if (!terminalOutput && typeof entry.output === 'string') {
    const bg = stripBackgroundShell(entry.output);
    if (bg !== null) {
      terminalOutput = bg;
    } else {
      terminalOutput = stripShellResultShell(entry.output) ?? entry.output;
    }
  }
  /* pid 主源: entry.commandPid (新 entry 走 shell_stream event 设进来).
   * fallback: 老 entry / 持久化重启后 commandPid 丢失时, 从 output / commandResult 抠 "pid=NNN"
   * (formatBackgroundProcessStarted 输出模板里就有). 这样历史 shell 卡片也能挂 stop button. */
  let pid: number | undefined = typeof (entry as any).commandPid === 'number'
    ? (entry as any).commandPid : undefined;
  if (pid === undefined) {
    const haystack = (entry.commandRawOutput ?? entry.commandResult ?? entry.output ?? '') as string;
    const m = haystack.match(/\bpid\s*[=:]\s*(\d+)/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) pid = n;
    }
  }
  /* 前台让位到后台 (foregroundShellExecution 的「已转到后台继续跑」/「自动转为后台继续跑」) */
  const backgrounded = typeof entry.output === 'string' && /命令已转到后台继续跑|已自动转为后台继续跑/.test(entry.output);
  return {
    type: 'terminal',
    command,
    output: terminalOutput,
    toolId: entry.toolCallId,
    pid,
    ...(backgrounded ? { backgrounded: true } : {}),
    exitCode: backgrounded ? undefined :
      entry.commandStatus === 'error' || entry.level === 'error' || entry.success === false
        ? 1
        : entry.pending || entry.commandStatus === 'running'
        ? undefined
        : 0,
    streaming: entry.pending || entry.commandStatus === 'running',
  };
}

/** 把 executeShellWorker.formatForegroundOutput 的中文壳剥掉, 返回真 stdout/stderr.
 *  跟 useStreamHandler.extractRawStdoutFromShellResult 行为一致, 复制一份避免跨模块 import.
 *  用于 mapTimeline 在 entry 缺 commandRawOutput 时的现场 fallback (例如老 IndexedDB 数据). */
function stripShellResultShell(formatted: string): string | undefined {
  if (!formatted.includes('▸ 工作目录') && !formatted.includes('━━━')) return undefined;
  let stdout = '';
  let stderr = '';
  const stdoutMatch = formatted.match(/◦ 标准输出 \(stdout\):\n([\s\S]*?)(?=\n\n◦ 错误输出|\n\n━━━|$)/);
  if (stdoutMatch?.[1]) stdout = stdoutMatch[1].replace(/\n+$/, '');
  const stderrMatch = formatted.match(/◦ 错误输出 \(stderr\):\n([\s\S]*?)(?=\n\n━━━|$)/);
  if (stderrMatch?.[1]) stderr = stderrMatch[1].replace(/\n+$/, '');
  if (stdout && stderr) return `${stdout}\n${stderr}`;
  if (stdout) return stdout;
  if (stderr) return stderr;
  return undefined;
}

function stripBackgroundShell(formatted: string): string | null {
  /* 是不是 bg-shell 格式 — 末尾有 [bg ...] marker 行或者起首有 [services ...] preamble */
  const hasBgMarker = /\[bg (?:pid=\d+|started|exited)/.test(formatted);
  const hasServicesPreamble = /^\[services:/.test(formatted);
  if (!hasBgMarker && !hasServicesPreamble) return null;

  let body = formatted;
  /* 干掉起首 services preamble (一行或多行, 直到 \n) */
  body = body.replace(/^\[services:[^\n]*\n+/, '');
  /* 干掉末尾 [bg ...] marker 行 + 前面的空白 */
  body = body.replace(/\n*\[bg [^\]]*\]\s*$/, '');
  return body.replace(/^\n+|\n+$/g, '');
}

/* ---------- content: search ---------- */
function buildSearchContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (!SEARCH_FAMILY_TOOLS.has(t)) return undefined;

  const pattern = (() => {
    const args = entry.toolArgs;
    if (args && typeof args === 'object') {
      if (typeof args.pattern === 'string') return args.pattern;
      if (typeof args.query === 'string') return args.query;
    }
    return undefined;
  })();

  const unwrapped = unwrapContextualOutput(entry.output);

  // files 模式: metadata.files 已经是干净的文件路径数组, 直接用,
  // 比 parseSearchHits 解析正文里的 "找到 N 个文件" 那段文本要准.
  const meta = unwrapped?.metadata as { files?: unknown; mode?: unknown } | undefined;
  if (meta && Array.isArray(meta.files)) {
    const files = (meta.files as unknown[]).filter((f): f is string => typeof f === 'string');
    return {
      type: 'search',
      pattern,
      tool: t,
      totalHits: files.length,
      hits: files.slice(0, 8).map((f) => ({ file: f, text: '' })),
    };
  }

  // content 模式 / 兜底: 用解包后的 content 跑 file:line:text 解析.
  const sourceText = unwrapped?.content ?? entry.output;
  const hits = parseSearchHits(sourceText);
  return {
    type: 'search',
    pattern,
    tool: t,
    totalHits: hits?.totalHits,
    hits: hits?.rows,
  };
}

function parseSearchHits(output?: string): { totalHits: number; rows: SearchHit[] } | undefined {
  if (!output || typeof output !== 'string') return undefined;
  const allLines = output.split('\n').filter((l) => l.trim());
  if (allLines.length === 0) return undefined;

  const rows: SearchHit[] = [];
  for (const line of allLines) {
    const m = /^([^:]+?):(\d+):(.*)$/.exec(line);
    if (m) {
      rows.push({ file: m[1], line: Number(m[2]), text: m[3].trim() });
    } else {
      rows.push({ file: line.trim(), text: '' });
    }
    if (rows.length >= 8) break;
  }
  return { totalHits: allLines.length, rows };
}

/* ---------- content: plan ---------- */
function buildPlanContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'plan' && entry.type !== 'plan_update') return undefined;
  const raw = entry.planSteps ?? [];
  if (raw.length === 0) return undefined;
  const steps: PlanStepRow[] = raw.map((s) => ({
    id: s.id,
    content: s.content,
    status: s.status as PlanItemStatus,
    priority: s.priority, phase: s.phase, estimateSec: s.estimateSec,
  }));
  /* 抽落盘路径 — handleUpdatePlan 在 output JSON 里带回 { planPath: '...' } */
  let planPath: string | undefined;
  const out = entry.output;
  if (typeof out === 'string' && out.includes('"planPath"')) {
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed.planPath === 'string') planPath = parsed.planPath;
    } catch { /* not JSON, skip */ }
  }
  return {
    type: 'plan',
    goal: entry.planGoal,
    steps,
    planPath,
    frozen: (entry as any).planFrozen === true,
  };
}

/* ---------- content: thinking ---------- */
function buildThinkingContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'thinking') return undefined;
  const text = (entry.detail || entry.output || entry.description || '').trim();
  if (!text) return undefined;
  return { type: 'thinking', text };
}

/* ---------- content: instructions (项目指令加载富卡) ----------
 * 事件源不是 LLM 工具调用, 而是 runtime 合成的一对 tool_call_start/tool_call_end
 * (runtime/instructionsTimelineCard.ts). payload 跟 use_skill 同一条通道: ContextualResult
 * JSON 塞在 output 里, 这里 unwrap 回来 —— 因为 SavedTimelineEntry 上没有 metadata 列.
 *
 * 三态里只有两态会走到这:
 *   有指令读到了 / 有文件读不了. "根本没有指令文件" 在 runtime 侧就不发事件, 不出卡. */
function buildInstructionsContent(entry: TimelineEntry): StepContent | undefined {
  if (normalizedToolName(entry) !== 'load_instructions') return undefined;
  const unwrapped = unwrapContextualOutput(entry.output);
  if (!unwrapped) return undefined;
  const md = (unwrapped.metadata ?? {}) as Record<string, unknown>;

  const sources = Array.isArray(md.sources)
    ? (md.sources as unknown[]).filter((s): s is { path: string; level: 'workspace' | 'parent' | 'user'; lines: number } => {
        const o = s as Record<string, unknown> | null;
        return !!o && typeof o.path === 'string' && typeof o.lines === 'number'
          && (o.level === 'workspace' || o.level === 'parent' || o.level === 'user');
      })
    : [];
  const failures = Array.isArray(md.failures)
    ? (md.failures as unknown[]).filter((f): f is { path: string; code: string; message: string } => {
        const o = f as Record<string, unknown> | null;
        return !!o && typeof o.path === 'string' && typeof o.code === 'string' && typeof o.message === 'string';
      })
    : [];
  /* 两边都空 = 没有任何可展示的东西, 别渲一张空卡 */
  if (sources.length === 0 && failures.length === 0) return undefined;

  return {
    type: 'instructions',
    workspace: typeof md.workspace === 'string' ? md.workspace : '',
    sources,
    failures,
    chars: typeof md.chars === 'number' ? md.chars : 0,
  };
}

/* ---------- content: error ---------- */
const MODE_RESTRICTED_DENIAL_RE = /is not in the current toolset|mode-restricted or not fetched|Do NOT retry it\.?\s+Use tool_search|is not available \(it may not exist|deferred\/mode-restricted|call tool_search once/i;

/** 这条 tool_error 是不是"换个工具"的路由指令 (跟模式无关, 任何模式下都不是故障)。 */
export function isToolRoutingHintEntry(entry: TimelineEntry): boolean {
  if (entry.type !== 'tool_error' && entry.type !== 'runner_error') return false;
  const combined = `${entry.errorMessage ?? ''}\n${entry.detail ?? ''}\n${entry.output ?? ''}`;
  return MODE_RESTRICTED_DENIAL_RE.test(combined);
}
function buildErrorContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.blockedBy && entry.blockedNotice) {
    return { type: 'none' };
  }
  /* 提前拦: assistant 模式 + tool_error 且文本是 mode-restricted 教学话术 → 静默一句话 log. */
  if (entry.type === 'tool_error' || entry.type === 'runner_error') {
    if (isToolRoutingHintEntry(entry)) {
      /* 这条"错误"本质是内部换工具指令, 用户视角不该看到. 出一条极短灰 log 保留因果链. */
      const isZh = _getUiLanguage() === 'zh';
      return {
        type: 'log',
        level: 'info',
        message: isZh ? '· 换个方式试试' : '· switched tool',
      };
    }
    if (isToolGuidanceEntry(entry)) {
      const isZh = _getUiLanguage() === 'zh';
      const summary = unwrapContextualOutput(entry.errorMessage || entry.output || entry.detail)?.summary;
      return {
        type: 'log',
        level: 'info',
        message: summary ? `· ${summary}` : (isZh ? '· 按要求调整后重来' : '· adjusting input'),
      };
    }
  }
  /* 没搜到不进错误卡 —— 红底 + 「反馈」按钮是给真故障准备的 (见 isNoResultEntry)。
   * 内容退回普通渲染, 让它跟"搜到了 0 条"长得一样。 */
  if (isNoResultEntry(entry)) return undefined;
  if (entry.type !== 'tool_error' && entry.type !== 'runner_error' && !entry.errorMessage) {
    /* 兜底: 一些 tool 用 {"error": "..."} 这种裸 JSON 报错 (例如 schedule_wakeup
     * "No active session context"). 没有 errorMessage 也没有 tool_error 类型,
     * 但用户看到的就是裸 JSON 一坨, 体验比正经的 RUNNER_ERROR 卡片差很多.
     * 这里嗅探一下: tool_result 的 detail/output 是 {"error":string,...} 就当 error 渲染. */
    if (entry.type === 'tool_result') {
      const out = (entry.output || entry.detail || '').toString().trim();
      const notRegistered = out.match(/^(Tool\s+"([^"]+)"\s+not registered\.)(?:\s+(.+))?$/i);
      if (notRegistered) {
        return {
          type: 'error',
          code: 'TOOL_NOT_REGISTERED',
          message: notRegistered[1] || out,
          suggestion: notRegistered[3]?.trim()
            || `Run tool_search({ query: "${notRegistered[2] || entry.toolName || 'tool'}" }) to discover available tools.`,
        };
      }
      if (out.startsWith('{') && out.includes('"error"')) {
        try {
          const parsed = JSON.parse(out);
          if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.trim()) {
            return {
              type: 'error',
              code: typeof parsed.code === 'string' ? parsed.code : (entry.toolName || '').toUpperCase(),
              message: parsed.error.trim(),
              suggestion: typeof parsed.hint === 'string' ? parsed.hint : undefined,
            };
          }
        } catch {
          /* 不是合法 JSON, 不强行展示 — 落回 buildCodeContent */
        }
      }
    }
    return undefined;
  }
  const rawMsg = (entry.errorMessage || entry.detail || '未知错误').trim();
  const unwrapped = unwrapContextualOutput(rawMsg);
  if (unwrapped && unwrapped.status === 'error') {
    const suggestion = typeof unwrapped.metadata?.verify_hint === 'string'
      ? (unwrapped.metadata.verify_hint as string)
      : entry.errorSuggestion;
    return {
      type: 'error',
      code: entry.errorCode ?? toolFailedTitle(unwrapped.tool),
      message: unwrapped.summary || unwrapped.error || rawMsg,
      suggestion,
      action: entry.errorAction,
      repeatCount: (entry as { errorRepeatCount?: number }).errorRepeatCount,
      lastAt: formatClock((entry as { errorLastAt?: number }).errorLastAt),
      requestId: entry.errorRequestId,
    };
  }
  const friendly = friendlyUpstreamFailure(rawMsg);
  if (friendly) {
    return {
      type: 'error',
      code: entry.errorCode ?? friendly.code,
      message: friendly.message,
      suggestion: entry.errorSuggestion ?? friendly.suggestion,
      action: entry.errorAction,
      repeatCount: (entry as { errorRepeatCount?: number }).errorRepeatCount,
      lastAt: formatClock((entry as { errorLastAt?: number }).errorLastAt),
      requestId: entry.errorRequestId,
    };
  }

  return {
    type: 'error',
    code: entry.errorCode,
    message: rawMsg,
    suggestion: entry.errorSuggestion,
    action: entry.errorAction,
    repeatCount: (entry as { errorRepeatCount?: number }).errorRepeatCount,
    lastAt: formatClock((entry as { errorLastAt?: number }).errorLastAt),
    requestId: entry.errorRequestId,
    /* 同 buildCodeContent: 浏览器的失败也走 BrowserResultView, 判工具名不判标题文案 */
    isBrowser: isBrowserToolName(normalizedToolName(entry)),
  };
}

/**
 * 上游故障归类 —— 只认**不是我们的错**的那几类, 其余原样放行 (不猜)。
 *
 *   判据按"用户能做什么"分, 不按 HTTP 码堆: 限流=等/换源, 鉴权=去配 key, 网络=查代理。
 *   认不出来就返回 null, 让原文照常显示 —— 宁可显示得技术一点, 不要瞎翻译成误导。
 */
export function friendlyUpstreamFailure(raw: string):
  { code: string; message: string; suggestion: string } | null {
  const t = (raw || '').toLowerCase();
  const isZh = _getUiLanguage() === 'zh';
  if (/rate limit|too many requests|\b429\b|quota exceeded/.test(t)) {
    return {
      code: 'RATE_LIMITED',
      message: isZh ? '对方限流了, 这次没取到' : 'Upstream rate limit — request not served',
      suggestion: isZh ? '等一会儿再试, 或换一个来源 (这不是本机的问题)' : 'Wait and retry, or use a different source',
    };
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid api key|permission denied/.test(t)) {
    return {
      code: 'UPSTREAM_AUTH',
      message: isZh ? '对方拒绝了这次访问 (鉴权/权限)' : 'Upstream refused the request (auth)',
      suggestion: isZh ? '检查设置里的密钥, 或换个不需要登录的来源' : 'Check the API key in Settings, or use a source that needs no auth',
    };
  }
  if (/etimedout|econnrefused|enotfound|fetch failed|network error|socket hang up|proxy/.test(t)) {
    return {
      code: 'NETWORK',
      message: isZh ? '网络没通' : 'Network unreachable',
      suggestion: isZh ? '检查网络或代理后重试' : 'Check your connection or proxy and retry',
    };
  }
  return null;
}

/* ---------- content: readfile ---------- */
function buildReadFileContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (!isReadFileToolName(t)) return undefined;

  const args = entry.toolArgs ?? {};
  const file =
    (typeof args.file_path === 'string' && args.file_path) ||
    (typeof args.filePath === 'string' && args.filePath) ||
    (typeof args.path === 'string' && args.path) ||
    entry.targetPath ||
    '';
  if (!file) return undefined;

  const offset =
    typeof args.offset === 'number' ? args.offset :
    typeof args.start_line === 'number' ? args.start_line :
    undefined;
  const limit =
    typeof args.limit === 'number' ? args.limit :
    typeof args.end_line === 'number' && typeof offset === 'number' ? args.end_line - offset :
    undefined;

  let preview: CodeLine[] | undefined;
  let totalLines: number | undefined;
  if (typeof entry.output === 'string' && entry.output.length > 0) {
    const all = entry.output.split('\n');
    totalLines = all.length;
    preview = all.slice(0, 20).map((text) => ({ kind: 'normal', text }));
    if (all.length > 20) {
      preview.push({ kind: 'comment', text: `… +${all.length - 20} more lines` });
    }
  }

  const displayFile = relAndShorten(file, 56);
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || file;
  const directory = displayFile.includes('/') ? displayFile.slice(0, displayFile.lastIndexOf('/')) : undefined;
  const ext = (fileName.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const language = ext ? ext.toUpperCase() : undefined;

  return { type: 'readfile', file, totalLines, offset, limit, preview, displayFile, fileName, directory, language };
}

/* ---------- content: ask_user ---------- */
function buildAskUserContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'ask_user') return undefined;
  const rawQs = entry.askUserQuestions ?? [];
  if (rawQs.length === 0) return undefined;
  const answers = entry.askUserAnswers ?? {};
  const questions: AskUserQuestion[] = rawQs.map((q) => ({
    question: q.question,
    options: q.options ?? [],
    answer: answers[q.question],
  }));
  const status: 'waiting' | 'answered' | 'timeout' | 'interrupted' =
    ((entry as any).interrupted === true || (entry as any).errorReason === 'interrupted') ? 'interrupted' :
    entry.askUserStatus === 'answered' ? 'answered' :
    entry.askUserStatus === 'timeout' ? 'timeout' : 'waiting';
  return {
    type: 'askUser',
    requestId: entry.askUserRequestId,
    status,
    questions,
    error: entry.askUserError,
    attemptedAnswers: entry.askUserAttemptedAnswers,
    createdAt: (entry as any).askUserCreatedAt,
    timeoutSec: (entry as any).askUserTimeoutSec,
  };
}

/* ---------- content: web (search / fetch) ---------- */
function buildWebContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (!/(web_?search|web_?fetch|websearch|webfetch)/i.test(t)) return undefined;
  const isFetch = /fetch/i.test(t);
  const args = entry.toolArgs ?? {};
  const query = typeof args.query === 'string' ? args.query : undefined;
  const url =
    typeof args.url === 'string' ? args.url :
    typeof args.target === 'string' ? args.target : undefined;

  const unwrapped = unwrapContextualOutput(entry.output);
  const rawMeta = (() => {
    if (unwrapped?.metadata) return unwrapped.metadata;
    if (typeof entry.output !== 'string') return undefined;
    try { return (JSON.parse(entry.output) as { metadata?: unknown })?.metadata; } catch { return undefined; }
  })();
  const meta = rawMeta as {
    results?: Array<{ title?: string; url?: string; description?: string }>;
    page_title?: string; content_chars?: number; hostname?: string; query?: string;
  } | undefined;

  let results: WebResult[] | undefined;
  if (Array.isArray(meta?.results) && meta!.results!.length > 0) {
    results = meta!.results!.slice(0, 8).map((r) => ({
      title: r.title || r.url || '结果',
      url: r.url,
      snippet: r.description,
    }));
  } else if (typeof entry.output === 'string' && entry.output.trim()) {
    results = parseWebResults(entry.output);
  }

  if (isFetch && (!results || results.length === 0) && (meta?.page_title || meta?.content_chars)) {
    results = [{
      title: meta.page_title || meta.hostname || url || '页面',
      url,
      snippet: typeof meta.content_chars === 'number'
        ? (getGlobalLanguage() === 'zh' ? `正文 ${meta.content_chars} 字符` : `${meta.content_chars} chars`)
        : undefined,
    }];
  }

  const failed = entry.success === false || unwrapped?.status === 'error';
  const bytes = isFetch
    ? (failed ? 0 : (typeof (meta as any)?.fetched_bytes === 'number' ? (meta as any).fetched_bytes
        : typeof meta?.content_chars === 'number' ? meta.content_chars : 0))
    : undefined;
  const total = !isFetch
    ? (failed ? 0 : (typeof (meta as any)?.result_count === 'number' ? (meta as any).result_count : (results?.length ?? 0)))
    : undefined;

  return { type: 'web', kind: isFetch ? 'fetch' : 'search', query: query ?? meta?.query, url, results, bytes, total };
}

function buildOfficeContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.success === false || entry.pending) return undefined;
  const t = normalizedToolName(entry);
  const a = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const file = typeof a.file_path === 'string' ? a.file_path : undefined;
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  if (t === 'sheet_set_cells' && Array.isArray(a.cells)) {
    const cells = (a.cells as Array<Record<string, unknown>>)
      .filter((c) => typeof c?.cell === 'string')
      .slice(0, 60)
      .map((c) => ({ addr: String(c.cell).toUpperCase(), value: str(c.formula ?? c.value) }));
    return cells.length ? { type: 'office', kind: 'sheet', file, sheet: typeof a.sheet === 'string' ? a.sheet : undefined, cells } : undefined;
  }
  if (t === 'sheet_write_range' && Array.isArray(a.data) && typeof a.range === 'string') {
    const m = /(?:(.+)!)?([A-Z]+)(\d+)/i.exec(a.range);
    if (!m) return undefined;
    const c0 = colToNum(m[2]!);
    const r0 = Number(m[3]);
    const cells: Array<{ addr: string; value: string }> = [];
    (a.data as unknown[][]).slice(0, 20).forEach((row, ri) => {
      (Array.isArray(row) ? row : [row]).slice(0, 12).forEach((v, ci) => cells.push({ addr: `${numToCol(c0 + ci)}${r0 + ri}`, value: str(v) }));
    });
    return cells.length ? { type: 'office', kind: 'sheet', sheet: m[1], cells } : undefined;
  }
  if (t === 'word_replace_text' && typeof a.find === 'string' && typeof a.replace === 'string') {
    return { type: 'office', kind: 'doc', file, before: a.find, after: a.replace };
  }
  if ((t === 'word_edit_paragraph' || t === 'word_insert_paragraph') && typeof a.new_text === 'string') {
    const idx = typeof a.index === 'number' ? a.index : typeof a.after_index === 'number' ? a.after_index + 1 : undefined;
    return { type: 'office', kind: 'doc', file, paragraph: idx, after: a.new_text };
  }
  return undefined;
}

/**
 * 解析 web search 输出为 results 列表. 宽松 parse:
 *   · JSON 形式: [{title, url, snippet}]
 *   · Markdown 形式: "**title** url\nsnippet"
 *   · fallback: 只有 URL 的每行
 */
function parseWebResults(output: string): WebResult[] | undefined {
  const trimmed = output.trim();
  /* 1. JSON */
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<{ title?: string; url?: string; snippet?: string }>;
      if (Array.isArray(arr) && arr.length > 0) {
        return arr
          .slice(0, 8)
          .map((r) => ({ title: r.title ?? r.url ?? '结果', url: r.url, snippet: r.snippet }));
      }
    } catch {
      /* fallthrough */
    }
  }
  if (trimmed.startsWith('{')) {
    const seen = new Set<string>();
    const out: WebResult[] = [];
    for (const m of trimmed.matchAll(/https?:\/\/[^\s"'\\)\]]+/g)) {
      const u = m[0].replace(/[.,;]+$/, '');
      if (seen.has(u)) continue;
      seen.add(u);
      let host = u;
      try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
      out.push({ title: host, url: u });
      if (out.length >= 8) break;
    }
    return out.length > 0 ? out : undefined;
  }
  /* 2. Markdown-ish: 按空行分块, 每块第一行当 title, 找 url, 剩下 snippet */
  const blocks = trimmed.split(/\n\s*\n/).slice(0, 8);
  const out: WebResult[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const urlMatch = b.match(/https?:\/\/\S+/);
    const title = lines[0].replace(/^\*+/, '').replace(/\*+$/, '').replace(/^#+\s*/, '');
    const snippet = lines.slice(1).filter((l) => !/^https?:/.test(l)).join(' ').slice(0, 200);
    out.push({ title, url: urlMatch?.[0], snippet: snippet || undefined });
  }
  return out.length > 0 ? out : undefined;
}

/* ---------- content: context_compaction ---------- */
function buildCompactionContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'context_compaction') return undefined;
  return {
    type: 'compaction',
    status: entry.compactionStatus,
    originalTokens: entry.compactionOriginalTokens,
    finalTokens: entry.compactionFinalTokens,
    budgetTokens: entry.compactionBudgetTokens,
    originalMsgs: entry.compactionOriginalMessages,
    keptMsgs: entry.compactionKeptMessages,
    droppedMsgs: entry.compactionDroppedMessages,
    compressionBuckets: entry.compressionBuckets,
    compressionTotalBuckets: entry.compressionTotalBuckets,
    compressionCompletedBuckets: entry.compressionCompletedBuckets,
    compressionSummaryModel: entry.compressionSummaryModel,
    errorDetail: entry.compactionStatus === 'failed' ? compactionErrorText(entry.detail) : undefined,
  };
}

/* "Error invoking remote method 'session:compact': Error: Request aborted" → "Request aborted"
 * —— IPC 包装前缀对用户没有信息量, 真正的原因在最后一个 "Error:" 之后。 */
function compactionErrorText(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  return detail.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(Error:\s*)+/, '').trim() || undefined;
}

/* ---------- content: target_continuation ---------- */
function buildTargetContinueContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'target_continuation') return undefined;
  return {
    type: 'target_continuation',
    iteration: entry.targetContinueIteration,
    consecutiveBlocks: entry.targetContinueConsecutiveBlocks,
    kind: entry.targetContinueKind,
  };
}

/* ---------- content: worker ---------- */
function buildWorkerContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'worker_status') return undefined;
  return {
    type: 'worker',
    agentId: entry.workerAgentId,
    role: entry.roleName || entry.roleId,
    model: entry.workerModel,
    task: entry.workerTask,
    status: entry.workerStatus,
    summary: entry.workerSummary,
    error: entry.workerError,
  };
}

/* ---------- content: external agent (Codex / Claude Code 等本机 CLI) ----------
 *
 *   跟子 agent 是同一类事情, 只是跑在另一个进程里, 所以也出 Agent 卡而不是通用
 *   工具卡。数据全部来自 tool_call/tool_result 本身 —— 不需要另立一路事件。 */
function buildExternalAgentContent(entry: TimelineEntry): StepContent | undefined {
  if (!isExternalAgentTool(entry.toolName)) return undefined;
  const { agentId, displayName } = externalAgentMeta(entry.toolName!);

  /* 任务书在 toolArgs.prompt; 拿不到就不显示任务行, 不该因此不出卡 */
  const task = String((entry.toolArgs as any)?.prompt ?? '');

  const output = entry.output ?? '';
  const failed = entry.type === 'tool_error'
    || /^\S+ 未完成/.test(output)
    || /尚未连接账号|已被卸载或禁用|运行时未初始化/.test(output);
  /* 转后台的返回文本不是最终结果 —— 卡片要继续显示「运行中 · 后台」,
   * 否则用户会以为它已经结束了 */
  const detached = /已转入后台继续跑/.test(output);
  const status: 'running' | 'completed' | 'error' =
    (entry.pending || detached) ? 'running' : failed ? 'error' : 'completed';

  /* 结果正文里那句「改动在独立分支 `xxx`」是用户最容易找不到东西的地方, 提到卡片上 */
  const branch = /独立分支 `([^`]+)`/.exec(output)?.[1];
  const changed = /涉及 (\d+) 个文件/.exec(output)?.[1];

  return {
    type: 'external_agent',
    agentId,
    displayName,
    task,
    status,
    summary: output,
    error: failed ? output : undefined,
    toolCallId: entry.toolCallId,
    isBackground: detached,
    branch,
    changedFiles: changed ? new Array(Number(changed)).fill('') : undefined,
  };
}

/* ---------- content: delegation (spawn_process) ---------- */
function buildDelegationContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'agent_delegation') return undefined;
  return {
    type: 'delegation',
    role: entry.delegationRole,
    roleName: entry.delegationRoleName,
    model: entry.delegationModel,
    task: entry.delegationTask,
    status: entry.delegationStatus,
    summary: entry.delegationSummary,
    error: entry.delegationError,
    toolCount: entry.delegationToolCount,
    currentStatus: entry.delegationCurrentStatus,
    isBackground: entry.delegationIsBackground === true,
    toolRecords: entry.delegationToolRecords?.map(r => ({
      name: r.name,
      args: r.args,
      status: r.status,
      duration: r.duration,
    })),
  };
}

/* ---------- content: explore (TaskAgent) ---------- */
function buildExploreContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'explore_status') return undefined;
  return {
    type: 'explore',
    role: entry.exploreRole,
    task: entry.exploreTask,
    status: entry.exploreStatus,
    summary: (entry as any).exploreSummary,
    error: (entry as any).exploreError,
    toolCount: entry.exploreToolCount,
    tokens: entry.exploreTokens,
    elapsed: entry.exploreElapsed,
    currentStatus: entry.exploreCurrentStatus,
    toolRecords: entry.exploreToolRecords?.map((r) => ({
      name: r.name,
      agentId: r.agentId,
      args: r.args,
      status: r.status,
      duration: r.duration,
      resultHint: r.resultHint,
    })),
    groupMembers: entry.exploreGroupMembers?.map((m) => ({
      agentId: m.agentId,
      task: m.task,
      model: m.model,
      status: m.status,
      toolCount: m.toolCount,
      tokens: m.tokens,
      iterations: m.iterations,
      tokensEstimated: m.tokensEstimated,
      startedAt: m.startedAt,
      elapsed: m.elapsed,
    })),
  };
}

/* ---------- content: dag ---------- */
function buildDagContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'dag_execution') return undefined;
  return {
    type: 'dag',
    id: entry.dagId,
    description: entry.dagDescription,
    nodeCount: entry.dagNodeCount,
    completedNodes: entry.dagCompletedNodes,
    failedNodes: entry.dagFailedNodes,
    nodes: entry.dagNodes?.map((n) => ({
      id: n.id,
      name: n.name,
      status: n.status,
      agentId: n.agentId,
      duration: n.duration,
    })),
  };
}

/* ---------- content: filelist (list / ls / tree / show_tree) ---------- */
function buildFileListContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (!/^(list|ls|tree|show_tree|list_files|list_dir|read_dir)$/i.test(t)) return undefined;
  if (!entry.output || typeof entry.output !== 'string') return undefined;

  const rawLines = entry.output.split('\n').map((l) => l.replace(/\r$/, ''));
  const meaningful = rawLines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return undefined;

  const take = meaningful.slice(0, 40);
  const entries = take.map((line) => {
    /* parse tree-drawing prefix (│  ├── └── spaces) */
    const prefixMatch = line.match(/^([\s│├└─┬┴┼]+)/);
    const prefix = prefixMatch?.[0] ?? '';
    const depth = Math.min(6, Math.floor(prefix.replace(/[^\s]/g, '').length / 2));
    const clean = line.slice(prefix.length).trim();
    const isDir = clean.endsWith('/') || clean.endsWith('\\');
    return { path: clean.replace(/[/\\]$/, ''), isDir, depth };
  }).filter((e) => e.path.length > 0);

  return {
    type: 'filelist',
    root: entry.targetPath,
    entries,
    total: meaningful.length,
  };
}

/* ---------- content: log ---------- */
function buildLogContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'log') return undefined;
  let message = (entry.detail || entry.description || '').trim();
  if (!message && entry.reconnectError) {
    message = [
      entry.reconnectErrorCode ? `错误码: ${entry.reconnectErrorCode}` : null,
      entry.reconnectDelayMs ? `下次重试: ${(entry.reconnectDelayMs / 1000).toFixed(1)}s 后` : null,
      `错误详情:\n${entry.reconnectError}`,
    ].filter(Boolean).join('\n');
  }
  if (!message) return undefined;
  return { type: 'log', level: entry.level, message };
}

/* ---------- content: network_* (9 种合 1) ---------- */
const NET_MSG_TYPE_LABEL: Record<string, string> = {
  proposal: '提议',
  counter: '反提议',
  support: '支持',
  concern: '疑虑',
  vote: '投票',
  comment: '评论',
};

function short(id?: string): string {
  if (!id) return '';
  return id.length > 6 ? id.slice(0, 6) : id;
}

function buildNetworkContent(entry: TimelineEntry): StepContent | undefined {
  const t = entry.type as string;
  if (!t.startsWith('network_')) return undefined;

  switch (t) {
    case 'network_bidding': {
      const fields: Array<{ k: string; v: string | number; highlight?: boolean }> = [];
      if (entry.networkTaskId) fields.push({ k: 'taskId', v: short(entry.networkTaskId) });
      if (typeof entry.networkTotalBids === 'number') fields.push({ k: '出价数', v: entry.networkTotalBids });
      if (entry.networkTopBid) {
        fields.push({
          k: '最高',
          v: `@${short(entry.networkTopBid.agentId)} · ${Math.round((entry.networkTopBid.confidence ?? 0) * 100)}%`,
          highlight: true,
        });
      }
      const list = entry.networkSelectedAgents?.map((a) => ({ main: `@${short(a)}` }));
      return { type: 'network', variant: 'bidding', label: 'BIDDING', tone: 'primary', fields, list };
    }

    case 'network_agent_bid': {
      const fields: Array<{ k: string; v: string | number; highlight?: boolean }> = [];
      if (entry.networkAgentName) fields.push({ k: 'agent', v: entry.networkAgentName });
      if (entry.networkAgentId) fields.push({ k: 'id', v: '@' + short(entry.networkAgentId) });
      fields.push({ k: '参与', v: entry.networkParticipate ? '是' : '否', highlight: entry.networkParticipate });
      if (typeof entry.networkCapabilityScore === 'number') {
        fields.push({ k: '能力', v: `${Math.round(entry.networkCapabilityScore * 100)}%` });
      }
      if (typeof entry.networkConfidence === 'number') {
        fields.push({ k: '信心', v: `${Math.round(entry.networkConfidence * 100)}%` });
      }
      return {
        type: 'network',
        variant: 'agent_bid',
        label: 'BID',
        tone: entry.networkParticipate ? 'ok' : 'warn',
        fields,
        extra: entry.networkReason,
      };
    }

    case 'network_negotiation': {
      const fields: Array<{ k: string; v: string | number }> = [];
      if (entry.networkNegotiationId) fields.push({ k: 'id', v: short(entry.networkNegotiationId) });
      if (entry.networkNegotiationStatus) fields.push({ k: 'status', v: entry.networkNegotiationStatus });
      if (typeof entry.networkRounds === 'number') fields.push({ k: '轮次', v: entry.networkRounds });
      const list = entry.networkParticipants?.map((a) => ({ main: `@${short(a)}` }));
      const tone: 'primary' | 'ok' | 'err' =
        entry.networkNegotiationStatus === 'consensus' ? 'ok' :
        entry.networkNegotiationStatus === 'failed' ? 'err' : 'primary';
      return { type: 'network', variant: 'negotiation', label: 'NEGOTIATION', tone, fields, list };
    }

    case 'network_negotiation_message': {
      const msgType = entry.networkMessageType ?? 'comment';
      const fields: Array<{ k: string; v: string | number }> = [];
      if (entry.networkAgentName) fields.push({ k: 'agent', v: entry.networkAgentName });
      if (typeof entry.networkRound === 'number') fields.push({ k: 'round', v: entry.networkRound });
      fields.push({ k: '类型', v: NET_MSG_TYPE_LABEL[msgType] ?? msgType });
      return {
        type: 'network',
        variant: 'negotiation_message',
        label: msgType.toUpperCase(),
        tone: msgType === 'vote' ? 'primary' : 'primary',
        fields,
        extra: entry.networkContent,
      };
    }

    case 'network_dag_topology': {
      const fields: Array<{ k: string; v: string | number }> = [];
      if (entry.networkDagId) fields.push({ k: 'dagId', v: short(entry.networkDagId) });
      if (typeof entry.networkLevelCount === 'number') fields.push({ k: '层级', v: entry.networkLevelCount });
      if (entry.networkCriticalPath?.length) {
        fields.push({ k: '关键路径', v: `${entry.networkCriticalPath.length} 节点` });
      }
      const list = entry.networkDagNodes?.slice(0, 10).map((n) => ({
        main: n.name,
        sub: n.agentId ? `@${short(n.agentId)} · L${n.level}` : `L${n.level}`,
        badge: n.isCritical ? 'CRITICAL' : undefined,
      }));
      return { type: 'network', variant: 'dag_topology', label: 'TOPOLOGY', tone: 'primary', fields, list };
    }

    case 'network_replan': {
      const fields: Array<{ k: string; v: string | number }> = [];
      if (typeof entry.networkNewNodeCount === 'number') {
        fields.push({ k: '新增节点', v: entry.networkNewNodeCount });
      }
      return {
        type: 'network',
        variant: 'replan',
        label: 'REPLAN',
        tone: 'warn',
        fields,
        extra: entry.networkReplanReason,
      };
    }

    case 'network_task_analysis': {
      const fields: Array<{ k: string; v: string | number }> = [];
      if (entry.taskAnalysisComplexity) fields.push({ k: '复杂度', v: entry.taskAnalysisComplexity });
      if (typeof entry.taskAnalysisEstimatedAgents === 'number') {
        fields.push({ k: '预计 Agent', v: entry.taskAnalysisEstimatedAgents });
      }
      if (entry.taskAnalysisSuggestedMode) fields.push({ k: '建议模式', v: entry.taskAnalysisSuggestedMode });
      return {
        type: 'network',
        variant: 'task_analysis',
        label: 'ANALYSIS',
        tone: 'primary',
        fields,
        extra: entry.taskAnalysisDescription,
      };
    }

    case 'network_agent_execution': {
      const status = entry.agentExecutionStatus;
      const tone: 'primary' | 'ok' | 'err' =
        status === 'completed' ? 'ok' : status === 'failed' ? 'err' : 'primary';
      const fields: Array<{ k: string; v: string | number }> = [];
      if (entry.agentExecutionAgentName) fields.push({ k: 'agent', v: entry.agentExecutionAgentName });
      if (entry.agentExecutionNodeName) fields.push({ k: 'node', v: entry.agentExecutionNodeName });
      if (status) fields.push({ k: 'status', v: status });
      return {
        type: 'network',
        variant: 'agent_execution',
        label: 'EXECUTE',
        tone,
        fields,
        extra: entry.agentExecutionError || entry.agentExecutionOutput,
      };
    }

    case 'network_mode_select': {
      const fields: Array<{ k: string; v: string | number; highlight?: boolean }> = [];
      if (entry.modeSelectMode) fields.push({ k: '模式', v: entry.modeSelectMode, highlight: true });
      if (typeof entry.modeSelectAgentCount === 'number') {
        fields.push({ k: 'agents', v: entry.modeSelectAgentCount });
      }
      return {
        type: 'network',
        variant: 'mode_select',
        label: 'MODE',
        tone: 'primary',
        fields,
        extra: entry.modeSelectReason,
      };
    }

    default:
      return undefined;
  }
}

/* ---------- content: schedule_wakeup ---------- */
function buildWakeupContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (!/^schedule_wakeup$|^schedulewakeup$|^wakeup_self$|^self_schedule$/i.test(t)) return undefined;

  const out = (entry.output || entry.detail || '').toString().trim();
  if (!out) {
    /* tool 还没回包(running 中) — 用 args 凑一个"准备登记"占位卡, 让用户立刻看到反馈 */
    const args = entry.toolArgs ?? {};
    const reason = typeof args.reason === 'string' ? args.reason : undefined;
    const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
    const delay = typeof args.delaySeconds === 'number' ? args.delaySeconds : undefined;
    if (reason || prompt || delay) {
      return {
        type: 'wakeup',
        status: 'scheduled',
        reason,
        prompt,
        delaySeconds: delay,
      };
    }
    return undefined;
  }

  let parsed: any = null;
  try { parsed = JSON.parse(out); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const args = entry.toolArgs ?? {};

  /* 成功登记: 顶层有 wakeup_id 与 due_at_ms */
  if (typeof parsed.wakeup_id === 'string' && typeof parsed.due_at_ms === 'number') {
    return {
      type: 'wakeup',
      status: 'scheduled',
      reason: typeof args.reason === 'string' ? args.reason : undefined,
      prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
      delaySeconds: typeof parsed.effective_delay_seconds === 'number'
        ? parsed.effective_delay_seconds
        : (typeof args.delaySeconds === 'number' ? args.delaySeconds : undefined),
      dueAtMs: parsed.due_at_ms,
      dueAtIso: typeof parsed.due_at_iso === 'string' ? parsed.due_at_iso : undefined,
      clamped: parsed.clamped === true,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    };
  }

  /* skipped 分支: status:'success', skipped:true */
  if (parsed.skipped === true || parsed.status === 'success') {
    return {
      type: 'wakeup',
      status: 'skipped',
      reason: typeof args.reason === 'string' ? args.reason : undefined,
      message: typeof parsed.message === 'string'
        ? parsed.message
        : (typeof parsed.reason === 'string' ? parsed.reason : undefined),
    };
  }

  /* 其它 — 当 invalid */
  return {
    type: 'wakeup',
    status: 'invalid',
    message: typeof parsed.error === 'string'
      ? parsed.error
      : (typeof parsed.message === 'string' ? parsed.message : '未知响应'),
  };
}

/* ---------- content: context_status ---------- */
function buildContextStatusContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (!/^context_status$|^contextstatus$|^session_status$|^token_status$|^budget_status$/i.test(t)) return undefined;
  const out = (entry.output || entry.detail || '').toString().trim();
  if (!out) return undefined;
  let parsed: any = null;
  try { parsed = JSON.parse(out); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const suggestion: 'ok' | 'save_memory_soon' | 'save_memory_and_restart' | 'unknown' =
    parsed.suggestion === 'ok' ||
    parsed.suggestion === 'save_memory_soon' ||
    parsed.suggestion === 'save_memory_and_restart'
      ? parsed.suggestion
      : 'unknown';

  /* 没 snapshot 那条回包: {status, suggestion:'ok', advice, snapshot_available:false} */
  if (parsed.snapshot_available === false) {
    return {
      type: 'context_status',
      suggestion,
      advice: typeof parsed.advice === 'string' ? parsed.advice : undefined,
      snapshotAvailable: false,
    };
  }

  return {
    type: 'context_status',
    suggestion,
    advice: typeof parsed.advice === 'string' ? parsed.advice : undefined,
    snapshotAvailable: true,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
    worstPct: typeof parsed.worst_pct === 'string' ? parsed.worst_pct : undefined,
    input: parsed.input && typeof parsed.input === 'object' ? {
      used: Number(parsed.input.used_tokens) || 0,
      budget: Number(parsed.input.budget_tokens) || 0,
      pct: typeof parsed.input.pct === 'string' ? parsed.input.pct : '0%',
      compressAt: typeof parsed.input.compression_triggers_at_tokens === 'number'
        ? parsed.input.compression_triggers_at_tokens : undefined,
    } : undefined,
    output: parsed.output && typeof parsed.output === 'object' ? {
      used: Number(parsed.output.used_tokens) || 0,
      budget: Number(parsed.output.budget_tokens) || 0,
      pct: typeof parsed.output.pct === 'string' ? parsed.output.pct : '0%',
    } : undefined,
    toolCalls: parsed.tool_calls && typeof parsed.tool_calls === 'object' ? {
      used: Number(parsed.tool_calls.used) || 0,
      budget: Number(parsed.tool_calls.budget) || 0,
    } : undefined,
    time: parsed.time && typeof parsed.time === 'object' ? {
      elapsedMs: Number(parsed.time.elapsed_ms) || 0,
      budgetMs: typeof parsed.time.budget_ms === 'number' ? parsed.time.budget_ms : undefined,
    } : undefined,
    turns: parsed.turns && typeof parsed.turns === 'object' ? {
      llmCalls: Number(parsed.turns.llm_calls) || 0,
      toolCallsTotal: Number(parsed.turns.tool_calls_total) || 0,
    } : undefined,
  };
}

/* ---------- content: surface (open_surface / update_surface / edit_plan / update_todos / close_surface) ----------
 * 这些工具的 output 是 __neox_surface_event__ marker JSON, 通用 buildCodeContent 会把
 * 整段 JSON 当代码渲染出去 (不可读) 或返回空 (用户看到空卡片). 这里把 marker 解出来,
 * 显示成"动作 · 关键字段"的结构化预览, 让用户展开看到的是有意义的信息. */
function buildSurfaceContent(entry: TimelineEntry): StepContent | undefined {
  const toolName = normalizedToolName(entry);
  const surfaceTools = new Set([
    'open_surface', 'update_surface', 'close_surface',
    'edit_plan', 'update_todos',
  ]);
  if (!surfaceTools.has(toolName)) return undefined;

  const raw = entry.output || entry.detail;
  if (!raw || typeof raw !== 'string') return undefined;
  if (!raw.includes('__neox_surface_event__')) return undefined;

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return undefined; }
  if (!payload || payload.__neox_surface_event__ !== true) return undefined;

  const lines: { kind: 'normal'; text: string }[] = [];
  const push = (text: string) => lines.push({ kind: 'normal', text });

  const action = payload.action as string | undefined;
  if (action === 'open' && payload.surface) {
    const s = payload.surface;
    push(`打开 surface`);
    push(`类型: ${s.kind || '(未知)'}`);
    if (s.title) push(`标题: ${stripLeadingEmoji(String(s.title))}`);
    if (s.pinned) push(`已 pin 到右侧`);
    if (typeof s.content === 'string' && s.content.trim()) {
      push('');
      push('── 内容预览 ──');
      const preview = s.content.split('\n').slice(0, 20);
      preview.forEach((l: string) => push(l));
      const total = s.content.split('\n').length;
      if (total > 20) push(`… 还有 ${total - 20} 行 (在右侧查看全部)`);
    }
  } else if (action === 'plan_op' && payload.planOp) {
    const op = payload.planOp;
    const kindLabel: Record<string, string> = {
      content:            '全量替换 plan',
      append:             '追加到 plan',
      replace_section:    '替换章节',
      set_section_status: '设置章节状态',
      add_note:           '添加笔记',
    };
    push(kindLabel[op.kind] || `plan · ${op.kind}`);
    if (op.heading) push(`章节: ${op.heading}`);
    if (op.status) push(`状态: ${op.status}`);
    const body = op.content || op.text || op.newContent;
    if (typeof body === 'string' && body.trim()) {
      push('');
      push('── 内容预览 ──');
      const preview = body.split('\n').slice(0, 15);
      preview.forEach((l: string) => push(l));
      const total = body.split('\n').length;
      if (total > 15) push(`… 还有 ${total - 15} 行`);
    }
  } else if (action === 'update' && payload.patch) {
    push(`更新 surface`);
    Object.entries(payload.patch as Record<string, unknown>).forEach(([k, v]) => {
      const valStr = typeof v === 'string' ? v : JSON.stringify(v);
      push(`${k}: ${valStr.length > 80 ? valStr.slice(0, 80) + '…' : valStr}`);
    });
  } else if (action === 'todo_replace' && Array.isArray(payload.todoItems)) {
    const items = payload.todoItems;
    const counts = {
      done: items.filter((i: any) => i.status === 'done').length,
      in_progress: items.filter((i: any) => i.status === 'in_progress').length,
      pending: items.filter((i: any) => i.status === 'pending').length,
      skipped: items.filter((i: any) => i.status === 'skipped').length,
    };
    push(`更新 TODO 清单 · 共 ${items.length} 项`);
    push(`完成 ${counts.done} · 进行 ${counts.in_progress} · 待办 ${counts.pending} · 跳过 ${counts.skipped}`);
    push('');
    items.slice(0, 12).forEach((item: any) => {
      /* 用 line glyph 不用 emoji — 跟 op_chip 同步 flat 风格 */
      const icon = item.status === 'done' ? '✓' :
                   item.status === 'in_progress' ? '◐' :
                   item.status === 'skipped' ? '⊘' : '○';
      push(`${icon}  ${item.text || item.title || '(无标题)'}`);
    });
    if (items.length > 12) push(`… 还有 ${items.length - 12} 项 (在右侧查看)`);
  } else if (action === 'close') {
    push(`关闭 surface`);
    if (payload.surfaceId) push(`ID: ${payload.surfaceId}`);
  }

  if (lines.length === 0) return undefined;

  /* 从 payload 里抽 surfaceId/kind/title — 让 TimelineStep 在卡片头加一个 "右侧重新打开" 按钮.
   * action=open → payload.surface.id 直接拿; action=update/plan_op/todo_replace → payload.surfaceId.
   * close 不附 ref (surface 已经没了). */
  let surfaceRef: { surfaceId: string; kind: string; title?: string } | undefined;
  if (action === 'open' && payload.surface?.id) {
    surfaceRef = {
      surfaceId: String(payload.surface.id),
      kind: String(payload.surface.kind || ''),
      title: typeof payload.surface.title === 'string' ? payload.surface.title : undefined,
    };
  } else if ((action === 'update' || action === 'plan_op' || action === 'todo_replace') && payload.surfaceId) {
    surfaceRef = {
      surfaceId: String(payload.surfaceId),
      kind: String(payload.surface?.kind || payload.patch?.kind || ''),
      title: typeof payload.patch?.title === 'string' ? payload.patch.title : undefined,
    };
  }

  return { type: 'code', lines, surfaceRef };
}

/* ---------- content: op_chip (状态切换 / 简单文件操作 / 终止进程) ----------
 * 取代裸 code dump, 给 LLM 一目了然的紧凑卡 (icon + 动作 + 目标 + tone).
 *
 *   覆盖工具:
 *     enter_plan_mode / exit_plan_mode
 *     enter_worktree / exit_worktree
 *     delete_file / rename_file / create_directory
 *     bash_kill
 *   后续 commit 会扩到 cron / task_create / task_update / task_stop. */
function buildOpChipContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry);
  if (!tool) return undefined;

  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

  /* icon 字段是 OpChipIcon 命名 key, 不再用 emoji — emoji 在 macOS 是 3D 立体效果,
   * 跟 Neox 整体冷色调 / flat 风格不协调. 全部走 stroke="currentColor" 的 14px SVG. */
  switch (tool) {
    case 'enter_plan_mode':
      return {
        type: 'op_chip',
        icon: 'plan',
        label: '进入计划模式',
        hint: '审批后才执行后续操作',
        tone: 'primary',
      };
    case 'exit_plan_mode':
      return {
        type: 'op_chip',
        icon: 'play',
        label: '退出计划模式',
        hint: '计划已确认, 进入执行',
        tone: 'ok',
      };
    case 'enter_worktree': {
      const branch = asStr(args.branch) || asStr(args.name);
      return {
        type: 'op_chip',
        icon: 'worktree',
        label: '进入 worktree',
        target: branch,
        hint: 'agent 在独立分支沙箱里干活',
        tone: 'primary',
      };
    }
    case 'exit_worktree':
      return {
        type: 'op_chip',
        icon: 'worktree_exit',
        label: '退出 worktree',
        hint: '回到主工作区',
        tone: 'plain',
      };
    case 'delete_file': {
      const path = asStr(args.path) || asStr(args.file_path);
      /* 删除前工具会把内容存成快照, 结果里带一个 manifest id —— 有它才能给"撤销删除".
       * 拿不到就不渲染按钮, 而不是给一个点了会失败的按钮。 */
      let deletionSnapshotId: string | undefined;
      try {
        const raw = typeof entry.output === 'string' ? JSON.parse(entry.output) : entry.output;
        const id = (raw as any)?.metadata?.deletion_snapshot_id;
        if (typeof id === 'string' && id) deletionSnapshotId = id;
      } catch { /* 输出不是 JSON / 还没回来 —— 无按钮 */ }
      return {
        type: 'op_chip',
        icon: 'trash',
        label: '删除',
        target: path ? shortenPath(path) : undefined,
        tone: 'err',
        deletionSnapshotId,
      };
    }
    case 'rename_file': {
      const from = asStr(args.source_path) || asStr(args.path) || asStr(args.from); /* 工具入参是 source_path / destination_path (fileMutationTools.ts) */
      const to = asStr(args.destination_path) || asStr(args.new_path) || asStr(args.to);
      const targetText = from && to
        ? `${shortenPath(from)} → ${shortenPath(to)}`
        : shortenPath(from ?? to ?? '');
      return {
        type: 'op_chip',
        icon: 'pen',
        label: '改名',
        target: targetText,
        tone: 'plain',
      };
    }
    case 'create_directory': {
      const path = asStr(args.directory) || asStr(args.path) || asStr(args.dir); /* 工具入参是 directory (directoryTools.ts) */
      return {
        type: 'op_chip',
        icon: 'folder_plus',
        label: '新建文件夹',
        target: path ? shortenPath(path) : undefined,
        tone: 'ok',
      };
    }
    case 'bash_kill': {
      const pid = args.pid;
      const targetText = typeof pid === 'number' || typeof pid === 'string'
        ? `pid ${pid}`
        : undefined;
      return {
        type: 'op_chip',
        icon: 'stop',
        label: '停止后台进程',
        target: targetText,
        tone: 'warn',
      };
    }
    /* ─── task management (T2) ─── */
    case 'task_create': {
      const subject = asStr(args.subject) || asStr(args.description) || asStr(args.task);
      return {
        type: 'op_chip',
        icon: 'task',
        label: '新建任务',
        target: subject,
        tone: 'primary',
      };
    }
    case 'task_update': {
      const taskId = asStr(args.taskId) || asStr(args.id);
      const status = asStr(args.status);
      return {
        type: 'op_chip',
        icon: status === 'completed' ? 'task_done' : 'task',
        label: status ? `任务 → ${status}` : '更新任务',
        target: taskId ? `#${taskId}` : undefined,
        tone: status === 'completed' ? 'ok' : status === 'failed' ? 'err' : 'plain',
      };
    }
    case 'task_stop': {
      const taskId = asStr(args.taskId) || asStr(args.id);
      return {
        type: 'op_chip',
        icon: 'stop',
        label: '停止任务',
        target: taskId ? `#${taskId}` : undefined,
        tone: 'warn',
      };
    }
    case 'task_get': {
      const taskId = asStr(args.taskId) || asStr(args.id);
      return {
        type: 'op_chip',
        icon: 'info',
        label: '查询任务',
        target: taskId ? `#${taskId}` : undefined,
        tone: 'plain',
      };
    }
    /* ─── cron (T3) ─── */
    case 'cron_create': {
      const expr = asStr(args.cron) || asStr(args.schedule);
      const prompt = asStr(args.prompt);
      return {
        type: 'op_chip',
        icon: 'clock',
        label: '新建定时任务',
        target: expr,
        hint: prompt ? prompt.slice(0, 40) + (prompt.length > 40 ? '…' : '') : undefined,
        tone: 'primary',
      };
    }
    case 'cron_delete': {
      const id = asStr(args.id) || asStr(args.jobId);
      return {
        type: 'op_chip',
        icon: 'clock',
        label: '删除定时任务',
        target: id,
        tone: 'plain',
      };
    }
    /* ─── service discovery (T3) ─── */
    case 'service_scan':
      return {
        type: 'op_chip',
        icon: 'search',
        label: '扫描运行服务',
        tone: 'primary',
      };
    case 'service_adopt': {
      const pid = args.pid;
      return {
        type: 'op_chip',
        icon: 'plus',
        label: '接管现有服务',
        target: typeof pid === 'number' || typeof pid === 'string' ? `pid ${pid}` : undefined,
        tone: 'ok',
      };
    }
    /* Target Mission 4 工具走独立 buildTargetOpContent (target_op type,
     * 铺满 + 中性淡背景, 不使用 op_chip 紫色 inline 胶囊). 见下方 builder. */
    default:
      return undefined;
  }
}

/* ---------- content: target_op — Target Mission 四工具铺满卡 ----------
 * activate_target / plan_target / check_target_done / abandon_target
 * 样式对齐 .atl-explore 家族 (中性 fg 3% 淡底 + radius 8 + 无 border), 铺满宽度,
 * 内容完整 (target 文本完整显示 word-break, 不 slice; 由 CSS 处理换行). */
function buildTargetOpContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry);
  if (tool !== 'activate_target' && tool !== 'plan_target'
    && tool !== 'check_target_done' && tool !== 'abandon_target') return undefined;
  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  if (tool === 'activate_target') {
    return {
      type: 'target_op',
      variant: 'activate',
      label: '激活 Target',
      target: asStr(args.target),
      note: asStr(args.rationale),
      tone: 'primary',
    };
  }
  if (tool === 'plan_target') {
    const subs = Array.isArray(args.sub_missions) ? args.sub_missions : [];
    const subMissions = subs
      .map((sm: any, i: number) => {
        const id = typeof sm?.id === 'string' && sm.id.trim() ? sm.id.trim() : `b${i + 1}`;
        const description = asStr(sm?.description);
        const successCriteria = asStr(sm?.success_criteria);
        const status: 'pending' | 'in_progress' | 'completed' =
          sm?.status === 'in_progress' || sm?.status === 'completed' ? sm.status : 'pending';
        return description ? { id, description, successCriteria, status } : null;
      })
      .filter(Boolean) as Array<{ id: string; description: string; successCriteria?: string; status: 'pending' | 'in_progress' | 'completed' }>;
    const completedSubMissions = subMissions.filter((s) => s.status === 'completed').length;
    return {
      type: 'target_op',
      variant: 'plan',
      label: '声明 Plan',
      target: asStr(args.target),
      note: asStr(args.rationale),
      subMissionCount: subs.length || undefined,
      subMissions: subMissions.length ? subMissions : undefined,
      completedSubMissions,
      tone: 'primary',
    };
  }
  if (tool === 'check_target_done') {
    const done = args.done === true;
    return {
      type: 'target_op',
      variant: done ? 'done_true' : 'done_false',
      label: done ? 'Target 达成' : '继续推进',
      note: asStr(args.reason),
      tone: done ? 'ok' : 'plain',
    };
  }
  // abandon_target
  return {
    type: 'target_op',
    variant: 'abandon',
    label: '放弃 Target',
    note: asStr(args.reason),
    tone: 'err',
  };
}

/* ---------- content: git_diff — 复用 'diff' variant (parse unified diff) ----------
 * git_diff 工具的输出就是 `git diff` 标准 unified format. 复用 edit_file 的 DiffView
 * 直接渲染 (双栏 + 行号 + +/- 高亮), 比裸 code 强不止一点点. */
const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
function buildVcsDiffContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry);
  if (tool !== 'git_diff') return undefined;
  const unwrapped = unwrapContextualOutput(entry.output || entry.detail);
  const raw = unwrapped?.content?.trim() || (entry.output || entry.detail || '').trim();
  if (!raw || typeof raw !== 'string') return undefined;
  /* 没有 hunk header 说明 diff 为空 (working tree clean) */
  if (!raw.includes('@@')) {
    return { type: 'op_chip', icon: 'commit', label: 'git diff', hint: 'no changes', tone: 'plain' };
  }
  /* 简易 unified diff parser — 只取第一个文件的 hunks (timeline 卡只看主要变动);
   * 多文件 diff 想全看用 git_diff 工具完整输出, 这里目的是 inline 快览. */
  const lines: DiffLine[] = [];
  let file: string | undefined;
  let oldLn = 0;
  let newLn = 0;
  let addCount = 0;
  let delCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const m = line.match(/^\+\+\+\s+b?\/?(.+?)(\t|$)/);
      if (m && !file) file = m[1].trim();
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ')) continue;
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      oldLn = parseInt(hunkMatch[1], 10);
      newLn = parseInt(hunkMatch[3], 10);
      lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.length === 0) { lines.push({ kind: 'ctx', text: '', oldNo: oldLn, newNo: newLn }); oldLn++; newLn++; continue; }
    const sigil = line.charAt(0);
    const text = line.slice(1);
    if (sigil === '+') { lines.push({ kind: 'add', text, newNo: newLn }); newLn++; addCount++; }
    else if (sigil === '-') { lines.push({ kind: 'del', text, oldNo: oldLn }); oldLn++; delCount++; }
    else if (sigil === ' ') { lines.push({ kind: 'ctx', text, oldNo: oldLn, newNo: newLn }); oldLn++; newLn++; }
    /* '\' (No newline at end of file) 等忽略 */
  }
  if (lines.length === 0) return undefined;
  return {
    type: 'diff',
    file: file || 'git diff',
    addCount,
    delCount,
    lines,
    streaming: false,
  };
}

/* ---------- content: git_commit — op_chip 显示 hash + subject ----------
 * git_commit 成功后输出包含 "[branch hash] subject" 模式 (git 内置), 提取出来. */
function buildVcsCommitContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry);
  if (tool !== 'git_commit') return undefined;
  const unwrapped = unwrapContextualOutput(entry.output || entry.detail);
  const raw = unwrapped?.content?.trim() || (entry.output || entry.detail || '').trim();
  if (!raw || typeof raw !== 'string') return undefined;
  /* 失败时 unwrapped.status === 'error' 或 stdout 含 nothing to commit */
  const isFail = unwrapped?.status === 'error' || /nothing to commit|fatal:/i.test(raw);
  if (isFail) {
    const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
    const msg = typeof args.message === 'string' ? args.message.slice(0, 60) : undefined;
    return { type: 'op_chip', icon: 'commit', label: 'git commit', target: msg, hint: 'nothing to commit', tone: 'warn' };
  }
  /* 抽 [branch hash] subject 这一行 */
  const m = raw.match(/^\[([^\s\]]+)\s+([0-9a-f]{4,40})(?:\s[^\]]*)?\]\s+(.+)$/m);
  if (m) {
    const branch = m[1];
    const hash = m[2].slice(0, 7);
    const subject = m[3].length > 60 ? m[3].slice(0, 57) + '…' : m[3];
    return {
      type: 'op_chip',
      icon: 'commit',
      label: `commit ${hash}`,
      target: subject,
      hint: branch,
      tone: 'ok',
    };
  }
  /* fallback: 没匹配 [branch hash] 就给简洁 op_chip */
  return { type: 'op_chip', icon: 'commit', label: 'git commit', tone: 'ok' };
}

/* ---------- content: task_list — 用 plan variant 渲染 ----------
 * task_list 输出 { tasks: [{ id, subject, status, owner, blockedBy }], total }.
 * 跟 PlanStepRow 结构 1:1 对应, 直接 map. */
function buildTaskListContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry);
  if (tool !== 'task_list') return undefined;
  const unwrapped = unwrapContextualOutput(entry.output || entry.detail);
  const raw = unwrapped?.content ?? entry.output ?? entry.detail;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    const tasks: any[] = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    if (tasks.length === 0) return { type: 'op_chip', icon: 'task', label: '任务列表为空', tone: 'plain' };
    const steps: PlanStepRow[] = tasks.map((t: any) => {
      const rawStatus = String(t.status || 'pending').toLowerCase();
      const status: PlanItemStatus =
        rawStatus === 'in_progress' ? 'in_progress' :
        rawStatus === 'completed' ? 'completed' :
        rawStatus === 'failed' ? 'failed' :
        rawStatus === 'blocked' ? 'blocked' :
        rawStatus === 'skipped' ? 'skipped' :
        'pending';
      return {
        id: String(t.id ?? ''),
        content: String(t.subject ?? t.description ?? t.id ?? ''),
        status,
      };
    });
    return { type: 'plan', goal: `任务列表 (${tasks.length})`, steps };
  } catch {
    return undefined;
  }
}

/* ---------- content: cron_list — 用 plan variant 渲染 (status 都标 pending = 等触发) ----------
 * cron_list 输出 { jobs: [{ id, cron, humanSchedule, prompt, nextRun, recurring }], total }. */
function buildCronListContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry);
  if (tool !== 'cron_list') return undefined;
  const unwrapped = unwrapContextualOutput(entry.output || entry.detail);
  const raw = unwrapped?.content ?? entry.output ?? entry.detail;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    const jobs: any[] = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    if (jobs.length === 0) return { type: 'op_chip', icon: 'clock', label: '没有定时任务', tone: 'plain' };
    const steps: PlanStepRow[] = jobs.map((j: any) => ({
      id: String(j.id ?? ''),
      content: `${j.cron ?? ''}  ·  ${j.humanSchedule ?? j.nextRun ?? ''}  ·  ${String(j.prompt ?? '').slice(0, 60)}`,
      status: 'pending',
    }));
    return { type: 'plan', goal: `定时任务 (${jobs.length})`, steps };
  } catch {
    return undefined;
  }
}

/* ---------- content: code (fallback) ---------- */
function buildReadDocContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry);
  if (tool !== 'read_document') return undefined;
  const out = entry.output || entry.detail;
  if (!out || typeof out !== 'string') return undefined;
  const trimmed = out.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object') return undefined;
    if (!obj.status && !obj.chars && !obj.markdown && !obj.error) return undefined;
    const args = entry.toolArgs as Record<string, unknown> | undefined;
    let fileName: string | undefined =
      (typeof args?.path === 'string' && args.path) ||
      (typeof args?.file === 'string' && args.file) ||
      (typeof args?.file_path === 'string' && args.file_path) ||
      (typeof args?.filename === 'string' && args.filename) ||
      undefined;
    if (!fileName && typeof obj.file_id === 'string') {
      fileName = obj.file_id.slice(0, 8) + '…';
    }
    if (!fileName && entry.description) {
      const m = entry.description.match(/[\w\-]+\.\w{2,5}/);
      if (m) fileName = m[0];
    }
    let sizeLabel: string | undefined;
    if (typeof obj.chars === 'number') {
      const c = obj.chars;
      sizeLabel = c >= 10000 ? `${(c / 1000).toFixed(1)}K` : c >= 1000 ? `${(c / 1000).toFixed(1)}K` : `${c}`;
      sizeLabel += ' 字符';
    }
    const kb = typeof obj.chars === 'number' ? (obj.chars * 2 / 1024) : undefined;
    const kbLabel = kb ? (kb >= 1 ? `${kb.toFixed(1)} KB` : undefined) : undefined;
    return {
      type: 'readdoc',
      status: obj.status || (obj.error ? 'error' : 'success'),
      fileName: fileName || '文档',
      chars: typeof obj.chars === 'number' ? obj.chars : undefined,
      sizeLabel: [sizeLabel, kbLabel].filter(Boolean).join(' · '),
    };
  } catch { return undefined; }
}


function extractJsonObjectText(input: string): string | undefined {
  const start = input.search(/[\[{]/);
  if (start < 0) return undefined;
  const open = input[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return input.slice(start).trim();
}

function collectImageDataUrls(payload: any): string[] {
  const srcs: string[] = [];
  const visit = (value: any): void => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== 'object') return;
    const data = typeof value.data === 'string'
      ? value.data
      : (typeof value.base64 === 'string' ? value.base64 : '');
    if (data) {
      const mime = typeof value.mimeType === 'string'
        ? value.mimeType
        : (typeof value.mime === 'string'
          ? value.mime
          : (typeof value.format === 'string' ? `image/${value.format}` : 'image/png'));
      srcs.push(data.startsWith('data:') ? data : `data:${mime};base64,${data}`);
    }
    if (value.image) visit(value.image);
    if (value.images) visit(value.images);
  };
  visit(payload);
  return srcs;
}

function buildPlainActionContent(entry: TimelineEntry): StepContent | undefined {
  const tool = normalizedToolName(entry).toLowerCase();
  const isPlainTool =
    tool === 'schedule_reminder' ||
    tool === 'list_pending_tasks' ||
    tool === 'get_weather' ||
    tool === 'update_profile' ||
    tool === 'calendar_events' ||
    tool === 'calendar_add' ||
    tool === 'apple_reminders' ||
    tool === 'contacts_search' ||
    tool === 'send_imessage';
  if (!isPlainTool) return undefined;
  const out = entry.output || entry.detail;
  /* 运行中 (无 output) 但工具已识别 → 返回 pending log 免于露 raw args JSON */
  if (!out || typeof out !== 'string') {
    if (tool === 'update_profile') return { type: 'log', level: 'info', message: '记住这条…' };
    if (tool === 'send_imessage') return { type: 'log', level: 'info', message: '发消息中…' };
    if (tool === 'calendar_add') return { type: 'log', level: 'info', message: '加日程中…' };
    if (tool === 'apple_reminders') return { type: 'log', level: 'info', message: '加提醒中…' };
    if (tool === 'calendar_events') return { type: 'log', level: 'info', message: '翻日历中…' };
    if (tool === 'contacts_search') return { type: 'log', level: 'info', message: '查联系人中…' };
    return undefined;
  }
  /* 尝试解 JSON, 失败也不慌 —— 直接显示 output 摘要 */
  let obj: Record<string, unknown> | null = null;
  const jsonStart = out.indexOf('{');
  if (jsonStart >= 0) {
    try { obj = JSON.parse(out.slice(jsonStart)) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

  if (tool === 'schedule_reminder') {
    const title = asStr(args.title) || asStr(obj?.title) || asStr(args.message) || '';
    const scheduledAtText = asStr(obj?.scheduledAt) || asStr(args.when);
    const recurrence = asStr(args.recurrence) || asStr(obj?.recurrence);
    const context = asStr(args.context) || asStr(obj?.context);
    const status = asStr(obj?.status);
    /* 失败仍走 log 走 error 提示 */
    if (status === 'error' || asStr(obj?.error)) {
      return { type: 'log', level: 'error', message: `✗ 提醒设置失败: ${asStr(obj?.error) || asStr(obj?.message) || '未知错误'}` };
    }
    return {
      type: 'timer_card',
      subKind: 'reminder',
      status: 'scheduled',
      title: title || '提醒',
      context,
      atText: scheduledAtText,
      recurrence: recurrence && recurrence !== 'once' ? recurrence : undefined,
    };
  }

  if (tool === 'get_weather') {
    /* 成功结果 = 卡片 JSON 本身 → 直接喂 NeoxCard weather (回答区同款卡);
     * 找不到地点等错误走 error log。任何状态都不 return undefined —
     * 否则落到 buildCodeContent 兜底, 运行中/未解析瞬间会闪 raw JSON。 */
    if (obj?.error) {
      return { type: 'log', level: 'error', message: `✗ ${String(obj.error)}` };
    }
    if (obj && obj.current) {
      return { type: 'neox_card', kind: 'weather', body: JSON.stringify(obj) };
    }
    return { type: 'log', level: 'info', message: '正在查询天气…' };
  }

  if (tool === 'list_pending_tasks') {
    /* 结果里是 reminders[] (老会话还可能带 outcomes[] / hints[]). 抽 count 展示. */
    const outcomes = Array.isArray(obj?.outcomes) ? obj.outcomes as unknown[] : [];
    const reminders = Array.isArray(obj?.reminders) ? obj.reminders as unknown[] : [];
    const total = outcomes.length + reminders.length;
    if (total === 0) return { type: 'log', level: 'info', message: '✓ 没有待办的提醒' };
    return { type: 'log', level: 'info', message: `待办提醒 · ${total} 条` };
  }

  if (tool === 'update_profile') {
    /* 静默一句话: agent 每存一条事实都出一行 "记住了: X". args 通常有 add/remove/section/entry.
     * 存在错误(如 tool 返回 error 字段)才用 error level. */
    if (obj?.error) return { type: 'log', level: 'error', message: `✗ 档案更新失败: ${String(obj.error)}` };
    const add = asStr(args.add) || asStr(args.entry) || asStr(args.text) || asStr(args.value);
    const remove = asStr(args.remove);
    const section = asStr(args.section) || asStr(obj?.section);
    if (remove) return { type: 'log', level: 'info', message: `✓ 忘掉了: ${remove}${section ? ` · ${section}` : ''}` };
    if (add) return { type: 'log', level: 'info', message: `✓ 记住了: ${add}${section ? ` · ${section}` : ''}` };
    return { type: 'log', level: 'info', message: '✓ 档案已更新' };
  }

  if (tool === 'calendar_events') {
    /* macOS 日历返回 events[]. 无事件也要人话. */
    const errMsg = asStr(obj?.error) || asStr(obj?.errorMessage) || asStr(obj?.message) || (obj?.timeout ? '超时' : '');
    if (errMsg) return { type: 'log', level: 'error', message: `✗ 读日历没成功: ${errMsg}${/权限|permission|-1743|not authorized/i.test(errMsg) ? ' (可能需要在系统设置→隐私→自动化开日历权限)' : ''}` };
    /* obj 里没 events 字段 (不是空数组) 说明返回结构异常, 也别乐观说"没安排" */
    if (!obj || !('events' in obj)) return { type: 'log', level: 'error', message: '✗ 读日历没成功: 结构异常, 可能超时或权限' };
    const events = Array.isArray(obj?.events) ? (obj.events as unknown[]) : [];
    if (events.length === 0) return { type: 'log', level: 'info', message: '✓ 这段没什么安排' };
    const range = asStr(args.range) || asStr(args.when) || '';
    return { type: 'log', level: 'info', message: `✓ 找到 ${events.length} 条日程${range ? ` · ${range}` : ''}` };
  }

  if (tool === 'calendar_add') {
    const title = asStr(args.title) || asStr(obj?.title) || '日程';
    const when = asStr(args.start) || asStr(args.date) || asStr(args.startDate) || asStr(obj?.start) || '';
    if (obj?.error) return { type: 'log', level: 'error', message: `✗ 加日程失败: ${String(obj.error)}` };
    return { type: 'log', level: 'info', message: `✓ 已加日程: ${title}${when ? ` · ${when}` : ''}` };
  }

  if (tool === 'apple_reminders') {
    const title = asStr(args.title) || asStr(obj?.title) || '提醒';
    const list = asStr(args.list) || asStr(obj?.list);
    if (obj?.error) return { type: 'log', level: 'error', message: `✗ 加系统提醒失败: ${String(obj.error)}` };
    return { type: 'log', level: 'info', message: `✓ 已加系统提醒: ${title}${list ? ` · ${list}` : ''}` };
  }

  if (tool === 'contacts_search') {
    if (obj?.error) return { type: 'log', level: 'error', message: `✗ 查联系人失败: ${String(obj.error)}` };
    const contacts = Array.isArray(obj?.contacts) ? (obj.contacts as unknown[]) : [];
    if (contacts.length === 0) return { type: 'log', level: 'info', message: '✓ 没找到匹配的联系人' };
    const first = contacts[0] as Record<string, unknown> | undefined;
    const name = asStr(first?.name) || asStr(first?.fullName) || '';
    const phone = asStr((first?.phones as unknown[] | undefined)?.[0] as string) || asStr(first?.phone) || '';
    const suffix = contacts.length > 1 ? ` +${contacts.length - 1} 位` : '';
    return { type: 'log', level: 'info', message: `✓ ${name}${phone ? ` · ${phone}` : ''}${suffix}` };
  }

  if (tool === 'send_imessage') {
    const to = asStr(args.to) || asStr(args.recipient) || '';
    const text = asStr(args.text) || asStr(args.message) || '';
    if (obj?.error) return { type: 'log', level: 'error', message: `✗ 发送失败: ${String(obj.error)}` };
    return { type: 'log', level: 'info', message: `✓ 已发给 ${to || '收件人'}: ${truncate(text, 60)}` };
  }

  return undefined;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

function buildPlainToolSummary(entry: TimelineEntry): StepContent | undefined {
  /* 只在 work 模式启用, 不影响 code. */
  if (_renderCtx?.agentMode !== 'work') return undefined;
  const tool = normalizedToolName(entry).toLowerCase();
  if (!tool) return undefined;
  /* 一些"结构化很重要"的类型交给 buildCodeContent 走 diff/terminal/search 等专用视图 */
  const structuralTools = new Set(['edit', 'write_file', 'read_file', 'readfile', 'execute_shell', 'bash', 'search', 'grep']);
  if (structuralTools.has(tool)) return undefined;
  /* internal 机制不该到这里(已在 row 层过滤), 保险再拦一次 */
  if (PLAIN_HIDDEN_TOOL_NAMES.has(tool)) return undefined;

  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  const primaryKeys = ['query', 'q', 'question', 'url', 'path', 'file', 'title', 'text', 'message', 'command', 'topic', 'name'];
  let primary = '';
  for (const k of primaryKeys) {
    const v = asStr(args[k]);
    if (v) { primary = truncate(v, 80); break; }
  }
  const label = displayToolName(normalizedToolName(entry));
  /* 结果侧: 若 output 存在但不是 JSON, 摘前 80 字; 是 JSON 就不显 (光显工具名+参数已够) */
  const out = entry.output || entry.detail;
  let tail = '';
  if (typeof out === 'string' && out.trim()) {
    const trimmed = out.trim();
    if (!/^[\[{]/.test(trimmed)) {
      tail = ` · ${truncate(trimmed, 80)}`;
    }
  }
  const running = entry.pending === true || !entry.output;
  const prefix = running ? '…' : '✓';
  return { type: 'log', level: 'info', message: `${prefix} ${label}${primary ? ` · ${primary}` : ''}${tail}` };
}

function buildDataContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'tool_result' || entry.success === false) return undefined;
  if (isBrowserToolName(normalizedToolName(entry))) return undefined;
  const out = entry.output || entry.detail;
  if (!out || typeof out !== 'string' || out.includes('__NEOX_IMAGE_RESULT__')) return undefined;
  const unwrapped = unwrapContextualOutput(out);
  const text = unwrapped ? (unwrapped.content?.trim() || '') : out;
  if (!text) return undefined;
  const data = parseDataResult(text);
  return data ? { type: 'data', ...data } : undefined;
}

function buildCodeContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (isBatchReadFileEntry(entry)) {
    // Batch readfile 的 detail 只是 "Completed N items..." 生命周期摘要，
    // 不应该落成一张白色 code pill；文件目标已在 row desc/meta 表达。
    return undefined;
  }

  const out = entry.output || entry.detail;
  if (!out || typeof out !== 'string') return undefined;

  /* 截图: __NEOX_IMAGE_RESULT__ 前缀 → 渲染为图片。payload 可能有 trailing 文本 / nested images。 */
  const imgIdx = out.indexOf('__NEOX_IMAGE_RESULT__');
  if (imgIdx >= 0) {
    try {
      const jsonText = extractJsonObjectText(out.slice(imgIdx + '__NEOX_IMAGE_RESULT__'.length));
      const srcs = jsonText ? collectImageDataUrls(JSON.parse(jsonText)) : [];
      if (srcs.length > 0) {
        return { type: 'code', lines: srcs.map((src: string) => ({ kind: 'normal' as const, text: `__IMG__${src}` })) };
      }
    } catch { /* fall through */ }
  }

  const unwrapped = unwrapContextualOutput(out);
  const text = unwrapped
    ? (unwrapped.content?.trim() || unwrapped.error || unwrapped.summary || '')
    : out;
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  /* Browser 工具 JSON 结果 → 简洁摘要 */
  if (trimmed.startsWith('{') && entry.toolName?.toLowerCase().startsWith('browser_')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        const parts: string[] = [];
        if (obj.ok === true) parts.push('✓');
        if (obj.ok === false) parts.push('✗');
        if (obj.url) parts.push(obj.url);
        if (obj.title) parts.push(obj.title);
        if (obj.text) parts.push(obj.text.length > 80 ? obj.text.slice(0, 80) + '…' : obj.text);
        if (typeof obj.count === 'number') parts.push(`${obj.count} 项`);
        if (parts.length > 0) {
          return { type: 'code', lines: [{ kind: 'normal' as const, text: parts.join(' · ') }] };
        }
      }
    } catch { /* fall through */ }
  }

  const allLines = trimmed.split('\n');
  const clipped = allLines.slice(0, 30);
  const extra = allLines.length - clipped.length;
  const codeLines = clipped.map((text) => ({ kind: 'normal' as const, text }));
  if (extra > 0) codeLines.push({ kind: 'normal' as const, text: `… +${extra} more lines` });
  /* 浏览器工具的输出走 BrowserResultView。判据是**工具名**, 不是标题文案 ——
   * 渲染端原来判 `/^browser/.test(stepTitle)`, 而标题早就中文化了 (「打开「x」」),
   * 那句永远为假, 于是所有浏览器结果都落到通用代码块 (审计里的 C2)。 */
  return { type: 'code', lines: codeLines, isBrowser: isBrowserToolName(t) };
}

/** 这条 entry 是浏览器工具吗 —— 经 call_tool 调时外层名字是 call_tool, 所以用归一后的名字。 */
function isBrowserToolName(toolName: string | undefined): boolean {
  return /^browser[_-]/i.test(toolName || '');
}

/** 渲染层路径归一: 旧 turn_summary entry 存盘时可能没归一化, 这里兜底合并同文件不同写法 (绝对/相对).
 *  有 workspacePath 时把相对路径补成绝对路径, 方便跟 aggregateTurnChanges 的输出对齐. */
function normalizeChangePathForDedup(p: string, workspacePath?: string): string {
  if (!p) return p;
  const np = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (np.startsWith('/') || /^[A-Za-z]:\//.test(np)) return np;
  if (!workspacePath) return np;
  const ws = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${ws}/${np.replace(/^\.\//, '')}`;
}

/** 用 newString/oldString 行数算 +/-, 跟 buildDiffContent 完全一致.
 *  老 turn_summary entry 持久化时 addCount/delCount 可能用了旧"差额"公式被算成 0/0,
 *  渲染时如果发现 editHunks 在但 add/del 都是 0, 用 hunks 重新算 → 总比 UI 一片空白好. */
function recomputeCountsFromHunks(hunks?: Array<{ oldString?: string; newString?: string }>): { add: number; del: number } {
  if (!hunks || hunks.length === 0) return { add: 0, del: 0 };
  let add = 0;
  let del = 0;
  for (const h of hunks) {
    const d = editHunkLines(h.oldString ?? '', h.newString ?? '', 1); /* 逐行配对, 没动的行不算 (同 buildRawHunkDiffContent) */
    add += d.add; del += d.del;
  }
  return { add, del };
}

/** 第二层 fallback: 老持久化的 entry 既没 hunks 也没正确 add/del, 只有 changedLines 的行号区间.
 *  按 kind 拆: add → 累加范围长度; del → 累加范围长度; modify → 当替换, add 和 del 都加范围长度.
 *  数字会偏大 (modify 算两份), 但好歹有数字, UI 不再空白. */
function recomputeCountsFromChangedLines(
  changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>,
): { add: number; del: number } {
  if (!changedLines || changedLines.length === 0) return { add: 0, del: 0 };
  let add = 0;
  let del = 0;
  for (const l of changedLines) {
    const n = Math.max(0, (l.end ?? l.start) - l.start + 1);
    if (l.kind === 'add') add += n;
    else if (l.kind === 'del') del += n;
    else { add += n; del += n; }
  }
  return { add, del };
}

function buildTurnSummaryContent(entry: TimelineEntry): StepContent | undefined {
  if (entry.type !== 'turn_summary') return undefined;

  /* 优先路径: 渲染 ctx 提供了 entries → 直接重跑 aggregator, 从真实 edit_file/tool_result 算准确 +/-.
   * 这样不依赖 persisted summaryChanges (可能是老差额公式产出的 0/0 或 modify-only 等有损数据). */
  let sourceChanges: Array<{
    path: string;
    op: 'edit' | 'write' | 'delete' | 'rename';
    addCount: number;
    delCount: number;
    changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>;
    from?: string;
    editHunks?: Array<{
      oldString?: string;
      newString?: string;
      startLine?: number;
      oldLineCount?: number;
      newLineCount?: number;
      oldCharCount?: number;
      newCharCount?: number;
    }>;
    fallbackContent?: string;
    overwrote?: boolean;
  }> = [];

  /* 统计口径固定为工具调用累计。summaryRefined 只表示 persisted change 上可能有
   * refinedLines 可用于 diff 内容展示, 不表示 addCount/delCount 可以直接信任。
   * 历史版本曾把最终净 diff 写进 summaryChanges, 所以只要 ctx 存在就优先现场重算。 */
  if (_renderCtx && entry.summaryTurnId) {
    const all = _renderCtx.entries;
    const userIdx = ctxIndexOfId(entry.summaryTurnId);
    const summaryIdx = ctxIndexOfId(entry.id);
    if (userIdx >= 0 && summaryIdx >= 0 && summaryIdx > userIdx) {
      /* 切到本 turn 的范围 (user_message → turn_summary 本身之前). 把 turn_summary 自己
       * 排除掉, 避免 aggregator 把它当成奇怪类型 entry. */
      const slice = all.slice(userIdx, summaryIdx);
      const fresh = aggregateTurnChanges(slice, _renderCtx.workspacePath);
      if (fresh && fresh.changes.length > 0) {
        sourceChanges = fresh.changes.map(c => ({
          path: c.path,
          op: c.op,
          addCount: c.addCount,
          delCount: c.delCount,
          changedLines: c.changedLines,
          from: c.from,
          editHunks: c.editHunks,
          fallbackContent: (c as any).fallbackContent,
          statsUnknown: (c as any).statsUnknown, // 同下: 逐字段拷贝必须带上, 否则退回 +0 −0
          overwrote: c.overwrote, // 改写已有文件 ≠ 新建
        }));
      }
    }
  }

  /* fallback: 没 ctx (例如某些测试调用), 退到 persisted summaryChanges */
  if (sourceChanges.length === 0) {
    const persisted = entry.summaryChanges ?? [];
    if (persisted.length === 0) return undefined;
    sourceChanges = persisted.map(c => {
      let addCount = c.addCount || 0;
      let delCount = c.delCount || 0;
      if (addCount === 0 && delCount === 0) {
        const fromHunks = recomputeCountsFromHunks((c as any).editHunks);
        if (fromHunks.add > 0 || fromHunks.del > 0) {
          addCount = fromHunks.add;
          delCount = fromHunks.del;
        } else {
          const fromChangedLines = recomputeCountsFromChangedLines(c.changedLines as any);
          addCount = fromChangedLines.add;
          delCount = fromChangedLines.del;
        }
      }
      return {
        path: c.path,
        op: c.op,
        addCount,
        delCount,
        changedLines: c.changedLines,
        from: c.from,
        editHunks: (c as any).editHunks,
        fallbackContent: (c as any).fallbackContent,
        statsUnknown: (c as any).statsUnknown,
      };
    });
  }

  if (_renderCtx?.agentMode === 'work') {
    sourceChanges = sourceChanges.filter((c) => !isProcessScript(c.path) && !/^\/(private\/)?tmp\//.test(c.path));
    if (sourceChanges.length === 0) return { type: 'none' };
  }

  const totalFiles = sourceChanges.length;
  const totalAdds = sourceChanges.reduce((s, c) => s + (c.addCount || 0), 0);
  const totalDels = sourceChanges.reduce((s, c) => s + (c.delCount || 0), 0);
  return {
    type: 'turn_summary',
    turnId: entry.summaryTurnId,
    totalFiles,
    totalAdds,
    totalDels,
    changes: sourceChanges,
  };
}

/* 已 warn 过的 entry.type 集合, 防同类 entry 反复刷 console。模块级别即可,
   sessionId 切换时 timeline 重 mount 但缓存留着也无所谓 (内容是 type 而非 entry id) */
const _unhandledTypeWarned = new Set<string>();


/* generate_image / edit_image → 图片结果卡。
 *
 * 【为什么单独做一条】不做的话它落到通用 tool_result, 用户在 timeline 上看到的是
 * 一行 JSON 路径 —— 而生图这件事的**全部价值就是那张图**, 让用户去文件夹里翻
 * 等于把最重要的产物藏起来了。 */
function buildImageGenContent(entry: TimelineEntry): StepContent | undefined {
  const t = normalizedToolName(entry);
  if (t !== 'generate_image' && t !== 'edit_image') return undefined;
  const rawOut = typeof entry.output === 'string' ? entry.output : '';
  if (!rawOut) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(rawOut); } catch { return undefined; }
  /* 剥掉 contextual 信封 */
  if (parsed && typeof parsed === 'object' && typeof parsed.tool === 'string'
      && typeof parsed.status === 'string'
      && (parsed.type === 'ephemeral' || parsed.type === 'contextual' || parsed.type === 'summarized')) {
    const inner = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : null;
    if (inner) {
      parsed = inner;
    } else if (typeof parsed.content === 'string') {
      try { parsed = JSON.parse(parsed.content); } catch { return undefined; }
    } else {
      return undefined;
    }
  }
  /* 失败时让 error 分支去渲染, 别画一张空图卡 */
  if (!parsed || parsed.error) return undefined;
  const paths: string[] = Array.isArray(parsed.paths) ? parsed.paths
    : Array.isArray(parsed.files) ? parsed.files
    : typeof parsed.path === 'string' ? [parsed.path] : [];
  if (paths.length === 0) return undefined;
  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  return {
    type: 'image',
    paths,
    prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
    model: typeof parsed.model === 'string' ? parsed.model
      : (typeof args.model === 'string' ? args.model : undefined),
    cached: parsed.mode === 'cache' || parsed.cached === true,
  };
}

/* Work: 命令 / 脚本 / diff / 原始输出不给看 —— 这一步就一行字。守卫拦截和内部换工具
 * 那两类"错误"留给 buildErrorContent 自己的静默分支, 这里不抢。 */
function buildWorkPlainContent(entry: TimelineEntry): StepContent | undefined {
  if (_renderCtx?.agentMode !== 'work') return undefined;
  if (entry.blockedBy || isToolRoutingHintEntry(entry)) return undefined;
  let tool = normalizedToolName(entry);
  let args = entry.toolArgs as Record<string, unknown> | undefined;
  if (tool === 'call_tool' && typeof args?.name === 'string') {
    tool = args.name.toLowerCase();
    const inner = args.args ?? args.arguments;
    args = inner && typeof inner === 'object' ? inner as Record<string, unknown> : undefined;
  }
  const failed = entry.type === 'tool_error' || entry.success === false;
  return plainWorkContentForTool(tool, args, entry.output, failed, _getUiLanguage() === 'zh');
}

function buildContent(entry: TimelineEntry): StepContent | undefined {
  const content =
    buildTurnSummaryContent(entry) ||
    computerCardContent(unwrapContextualOutput(entry.output)?.metadata, _getUiLanguage() === 'zh') ||
    /* 模型看过的图 (seenImagesContent.ts): 排在浏览器卡前 (用户要看截图, 不是步骤列表), 电脑操作卡后 (它自带窗口截图) */
    buildSeenImagesContent(entry) ||
    browserCardContent(unwrapContextualOutput(entry.output)?.metadata, _getUiLanguage() === 'zh') || /* 同上, 浏览器脚本那张 */
    deepResearchCardContent(unwrapContextualOutput(entry.output)?.metadata, _getUiLanguage() === 'zh') ||
    /* 活卡 —— 调研跑着的那几分钟。必须排在结果卡之后 (结果到齐就让位), 但在这里就要
     * 拦住, 否则一路掉到最底下的 buildCodeContent, 把**入参 JSON** 摊成代码块。 */
    deepResearchLiveContent(entry) ||
    buildToolCardContent(entry, _renderCtx?.agentMode) || /* 设计稿「全部工具」里有卡的那些 (toolCards/), 排在 Work 白话前: 成品卡两种模式都出 */
    buildWorkPlainContent(entry) ||
    buildErrorContent(entry) ||
    buildOfficeContent(entry) ||
    buildDiffContent(entry) ||
    buildBashOutputContent(entry) ||
    buildTerminalContent(entry) ||
    buildSearchContent(entry) ||
    buildImageGenContent(entry) ||
    buildReadFileContent(entry) ||
    buildWebContent(entry) ||
    buildAskUserContent(entry) ||
    buildCompactionContent(entry) ||
    buildTargetContinueContent(entry) ||
    buildWorkerContent(entry) ||
    buildExternalAgentContent(entry) ||
    buildDelegationContent(entry) ||
    buildExploreContent(entry) ||
    buildDagContent(entry) ||
    buildFileListContent(entry) ||
    buildLogContent(entry) ||
    buildNetworkContent(entry) ||
    buildPlanContent(entry) ||
    buildThinkingContent(entry) ||
    buildWakeupContent(entry) ||
    buildContextStatusContent(entry) ||
    buildSurfaceContent(entry) ||
    buildVcsDiffContent(entry) ||
    buildVcsCommitContent(entry) ||
    buildTaskListContent(entry) ||
    buildCronListContent(entry) ||
    buildTargetOpContent(entry) ||
    buildSessionPeerContent(entry) ||
    buildOpChipContent(entry) ||
    buildReadDocContent(entry) ||
    buildSkillContent(entry, normalizedToolName(entry)) ||
    buildInstructionsContent(entry) ||
    buildPlainActionContent(entry) ||
    buildPlainToolSummary(entry) ||
    buildDataContent(entry) ||
    buildCodeContent(entry);

  /* 28 个 builder OR chain 全 miss 时之前是默默 return undefined → step.content=undefined
     → step 整行可能消失 (TimelineStep.tsx 看到 !content 直接 null)。新增 entry.type 时如果
     忘记加对应 builder, 现场没有任何告警 → 排查极难。
     这里加一道 dev-mode warning, 每个 type 只 warn 一次。返回值保持原行为 (undefined),
     避免改动 UI 表象。 */
  if (!content) {
    const t = (entry.type as string) || '_unknown_';
    if (!_unhandledTypeWarned.has(t)) {
      _unhandledTypeWarned.add(t);
      const dbg = (globalThis as any).process?.env?.NEOX_DEBUG === '1'
        || (globalThis as any).__NEOX_DEBUG__ === true;
      if (dbg) {
        // eslint-disable-next-line no-console
        console.warn(`[Timeline] no content builder matched for entry.type="${t}" — step may be invisible.`, entry);
      }
    }
  }
  return content;
}

/* ---------- row meta chips ---------- */
function buildMeta(entry: TimelineEntry): string[] | undefined {
  const chips: string[] = [];
  if (entry.batchTotal && entry.batchTotal > 1) {
    const done = entry.batchCompleted ?? 0;
    chips.push(`${done}/${entry.batchTotal}`);
  }
  if (entry.totalChars && entry.totalChars > 0 && !(entry.pending && entry.streaming)) {
    chips.push(`${entry.totalChars} 字符`);
  }
  if (entry.resultLength && entry.resultLength > 0) {
    /* use_skill 的 resultLength 是 SKILL.md 全文长度 (25 KB+), 用户角度毫无信息量, 跳过.
     * load_instructions 同理: 那是内部 ContextualResult JSON 的长度, 不是"指令有多大"
     * (真正的大小已经在卡片里以行数/字符数呈现). */
    const tool = normalizedToolName(entry);
    if (tool !== 'use_skill' && tool !== 'load_instructions') {
      const kb = entry.resultLength / 1024;
      chips.push(kb >= 1 ? `${kb.toFixed(1)} KB` : `${entry.resultLength} B`);
    }
  }
  if (entry.exploreToolCount && entry.exploreToolCount > 0) {
    chips.push(`${entry.exploreToolCount} 工具`);
  }
  if (entry.exploreTokens && entry.exploreTokens > 0) {
    const k = entry.exploreTokens / 1000;
    chips.push(k >= 1 ? `${k.toFixed(1)}k tok` : `${entry.exploreTokens} tok`);
  }
  if (entry.delegationToolCount && entry.delegationToolCount > 0) {
    chips.push(`${entry.delegationToolCount} 工具`);
  }
  if (entry.type === 'turn_summary' && entry.summaryChanges) {
    const content = buildTurnSummaryContent(entry);
    const adds = content?.type === 'turn_summary'
      ? content.totalAdds
      : entry.summaryChanges.reduce((s, c) => s + (c.addCount || 0), 0);
    const dels = content?.type === 'turn_summary'
      ? content.totalDels
      : entry.summaryChanges.reduce((s, c) => s + (c.delCount || 0), 0);
    /* 合计不再进 meta chips —— 改走 step.diffStat 由渲染层上色 (见上面 diffStat 的注释)。 */
    void adds; void dels;
  }
  return chips.length > 0 ? chips : undefined;
}

/* ---------- type 分类 ---------- */

/* 消息 row — 文本对话 */
const MESSAGE_RENDER_TYPES = new Set<string>([
  'user_message',
  'assistant_message',
  'agent_message',         // 多 agent 下的 assistant
  'assistant_prefix',      // tool 调用前 LLM 的解释
]);

function getMessageText(entry: TimelineEntry): string {
  return (((entry as any).detail || (entry as any).output || (entry as any).text || '') as any).toString();
}

const WHITESPACE_RE = /\s/;

function isRenderableMessageText(entry: TimelineEntry): boolean {
  const text = getMessageText(entry);
  let dots = 0;
  let ellipsis = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '.') { dots++; continue; }
    if (ch === '\u2026') { dots++; ellipsis = true; continue; }
    if (WHITESPACE_RE.test(ch)) continue;
    return true;
  }
  if (dots === 0) return false;
  if (entry.type === 'user_message') return true;
  return !(ellipsis || dots >= 2);
}

/* tool row — 全部其它可渲染 type (覆盖 useStreamHandler 实际发出的所有 type) */
const TOOL_RENDER_TYPES = new Set<string>([
  'thinking',
  'tool_call',
  'tool_result',
  'tool_error',
  'edit_file',
  'file_stream',
  'log',
  'plan',
  'plan_update',
  'context_compaction',
  'target_continuation',
  'runner_error',
  /* 协作 */
  'worker_status',
  'dag_execution',
  'explore_status',
  'ask_user',
  'agent_delegation',
  /* network */
  'network_bidding',
  'network_agent_bid',
  'network_negotiation',
  'network_negotiation_message',
  'network_dag_topology',
  'network_replan',
  'network_task_analysis',
  'network_agent_execution',
  'network_mode_select',
  /* 新增的 P0 类型 */
  'cron_create',
  'cron_delete',
  'cron_list',
  'task_create',
  'task_update',
  'task_list',
  'task_get',
  'task_stop',
  'plan_enter',
  'plan_exit',
  'worktree_enter',
  'worktree_exit',
  /* 本轮改动汇总 — run_result 时 append, 紧凑卡片列出每个文件 + ±diff + 跳转 */
  'turn_summary',
]);

/* 严格跳过 — 只有 edit_file 的 delta stream 碎片 (file_stream 反而是 write_file 的完整卡!) */
const SKIP_TYPES = new Set<string>([
  'edit_file_stream',
  'model_switch',
  /* 以下仅作防御 (非 TimelineEntryType 值, 不应出现在 timeline) */
  'token',
  'reasoning',
  'status',
  'metrics',
]);

/* ---------- 渲染 context (let buildTurnSummaryContent 拿到全 entries + workspacePath) ----------
 * JS 单线程, 模块级闭包安全. mapTimelineEntries 入口设置, finally 清掉. */
let _renderCtx: {
  entries: TimelineEntry[];
  workspacePath?: string;
  density?: TimelineDensity;
  agentMode?: 'work' | 'code';
  /** id → entries 下标, 首次访问时惰性构建 (见 ctxIndexOfId) */
  idIndex?: Map<string, number>;
} | null = null;

function ctxIndexOfId(id: string): number {
  const ctx = _renderCtx;
  if (!ctx) return -1;
  if (!ctx.idIndex) {
    const m = new Map<string, number>();
    for (let i = 0; i < ctx.entries.length; i++) m.set(ctx.entries[i].id, i);
    ctx.idIndex = m;
  }
  return ctx.idIndex.get(id) ?? -1;
}

/* ---------- 主函数 ---------- */
export function mapTimelineEntries(
  entries: TimelineEntry[],
  workspacePath?: string,
  options?: { density?: TimelineDensity; agentMode?: 'work' | 'code' },
): TimelineItem[] {
  _renderCtx = { entries, workspacePath, density: options?.density ?? 'normal', agentMode: options?.agentMode };
  try {
    return _mapTimelineEntriesImpl(entries);
  } finally {
    _renderCtx = null;
  }
}


function _mapTimelineEntriesImpl(input: TimelineEntry[]): TimelineItem[] {
  /* Pilot 巡检: 没事的那一整轮不显示, 触发那条也不显示 (见 pilotPatrolFilter.ts) */
  const entries = dropPilotPatrolNoise(dropDuplicatedSubStepText(input));
  /* 1. 过滤 + 排序 */
  const kept = entries
    .filter((e) => {
      const t = e.type as string;
      if (SKIP_TYPES.has(t)) return false;
      if ((t === 'tool_call' || t === 'tool_result' || t === 'tool_error')) {
        const tn = (e.toolName || '').toLowerCase();
        if (tn === 'agent' || tn === 'ask_user') return false;
        if (_renderCtx?.agentMode === 'work' && PLAIN_HIDDEN_TOOL_NAMES.has(tn)) return false;
      }
      /* Work: "本轮改动"只剩过程脚本时整行不出 —— 否则留一个空标题 (buildTurnSummaryContent 已给 'none') */
      if (t === 'turn_summary' && _renderCtx?.agentMode === 'work'
          && buildTurnSummaryContent(e)?.type === 'none') {
        return false;
      }
      if (MESSAGE_RENDER_TYPES.has(t)) {
        return isRenderableMessageText(e);
      }
      if (TOOL_RENDER_TYPES.has(t)) {
        /* 空 thinking (后端占位) 不渲染 */
        if (t === 'thinking' && !e.detail && !e.description && !e.output && !e.pending) return false;
        return true;
      }
      /* 未知 type: 也尝试渲染一条 (宁可多不可少), 至少让用户看到 */
      return true;
    })
    .sort((a, b) => {
      const ta = normalizeTs(a.timestamp);
      const tb = normalizeTs(b.timestamp);
      if (ta !== tb) return ta - tb;
      const sa = a.sequence ?? 0;
      const sb = b.sequence ?? 0;
      return sa - sb;
    });

  /* 1.5. Coalesce pass: 同 turn 同 filePath 的多次 file_stream 合并成一张卡 (anchor).
   *
   * Cursor 风格 — 对 write_file 这种全量流式写入合并同文件重复卡:
   *   · 第一次 write → 留作 anchor, 其它隐藏
   *   · anchor 展开渲染时拿走该 (turn, file) 下所有 entry 的 editHunks 联合
   *   · 优先用 turn_summary 那条 entry 里的 refinedLines 展示净 diff, 没 refined 才 fallback raw hunks
   *   · 卡片 chip / 汇总数字使用工具调用累计口径, 不被净 diff 覆盖
   *
   * 隐藏的 entry id 走 hiddenCoalesced set, map 阶段直接 skip. anchor 进 coalesceGroup 记录,
   * buildContent 时按 anchor.id 拉对应 group + summary refined 渲染. */
  type CoalesceGroup = {
    anchorId: string;
    turnId: string;
    filePath: string;
    entries: TimelineEntry[];
    /* anchor 是否还在 streaming — 任一组员 pending=true 算流式态. 流式期间 fallback raw, 完成后用 refined. */
    streaming: boolean;
  };
  const hiddenCoalesced = new Set<string>();
  const coalesceGroupByAnchor = new Map<string, CoalesceGroup>();
  {
    let currentTurnId = '';
    const anchorByKey = new Map<string, string>();
    for (const e of kept) {
      const t = e.type as string;
      if (t === 'user_message') {
        currentTurnId = e.id;
        continue;
      }
      if (t !== 'file_stream') continue;
      const filePath = (e.editFilePath || (e as any).filePath || e.targetPath || '').trim();
      if (!filePath) continue;
      /* delete / rename 不参与 coalesce — 这俩跟 edit 语义本质不同, 各自独立显示更清晰 */
      const op = (e as any).editOp || ((e.type === 'file_stream') ? 'write' : 'edit');
      if (op === 'delete' || op === 'rename') continue;
      if (e.success === false || e.level === 'error') continue;

      const key = `${currentTurnId}::${filePath}`;
      const existingAnchorId = anchorByKey.get(key);
      if (existingAnchorId) {
        hiddenCoalesced.add(e.id);
        const group = coalesceGroupByAnchor.get(existingAnchorId);
        if (group) {
          group.entries.push(e);
          if (e.pending === true) group.streaming = true;
        }
      } else {
        anchorByKey.set(key, e.id);
        coalesceGroupByAnchor.set(e.id, {
          anchorId: e.id,
          turnId: currentTurnId,
          filePath,
          entries: [e],
          streaming: e.pending === true,
        });
      }
    }
  }
  let lastFailedCompactionId: string | undefined;
  for (const e of kept) {
    if (e.type === 'context_compaction' && e.compactionStatus === 'failed') lastFailedCompactionId = e.id;
  }
  /* coalesce 后真正参与渲染的 entries — 隐藏被 coalesce 的非 anchor */
  const visibleKept = kept.filter((e) => !hiddenCoalesced.has(e.id)
    && !(e.type === 'context_compaction' && e.compactionStatus === 'failed' && e.id !== lastFailedCompactionId));

  /* 把 coalesceGroupByAnchor 注册到 _renderCtx, 让 buildDiffContent 能查 */
  if (_renderCtx) {
    (_renderCtx as any).coalesceGroupByAnchor = coalesceGroupByAnchor;
  }

  /* 2. batch 计数 — 走 coalesce 后的 visibleKept (隐藏的 entry 不算 batch) */
  const batchCount = new Map<string, number>();
  for (const e of visibleKept) {
    if (e.batchId && TOOL_RENDER_TYPES.has(e.type as string)) {
      batchCount.set(e.batchId, (batchCount.get(e.batchId) ?? 0) + 1);
    }
  }

  const errorEntryIndex = new Set<number>();
  visibleKept.forEach((e, idx) => {
    const t = e.type as string;
    if (t === 'runner_error' || t === 'tool_error' || (e as any).errorCode) {
      errorEntryIndex.add(idx);
    }
  });
  const lastErrorIndex = errorEntryIndex.size > 0 ? Math.max(...errorEntryIndex) : -1;

  /* 3. 映射 — visibleKept 才进入渲染 */
  const seenBatches = new Set<string>();
  let lastSettledIdx = -1;
  for (let i = visibleKept.length - 1; i >= 0; i--) {
    const x = visibleKept[i];
    if (x.type !== 'thinking' && x.pending !== true) { lastSettledIdx = i; break; }
  }

  const ctxSig = `${_renderCtx?.workspacePath ?? ''}${_renderCtx?.density ?? 'normal'}${_renderCtx?.agentMode ?? ''}${_getUiLanguage()}`;
  const mapped = visibleKept.map<TimelineItem>((e, entryIdx) => {
    const type = e.type as string;
    /* groupId/groupLabel 必须在缓存判定**之前**算 —— seenBatches 是有副作用的,
     * 命中缓存直接 return 会漏掉 add, 导致同批第二条也被贴上 "并行 · N" 标签。 */
    let groupId: string | undefined;
    let groupLabel: string | undefined;
    if (e.batchId && (batchCount.get(e.batchId) ?? 0) > 1) {
      groupId = e.batchId;
      if (!seenBatches.has(e.batchId)) {
        seenBatches.add(e.batchId);
        const n = batchCount.get(e.batchId) ?? 1;
        groupLabel = _getUiLanguage() === 'zh' ? `并行 · ${n} 个工具` : `Parallel · ${n} tools`;
      }
    }
    const cacheable = type !== 'turn_summary' && type !== 'file_stream';
    let sig = '';
    if (cacheable) {
      /* entry 之外的输入全部进 sig: 上下文 + 两个跨条目判据 + 批次归属 */
      const forceClearPending = lastErrorIndex >= 0 && lastErrorIndex >= entryIdx ? '1' : '0';
      const thinkingSettled = lastSettledIdx > entryIdx ? '1' : '0';
      sig = `${ctxSig}${forceClearPending}${thinkingSettled}${groupId ?? ''}${groupLabel ?? ''}`;
      const hit = _itemCache.get(e);
      if (hit !== undefined && hit.sig === sig) return hit.item;
    }
    const item = _mapOneEntry(e, entryIdx, {
      lastErrorIndex,
      lastSettledIdx,
      groupId,
      groupLabel,
    });
    if (cacheable) _itemCache.set(e, { sig, item });
    return item;
  });

  return _applyPostMapFilters(mapped);
}

type MapOneCtx = {
  lastErrorIndex: number;
  lastSettledIdx: number;
  groupId?: string;
  groupLabel?: string;
};

type ItemCacheSlot = { sig: string; item: TimelineItem };
let _itemCache = new WeakMap<TimelineEntry, ItemCacheSlot>();

/** 测试用: 清空增量映射缓存 (WeakMap 不可枚举, 直接换一只新的) */
export function __resetTimelineMapCacheForTests(): void {
  _itemCache = new WeakMap();
}

function _mapOneEntry(
  e: TimelineEntry,
  entryIdx: number,
  mctx: MapOneCtx,
): TimelineItem {
  const { lastErrorIndex, lastSettledIdx } = mctx;
  {
    /* 消息 row */
    if (MESSAGE_RENDER_TYPES.has(e.type as string)) {
      const role: 'user' | 'assistant' =
        e.type === 'user_message' ? 'user' : 'assistant';
      const text = getMessageText(e);
      if (role === 'user' && typeof text === 'string' && /^\s*<life-reminder-fired>/.test(text)) {
        const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/);
        const ctxMatch = text.match(/<context>([\s\S]*?)<\/context>/);
        const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const remTitle = titleMatch ? decode(titleMatch[1].trim()) : '提醒';
        const remCtx = ctxMatch ? decode(ctxMatch[1].trim()) : undefined;
        const firedStep: TimelineStep = {
          kind: 'tool',
          id: e.id,
          title: '提醒到点',
          desc: undefined,
          status: 'done',
          iconKind: 'retry',
          timestamp: formatClock(e.timestamp),
          duration: undefined,
          startedAtMs: e.timestamp,
          content: {
            type: 'timer_card',
            subKind: 'reminder',
            status: 'fired',
            title: remTitle,
            context: remCtx,
            atText: formatClock(e.timestamp),
          },
          meta: undefined,
          defaultExpanded: true,
          presentation: undefined,
        } as TimelineStep;
        return firedStep;
      }
      let displayText = (role === 'user' && typeof text === 'string' && /^\s*<voice-turn>/.test(text))
        ? text.replace(/^\s*<voice-turn>\s*/, '').replace(/\s*<\/voice-turn>\s*$/, '')
        : text;
      if (role === 'user' && typeof displayText === 'string' && displayText.includes('<neox-directive>')) {
        displayText = displayText
          .replace(/<neox-directive>[\s\S]*?<\/neox-directive>/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      const rawAtts = Array.isArray(e.attachments) ? e.attachments : [];
      const attachments = rawAtts.length > 0
        ? rawAtts.map((a) => ({
            id: a.id,
            kind: a.type,
            name: a.name,
            path: a.path,
            data: a.data,
            size: a.size,
            language: a.language,
          }))
        : undefined;
      /* pending 且晚于自己的位置存在 error → 强制清 pending (防 shimmer 永动) */
      const forceClearPending =
        role === 'assistant' && e.pending === true &&
        lastErrorIndex >= 0 && lastErrorIndex >= entryIdx;
      const msg: TimelineMessage = {
        kind: 'message',
        id: e.id,
        role,
        text: displayText,
        timestamp: formatClock(e.timestamp),
        timestampMs: typeof e.timestamp === 'number' ? e.timestamp : undefined,
        streaming: forceClearPending ? false : e.pending,
        attachments,
        source: (e as any).messageSource,
        injectionPending: (e as any).injectedConfirmed === false,
        /* 本轮消耗 + 模型 —— 消息定稿时快照进 timeline entry, 这里原样带给 cell */
        turnTokens: (e as any).turnTokens,
        turnTps: (e as any).turnTps,
        turnUsage: (e as any).turnUsage,
        model: (e as any).model,
      };
      return msg;
    }

    /* tool row */
    let status = pickStatus(e);
    /* pending thinking 之后已有完成条目 → 按完成渲染 (见 lastSettledIdx 注释) */
    if (status === 'running' && e.type === 'thinking' && e.pending === true && lastSettledIdx > entryIdx) {
      status = 'done';
    }
    const thinkingDoneTitle = e.type === 'thinking' && status !== 'running' && status !== 'pending';
    const iconKind = pickIconKind(e);
    const thoughtFor = thinkingDoneTitle ? formatThoughtFor(e.duration, _getUiLanguage() === 'zh') : undefined;
    const title = thinkingDoneTitle
      ? (thoughtFor ?? (_getUiLanguage() === 'zh' ? '思考' : 'Thought'))
      : buildTitle(e);
    const desc = buildDesc(e);
    const timestamp = formatClock(e.timestamp);
    const duration = thoughtFor ? undefined : formatHms(e.duration);
    const content = buildContent(e);
    const meta = buildMeta(e);
    const presentation = getTimelineStepPresentation({
      status,
      iconKind,
      content,
      density: (_renderCtx as any)?.density ?? 'normal',
    });

    const step: TimelineStep = {
      kind: 'tool',
      id: e.id,
      title,
      desc,
      status,
      iconKind,
      brandIcon: pluginLogoFromToolName(e.toolName),
      timestamp,
      duration,
      startedAtMs: e.timestamp,
      content,
      meta,
      diffStat:
        content?.type === 'diff'
          ? { add: content.addCount, del: content.delCount }
          : content?.type === 'turn_summary' && (content.totalAdds > 0 || content.totalDels > 0)
            ? { add: content.totalAdds, del: content.totalDels }
            : undefined,
      defaultExpanded: presentation.defaultExpanded,
      presentation,
      /* status 仍是 failed (折叠/图标/统计等 38 处判据一个不动), 只降语气。
       * benign = 工具自己返回的错, agent 换个做法就接着干 —— 见 isTurnFatalEntry。 */
      tone: isHighLoadEntry(e)
        ? 'busy'
        : (status === 'failed' && !isTurnFatalEntry(e) ? 'benign' : undefined),
      blockedBy: e.blockedBy,
    };

    if (e.blockedBy && e.blockedNotice) {
      const repeat = e.blockedRepeat && e.blockedRepeat > 1 ? ` ×${e.blockedRepeat}` : '';
      step.desc = `${e.blockedNotice}${repeat}`;
    }

    /* 批次归属在调用方算好 (seenBatches 副作用必须先于缓存命中判定) */
    if (mctx.groupId) step.groupId = mctx.groupId;
    if (mctx.groupLabel) step.groupLabel = mctx.groupLabel;

    return step;
  }
}

function _applyPostMapFilters(mapped: TimelineItem[]): TimelineItem[] {
  const showReasoning = getShowReasoningPreference();
  const filtered = showReasoning
    ? mapped
    : mapped.filter((it) => !(it.kind === 'tool' && it.content?.type === 'thinking'));

  /* 极简模式: 去掉 debug 级噪声 (思考中 / log / op_chip), 让主线只剩消息和真正的工具动作.
   * 失败的步骤永远保留 (即便被归类为 debug), 否则用户看不到出错。 */
  const density: TimelineDensity = (_renderCtx as any)?.density ?? 'normal';
  if (density !== 'minimal') return filtered;
  return filtered.filter((it) => {
    if (it.kind !== 'tool') return true;
    if (it.status === 'failed') return true;
    if (it.presentation?.importance === 'debug') return false;
    if (it.content?.type === 'thinking') return false;
    return true;
  });
}
