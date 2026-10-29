
/** 每百万 token 的美元价 */
export interface ModelPrice {
  input: number;
  output: number;
  /** 缓存命中的输入价; 不给按 input 的 10% 算 (主流厂商的缓存读都在这个量级) */
  cachedInput?: number;
}

export interface BudgetRoute {
  providerId: string;
  modelName: string;
}

export interface SessionBudgetConfig {
  /** 本会话预算上限 (美元); 0 = 只记账不熔断 */
  limitUsd: number;
  /** 规划 / 审查用的贵模型; 不给 = 子 agent 照常路由, 只做预算控制 */
  advisor?: BudgetRoute | null;
  /** 指挥模式: 主循环 (输入框选的贵模型) 只指挥, 子 agent 一律用这个便宜模型干活 */
  worker?: BudgetRoute | null;
  /** 模型名 → 价格。缺的模型走 DEFAULT_PRICES, 再缺记 0 并在快照里标出来 */
  prices?: Record<string, ModelPrice>;
}

export interface UsageSample {
  model: string;
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
  /** main = 主 agent; sub = 子 agent (plan/verify/code...) */
  source: 'main' | 'sub';
}

export interface ModelSpend {
  usd: number;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** 这个模型没有价格 —— 花费按 0 记, UI 要提示「有模型未计价」 */
  unpriced?: boolean;
}

export interface BudgetSnapshot {
  sessionId: string;
  limitUsd: number;
  spentUsd: number;
  /** spent / limit; limit=0 时为 0 */
  ratio: number;
  exceeded: boolean;
  byModel: Record<string, ModelSpend>;
  advisorModel: string | null;
  /** 「如果全程都用规划模型」按同样 token 量估的花费; 没配 advisor 时为 null */
  allAdvisorUsd: number | null;
}

export type BudgetEvent =
  | { type: 'budget_update'; snapshot: BudgetSnapshot }
  | { type: 'budget_threshold'; snapshot: BudgetSnapshot; threshold: number }
  | { type: 'budget_exceeded'; snapshot: BudgetSnapshot };

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-5.6-sol': { input: 2, output: 10 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4.24, output: 21.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'deepseek-v4.1-flash': { input: 0.3, output: 1.2 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96 },
  'kimi-k3': { input: 3, output: 15 },
  'glm-5.3': { input: 1.4, output: 4.4 },
  'glm-5.3-flash': { input: 0.15, output: 0.5 },
  'qwen3.8-max': { input: 2.32, output: 6.97 },
};

/** 预算提醒的档位 (占比) —— 跨过一档发一次 threshold 事件, 同一档不重复 */
export const BUDGET_THRESHOLDS = [0.5, 0.8] as const;

/** 规划 / 审查两类子 agent 走贵模型; 其余 (code / shell / explore ...) 继承主力便宜模型 */
export const ADVISOR_AGENT_TYPES = new Set(['plan', 'verify']);

export function priceOf(model: string, prices?: Record<string, ModelPrice>): ModelPrice | null {
  const key = (model || '').trim().toLowerCase();
  if (!key) return null;
  for (const table of [prices, DEFAULT_PRICES]) {
    if (!table) continue;
    if (table[key]) return table[key]!;
    for (const [k, v] of Object.entries(table)) if (k.toLowerCase() === key) return v;
  }
  /* 带日期 / 渠道后缀的别名 (claude-haiku-4-5-20251001): 最长前缀命中 */
  let best: { k: string; v: ModelPrice } | null = null;
  for (const table of [prices, DEFAULT_PRICES]) {
    if (!table) continue;
    for (const [k, v] of Object.entries(table)) {
      if (key.startsWith(k.toLowerCase()) && (!best || k.length > best.k.length)) best = { k, v };
    }
  }
  return best?.v ?? null;
}

export function costOf(sample: Pick<UsageSample, 'inputTokens' | 'cachedTokens' | 'outputTokens'>, price: ModelPrice): number {
  const cached = Math.max(0, Math.min(sample.cachedTokens ?? 0, sample.inputTokens));
  const fresh = Math.max(0, sample.inputTokens - cached);
  const cachedPrice = price.cachedInput ?? price.input * 0.1;
  return (fresh * price.input + cached * cachedPrice + Math.max(0, sample.outputTokens) * price.output) / 1e6;
}

interface BudgetState {
  config: SessionBudgetConfig;
  byModel: Record<string, ModelSpend>;
  spentUsd: number;
  /** 已经提醒过的最高档位 */
  notified: number;
  exceededFired: boolean;
}

const states = new Map<string, BudgetState>();
/** 子 agent 会话 → 根会话 (子 agent 的花费记到发起它的那个会话账上) */
const parents = new Map<string, string>();
const listeners = new Set<(sessionId: string, e: BudgetEvent) => void>();

export function setSessionBudget(sessionId: string, config: SessionBudgetConfig | null): BudgetSnapshot | null {
  if (!sessionId) return null;
  if (!config) { states.delete(sessionId); return null; }
  const prev = states.get(sessionId);
  const limitUsd = Math.max(0, Number(config.limitUsd) || 0);
  const next: BudgetState = prev
    /* 改预算不清账: 用户把 $1 调到 $3, 已经花掉的照样算数; 调高后允许再提醒 / 再熔断 */
    ? { ...prev, config: { ...config, limitUsd }, notified: 0, exceededFired: false }
    : { config: { ...config, limitUsd }, byModel: {}, spentUsd: 0, notified: 0, exceededFired: false };
  states.set(sessionId, next);
  const snap = snapshotOf(sessionId, next);
  emit(sessionId, { type: 'budget_update', snapshot: snap });
  return snap;
}

export function getSessionBudget(sessionId: string | undefined): SessionBudgetConfig | null {
  return sessionId ? states.get(rootOf(sessionId))?.config ?? null : null;
}

export function linkChildSession(childSessionId: string, parentSessionId: string): void {
  if (childSessionId && parentSessionId && childSessionId !== parentSessionId) parents.set(childSessionId, parentSessionId);
}

export function rootOf(sessionId: string): string {
  let cur = sessionId;
  for (let i = 0; i < 8 && parents.has(cur); i++) cur = parents.get(cur)!;
  return cur;
}

export function getBudgetSnapshot(sessionId: string | undefined): BudgetSnapshot | null {
  if (!sessionId) return null;
  const root = rootOf(sessionId);
  const st = states.get(root);
  return st ? snapshotOf(root, st) : null;
}

/** 记一发请求。没设预算的会话直接忽略 (零成本)。返回记账后的快照。 */
export function recordBudgetUsage(sessionId: string | undefined, sample: UsageSample): BudgetSnapshot | null {
  if (!sessionId || states.size === 0) return null;
  const root = rootOf(sessionId);
  const st = states.get(root);
  if (!st) return null;
  const price = priceOf(sample.model, st.config.prices);
  const usd = price ? costOf(sample, price) : 0;
  const m = (st.byModel[sample.model] ??= { usd: 0, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  m.usd += usd; m.requests += 1;
  m.inputTokens += Math.max(0, sample.inputTokens);
  m.cachedTokens += Math.max(0, sample.cachedTokens ?? 0);
  m.outputTokens += Math.max(0, sample.outputTokens);
  if (!price) m.unpriced = true;
  st.spentUsd += usd;

  const snap = snapshotOf(root, st);
  emit(root, { type: 'budget_update', snapshot: snap });
  if (st.config.limitUsd > 0) {
    for (const t of BUDGET_THRESHOLDS) {
      if (snap.ratio >= t && st.notified < t) { st.notified = t; emit(root, { type: 'budget_threshold', snapshot: snap, threshold: t }); }
    }
    if (snap.exceeded && !st.exceededFired) { st.exceededFired = true; emit(root, { type: 'budget_exceeded', snapshot: snap }); }
  }
  return snap;
}

export function isBudgetExceeded(sessionId: string | undefined): boolean {
  return !!getBudgetSnapshot(sessionId)?.exceeded;
}

export function onBudgetEvent(listener: (sessionId: string, e: BudgetEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 子 agent 该用哪个模型: 预算模式下 plan / verify 走规划模型; 其他返回 null (照常路由) */
export function advisorRouteFor(sessionId: string | undefined, agentTypeId: string | undefined): BudgetRoute | null {
  const cfg = getSessionBudget(sessionId);
  if (!cfg?.advisor || !agentTypeId) return null;
  return ADVISOR_AGENT_TYPES.has(agentTypeId) ? cfg.advisor : null;
}

/** 指挥模式下子 agent 的模型 (fork 除外, 由调用方判断); 没开指挥模式返回 null */
export function workerRouteFor(sessionId: string | undefined): BudgetRoute | null {
  return getSessionBudget(sessionId)?.worker ?? null;
}

/** 这个会话是不是指挥模式的**主循环** (子 agent 会话不算 —— 它们是干活的) */
export function isConductorMain(sessionId: string | undefined): boolean {
  return !!sessionId && !parents.has(sessionId) && !!states.get(sessionId)?.config.worker;
}

/** 指挥模式下追加给子 agent 任务的汇报要求 —— 主管按贵价读每一个字, 汇报越短越省 */
export const CONDUCTOR_WORKER_REPORT_RULE_ZH =
  '\n\n[汇报要求] 做完后用不超过 8 行汇报: 改了哪些文件; 跑了什么验证、结果如何 (通过数 / 失败的用例名和一句原因); 还有什么没解决。不要贴代码, 不要复述需求。';

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

export function getBudgetPromptSection(sessionId: string | undefined, lang: 'zh' | 'en' = 'zh'): string {
  const snap = getBudgetSnapshot(sessionId);
  const cfg = getSessionBudget(sessionId);
  if (!snap || !cfg) return '';
  const pct = snap.limitUsd > 0 ? Math.min(100, Math.floor(snap.ratio * 10) * 10) : null;
  const adv = cfg.advisor?.modelName;
  if (cfg.worker) return conductorPromptSection(snap, pct, cfg.worker.modelName, lang);
  if (lang === 'en') {
    return [
      '<budget>',
      snap.limitUsd > 0
        ? `This session has a spending budget of ${usd(snap.limitUsd)} (all requests, including sub-agents, at list price). About ${pct}% is used.`
        : 'This session is in cost-saving mode (spend is tracked, no hard limit).',
      '· You are the worker: write the code, run commands and tests yourself. Do not hand implementation to sub-agents.',
      adv
        ? `· The expensive model (${adv}) is for two checkpoints only: for a non-trivial task, dispatch ONE agent of type "plan" first to get an implementation plan and pitfalls list; when done, dispatch ONE agent of type "verify" to review your work against the requirements. Pass only what they need, not whole files they can read themselves.`
        : '· Do not dispatch sub-agents unless the task truly needs parallel work.',
      '· Avoid re-reading files you already have; keep tool output short (tail/grep).',
      snap.limitUsd > 0 ? '· Past 80% of the budget: skip optional work, finish the essentials, and report what is left. When the budget runs out the run stops.' : '',
      '</budget>',
    ].filter(Boolean).join('\n');
  }
  return [
    '<budget>',
    snap.limitUsd > 0
      ? `本会话有花费预算 ${usd(snap.limitUsd)} (含子 Agent 的全部请求, 按官方价), 目前约用掉 ${pct}%。`
      : '本会话处于省钱模式 (记账, 不设上限)。',
    '· 你是干活的人: 代码自己写、命令和测试自己跑, 不要把实现派给子 Agent。',
    adv
      ? `· 贵模型 (${adv}) 只用在两个关口: 任务不简单时, 先派一个 type="plan" 的子 Agent 出实现方案和易错点; 做完后派一个 type="verify" 的子 Agent 对照需求审查。只给它们必要的说明, 别把它们自己能读的文件整段贴过去。`
      : '· 除非真的需要并行, 不要派子 Agent。',
    '· 读过的文件别反复读; 命令输出尽量短 (tail / grep)。',
    snap.limitUsd > 0 ? '· 用过 80% 后: 砍掉可选的工作, 先把必须的做完并说明还剩什么。预算用完会被自动停下。' : '',
    '</budget>',
  ].filter(Boolean).join('\n');
}

function conductorPromptSection(snap: BudgetSnapshot, pct: number | null, worker: string, lang: 'zh' | 'en'): string {
  const limit = snap.limitUsd > 0;
  if (lang === 'en') {
    return [
      '<conductor>',
      `Conductor mode is on. You are the conductor, not the main pair of hands: substantial work — building a feature, fixing a bug, investigating a problem, writing tests, sweeping changes, exploring the codebase — goes to sub-agents (agent tool). They run on the cheaper ${worker} and can carry a whole piece of work end to end.`,
      limit ? `Session budget ${usd(snap.limitUsd)} (all requests incl. sub-agents), about ${pct}% used.` : '',
      '· Your job: understand the request, split it into pieces, give each piece a clear brief (goal, relevant files, how to check it is done), dispatch it, read the report, verify, decide what is next. Independent pieces can go out at the same time.',
      '· If a report shows a problem, send it back to a sub-agent to fix rather than redoing it yourself.',
      '· Keep for yourself only what is quicker than writing a brief: answering a question, glancing at a file, a one-line tweak.',
      limit ? '· Past 80% of the budget: finish the essentials and report what remains. The run stops when the budget runs out.' : '',
      '</conductor>',
    ].filter(Boolean).join('\n');
  }
  return [
    '<conductor>',
    `指挥模式已开: 你是指挥, 不是主力手。成块的活 —— 实现功能、修 bug、排查问题、写测试、批量改动、摸清代码库 —— 都交给子 Agent (agent 工具), 它们用更便宜的 ${worker}, 能把一整块活从头干完。`,
    limit ? `本会话预算 ${usd(snap.limitUsd)} (含子 Agent 的全部请求), 目前约用掉 ${pct}%。` : '',
    '· 你的活: 弄清需求、拆成几块、给每块写清楚的任务说明 (目标、相关文件、怎么算做完), 派出去, 看汇报、验收、决定下一步。互不依赖的几块可以同时派。',
    '· 汇报里有问题就再派给子 Agent 去修, 别自己接手重写。',
    '· 只有比写任务说明还快的事自己做: 回答一个问题、看一眼文件、改一两行。',
    limit ? '· 用过 80% 后: 先把必须的做完, 说明还剩什么。预算用完会被自动停下。' : '',
    '</conductor>',
  ].filter(Boolean).join('\n');
}

/** 跨档提醒 (perTurnInjector 用) —— 只在刚跨过某一档时返回一句, 平时返回 null */
export function budgetThresholdNote(snapshot: BudgetSnapshot, threshold: number, lang: 'zh' | 'en' = 'zh'): string {
  const pct = Math.round(threshold * 100);
  return lang === 'en'
    ? `[budget] ${pct}% of the ${usd(snapshot.limitUsd)} budget is used (${usd(snapshot.spentUsd)}). ${threshold >= 0.8 ? 'Wrap up: finish the essentials only.' : 'Keep going, stay lean.'}`
    : `[预算] 已用 ${pct}% (${usd(snapshot.spentUsd)} / ${usd(snapshot.limitUsd)})。${threshold >= 0.8 ? '开始收尾: 只做必须的部分。' : '继续, 保持精简。'}`;
}

function snapshotOf(sessionId: string, st: BudgetState): BudgetSnapshot {
  const limit = st.config.limitUsd;
  const advisorModel = st.config.advisor?.modelName ?? null;
  let allAdvisorUsd: number | null = null;
  if (advisorModel) {
    const ap = priceOf(advisorModel, st.config.prices);
    if (ap) {
      allAdvisorUsd = Object.values(st.byModel).reduce((s, m) => s + costOf({ inputTokens: m.inputTokens, cachedTokens: m.cachedTokens, outputTokens: m.outputTokens }, ap), 0);
    }
  }
  return {
    sessionId,
    limitUsd: limit,
    spentUsd: st.spentUsd,
    ratio: limit > 0 ? st.spentUsd / limit : 0,
    exceeded: limit > 0 && st.spentUsd >= limit,
    byModel: JSON.parse(JSON.stringify(st.byModel)),
    advisorModel,
    allAdvisorUsd,
  };
}

function emit(sessionId: string, e: BudgetEvent): void {
  for (const l of listeners) { try { l(sessionId, e); } catch { /* 监听方的错不影响记账 */ } }
}

/** 测试用 */
export function __resetBudgetsForTest(): void { states.clear(); parents.clear(); listeners.clear(); }
