/**
 * The <team_plan> system section defines the fixed three-stage team planning
 * flow. The prompt describes the stages and loopContinuationGate enforces them.
 */
import { getTeamPlan, unclaimedRequirementIds, openBranchIds, treeShape } from './teamPlanStore.js';

export function getTeamPlanPromptSection(sessionId?: string | null, isEn = false): string {
  const plan = getTeamPlan(sessionId);
  if (!plan) return '';
  const done = { req: plan.requirements.length, mem: plan.roster.length };
  const unclaimed = unclaimedRequirementIds(plan);
  const open = openBranchIds(plan);
  const shape = treeShape(plan);

  if (isEn) {
    return [
      '<team_plan>',
      `You are running a TEAM plan (not a solo task): ${plan.goal}`,
      `Stage: ${plan.stage} · nodes ${done.req} (${shape.leaves} leaves, depth ${shape.maxDepth + 1}) · unexpanded ${open.length} · members ${done.mem} · unclaimed ${unclaimed.length}`,
      '',
      'Fixed three steps:',
      '1. team_decompose — RECURSIVE requirement decomposition, one node per call: system -> domain -> capability',
      '   -> executable item, typically 3~4 levels. **Call use_skill("team-requirements") first** for the playbook',
      '   (seven lenses per node, parallel read-only sub-agents per branch, a real doc on disk).',
      '   A child is a leaf only if: <=3 person-days AND has objective acceptance AND single responsibility.',
      '   Otherwise mark it branch and expand it next. Never stop with unexpanded branches.',
      '2. team_roster — derive headcount from SCALE: 2~15 leaves per person (hard cap 20 people).',
      '   Under 2 per person = too many people; over 15 = one person serializing, no parallel gain.',
      '   Split by capability boundary, not one person per domain. Each member needs a level + reason.',
      '3. member reviews + claim — each member speaks first via team_member_review (what they want, why them,',
      '   risks and prerequisites); only after everyone has spoken, team_claim locks the assignment.',
      '',
      'Record the process with team_meeting (kind = requirements / design / test / estimate / review).',
      'Each note is one member speaking in their own voice; decisions capture cross-domain contracts.',
      'Three meetings are required before closing: design (contracts/boundaries), test (acceptance),',
      'estimate (weight effort by business difficulty, not by item count).',
      '',
      'Dependencies must be machine-readable: every leaf declares dependsOn — list ids for hard',
      'prerequisites, or [] to confirm there are none. Closing computes waves (parallel within a wave)',
      'and cross-person dependencies; cycles are rejected — break them with "contract first".',
      '',
      'When all three are done: STOP and walk the user through the plan (tree shape, roster + levels,',
      'who owns what, how many waves, cross-person dependencies, risks).',
      '',
      'Step 4 — only when the user explicitly says to start: team_execute({confirm:true}).',
      'Never self-authorize execution. The scheduler dispatches wave by wave (parallel within a wave),',
      'each member can only write inside their own territory, and finished prerequisites notify downstream.',
      '</team_plan>',
    ].join('\n');
  }
  return [
    '<team_plan>',
    `你在跑一个**团队方案** (不是单干): ${plan.goal}`,
    `当前阶段: ${plan.stage} · 节点 ${done.req} 个 (叶子 ${shape.leaves}, 深度 ${shape.maxDepth + 1} 层) · 待展开 ${open.length} · 成员 ${done.mem} 人 · 未认领 ${unclaimed.length} 条`,
    '',
    '固定三步:',
    '1. team_decompose —— **递归**拆需求, 一次展开一个节点: 系统 → 域 → 能力 → 可执行条目,',
    '   通常 3~4 层。**先 use_skill("team-requirements") 拿方法论**再动手 (每个节点过七视角 /',
    '   分支多时并行派只读子 agent, 每个只带自己那一支的上下文 / 落一份给人读的文档)。',
    '   一个子节点能收成叶子, 当且仅当: ≤3 人天 且 有客观验收 且 单一职责 (标题里没有"和/及"捆两件事)。',
    '   不满足就标 branch, 下一轮再拆它。**有分支没展开就不算拆完**, 别停。',
    '2. team_roster —— 从需求**规模**推人数: 一个人手上 2~15 条叶子 (上限 20 人, 真实团队就这规模)。',
    '   人均不到 2 条 = 人分多了 (协调成本比干活高); 人均超过 15 条 = 他一个人串着跑, 并行收益没了。',
    '   按能力边界切人 (领地天然连在一起的合成一摊), 不是每个域硬配一个人。每人要有定级和理由。',
    '3. 成员发言 + 领取   —— 每个成员先 team_member_review 说自己的判断 (要领哪些 / 为什么是我 /',
    '   风险和前置), 全员说完再 team_claim 落定分配。分活不是主脑一句话拍的。',
    '',
    '过程要留痕: 关键讨论用 team_meeting 记成会议 (kind = requirements / design / test / estimate / review)。',
    '每条 notes 是**某个成员用自己的视角说的话**, decisions 是会上定下来的跨域契约与口径。',
    '闭环前三场会必须开: design (接口契约/数据边界) · test (验收口径) · estimate (工期按业务语义难度加权)。',
    '',
    '依赖是**机器要读的**, 不是写在会议记录里就算: 每个叶子都要给 dependsOn ——',
    '有前置就列 id (硬依赖: 拿不到它的接口/表结构就没法开工), 确认没有就给空数组 []。',
    '闭环时会算施工批次 (批内并行/跨批串行) 和跨人依赖, 成环会被打回 —— 拆环用"契约先行":',
    '把一条切成"先给接口契约"和"再落实现"两步, 让别人只依赖前半步。',
    '',
    '三步走完**停下来把方案讲给用户**: 需求怎么拆 (几层几个叶子)、几个人各是什么职能和定级、',
    '谁领了哪些、分几批施工、跨人依赖在哪、风险是什么。',
    '',
    '④ 开工 —— 用户明确说"开始/开工/派兵"才调 team_execute({confirm:true})。',
    '自己**绝不**顺手开工: 方案是给人拍板的, 不是自我授权的。开工后调度器按批次派兵',
    '(批内并行/跨批串行), 每人只能写自己领地 (越界会被闸拒并告诉他该找谁), 前置交付会自动通知下游。',
    '</team_plan>',
  ].join('\n');
}
