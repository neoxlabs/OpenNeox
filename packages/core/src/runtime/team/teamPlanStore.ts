
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export type TeamStage = 'requirements' | 'roster' | 'assignment' | 'ready';

export interface TeamRequirement {
  id: string;
  title: string;
  /** 展开说明 —— 要做成什么样 */
  detail?: string;
  /** 客观验收判据 */
  acceptance?: string;
  /** 归属模块/主题 —— 需求管理器按它分组 (没有分组的长清单没法看) */
  module?: string;
  /** 优先级 P0/P1/P2 —— 排期和取舍的依据 */
  priority?: 'P0' | 'P1' | 'P2';
  /** 依赖的其它需求 id —— 谁必须先做完 */
  dependsOn?: string[];
  /** 粗估工作量 (人时) —— 老字段, 保留兼容 */
  estimateHours?: number;
  estimateDays?: number;
  /** 任务状态 —— 看板一列, 后续执行层推进它 */
  status?: 'todo' | 'doing' | 'blocked' | 'done';

  /** 父节点 id —— 顶层节点为空 */
  parentId?: string;
  /** 层深 (0 = 域/顶层) —— 冗余存一份, 省得每次爬链 */
  depth?: number;
  /** 还能不能再拆: leaf = 可执行条目 (一个人 1~3 人天), branch = 还要往下展开 */
  kind?: 'branch' | 'leaf';
  /** 判成叶子的理由 —— 谁都能复核"凭什么说它不用再拆了" */
  leafReason?: string;
}

export interface TeamMember {
  id: string;
  /** 角色: implementer / researcher / reviewer / … (自由文本, 不硬编码枚举) */
  role: string;
  /** 职能title: "结算规则负责人" 这类人话 */
  title: string;
  /** 为什么这个团队需要这个人 */
  why?: string;
  model?: string;
  level?: string;
  /** 凭什么给这个级 —— 看板上跟等级并排显示, 谁都能复核 */
  levelReason?: string;
}

export type TeamMeetingKind = 'requirements' | 'design' | 'test' | 'estimate' | 'review' | 'standup';

export interface TeamMeetingNote {
  /** 谁说的 (roster 里的 id; 'facilitator' = 主持/主脑) */
  memberId: string;
  /** 他说了什么 */
  say: string;
}

export interface TeamMeeting {
  id: string;
  kind: TeamMeetingKind;
  /** 会议主题 —— 「需求评审: 九域范围与边界」这种人话 */
  title: string;
  /** 参会人 (roster id) */
  participants: string[];
  /** 逐条发言记录 —— 会议台上按时间顺序铺开 */
  notes: TeamMeetingNote[];
  /** 会上定下来的事 (决议) —— 比发言更重要, 单独存 */
  decisions?: string[];
  /** 会上没定下来、需要跟进的 */
  openQuestions?: string[];
  at: number;
}

export interface TeamMemberReview {
  memberId: string;
  /** 他想认领的需求 id */
  picks: string[];
  /** 他对这摊活的判断: 范围理解 / 为什么由我来做 / 打算怎么切 */
  analysis: string;
  /** 他看到的风险、坑、不确定的地方 */
  concerns?: string;
  /** 他需要别人先做完什么 (跨人依赖) */
  needs?: string[];
  at: number;
}

export interface TeamClaim {
  memberId: string;
  requirementIds: string[];
  /** 领地: 文件/目录区块, 写角色之间必须互斥 */
  ownedScope: string[];
  /** 领取理由 (自组网里这是成员自己说的) */
  why?: string;
}

export interface TeamPlan {
  teamId: string;
  sessionId: string;
  goal: string;
  stage: TeamStage;
  /** 需求分析文档路径 (相对工作区) —— 看板「文档」页读它。
   *  条目清单是给机器分配用的, 文档是给人读的, 两者都要有。 */
  documentPath?: string;
  requirements: TeamRequirement[];
  roster: TeamMember[];
  /** 成员发言 (每人一条, 后发的覆盖先发的) */
  reviews: TeamMemberReview[];
  /** 会议记录 —— 需求评审 / 开发研讨 / 测试研讨 …, 会议台按时间倒序铺 */
  meetings?: TeamMeeting[];
  claims: TeamClaim[];
  createdAt: number;
  updatedAt: number;
}

const plansBySession = new Map<string, TeamPlan>();

type PersistFn = (plan: TeamPlan) => void;
type LoadFn = (sessionId: string) => TeamPlan | null;
type PurgeFn = (sessionId: string) => void;
let persistImpl: PersistFn | null = null;
let loadImpl: LoadFn | null = null;
let purgeImpl: PurgeFn | null = null;

/** 宿主注入落盘/读取实现 (server 注入真 DB; 测试注入内存桩) */
export function setTeamPlanPersistence(
  fns: { persist?: PersistFn; load?: LoadFn; purge?: PurgeFn } | null,
): void {
  persistImpl = fns?.persist ?? null;
  loadImpl = fns?.load ?? null;
  purgeImpl = fns?.purge ?? null;
}

function touch(plan: TeamPlan): TeamPlan {
  plan.updatedAt = Date.now();
  plansBySession.set(plan.sessionId, plan);
  try { persistImpl?.(plan); } catch (err: any) {
    cliLogger.warn('TEAM_PLAN', `落盘失败 (不阻塞规划): ${err?.message ?? err}`);
  }
  return plan;
}

/** 拿这个会话的团队规划 —— 内存没有就回库里捞 (看板重建走这条) */
export function getTeamPlan(sessionId?: string | null): TeamPlan | null {
  if (!sessionId) return null;
  const cached = plansBySession.get(sessionId);
  if (cached) return cached;
  try {
    const loaded = loadImpl?.(sessionId) ?? null;
    if (loaded) plansBySession.set(sessionId, loaded);
    return loaded;
  } catch {
    return null;
  }
}

/** ① 开团 —— 进入需求解析阶段 */
export function startTeamPlan(sessionId: string, goal: string): TeamPlan {
  const teamId = `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  return touch({
    teamId, sessionId, goal,
    stage: 'requirements',
    requirements: [], roster: [], reviews: [], meetings: [], claims: [],
    createdAt: now, updatedAt: now,
  });
}

/** ① → ② 需求清单落定 */
export function setTeamRequirements(
  sessionId: string,
  requirements: TeamRequirement[],
  documentPath?: string,
): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  plan.requirements = requirements;
  if (documentPath) plan.documentPath = documentPath;
  plan.stage = 'roster';
  return touch(plan);
}

/** 单条改派 —— 看板上用户点着分配时走这条 (不是模型调的)。
 *  memberId 传 null = 收回认领。改完自动重算 stage: 领满了就 ready, 缺了就退回 assignment。 */
export function assignRequirement(
  sessionId: string,
  requirementId: string,
  memberId: string | null,
): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  if (!plan.requirements.some((r) => r.id === requirementId)) return null;
  if (memberId && !plan.roster.some((m) => m.id === memberId)) return null;
  /* 先从所有人手里摘掉这条 (一条需求只能有一个主人), 再给新主人 */
  for (const c of plan.claims) {
    c.requirementIds = c.requirementIds.filter((id) => id !== requirementId);
  }
  if (memberId) {
    let target = plan.claims.find((c) => c.memberId === memberId);
    if (!target) {
      target = { memberId, requirementIds: [], ownedScope: [] };
      plan.claims.push(target);
    }
    target.requirementIds.push(requirementId);
  }
  plan.stage = unclaimedRequirementIds(plan).length === 0 && plan.roster.length > 0
    ? 'ready'
    : (plan.roster.length > 0 ? 'assignment' : plan.stage);
  return touch(plan);
}

/** ② → ③ 编制落定 */
export function setTeamRoster(sessionId: string, roster: TeamMember[]): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  plan.roster = roster;
  plan.stage = 'assignment';
  return touch(plan);
}

/** ③a 成员发言 —— 每人一条, 同一个人再说一次就覆盖 */
export function addTeamMemberReview(sessionId: string, review: TeamMemberReview): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  if (!plan.roster.some((m) => m.id === review.memberId)) return null;
  plan.reviews = [...(plan.reviews ?? []).filter((r) => r.memberId !== review.memberId), review];
  return touch(plan);
}

/** 还没发言的成员 —— 全员说完才允许 team_claim */
export function membersWithoutReview(plan: TeamPlan): string[] {
  const spoke = new Set((plan.reviews ?? []).map((r) => r.memberId));
  return plan.roster.map((m) => m.id).filter((id) => !spoke.has(id));
}

/** ③ 领取 —— 全部需求都被认领后进 ready */
export function applyTeamClaims(sessionId: string, claims: TeamClaim[]): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  plan.claims = claims;
  plan.stage = unclaimedRequirementIds(plan).length === 0 ? 'ready' : 'assignment';
  return touch(plan);
}


/** 某节点的直接子节点 */
export function childrenOf(plan: TeamPlan, parentId: string): TeamRequirement[] {
  return plan.requirements.filter((r) => r.parentId === parentId);
}

/** 叶子 = 真正可执行、可领取的条目。老数据没有 kind, 没孩子就算叶子。 */
export function leafRequirements(plan: TeamPlan): TeamRequirement[] {
  const hasChild = new Set(plan.requirements.map((r) => r.parentId).filter(Boolean) as string[]);
  return plan.requirements.filter((r) => (r.kind ? r.kind === 'leaf' : !hasChild.has(r.id)));
}

/** 还没展开的分支 —— 声明了自己是 branch 却一个孩子都没有。规划不能停在这里。 */
export function openBranchIds(plan: TeamPlan): string[] {
  const hasChild = new Set(plan.requirements.map((r) => r.parentId).filter(Boolean) as string[]);
  return plan.requirements.filter((r) => r.kind === 'branch' && !hasChild.has(r.id)).map((r) => r.id);
}

/** 树的形状 —— 看板和工具回执都要报这几个数 */
export function treeShape(plan: TeamPlan): { total: number; leaves: number; openBranches: number; maxDepth: number; byDepth: number[] } {
  const byDepth: number[] = [];
  for (const r of plan.requirements) {
    const d = r.depth ?? 0;
    byDepth[d] = (byDepth[d] ?? 0) + 1;
  }
  return {
    total: plan.requirements.length,
    leaves: leafRequirements(plan).length,
    openBranches: openBranchIds(plan).length,
    maxDepth: byDepth.length ? byDepth.length - 1 : 0,
    byDepth: byDepth.map((n) => n ?? 0),
  };
}

/**
 * 往某个父节点下挂一批子节点 (parentId=null → 顶层)。
 *
 * 一次只展开一个节点 —— 这就是"递归下降"在存储层的样子。stage 由 openBranches 决定:
 * 还有没展开的分支就留在 requirements, 全展开完才进 roster。
 */
export function addTeamNodes(
  sessionId: string,
  parentId: string | null,
  children: TeamRequirement[],
  documentPath?: string,
): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  const parent = parentId ? plan.requirements.find((r) => r.id === parentId) : null;
  if (parentId && !parent) return null;
  const depth = parent ? (parent.depth ?? 0) + 1 : 0;
  /* 父节点从此是分支 (它自己不再可领取) —— 领取只发生在叶子层 */
  if (parent) { parent.kind = 'branch'; parent.leafReason = undefined; }
  for (const c of children) {
    c.parentId = parentId ?? undefined;
    c.depth = depth;
    plan.requirements.push(c);
  }
  if (documentPath) plan.documentPath = documentPath;
  plan.stage = openBranchIds(plan).length > 0 ? 'requirements' : 'roster';
  return touch(plan);
}

/** 这个分支其实不用再拆了 —— 就地收成叶子 (要给理由, 谁都能复核) */
export function closeBranchAsLeaf(
  sessionId: string,
  nodeId: string,
  leafReason: string,
  fill?: { estimateDays?: number; acceptance?: string },
): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  const node = plan.requirements.find((r) => r.id === nodeId);
  if (!node) return null;
  if (childrenOf(plan, nodeId).length > 0) return null;   // 已经有孩子了, 它是分支
  node.kind = 'leaf';
  node.leafReason = leafReason;
  if (fill?.estimateDays != null) node.estimateDays = fill.estimateDays;
  if (fill?.acceptance) node.acceptance = fill.acceptance;
  plan.stage = openBranchIds(plan).length > 0 ? 'requirements' : 'roster';
  return touch(plan);
}

export function pruneTeamNode(sessionId: string, nodeId: string): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  const node = plan.requirements.find((r) => r.id === nodeId);
  if (!node) return null;
  if (childrenOf(plan, nodeId).length > 0) return null;   // 有孩子的不许删 (会留下孤儿)
  plan.requirements = plan.requirements.filter((r) => r.id !== nodeId);
  plan.claims = plan.claims.map((c) => ({ ...c, requirementIds: c.requirementIds.filter((id) => id !== nodeId) }));
  /* 依赖里也要摘 —— 指向已删节点的 dependsOn 是死链 */
  for (const r of plan.requirements) {
    if (r.dependsOn?.includes(nodeId)) r.dependsOn = r.dependsOn.filter((d) => d !== nodeId);
  }
  plan.stage = openBranchIds(plan).length > 0 ? 'requirements'
    : unclaimedRequirementIds(plan).length === 0 && plan.roster.length > 0 ? 'ready'
      : plan.roster.length > 0 ? 'assignment' : 'roster';
  return touch(plan);
}


/** 依赖成环检测 —— 返回其中一个环 (id 序列), 无环返回 null。 */
export function findDependencyCycle(plan: TeamPlan): string[] | null {
  const byId = new Map(plan.requirements.map((r) => [r.id, r]));
  const state = new Map<string, 0 | 1 | 2>();   // 0 未访问 / 1 在栈上 / 2 已完成
  const stack: string[] = [];
  const walk = (id: string): string[] | null => {
    const st = state.get(id) ?? 0;
    if (st === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (st === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const cyc = walk(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const r of plan.requirements) {
    const cyc = walk(r.id);
    if (cyc) return cyc;
  }
  return null;
}

/** 指向不存在节点的依赖 (死链) */
export function danglingDependencies(plan: TeamPlan): Array<{ id: string; missing: string[] }> {
  const ids = new Set(plan.requirements.map((r) => r.id));
  return plan.requirements
    .map((r) => ({ id: r.id, missing: (r.dependsOn ?? []).filter((d) => !ids.has(d)) }))
    .filter((x) => x.missing.length > 0);
}

/**
 * 施工批次 (拓扑分层) —— 同一批次内的叶子**可以并行**, 跨批次必须串行。
 * 这是执行层派兵的依据, 也是看板上"第几批"那一列。
 */
export function scheduleWaves(plan: TeamPlan): string[][] {
  const leaves = leafRequirements(plan);
  const leafIds = new Set(leaves.map((r) => r.id));
  /* 依赖可能指向分支 (一整块) —— 展开成它子树里的叶子, 否则拓扑排序会把分支当节点算错 */
  const expand = (id: string): string[] => {
    if (leafIds.has(id)) return [id];
    const out: string[] = [];
    const walk = (pid: string) => {
      for (const c of plan.requirements.filter((r) => r.parentId === pid)) {
        if (leafIds.has(c.id)) out.push(c.id); else walk(c.id);
      }
    };
    walk(id);
    return out;
  };
  const deps = new Map<string, Set<string>>();
  for (const l of leaves) {
    deps.set(l.id, new Set((l.dependsOn ?? []).flatMap(expand).filter((d) => d !== l.id)));
  }
  const waves: string[][] = [];
  const done = new Set<string>();
  let guard = 0;
  while (done.size < leaves.length && guard++ < leaves.length + 2) {
    const wave = leaves
      .filter((l) => !done.has(l.id))
      .filter((l) => [...(deps.get(l.id) ?? [])].every((d) => done.has(d) || !leafIds.has(d)))
      .map((l) => l.id);
    if (wave.length === 0) break;   // 成环 —— 交给 findDependencyCycle 报错
    waves.push(wave);
    for (const id of wave) done.add(id);
  }
  return waves;
}

/**
 * 记一场会 —— 会议台的写入口。
 *
 * 同 kind 允许开多场 (开发研讨可能分域各开一次), 不去重; 按 at 倒序在看板上铺。
 * 成员发言 (team_member_review) 会自动汇成一场"需求评审会", 见 derivedRequirementMeeting。
 */
export function addTeamMeeting(sessionId: string, meeting: Omit<TeamMeeting, 'id'> & { id?: string }): TeamPlan | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  const id = meeting.id || `mtg_${meeting.kind}_${Date.now().toString(36)}`;
  plan.meetings = [...(plan.meetings ?? []), { ...meeting, id }];
  return touch(plan);
}

export function unclaimedRequirementIds(plan: TeamPlan): string[] {
  const claimed = new Set(plan.claims.flatMap((c) => c.requirementIds));
  return leafRequirements(plan).map((r) => r.id).filter((id) => !claimed.has(id));
}

/** 被重复认领的需求 —— "不重"那一半 */
export function duplicateClaimedRequirementIds(plan: TeamPlan): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const c of plan.claims) {
    for (const id of c.requirementIds) {
      if (seen.has(id)) dup.add(id);
      seen.add(id);
    }
  }
  return [...dup];
}

/** 团队规划进行中 —— 续跑三道闸认它 (不再借 isTargetActive) */
export function isTeamPlanActive(sessionId?: string | null): boolean {
  const plan = getTeamPlan(sessionId);
  return !!plan && plan.stage !== 'ready';
}

/** 规划闭环 —— 方案完整 (需求 + 编制 + 领取), 该交回用户了 */
export function isTeamPlanReady(sessionId?: string | null): boolean {
  return getTeamPlan(sessionId)?.stage === 'ready';
}


/** 活跃团队 —— 规划没走完 (stage != ready) 或执行还在跑的都算占着一个位 */
export function activeTeamSessions(execActive?: (sid: string) => boolean): Array<{ sessionId: string; teamId: string; goal: string; stage: TeamStage }> {
  const out: Array<{ sessionId: string; teamId: string; goal: string; stage: TeamStage }> = [];
  for (const p of plansBySession.values()) {
    const running = p.stage !== 'ready' || (execActive?.(p.sessionId) ?? false);
    if (running) out.push({ sessionId: p.sessionId, teamId: p.teamId, goal: p.goal, stage: p.stage });
  }
  return out;
}

/** 这个会话是不是团队会话 (不分阶段) —— UI 文案据此说"团队"而不是别的 */
export function isTeamSession(sessionId?: string | null): boolean {
  return !!getTeamPlan(sessionId);
}

/** 结束/清除 (用户放弃或重开) */
export function clearTeamPlan(sessionId: string): void {
  plansBySession.delete(sessionId);
}

/**
 * 解散团队 —— 内存 **和** 存档一起删。
 *
 * clearTeamPlan 只清内存, 那是"这个进程先不看它了"; 用户点 ✕ 说的是"删掉",
 * 存档留着下次启动 getTeamPlan 就从库里捞回来, 团队原地复活。
 */
export function purgeTeamPlan(sessionId: string): void {
  plansBySession.delete(sessionId);
  try { purgeImpl?.(sessionId); } catch (err: any) {
    cliLogger.warn('TEAM_PLAN', `解散团队时删存档失败: ${err?.message ?? err}`);
  }
}

/** 下一步该干什么 —— 提示词和续跑 pin 共用同一句, 免得两处口径漂 */
export function teamStageDirective(sessionId: string, isEn = false): string | null {
  const plan = getTeamPlan(sessionId);
  if (!plan) return null;
  const reqCount = plan.requirements.length;
  const unclaimed = unclaimedRequirementIds(plan);
  switch (plan.stage) {
    case 'requirements': {
      /* 递归拆解: 有待展开的分支就报出来 —— 规划停不下来的原因具体到节点 id */
      const open = openBranchIds(plan);
      const shape = treeShape(plan);
      if (open.length > 0) {
        return isEn
          ? `[Team · stage 1/3 DECOMPOSE] ${open.length} branch node(s) still unexpanded: ${open.slice(0, 8).join(', ')}. Call team_decompose({parentId}) on each until every node is a leaf (≤3 person-days, has acceptance, single responsibility). Tree so far: ${shape.leaves} leaves / depth ${shape.maxDepth + 1}.`
          : `[团队 · 第 1/3 步 · 递归拆解] 还有 ${open.length} 个分支没展开: ${open.slice(0, 8).join('、')}。逐个调 team_decompose({parentId}) 往下拆, 直到每个节点都是叶子 (≤3 人天 / 有客观验收 / 单一职责)。当前树: ${shape.leaves} 个叶子 / ${shape.maxDepth + 1} 层。`;
      }
      return isEn
        ? `[Team · stage 1/3 DECOMPOSE] ${plan.goal}\nSurvey the repo first (explore/readfile), then call team_decompose({documentPath, children:[…]}) to cut the top-level domains. Each child declares kind: 'branch' (needs further splitting) or 'leaf' (≤3 person-days, has acceptance). Keep going down — a system-level goal is 3~4 levels deep, not one flat list.`
        : `[团队 · 第 1/3 步 · 递归拆解] ${plan.goal}\n先盘清仓库现状 (explore/readfile), 然后调 team_decompose({documentPath, children:[…]}) 切顶层的域。每个子节点自报 kind: 'branch' (还要往下拆) 或 'leaf' (≤3 人天 + 有客观验收 + 单一职责)。**一层一层往下走** —— 系统级目标通常 3~4 层, 不是一次列一张平铺清单。`;
    }
    case 'roster':
      return isEn
        ? `[Team · stage 2/3 ROSTER] ${reqCount} requirements are on the table. Now decide WHO this team needs: call team_roster({members:[{id,role,title,why}]}) — derive the headcount from the requirements, not from a template.`
        : `[团队 · 第 2/3 步 · 编制] 需求已经有 ${reqCount} 条。现在定**这个团队需要哪些人**: 调 team_roster({members:[{id,role,title,why}]}) —— 人数和角色要从需求推出来 (谁负责哪一摊、为什么需要这个人), 不是套模板。`;
    case 'assignment':
      return isEn
        ? `[Team · stage 3/3 CLAIM] ${unclaimed.length} requirement(s) still unclaimed: ${unclaimed.slice(0, 8).join(', ')}. Let each member claim what fits them: team_claim({claims:[{memberId,requirementIds,ownedScope,why}]}). Every requirement must be claimed exactly once and write scopes must not overlap.`
        : `[团队 · 第 3/3 步 · 领取] 还有 ${unclaimed.length} 条需求没人认领: ${unclaimed.slice(0, 8).join('、')}。让每个成员按自己的职能去**领取**需求: 调 team_claim({claims:[{memberId,requirementIds,ownedScope,why}]})。每条需求恰好被一个人领走, 写角色的领地不许重叠。`;
    case 'ready':
      return null;
  }
}
