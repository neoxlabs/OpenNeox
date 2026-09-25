/**
 * TeamRunValidator — team_run 泳道结构化校验 (Team P2, TEAM_MODE_DESIGN §3.2)
 *
 * 防拆碎是**机制**不是恳求: colony evals + 用户体感双重实证 "拆得越细死得越惨",
 * 所以硬规则在这里以结构化校验落地 — 违规直接拒绝并返回结构化错误让 Conductor 重拆,
 * LLM 想违反也违反不了。
 *
 * 硬规则 (§3.2):
 *   - 泳道数 2-4 (单 lane / 0 lane → 建议直接执行不开团; >4 → 重拆合并)
 *   - 每 lane 预计工作量 ≥5 分钟 (缺省按 ownedScope 规模粗估)
 *   - 写角色 (implementer/researcher) 的 ownedScope 互斥 — 路径重叠即拒
 *     (reviewer 只读不占 worktree, 允许覆盖全库, 不参与互斥)
 *   - 整任务预计 <10 分钟 → 降级建议 (直接执行更快)
 *   - 里程碑 ≤2 个 (同步稀: 通常是"接口定型"/"全部完成")
 */

export type TeamLaneRole = 'implementer' | 'researcher' | 'reviewer';

export const TEAM_LANE_ROLES: readonly TeamLaneRole[] = ['implementer', 'researcher', 'reviewer'];

/** 泳道数硬上限 (§3.2: 默认 ≤4 — implementer ≤3 + reviewer) */
export const MAX_TEAM_LANES = 4;
/** 泳道数下限 — 少于 2 条泳道没有并行收益, 直接执行更快 */
export const MIN_TEAM_LANES = 2;
/** 单 lane 最小工作量门槛 (分钟) — 低于此值的碎泳道被拒 */
export const MIN_LANE_MINUTES = 5;
/** 整任务最小工作量门槛 (分钟) — 低于此值建议降级单 agent */
export const MIN_TEAM_TOTAL_MINUTES = 10;
/** 里程碑数上限 (§3.2: 依赖表达退化为里程碑, 通常 ≤2) */
export const MAX_TEAM_MILESTONES = 2;

export interface TeamLaneInput {
  role?: string;
  goal?: string;
  ownedScope?: string[];
  acceptance?: string;
  model?: string;
  estimatedMinutes?: number;
  /** 这条泳道认领了哪些战略块 (plan_target 的 b1/b2/…) —— 编队跟块清单的连接点。
   *  只有块清单说"要做什么", 没人说"谁做", 规划就是半成品 (用户指正)。 */
  blockIds?: string[];
}

export interface TeamMilestoneInput {
  id?: string;
  title?: string;
}

export interface TeamRunInput {
  goal?: string;
  lanes?: TeamLaneInput[];
  milestones?: TeamMilestoneInput[];
}

export interface NormalizedTeamLane {
  role: TeamLaneRole;
  goal: string;
  /** 归一化后的领地路径 (去 './' 前缀 / 反斜杠统一 / 去尾 '/') */
  ownedScope: string[];
  acceptance: string;
  model?: string;
  /** 缺省时按 ownedScope 规模粗估后的值 */
  estimatedMinutes: number;
  /** 认领的战略块 id (可空 —— 老调用方/无块场景不强制) */
  blockIds?: string[];
}

export interface TeamMilestone {
  id: string;
  title: string;
}

export interface TeamRunViolation {
  code:
    | 'INVALID_ARGS'
    | 'TOO_FEW_LANES'
    | 'TOO_MANY_LANES'
    | 'INVALID_ROLE'
    | 'LANE_INCOMPLETE'
    | 'LANE_TOO_SMALL'
    | 'SCOPE_OVERLAP'
    | 'TASK_TOO_SMALL'
    | 'TOO_MANY_MILESTONES';
  message: string;
  /** 涉事 lane 的下标 (0-based), 便于 Conductor 定位重拆 */
  lanes?: number[];
}

export type TeamRunValidation =
  | { ok: true; goal: string; lanes: NormalizedTeamLane[]; milestones: TeamMilestone[] }
  | {
      ok: false;
      /** 首要违规码 — 方便调用方/测试快速分支 */
      code: TeamRunViolation['code'];
      violations: TeamRunViolation[];
      /** 给 Conductor 的下一步动作指引: 重拆 or 放弃开团直接执行 */
      advice: string;
    };

/**
 * 缺省工作量粗估 — 按 ownedScope 区块数近似:
 * 一个文件/目录区块的实现+自查 ≈ 4 分钟, 加 3 分钟固定启动理解成本, 封顶 40。
 * 刻意保守 (宁可高估让团开起来, 也不低估把正当泳道误杀成碎块)。
 */
export function estimateLaneMinutes(ownedScope: string[]): number {
  const blocks = Math.max(1, ownedScope.length);
  return Math.min(40, 3 + blocks * 4);
}

/** 归一化领地路径: 统一 '/'、去 './' 前缀、去尾 '/'、trim。空串过滤由调用方做。 */
function normalizeScopePath(p: string): string {
  let s = String(p).trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** a 与 b 是否领地重叠: 相等, 或一方是另一方的目录前缀 */
function scopesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * team_run 入参结构化校验 + 归一化。
 * 所有违规一次性收集返回 (不挤牙膏), Conductor 一轮就能改对。
 */
export function validateTeamRun(input: TeamRunInput): TeamRunValidation {
  const violations: TeamRunViolation[] = [];

  const goal = typeof input?.goal === 'string' ? input.goal.trim() : '';
  if (!goal) {
    violations.push({ code: 'INVALID_ARGS', message: 'goal 不能为空 — 写清楚这个团队要达成什么' });
  }

  const rawLanes = Array.isArray(input?.lanes) ? input.lanes : [];

  // ── 泳道数硬门槛 ────────────────────────────────────────────
  if (rawLanes.length < MIN_TEAM_LANES) {
    violations.push({
      code: 'TOO_FEW_LANES',
      message:
        `泳道数 ${rawLanes.length} < ${MIN_TEAM_LANES} — 无并行收益。` +
        `这个任务不需要开团: 直接自己执行 (或派单个 agent) 更快。`,
    });
  }
  if (rawLanes.length > MAX_TEAM_LANES) {
    violations.push({
      code: 'TOO_MANY_LANES',
      message:
        `泳道数 ${rawLanes.length} > ${MAX_TEAM_LANES} — 拆得越细死得越惨 (启动+上下文传递开销吃掉全部并行收益)。` +
        `按模块/目录区块合并成 ${MAX_TEAM_LANES} 条以内的大块泳道。`,
    });
  }

  // ── 逐 lane 校验 + 归一化 ───────────────────────────────────
  const lanes: NormalizedTeamLane[] = [];
  rawLanes.forEach((lane, i) => {
    const role = String(lane?.role ?? '').trim().toLowerCase();
    if (!TEAM_LANE_ROLES.includes(role as TeamLaneRole)) {
      violations.push({
        code: 'INVALID_ROLE',
        message: `lane[${i}].role "${lane?.role}" 非法 — 必须是 ${TEAM_LANE_ROLES.join(' / ')} 之一`,
        lanes: [i],
      });
    }
    const laneGoal = typeof lane?.goal === 'string' ? lane.goal.trim() : '';
    const acceptance = typeof lane?.acceptance === 'string' ? lane.acceptance.trim() : '';
    const ownedScope = (Array.isArray(lane?.ownedScope) ? lane.ownedScope : [])
      .map(normalizeScopePath)
      .filter(Boolean);
    const missing: string[] = [];
    if (!laneGoal) missing.push('goal');
    if (!acceptance) missing.push('acceptance');
    if (ownedScope.length === 0) missing.push('ownedScope');
    if (missing.length > 0) {
      violations.push({
        code: 'LANE_INCOMPLETE',
        message: `lane[${i}] 缺少 ${missing.join(' / ')} — 泳道必须有明确职责、领地和验收标准`,
        lanes: [i],
      });
    }

    const rawMinutes = Number(lane?.estimatedMinutes);
    const estimatedMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0
      ? rawMinutes
      : estimateLaneMinutes(ownedScope);
    if (estimatedMinutes < MIN_LANE_MINUTES) {
      violations.push({
        code: 'LANE_TOO_SMALL',
        message:
          `lane[${i}] 预计 ${estimatedMinutes} 分钟 < ${MIN_LANE_MINUTES} 分钟 — 碎泳道被禁` +
          ` (启动开销 > 工作量)。把它合并进相邻泳道。`,
        lanes: [i],
      });
    }

    lanes.push({
      role: (TEAM_LANE_ROLES.includes(role as TeamLaneRole) ? role : 'implementer') as TeamLaneRole,
      goal: laneGoal,
      ownedScope,
      acceptance,
      model: typeof lane?.model === 'string' && lane.model.trim() ? lane.model.trim() : undefined,
      estimatedMinutes,
      blockIds: Array.isArray(lane?.blockIds)
        ? lane.blockIds.map((b) => String(b).trim()).filter(Boolean)
        : undefined,
    });
  });

  // ── 写角色领地互斥 (§5 写隔离: worktree 合并冲突的第一道防线) ──
  //   reviewer 只读 (不占 worktree, 不产生合并冲突), 允许覆盖任意范围。
  const writeLanes = lanes
    .map((lane, i) => ({ lane, i }))
    .filter(({ lane }) => lane.role !== 'reviewer');
  for (let a = 0; a < writeLanes.length; a++) {
    for (let b = a + 1; b < writeLanes.length; b++) {
      const overlaps: string[] = [];
      for (const sa of writeLanes[a].lane.ownedScope) {
        for (const sb of writeLanes[b].lane.ownedScope) {
          if (scopesOverlap(sa, sb)) overlaps.push(`"${sa}" ↔ "${sb}"`);
        }
      }
      if (overlaps.length > 0) {
        violations.push({
          code: 'SCOPE_OVERLAP',
          message:
            `lane[${writeLanes[a].i}] 与 lane[${writeLanes[b].i}] 领地重叠: ${overlaps.join(', ')} — ` +
            `写角色的 ownedScope 必须互斥 (并行写同一区块 = 合并冲突)。按文件/目录区块重新划界。`,
          lanes: [writeLanes[a].i, writeLanes[b].i],
        });
      }
    }
  }

  // ── 整任务规模门槛 (§3.2: 整任务 <10 分钟 → 直接降级单 agent) ──
  const totalMinutes = lanes.reduce((sum, l) => sum + l.estimatedMinutes, 0);
  if (rawLanes.length >= MIN_TEAM_LANES && totalMinutes < MIN_TEAM_TOTAL_MINUTES) {
    violations.push({
      code: 'TASK_TOO_SMALL',
      message:
        `整任务预计 ${totalMinutes} 分钟 < ${MIN_TEAM_TOTAL_MINUTES} 分钟 — 任务较小, 单 agent 直接执行更快。` +
        `不要开团, 直接自己做 (或派一个 agent)。`,
    });
  }

  // ── 里程碑 ──────────────────────────────────────────────────
  const rawMilestones = Array.isArray(input?.milestones) ? input.milestones : [];
  if (rawMilestones.length > MAX_TEAM_MILESTONES) {
    violations.push({
      code: 'TOO_MANY_MILESTONES',
      message:
        `里程碑 ${rawMilestones.length} 个 > ${MAX_TEAM_MILESTONES} 个 — 同步要稀 (密集同步点 = 变相细碎 DAG)。` +
        `只保留真正的跨泳道依赖点 (如"接口定型"/"全部完成")。`,
    });
  }
  const milestones: TeamMilestone[] = rawMilestones
    .slice(0, MAX_TEAM_MILESTONES)
    .map((m, i) => ({
      id: String(m?.id ?? `m${i + 1}`).trim() || `m${i + 1}`,
      title: String(m?.title ?? '').trim() || `milestone ${i + 1}`,
    }));

  if (violations.length > 0) {
    const degrade = violations.some(v => v.code === 'TOO_FEW_LANES' || v.code === 'TASK_TOO_SMALL');
    return {
      ok: false,
      code: violations[0].code,
      violations,
      advice: degrade
        ? '不要开团 — 任务规模不够摊薄并行开销。直接自己执行, 或派一个 agent 单干, 并向用户说明"任务较小, 单 agent 直接执行更快"。'
        : '按 violations 逐条修正后重新调用 team_run: 合并碎块、按目录区块重新划分互斥领地、补齐缺失字段。不要把同一个违规原样重发。',
    };
  }

  return { ok: true, goal, lanes, milestones };
}
