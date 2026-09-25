/**
 * cluster 核心类型 —— 三层抽象。
 *
 * 【设计】**节点内满血自主, 节点间确定性调度**:
 *   ClusterNode      内部仍是 |𝒰|≤1 的完整 agent loop —— 不管它怎么想
 *   ClusterScheduler 节点之间 |𝒰|≥1, 依赖显式、拓扑序、确定性 —— 这里必须硬
 *   Workflow         **数据, 不是代码** —— 用户可定义模板, teamwork 只是其中一个
 */

// ────────────────────────────────────────────────────────────
// 节点 —— 一个完整的 neox agent 会话
// ────────────────────────────────────────────────────────────

/**
 * 节点不是"阉割版 worker", 是**对等的完整 neox**。
 * 它有全套工具、能自己再派子 agent、有自己的 worktree 和上下文。
 * 底层 agent loop 本来就强, 把节点做成受限 worker 是浪费能力。
 */
export interface NodeSpec {
  /** 节点 id — 全集群唯一, 同时用作 worktree 分支名与调度 key */
  id: string;
  /** 给这个节点的任务 (意图, 不是步骤清单 —— 节点内自主) */
  prompt: string;
  /** 显式依赖: 这些节点完成后本节点才进就绪集 */
  dependsOn?: string[];
  /**
   * join 语义 (arXiv 2604.11378 的调度原语):
   *   all_of — 全部前驱完成 (默认)
   *   any_of — 任一前驱完成即可, 其余跳过
   */
  join?: 'all_of' | 'any_of';
  /** 领地: 只准碰这些路径 —— 越界会在合并时被检出 */
  ownedPaths?: string[];
  /** 模型覆盖; 不传继承集群默认 */
  model?: string;
  /** 是否在独立 worktree 里跑 (写节点默认 true, 只读节点 false) */
  isolate?: boolean;
  /** 节点自己能不能再派子 agent。**计入全局并发预算** */
  allowSubAgents?: boolean;
}

export type NodeStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';

export interface NodeResult {
  id: string;
  status: NodeStatus;
  /** 节点最终输出文本 */
  output: string;
  /** 结构化产出 (固定 schema —— 不让 agent 协商格式,
   *  依据: arXiv 2606.19135 可演化 schema 的协商开销显著) */
  artifacts?: Record<string, unknown>;
  startedAt?: number;
  finishedAt?: number;
  tokens: number;
  turns: number;
  /** worktree 分支 (isolate 时) */
  branch?: string;
  workDir?: string;
  error?: string;
}

// ────────────────────────────────────────────────────────────
// 工作流 —— 数据, 不是代码
// ────────────────────────────────────────────────────────────

/**
 * 工作流是**模板数据**, 用户可自定义。
 *
 * 框架只提供**节点 + 调度**, 具体怎么编排由模板定义。
 * teamwork (需求分析→并行开发→集成) 只是自带的一个模板, 不是模式。
 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** 静态节点 (可选) —— 也可以完全由 planner 在运行时生成 */
  nodes?: NodeSpec[];
  /**
   * 动态规划器: 拿到目标后现场产出节点图。
   * 有它就是 dynamic workflow (运行时生成拓扑), 没有就是 static template。
   */
  planner?: {
    /** 规划节点的 prompt —— 它的产出必须能被解析成 NodeSpec[] */
    prompt: string;
    model?: string;
  };
  /** 常开机制开关 */
  features?: {
    /** 持续集成: 每 N 毫秒合并 + 校验 + 错误回灌。0 = 关 */
    continuousIntegrationMs?: number;
    /** 校验命令 (typecheck/build/test) —— 集成闸 */
    verifyCommand?: string;
  };
}

// ────────────────────────────────────────────────────────────
// 调度
// ────────────────────────────────────────────────────────────

export interface ClusterBudget {
  /**
   * **全局**并发上限 —— 跨层统一, 不是每层各管各的。
   *
   *  这条是集群化最容易失控的地方: 节点是完整 neox, 会自己再派子 agent,
   * 3 个节点 × 每个 3 个子 agent = 12 并发, 而不是你以为的 3。
   * 现状 core 里 MAX_CONCURRENT_BACKGROUND_AGENTS=3 与 MAX_PARALLEL_EXPLORES=2
   * 是两个独立常数, 集群化后会变成三层各管各的 —— 必须由调度器统一收口。
   *
   * 实践参考: arXiv 2606.19135 —— 2026 年实践团队规模就是 3-4 个 agent,
   * 再多协调开销涨得比收益快。
   */
  maxConcurrent: number;
  /** 整体墙钟预算 (ms), 0 = 无限 */
  wallClockMs?: number;
  /** 输出 token 熔断 —— 放开时长闸之后唯一挡在跑飞和无上限账单之间的东西 */
  maxOutputTokens?: number;
}

export interface ClusterRunResult {
  workflowId: string;
  nodes: NodeResult[];
  wallClockMs: number;
  totalTokens: number;
  /** 集成校验的最终状态 */
  verify?: { ok: boolean; errorCount: number; sample: string[] };
  /** 越界: 节点改了不属于自己 ownedPaths 的文件 */
  trespass: Array<{ node: string; path: string }>;
  status: 'success' | 'partial' | 'aborted' | 'failed';
}

/** 调度事件 —— 供 UI / 日志消费 */
export type ClusterEvent =
  | { type: 'run_start'; workflowId: string; nodes: string[]; timestamp: number }
  | { type: 'node_ready'; id: string; timestamp: number }
  | { type: 'node_start'; id: string; timestamp: number }
  | { type: 'node_progress'; id: string; turns: number; tokens: number; timestamp: number }
  | { type: 'node_done'; id: string; status: NodeStatus; timestamp: number }
  | { type: 'integrate'; ok: boolean; errorCount: number; timestamp: number }
  | { type: 'run_complete'; status: ClusterRunResult['status']; timestamp: number };
