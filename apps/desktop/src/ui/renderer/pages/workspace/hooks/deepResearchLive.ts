
/** 一路调研的行状态。id/question/status/summary 来自调度器 (research_progress);
 *  agentId/toolCount/tokens/currentTool 来自子 agent 事件 —— 调度器不知道这些。 */
export interface ResearchWorkerRow {
  id: string;
  question: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  summary?: string;
  agentId?: string;
  toolCount?: number;
  tokens?: number;
  currentTool?: string;
}

export interface ResearchStats {
  sources: number;
  domains: number;
  claims: number;
  disputed: number;
  singleSource: number;
  dispatched: number;
  completed: number;
  failed: number;
  inFlight: number;
  queued: number;
  concurrency: number;
  maxWorkers: number;
}

/** entry 上跟活卡有关的那几个字段 (结构化子集 —— 这里不依赖完整 TimelineEntry 类型)。 */
export interface ResearchLiveFields {
  deepResearchTopic?: string;
  deepResearchScale?: string;
  deepResearchPhase?: 'running' | 'done';
  deepResearchStartedAt?: number;
  deepResearchStats?: ResearchStats;
  deepResearchWorkers?: ResearchWorkerRow[];
  /** 报告落盘路径。第一条进度事件就带着了 —— 中断时卡片靠它指路 */
  deepResearchReportPath?: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function isDeepResearchEntry(entry: unknown): boolean {
  const e = (entry ?? {}) as Record<string, unknown>;
  const name = str(e.toolName).toLowerCase();
  if (name === 'deep_research') return true;
  const args = (e.toolArgs ?? {}) as Record<string, unknown>;
  /* call_tool 的入参里工具名可能叫 name / tool / tool_name, 三个都认 */
  const inner = (str(args.name) || str(args.tool) || str(args.tool_name)).toLowerCase();
  return inner === 'deep_research';
}

/** 已经挂过活卡数据的 entry —— 进度事件找父卡时优先认这个, 比工具名可靠。 */
export function hasResearchLiveData(entry: unknown): boolean {
  const e = (entry ?? {}) as Record<string, unknown>;
  return e.deepResearchPhase !== undefined || Array.isArray(e.deepResearchWorkers);
}

/**
 * research_progress 事件 → entry 补丁。
 *
 * 合并规则: 调度器是 id/question/status/summary 的唯一真相, 直接盖掉;
 * 而 agentId/toolCount/tokens/currentTool 是子 agent 事件攒出来的, **必须保留** ——
 * 每来一条进度就把它们抹掉的话, token 数字会一秒跳一次 0。
 */
export function applyResearchProgress(
  prev: ResearchLiveFields,
  ev: Record<string, unknown>,
): ResearchLiveFields {
  const incoming = Array.isArray(ev.workers) ? (ev.workers as Array<Record<string, unknown>>) : [];
  const kept = new Map<string, ResearchWorkerRow>();
  for (const w of prev.deepResearchWorkers || []) kept.set(w.id, w);

  const workers: ResearchWorkerRow[] = incoming.map((w) => {
    const id = str(w.id);
    const old = kept.get(id);
    const status = str(w.status) as ResearchWorkerRow['status'];
    return {
      id,
      question: str(w.question),
      status: status || 'queued',
      ...(str(w.summary) ? { summary: str(w.summary) } : old?.summary ? { summary: old.summary } : {}),
      /* 子 agent 侧攒的那三个原样带过来 */
      ...(old?.agentId ? { agentId: old.agentId } : {}),
      ...(old?.toolCount ? { toolCount: old.toolCount } : {}),
      ...(old?.tokens ? { tokens: old.tokens } : {}),
      /* 跑完了就不该再顶着"正在 web_fetch"不放 */
      ...(old?.currentTool && status === 'running' ? { currentTool: old.currentTool } : {}),
    };
  });

  const phase = str(ev.phase);
  return {
    ...prev,
    deepResearchReportPath: str(ev.reportPath) || prev.deepResearchReportPath,
    deepResearchTopic: str(ev.topic) || prev.deepResearchTopic,
    deepResearchScale: str(ev.scale) || prev.deepResearchScale,
    deepResearchPhase: phase === 'done' ? 'done' : 'running',
    deepResearchStartedAt: prev.deepResearchStartedAt ?? Date.now(),
    deepResearchStats: {
      sources: num(ev.sources),
      domains: num(ev.domains),
      claims: num(ev.claims),
      disputed: num(ev.disputed),
      singleSource: num(ev.singleSource),
      dispatched: num(ev.dispatched),
      completed: num(ev.completed),
      failed: num(ev.failed),
      inFlight: num(ev.inFlight),
      queued: num(ev.queued),
      concurrency: num(ev.concurrency),
      maxWorkers: num(ev.maxWorkers),
    },
    deepResearchWorkers: workers.length > 0 ? workers : prev.deepResearchWorkers,
  };
}

/** worker_start 的 task 文案 → 题目。deepResearch.ts 派活时写的是 `调研: <question 前 60 字>`。 */
export function stripWorkerTaskPrefix(task: string): string {
  return String(task ?? '').replace(/^\s*(调研|探索|任务)\s*[:：]\s*/, '').trim();
}

/**
 * 把一个子 agent 绑到某一行上。
 *
 * 绑定键只能靠**题目前缀**: agentTool 派活时只带得过去一个 description 字符串,
 * 没有地方塞我们自己的 seed id。两边都是从同一个 sub.question 切出来的, 所以前缀一定对得上。
 * 前缀对不上时 (题目被别处改写过) 退一步: 挑第一个还没绑 agent 的 running 行。
 * 宁可绑到相邻那一行, 也好过整行没有 token 显示。
 */
export function bindResearchWorker(
  prev: ResearchLiveFields,
  agentId: string,
  task: string,
): ResearchLiveFields {
  const rows = prev.deepResearchWorkers;
  if (!rows || rows.length === 0 || !agentId) return prev;
  if (rows.some((r) => r.agentId === agentId)) return prev;

  const wanted = stripWorkerTaskPrefix(task);
  let idx = -1;
  if (wanted) {
    idx = rows.findIndex((r) => !r.agentId && (r.question.startsWith(wanted) || wanted.startsWith(r.question)));
  }
  if (idx < 0) idx = rows.findIndex((r) => !r.agentId && r.status === 'running');
  if (idx < 0) idx = rows.findIndex((r) => !r.agentId);
  if (idx < 0) return prev;

  const next = [...rows];
  next[idx] = { ...next[idx], agentId };
  return { ...prev, deepResearchWorkers: next };
}

function patchRow(
  prev: ResearchLiveFields,
  agentId: string,
  fn: (row: ResearchWorkerRow) => ResearchWorkerRow,
): ResearchLiveFields {
  const rows = prev.deepResearchWorkers;
  if (!rows) return prev;
  const idx = rows.findIndex((r) => r.agentId === agentId);
  if (idx < 0) return prev;
  const next = [...rows];
  next[idx] = fn(next[idx]);
  return { ...prev, deepResearchWorkers: next };
}

/** 子 agent 又调了一个工具: 这一行的工具数 +1, 并把"正在干什么"换成这个工具名。 */
export function applyResearchWorkerTool(
  prev: ResearchLiveFields,
  agentId: string,
  toolName: string,
): ResearchLiveFields {
  return patchRow(prev, agentId, (row) => ({
    ...row,
    toolCount: (row.toolCount || 0) + 1,
    currentTool: toolName || row.currentTool,
  }));
}

/**
 * 这一行的 token。
 *   mode 'add' = 流式 delta 的估算值, 累加;
 *   mode 'max' = 一轮结束的权威 usage, 取大 —— 不能直接盖, 权威值是**单轮**的,
 *                而估算值是整条命的累计, 直接盖会让数字往回跳。
 */
export function applyResearchWorkerTokens(
  prev: ResearchLiveFields,
  agentId: string,
  tokens: number,
  mode: 'add' | 'max',
): ResearchLiveFields {
  if (!Number.isFinite(tokens) || tokens <= 0) return prev;
  return patchRow(prev, agentId, (row) => ({
    ...row,
    tokens: mode === 'add' ? (row.tokens || 0) + tokens : Math.max(row.tokens || 0, tokens),
  }));
}

export function markResearchWorkerDone(
  prev: ResearchLiveFields,
  agentId: string,
  ok: boolean,
  summary?: string,
  toolCount?: number,
): ResearchLiveFields {
  return patchRow(prev, agentId, (row) => ({
    ...row,
    status: ok ? 'done' : 'failed',
    ...(summary ? { summary: String(summary).slice(0, 120) } : {}),
    ...(toolCount && toolCount > (row.toolCount || 0) ? { toolCount } : {}),
    currentTool: undefined,
  }));
}

/** 卡上那个合计 token —— 每一路之和。 */
export function totalResearchTokens(rows: ResearchWorkerRow[] | undefined): number {
  return (rows || []).reduce((sum, r) => sum + (r.tokens || 0), 0);
}
