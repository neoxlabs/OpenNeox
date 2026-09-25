
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import {
  startTeamPlan, setTeamRoster, applyTeamClaims,
  getTeamPlan, unclaimedRequirementIds, duplicateClaimedRequirementIds,
  addTeamMemberReview, membersWithoutReview,
  addTeamNodes, closeBranchAsLeaf, pruneTeamNode, openBranchIds, treeShape, leafRequirements,
  addTeamMeeting, findDependencyCycle, danglingDependencies, scheduleWaves, activeTeamSessions,
  type TeamPlan,
} from './teamPlanStore.js';
import { startTeamExec, getTeamExec, execProgress, isTeamExecActive, type TeamExecState } from './teamExecStore.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

export interface TeamPlanToolsOptions {
  sessionId?: string;
  modelName?: string;
  /** 团队事件 → UI (借 onTaskAgentEvent 通道, 跟 worker_start 同路) */
  onTaskAgentEvent?: (agentId: string, event: any, tracker?: any) => void;
  /** 当前工作目录 —— 开工时钉给整个团队, 用户中途切项目也不漂 */
  workDir?: string;
  /** 执行层入口 —— 宿主注入 (要 agent 工具 + 并发管理器, 这一层拿不到)。不注入就只能出方案。 */
  executeTeam?: (plan: TeamPlan, opts?: { taskTimeoutMs?: number }) => Promise<TeamExecState | null>;
}

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 20;
/** 人均叶子数下限 —— 低于这个说明人分多了 (一人一条不如自己干) */
const MIN_LEAVES_PER_MEMBER = 2;
/** 人均叶子数上限 —— 高于这个说明人太少 (他一个人串着跑, 并行收益没了) */
const MAX_LEAVES_PER_MEMBER = 15;

const wrap = (
  tool: string,
  status: 'success' | 'error',
  summary: string,
  content: string | undefined,
  data: Record<string, unknown>,
) => JSON.stringify({
  type: 'contextual', status, tool, summary, ...(content ? { content } : {}), ...data,
});

const reject = (code: string, message: string, extra?: Record<string, unknown>) =>
  wrap(_currentTool, 'error', message.split(/[\n。]/)[0].slice(0, 120) || code, message,
    { code, message, guidance: true, ...extra });

/** 当前正在执行的团队工具名 —— reject 里要报出来, 免得每处都传一遍。
 *  每个工具 function 开头设一次; 工具调用是串行的 (parallelSafety: 'unsafe'), 不会串号。 */
let _currentTool = 'team';

/** 会议类型的人话标签 —— 工具回执和看板共用同一套口径 */
const MEETING_LABEL: Record<string, string> = {
  requirements: '需求评审会', design: '开发研讨会', test: '测试研讨会',
  estimate: '工期复核会', review: '复盘会', standup: '站会',
};

function emitPlan(opts: TeamPlanToolsOptions, plan: TeamPlan): void {
  try {
    opts.onTaskAgentEvent?.(plan.teamId, {
      type: 'team_plan_update',
      teamId: plan.teamId,
      sessionId: plan.sessionId,
      goal: plan.goal,
      stage: plan.stage,
      requirements: plan.requirements,
      roster: plan.roster,
      reviews: plan.reviews ?? [],
      meetings: plan.meetings ?? [],
      claims: plan.claims,
      timestamp: Date.now(),
    });
  } catch { /* 事件失败不影响规划本身 */ }
}

function requirePlan(opts: TeamPlanToolsOptions): { plan: TeamPlan } | { error: string } {
  const plan = getTeamPlan(opts.sessionId);
  if (!plan) {
    return { error: reject('NO_TEAM', '当前会话还没有团队 —— 先调 team_run({ goal }) 开团。') };
  }
  return { plan };
}

export function createTeamPlanTools(opts: TeamPlanToolsOptions): Tool[] {
  const teamRun: Tool = {
    name: 'team_run',
    description: `用户说「调用团队 / 用团队 / 团队作战」时**先调这个** (只传 goal)。

开团 = 先规划后执行, 规划这三步由你自己完成 (不派兵):
  ① team_decompose —— **递归**把目标拆成一棵树 (系统 → 域 → 能力 → 可执行条目, 通常 3~4 层),
                      一次调用只展开一个节点, 拆到每个叶子都 ≤3 人天为止
  ② team_roster    —— 按叶子推导这个团队需要哪些人 (角色/职能/为什么)
  ③ team_claim     —— 每个成员领取自己那部分叶子 (不重不漏, 领地互斥)
三步走完**停下来把方案交给用户**。
④ team_execute({confirm:true}) —— 真派兵开工 (批内并行 / 跨批串行, 每人一条自己的 timeline,
   各写各的领地)。**只有用户明确说开工才调**, 不许自己拍板。`,
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '团队要达成的目标 (用户原话 + 你理解的范围)' },
      },
      required: ['goal'],
    },
    async function(args: any) {
      _currentTool = 'team_run';
      const goal = typeof args?.goal === 'string' ? args.goal.trim() : '';
      if (!goal) return reject('INVALID_ARGS', 'goal 不能为空 —— 写清楚这个团队要达成什么。');
      if (!opts.sessionId) return reject('NO_SESSION', '拿不到会话 id, 无法开团。');

      const maxTeams = (() => {
        try {
          const n = Number((loadConfig() as any)?.agentRuntime?.maxConcurrentTeams);
          return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
        } catch { return 1; }
      })();
      const others = activeTeamSessions(isTeamExecActive).filter((t) => t.sessionId !== opts.sessionId);
      if (others.length >= maxTeams) {
        const occupied = others.slice(0, 3)
          .map((t) => `· ${t.goal.slice(0, 40)}${t.goal.length > 40 ? '…' : ''} (${t.stage === 'ready' ? '执行中' : `规划中 ${t.stage}`})`)
          .join('\n');
        return reject('TEAM_LIMIT_REACHED',
          `已经有 ${others.length} 个团队在跑, 达到上限 ${maxTeams} 个 —— 一个团队要并行起好几个子 agent, `
          + '同时跑两个团队并发额度和机器都吃不住, 你也看不过来。\n'
          + `占着位的:\n${occupied}\n`
          + '要么等它跑完, 要么去那个会话里收尾, 要么在设置里把「同时最多几个团队」调大 (设置 → Agent 运行时)。'
          + '**先把这句话原样讲给用户**, 让他决定, 不要自己换个会话重试。',
          { activeTeams: others, maxTeams });
      }
      const plan = startTeamPlan(opts.sessionId, goal);
      emitPlan(opts, plan);
      cliLogger.info('TEAM_PLAN', `${plan.teamId} started`, { goal: goal.slice(0, 80) });
      return wrap('team_run', 'success', `团队已开 · 第 1/3 步 递归拆需求`, undefined, {
        status: 'planning',
        teamId: plan.teamId,
        stage: plan.stage,
        message: '团队已开 (第 1/3 步: 递归拆需求)。**先调 use_skill("team-requirements") 拿方法论** ——'
          + '里面是每个节点过七视角的做法、分支多时并行派只读子 agent 的写法、以及需求文档的结构。'
          + '然后调 team_decompose 切顶层的域, 再逐个把 branch 展开 —— 系统级目标通常 3~4 层, '
          + '一次列一张平铺清单出来的只会是 demo 级的东西。',
      });
    },
  };

  const LEAF_MAX_DAYS = 3;
  const BRANCH_SPLIT_DAYS = 10;
  /** 标题里出现这些连接词 = 至少两件事捆在一条里, 还能拆 */
  const CONJUNCTION = /[和及與与]|、|＋|\+|以及/;

  const teamDecompose: Tool = {
    name: 'team_decompose',
    description: `① 需求拆解 (递归, 一次展开一个节点) —— 不是一次列完所有需求, 是像人一样逐层下降:
系统 → 域 → 能力 → 可执行条目, 通常 3~4 层。

  · 第一次调用不传 parentId = 切顶层的域
  · 之后对**每一个** branch 节点各调一次, 把它拆开
  · children 里每条自报 kind: 'leaf' (可执行条目) 还是 'branch' (还要往下拆)

判成 leaf 的三条硬判据 (少一条就该标 branch 继续拆):
  1. estimateDays ≤ ${LEAF_MAX_DAYS} —— 一个人 1~3 天能做完; 超了说明它还是个"能力"不是任务
  2. 有 acceptance —— 写不出客观判据说明你还没想清楚它是什么
  3. 标题里没有"和/及/与/、/+"连接的两件事 —— 有就至少还能拆成两条

另一条: 一个分支底下**不许一口气摊出 >10 人天的一串叶子** —— 那说明中间缺了一层"能力组"。
先把它拆成 2~4 个 branch (每组 ≤10 人天, 按业务子流程/数据边界分), 再逐组展开成叶子。
这一层就是真实团队里"一个负责人一个迭代吃得下的一块"。

branch 节点不用估工期, 但要有 detail 说清这一块包含什么、为什么它需要再拆。
所有 branch 都展开完 (openBranches=0) 才进第 2 步定编制; 领取只发生在叶子上。`,
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: '要展开哪个节点 (不传 = 切顶层的域)' },
        documentPath: { type: 'string', description: '需求分析文档路径 (第一次调用时给, 后面不用重复)' },
        closeAsLeaf: { type: 'boolean', description: '这个 parentId 其实不用再拆 —— 就地收成叶子 (要给 leafReason)' },
        leafReason: { type: 'string', description: '配合 closeAsLeaf: 凭什么说它不用再拆了' },
        estimateDays: { type: 'number', description: `配合 closeAsLeaf: 这条自己的人天 (>0 且 ≤${LEAF_MAX_DAYS})` },
        acceptance: { type: 'string', description: '配合 closeAsLeaf: 这条自己的客观验收判据' },
        children: {
          type: 'array',
          description: '这个节点拆出来的下一层。每条自报 kind。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '短 id, 建议带父级前缀 (BIL-2-1)' },
              title: { type: 'string', description: '一句话说清要做成什么样 (leaf 不许用"和/及"捆两件事)' },
              detail: { type: 'string', description: 'leaf: 数据结构/接口签名/错误码/边界; branch: 这一块包含什么、为什么还要再拆' },
              acceptance: { type: 'string', description: 'leaf 必填: 客观验收判据' },
              kind: { type: 'string', enum: ['leaf', 'branch'], description: 'leaf = 可执行条目; branch = 还要往下拆' },
              leafReason: { type: 'string', description: 'leaf 可选: 凭什么说它到底了' },
              module: { type: 'string', description: '归属域 (顶层节点自己就是域, 子节点继承)' },
              priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
              dependsOn: {
                type: 'array', items: { type: 'string' },
                description: '这条**必须先做完**的前置 (节点 id, 可指向叶子或整块分支)。'
                  + '没有前置就给空数组 [] —— 不给这个字段等于"没想过顺序", 会被打回。'
                  + '只写硬依赖: A 没完成 B 根本没法开工 (要它的接口/表结构/数据), 不是"最好先做"。',
              },
              estimateDays: { type: 'number', description: `leaf 必填, 且 ≤${LEAF_MAX_DAYS}` },
            },
            required: ['title', 'kind'],
          },
        },
      },
      required: [],
    },
    async function(args: any) {
      _currentTool = 'team_decompose';
      const got = requirePlan(opts);
      if ('error' in got) return got.error;
      const plan0 = got.plan;
      const parentId = typeof args?.parentId === 'string' && args.parentId.trim() ? args.parentId.trim() : null;
      const parent = parentId ? plan0.requirements.find((r) => r.id === parentId) : null;
      if (parentId && !parent) {
        return reject('UNKNOWN_NODE', `节点 "${parentId}" 不存在。当前待展开: ${openBranchIds(plan0).join('、') || '无'}`);
      }

      /* 分支就地收成叶子 —— 拆到一半发现它本来就够小 */
      if (args?.closeAsLeaf === true) {
        if (!parentId) return reject('INVALID_ARGS', 'closeAsLeaf 要配 parentId。');
        const why = String(args?.leafReason ?? '').trim();
        if (why.length < 10) return reject('MISSING_LEAF_REASON', '收成叶子要给理由 —— 凭什么说它不用再拆了 (一个人几天能做完 / 单一职责)。');
        const days = Number.isFinite(Number(args?.estimateDays)) ? Number(args.estimateDays) : parent!.estimateDays;
        const acc = (args?.acceptance ? String(args.acceptance).trim() : '') || parent!.acceptance;
        const problems: string[] = [];
        if (!(Number(days) > 0)) problems.push(`要给 estimateDays (>0 且 ≤${LEAF_MAX_DAYS})`);
        else if (Number(days) > LEAF_MAX_DAYS) problems.push(`${days} 人天 > ${LEAF_MAX_DAYS}, 它不是一条任务, 该继续拆`);
        if (!acc) problems.push('要给 acceptance (客观验收判据)');
        if (CONJUNCTION.test(parent!.title)) problems.push(`标题「${parent!.title}」里用"和/及/与/、/+"捆了两件事, 不是单一职责`);
        if (problems.length) {
          return reject('NOT_A_LEAF',
            `"${parentId}" 收不成叶子: ${problems.join('; ')}。`
            + '叶子判据这条路上也一样生效 —— 补齐后再收, 或者继续 team_decompose 往下拆。'
            + '如果它压根是个拆错的/重复的/空占位节点, 用 team_prune({nodeId, reason}) 删掉它, 别留成假任务。',
            { problems });
        }
        const p = closeBranchAsLeaf(opts.sessionId!, parentId, why, { estimateDays: Number(days), acceptance: acc });
        if (!p) return reject('HAS_CHILDREN', `"${parentId}" 已经有子节点了, 它是分支不是叶子。`);
        emitPlan(opts, p);
        const shape = treeShape(p);
        return wrap('team_decompose', 'success',
          `「${parent!.title}」收成叶子 · ${Number(days)} 人天 · 叶子 ${shape.leaves} 个`,
          why, { status: 'ok', closed: parentId, ...shape, openBranchIds: openBranchIds(p) });
      }

      const raw = Array.isArray(args?.children) ? args.children : [];
      if (raw.length === 0) return reject('INVALID_ARGS', 'children 不能为空 (真的不用拆就用 closeAsLeaf:true + leafReason)。');
      if (raw.length === 1 && parentId) {
        return reject('POINTLESS_SPLIT', `把 "${parentId}" 拆成 1 个子节点等于没拆 —— 要么给 ≥2 个子节点, 要么 closeAsLeaf:true 说明它本来就够小。`);
      }

      const inheritedModule = parent?.module ?? undefined;
      const kids = raw.map((c: any, i: number) => ({
        id: String(c?.id ?? `${parentId ?? 'D'}-${i + 1}`).trim() || `${parentId ?? 'D'}-${i + 1}`,
        title: String(c?.title ?? '').trim(),
        detail: c?.detail ? String(c.detail).trim() : undefined,
        acceptance: c?.acceptance ? String(c.acceptance).trim() : undefined,
        module: c?.module ? String(c.module).trim() : inheritedModule,
        priority: ['P0', 'P1', 'P2'].includes(c?.priority) ? c.priority : undefined,
        dependsOn: Array.isArray(c?.dependsOn) ? c.dependsOn.map((x: any) => String(x).trim()).filter(Boolean) : undefined,
        estimateDays: Number.isFinite(Number(c?.estimateDays)) ? Number(c.estimateDays) : undefined,
        kind: c?.kind === 'branch' ? 'branch' as const : 'leaf' as const,
        leafReason: c?.leafReason ? String(c.leafReason).trim() : undefined,
        status: 'todo' as const,
      })).filter((c: any) => c.title);

      const existing = new Set(plan0.requirements.map((r) => r.id));
      const dupIn = kids.filter((c: any) => existing.has(c.id)).map((c: any) => c.id);
      if (dupIn.length) return reject('DUPLICATE_ID', `这些 id 已经用过了: ${dupIn.join('、')}`);

      /* 依赖必须指向真实节点 —— 指向不存在的 id 是死链, 执行层排序时会静默漏掉 */
      const knownIds = new Set([...existing, ...kids.map((c: any) => c.id)]);
      const badDeps = kids
        .map((c: any) => ({ id: c.id, missing: (c.dependsOn ?? []).filter((d: string) => !knownIds.has(d)) }))
        .filter((x: any) => x.missing.length > 0);
      if (badDeps.length) {
        return reject('DANGLING_DEPENDENCY',
          `这些依赖指向不存在的节点:\n${badDeps.map((b: any) => `· ${b.id} → ${b.missing.join('、')}`).join('\n')}\n`
          + '依赖只能指向已经存在的节点 (或本批里的兄弟节点)。如果前置还没拆出来, 先拆它, 或者暂时留空 [] 等它出现后再补。',
          { danglingDeps: badDeps });
      }
      const selfDep = kids.filter((c: any) => (c.dependsOn ?? []).includes(c.id)).map((c: any) => c.id);
      if (selfDep.length) return reject('SELF_DEPENDENCY', `这些节点依赖了自己: ${selfDep.join('、')}`);

      /* ── 叶子判据 (局部, 逐条判) ── */
      const bad: Array<{ id: string; why: string }> = [];
      for (const c of kids as any[]) {
        if (c.kind === 'leaf') {
          if (!c.acceptance) bad.push({ id: c.id, why: '叶子必须有 acceptance —— 写不出客观判据说明还没想清楚它是什么' });
          else if (!Number.isFinite(c.estimateDays)) bad.push({ id: c.id, why: `叶子必须给 estimateDays (≤${LEAF_MAX_DAYS} 人天)` });
          else if (c.estimateDays > LEAF_MAX_DAYS) bad.push({ id: c.id, why: `${c.estimateDays} 人天 > ${LEAF_MAX_DAYS} —— 这还是一个"能力"不是一条任务, 标 branch 继续往下拆` });
          else if (CONJUNCTION.test(c.title)) bad.push({ id: c.id, why: `标题里用"和/及/与/、/+"捆了至少两件事 (「${c.title}」) —— 拆成两条, 或者标 branch 再展开` });
          else if ((c.detail ?? '').length < 60) bad.push({ id: c.id, why: '叶子的 detail 太薄 —— 领它的人要能照着做: 数据结构/接口签名/错误码/边界至少交代到' });
          else if (!Array.isArray(c.dependsOn)) {
            bad.push({ id: c.id, why: '没给 dependsOn —— 顺序不能靠猜: 有前置就列 id, 确认没有就给空数组 []' });
          }
        } else if ((c.detail ?? '').length < 30) {
          bad.push({ id: c.id, why: '分支也要有 detail —— 这一块包含什么、为什么它还要再拆' });
        }
      }
      /* ── 缺中间层: 一块 >10 人天的活不该直接摊成一串叶子 ── */
      if (parentId && bad.length === 0) {
        const allLeaves = (kids as any[]).every((c) => c.kind === 'leaf');
        const sumDays = (kids as any[]).reduce((n, c) => n + (c.estimateDays ?? 0), 0);
        if (allLeaves && kids.length >= 4 && sumDays > BRANCH_SPLIT_DAYS) {
          return reject('NEEDS_INTERMEDIATE_LAYER',
            `"${parentId}" 底下一口气摊了 ${kids.length} 条叶子、合计 ${Math.round(sumDays * 10) / 10} 人天 (> ${BRANCH_SPLIT_DAYS}) —— `
            + '这一块的规模等于好几个人几周的活, 中间缺了一层。先把它拆成 2~4 个**能力组** (kind:"branch", '
            + '每组 ≤10 人天, 按业务子流程/数据边界分, 不是按"第一批第二批"分), 再逐个把能力组展开成叶子。'
            + '这一层就是真实团队里"一个负责人一个迭代吃得下的一块", 少了它, 排期和分工都落不到人头上。',
            { childCount: kids.length, sumDays });
        }
      }

      if (bad.length) {
        return reject('NOT_A_LEAF',
          `这些子节点不合格:\n${bad.map((b) => `· ${b.id}: ${b.why}`).join('\n')}\n`
          + `判据是**局部**的: 一条能收成叶子只看它自己够不够小 (≤${LEAF_MAX_DAYS} 人天 / 有客观验收 / 单一职责)。`
          + '不够小就标 kind:"branch", 下一轮再对它调 team_decompose —— 拆到叶子为止, 这才是像人一样把功能想透。',
          { rejected: bad });
      }

      const docPath = typeof args?.documentPath === 'string' ? args.documentPath.trim() : '';
      if (!parentId && !docPath && !plan0.documentPath) {
        return reject('MISSING_DOCUMENT',
          '第一次展开要带 documentPath —— 先写一份给人读的需求文档 (背景/目标/范围/非目标/领域划分/风险/里程碑) 落到工作区。'
          + '树是给机器分配用的, 文档才是团队对齐的依据。');
      }
      if (docPath && opts.workDir) {
        try {
          const { existsSync, statSync } = await import('node:fs');
          const { resolve, isAbsolute } = await import('node:path');
          const full = isAbsolute(docPath) ? docPath : resolve(opts.workDir, docPath);
          if (!existsSync(full)) {
            return reject('DOCUMENT_NOT_WRITTEN',
              `documentPath 指的文件不存在: ${docPath} —— 登记路径 ≠ 写了文档。`
              + '先用 write_file 把那份给人读的需求文档真的落到工作区 (背景/目标/范围/非目标/'
              + '领域划分/数据模型/风险/里程碑), 再带着路径调一次。'
              + '看板「文档」页读的就是这个文件, 编不出来的路径只会让用户看到一片空白。',
              { documentPath: docPath, resolved: full });
          }
          if (statSync(full).size < 200) {
            return reject('DOCUMENT_TOO_THIN',
              `${docPath} 只有 ${statSync(full).size} 字节 —— 这不是一份能拿去对齐的文档。`
              + '至少要有: 背景与目标 / 范围与非目标 / 领域划分 / 关键数据模型或接口契约 / 风险 / 里程碑。',
              { documentPath: docPath, bytes: statSync(full).size });
          }
        } catch { /* 探测失败 (权限/异常路径) 就不拦 —— 宁可放过, 不误伤 */ }
      }

      const plan = addTeamNodes(opts.sessionId!, parentId, kids as any, docPath || undefined)!;
      emitPlan(opts, plan);
      const shape = treeShape(plan);
      const open = openBranchIds(plan);
      const leafN = (kids as any[]).filter((c) => c.kind === 'leaf').length;
      const branchN = kids.length - leafN;
      return wrap('team_decompose', 'success',
        `${parent ? `展开「${parent.title}」` : '切出顶层域'} · +${kids.length} 个节点`
        + `(${branchN ? `${branchN} 个待拆分支, ` : ''}${leafN} 个叶子)`
        + ` · 全树 ${shape.leaves} 叶 / ${shape.maxDepth + 1} 层`
        + (open.length ? ` · 还剩 ${open.length} 个分支没展开` : ' · 拆解完成'),
        (kids as any[]).map((c) => `${c.kind === 'leaf' ? `· ${c.estimateDays}d` : '▸'} ${c.title}`).join('\n'),
        {
        status: 'ok',
        expanded: parentId ?? '(top)',
        added: kids.length,
        ...shape,
        openBranchIds: open.slice(0, 20),
        message: open.length > 0
          ? `还有 ${open.length} 个分支没展开: ${open.slice(0, 8).join('、')}${open.length > 8 ? '…' : ''} —— `
            + '逐个对它们调 team_decompose (域多就并行派只读子 agent, 每个 agent 只带自己那一支的上下文, 别把九个域的细节全塞给一个 agent)。'
          : `全部展开完了: ${shape.leaves} 个可执行叶子 / 最深 ${shape.maxDepth + 1} 层 (各层 ${shape.byDepth.join('/')})。`
            + '第 2/3 步: team_roster 定编制。',
      });
    },
  };


  const teamPrune: Tool = {
    name: 'team_prune',
    description: `删掉需求树上一个**没有子节点**的节点 —— 拆错了、跟别的域重复了、或者是个空占位。

没有这个工具的时候模型只能拿 closeAsLeaf 把废节点"收成叶子", 结果是树上多一个假任务,
还会被某个成员领走 (2026-08-16 实拍原话: 「占位节点, 无任何实际拆分内容」)。
有子节点的不许删 (会留下孤儿) —— 先把子节点处理掉。删除会同时从认领和依赖里摘掉它。`,
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '要删掉的节点 id' },
        reason: { type: 'string', description: '为什么删 (拆错/重复/空占位) —— 留痕给人复核' },
      },
      required: ['nodeId', 'reason'],
    },
    async function(args: any) {
      _currentTool = 'team_prune';
      const got = requirePlan(opts);
      if ('error' in got) return got.error;
      const nodeId = String(args?.nodeId ?? '').trim();
      const reason = String(args?.reason ?? '').trim();
      if (!nodeId) return reject('INVALID_ARGS', 'nodeId 不能为空。');
      if (reason.length < 5) return reject('MISSING_REASON', '删节点要给理由 (拆错/重复/空占位), 留痕给人复核。');
      const node = got.plan.requirements.find((r) => r.id === nodeId);
      if (!node) return reject('UNKNOWN_NODE', `节点 "${nodeId}" 不存在。`);
      const p = pruneTeamNode(opts.sessionId!, nodeId);
      if (!p) return reject('HAS_CHILDREN', `"${nodeId}" 还有子节点, 不能删 (会留下孤儿) —— 先处理掉它的子节点。`);
      emitPlan(opts, p);
      cliLogger.info('TEAM_PLAN', `${p.teamId} pruned ${nodeId}`, { reason: reason.slice(0, 80) });
      return wrap('team_prune', 'success', `删掉「${node.title}」 · 全树 ${treeShape(p).leaves} 叶`,
        reason, { status: 'ok', pruned: nodeId, ...treeShape(p), openBranchIds: openBranchIds(p) });
    },
  };


  const teamMeeting: Tool = {
    name: 'team_meeting',
    description: `记一场团队会议 —— 会议台按时间铺开, 用户点开能看到讨论过程。

kind: requirements 需求评审 / design 开发研讨 / test 测试研讨 / estimate 工期复核 / review 复盘 / standup 站会

notes 里每条是**某个成员说的话** (memberId + say), 用他本人的视角和专业口吻说, 不是主脑转述。
decisions 是会上定下来的事 (跨域契约、接口口径、验收标准…), openQuestions 是没定下来要跟进的。
成员领活前的发言 (team_member_review) 会自动汇成一场需求评审会, 不用重复记。`,
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string', enum: ['requirements', 'design', 'test', 'estimate', 'review', 'standup'],
          description: 'requirements 需求评审 / design 开发研讨 / test 测试研讨 / estimate 工期复核 / review 复盘 / standup 站会',
        },
        title: { type: 'string', description: '会议主题 (人话, 如「开发研讨: 租户隔离的 RLS 与应用层双闸」)' },
        participants: { type: 'array', items: { type: 'string' }, description: '参会成员 id' },
        notes: {
          type: 'array',
          description: '逐条发言 —— 谁说了什么',
          items: {
            type: 'object',
            properties: {
              memberId: { type: 'string', description: 'roster 里的成员 id (主持人用 facilitator)' },
              say: { type: 'string', description: '他说的话 (他自己的视角)' },
            },
            required: ['memberId', 'say'],
          },
        },
        decisions: { type: 'array', items: { type: 'string' }, description: '会上定下来的事' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: '没定下来、要跟进的' },
      },
      required: ['kind', 'title', 'notes'],
    },
    async function(args: any) {
      _currentTool = 'team_meeting';
      const got = requirePlan(opts);
      if ('error' in got) return got.error;
      const kind = ['requirements', 'design', 'test', 'estimate', 'review', 'standup'].includes(args?.kind) ? args.kind : null;
      if (!kind) return reject('INVALID_ARGS', 'kind 必须是 requirements / design / test / estimate / review / standup 之一。');
      const title = String(args?.title ?? '').trim();
      if (title.length < 4) return reject('INVALID_ARGS', 'title 要写清这场会讨论什么。');
      const notes = (Array.isArray(args?.notes) ? args.notes : [])
        .map((n: any) => ({ memberId: String(n?.memberId ?? '').trim(), say: String(n?.say ?? '').trim() }))
        .filter((n: any) => n.memberId && n.say);
      if (notes.length < 2) {
        return reject('EMPTY_MEETING', '一场会至少要有两条发言 —— 一个人自言自语不叫会。'
          + '让每个参会成员用自己的视角说 (他关心什么、他的判断、他要的前置), 不是主脑转述。');
      }
      const known = new Set(got.plan.roster.map((m) => m.id));
      const unknown = [...new Set(notes.map((n: any) => n.memberId))]
        .filter((id) => id !== 'facilitator' && !known.has(id as string));
      if (unknown.length) return reject('UNKNOWN_MEMBER', `这些发言人不在编制里: ${unknown.join('、')}`);
      const participants = (Array.isArray(args?.participants) ? args.participants.map((x: any) => String(x).trim()) : [])
        .filter((x: string) => known.has(x));
      const plan = addTeamMeeting(opts.sessionId!, {
        kind, title, at: Date.now(),
        participants: participants.length ? participants : [...new Set(notes.map((n: any) => n.memberId))].filter((id) => id !== 'facilitator') as string[],
        notes,
        decisions: Array.isArray(args?.decisions) ? args.decisions.map((x: any) => String(x).trim()).filter(Boolean) : undefined,
        openQuestions: Array.isArray(args?.openQuestions) ? args.openQuestions.map((x: any) => String(x).trim()).filter(Boolean) : undefined,
      })!;
      emitPlan(opts, plan);
      const decN = (args?.decisions?.length ?? 0);
      return wrap('team_meeting', 'success',
        `${MEETING_LABEL[kind]}「${title}」· ${notes.length} 条发言${decN ? ` · ${decN} 条决议` : ''}`,
        notes.map((n: any) => {
          const mm = got.plan.roster.find((x) => x.id === n.memberId);
          return `【${n.memberId}${mm?.title ? ` · ${mm.title}` : ''}】\n${n.say}`;
        }).join('\n\n')
          + (decN ? `\n\n决议:\n${args.decisions.map((d: string) => `· ${d}`).join('\n')}` : ''),
        { status: 'ok', meetings: (plan.meetings ?? []).length, kind, noteCount: notes.length });
    },
  };

  const teamRoster: Tool = {
    name: 'team_roster',
    description: '② 编制 —— 按需求清单推导这个团队需要哪些人 (每人: id / role / title 职能 / why 为什么需要)。人数从需求推, 不套模板。',
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        members: {
          type: 'array',
          description: `团队成员。人数**从需求规模推**: 一个人手上 ${MIN_LEAVES_PER_MEMBER}~${MAX_LEAVES_PER_MEMBER} 条叶子`
            + ` (${MIN_MEMBERS}~${MAX_MEMBERS} 人)。不是套模板, 也不是每个域配一个人。`,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '短 id, 如 M1' },
              role: { type: 'string', description: 'implementer / researcher / reviewer 等' },
              level: { type: 'string', description: '定级 (自由文本: 资深/中级/专家/P6 都行) —— 谁能独立扛一个能力组、谁只适合领单点任务, 决定活怎么分' },
              levelReason: { type: 'string', description: '凭什么给这个级 (看板「定级」页跟等级并排显示)' },
              title: { type: 'string', description: '职能, 人话: 如「结算规则负责人」' },
              why: { type: 'string', description: '为什么这个团队需要他 (对应哪些需求)' },
              model: { type: 'string', description: '可选模型覆盖' },
            },
            required: ['id', 'role', 'title'],
          },
        },
      },
      required: ['members'],
    },
    async function(args: any) {
      _currentTool = 'team_roster';
      const got = requirePlan(opts);
      if ('error' in got) return got.error;
      if (got.plan.requirements.length === 0) {
        return reject('NO_REQUIREMENTS', '需求还没拆 —— 先调 team_decompose, 编制要从需求规模推出来。');
      }
      const raw = Array.isArray(args?.members) ? args.members : [];
      const members = raw
        .map((m: any, i: number) => ({
          id: String(m?.id ?? `M${i + 1}`).trim() || `M${i + 1}`,
          role: String(m?.role ?? '').trim(),
          level: m?.level ? String(m.level).trim() : undefined,
          levelReason: m?.levelReason ? String(m.levelReason).trim() : undefined,
          title: String(m?.title ?? '').trim(),
          why: m?.why ? String(m.why).trim() : undefined,
          model: m?.model ? String(m.model).trim() : undefined,
        }))
        .filter((m: any) => m.role && m.title);
      if (members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
        return reject('BAD_ROSTER_SIZE',
          `编制 ${members.length} 人 —— 必须 ${MIN_MEMBERS}-${MAX_MEMBERS} 人 (少于 ${MIN_MEMBERS} 不叫团队; `
          + `多于 ${MAX_MEMBERS} 主脑自己就成瓶颈了, 真实团队也就这个规模)。`);
      }
      const leafN = leafRequirements(got.plan).length;
      if (leafN > 0) {
        const per = leafN / members.length;
        if (per < MIN_LEAVES_PER_MEMBER && members.length > MIN_MEMBERS) {
          const suggest = Math.max(MIN_MEMBERS, Math.ceil(leafN / MAX_LEAVES_PER_MEMBER));
          return reject('ROSTER_TOO_MANY',
            `${leafN} 条可执行需求配 ${members.length} 个人 —— 人均只有 ${per.toFixed(1)} 条, 人分多了。`
            + `一个人手上至少要有 ${MIN_LEAVES_PER_MEMBER} 条活才算一摊正经事, 否则协调成本比干活还高 `
            + `(每个人都要读上下文、对契约、汇报)。`
            + `这个规模 ${suggest}~${Math.max(suggest, Math.ceil(leafN / MIN_LEAVES_PER_MEMBER))} 人就够, `
            + '按**能力边界**合并 (谁的领地天然连在一起), 不是每个域硬配一个人。',
            { leaves: leafN, members: members.length, perMember: Number(per.toFixed(1)) });
        }
        if (per > MAX_LEAVES_PER_MEMBER) {
          const suggest = Math.min(MAX_MEMBERS, Math.ceil(leafN / MAX_LEAVES_PER_MEMBER));
          return reject('ROSTER_TOO_FEW',
            `${leafN} 条可执行需求只配 ${members.length} 个人 —— 人均 ${per.toFixed(1)} 条, 人太少了。`
            + `一个人串着跑 ${Math.ceil(per)} 条活, 并行收益就没了 (批内并行是这套调度的全部意义)。`
            + `这个规模需要 ${suggest} 人左右 (人均 ≤${MAX_LEAVES_PER_MEMBER} 条), 上限 ${MAX_MEMBERS} 人。`
            + '按域/能力边界切人, 谁的领地互不重叠就能真并行。',
            { leaves: leafN, members: members.length, perMember: Number(per.toFixed(1)) });
        }
      }
      const plan = setTeamRoster(opts.sessionId!, members)!;
      emitPlan(opts, plan);
      return wrap('team_roster', 'success',
        `编制已定 · ${members.length} 人: ${members.map((m: any) => m.title || m.id).join(' / ')}`,
        members.map((m: any) => `${m.title || m.id} (${m.role})${m.why ? ` —— ${m.why}` : ''}`).join('\n'),
        {
        status: 'ok', stage: plan.stage, memberCount: members.length,
        roster: members.map((m: any) => ({ id: m.id, role: m.role, title: m.title, level: m.level })),
        message: `编制已登记 (${members.length} 人)。第 3/3 步分两小步: `
          + '① 逐个成员调 team_member_review 发言 (要接哪些 / 为什么是我 / 风险与前置) —— 以他本人的视角说; '
          + `② 全员说完再 team_claim 落定, ${plan.requirements.length} 条需求恰好领完 (不重不漏), 写角色领地不许重叠。`,
      });
    },
  };

  const teamClaim: Tool = {
    name: 'team_claim',
    description: '③ 领取 —— 每个成员按自己的职能领走一部分需求 (自组网: 谁适合谁领, 不是主脑硬派)。要求: 每条需求恰好被一个人领走, 写角色领地互斥。',
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        claims: {
          type: 'array',
          description: '领取记录, 一个成员一条',
          items: {
            type: 'object',
            properties: {
              memberId: { type: 'string', description: 'team_roster 里的成员 id' },
              requirementIds: { type: 'array', items: { type: 'string' }, description: '认领的需求 id' },
              ownedScope: { type: 'array', items: { type: 'string' }, description: '领地: 文件/目录 (写角色之间互斥)' },
              why: { type: 'string', description: '为什么他来领这些 (自组网里这是成员自己的理由)' },
            },
            required: ['memberId', 'requirementIds'],
          },
        },
      },
      required: ['claims'],
    },
    async function(args: any) {
      _currentTool = 'team_claim';
      const got = requirePlan(opts);
      if ('error' in got) return got.error;
      const plan0 = got.plan;
      if (plan0.roster.length === 0) {
        return reject('NO_ROSTER', '编制还没定 —— 先调 team_roster, 没有人怎么领活。');
      }
      const silent = membersWithoutReview(plan0);
      if (silent.length > 0) {
        return reject('MEMBERS_NOT_HEARD',
          `这些成员还没发言: ${silent.join('、')} —— 分活之前先让每个人用 team_member_review `
          + '说自己的判断 (要接哪些/为什么是我/风险与前置)。分工不是主脑一句话拍的。');
      }
      const held = new Set((plan0.meetings ?? []).map((m) => m.kind));
      const missingMtgs = (['design', 'test', 'estimate'] as const).filter((k) => !held.has(k));
      if (missingMtgs.length > 0) {
        return reject('MEETINGS_REQUIRED',
          `方案闭环前还缺这些会: ${missingMtgs.map((k) => MEETING_LABEL[k]).join('、')} —— 用 team_meeting 开。`
          + '开发研讨定跨域契约 (谁的接口谁定、数据边界在哪、谁的改动会碰到谁); '
          + '测试研讨定验收口径 (怎么算做完、哪些边界必须有用例、谁来复核); '
          + '工期复核让每个人对着自己那摊活说实话 —— **按业务语义难度**而不是按条数估: '
          + '借贷平衡/期末结转/对账容差/并发幂等这类地方要加权, 别出现"总账 6 条 9 天"这种一眼乐观的数。'
          + 'notes 里每条是某个成员用自己的视角说的话, decisions 记会上定下来的事 —— '
          + '这两件事定不清, 实现阶段必打架, 而且没人知道当初为什么这么定。',
          { missingMeetings: missingMtgs });
      }
      const cycle = findDependencyCycle(plan0);
      if (cycle) {
        return reject('DEPENDENCY_CYCLE',
          `依赖成环: ${cycle.join(' → ')} —— 环里每一条都在等别人先做完, 谁都开不了工。`
          + '拆环的常规做法: 把其中一条切成"先给接口契约/表结构"和"再落实现"两步, '
          + '让别人依赖前半步 (契约先行), 而不是依赖整条。',
          { cycle });
      }
      const dangling = danglingDependencies(plan0);
      if (dangling.length > 0) {
        return reject('DANGLING_DEPENDENCY',
          `这些依赖指向不存在的节点: ${dangling.map((d) => `${d.id}→${d.missing.join('、')}`).join('; ')} —— `
          + '大概是拆解中途改过 id 或删过节点。补上或摘掉。', { dangling });
      }
      const raw = Array.isArray(args?.claims) ? args.claims : [];
      const claims = raw.map((c: any) => ({
        memberId: String(c?.memberId ?? '').trim(),
        requirementIds: (Array.isArray(c?.requirementIds) ? c.requirementIds : []).map((x: any) => String(x).trim()).filter(Boolean),
        ownedScope: (Array.isArray(c?.ownedScope) ? c.ownedScope : []).map((x: any) => String(x).trim()).filter(Boolean),
        why: c?.why ? String(c.why).trim() : undefined,
      })).filter((c: any) => c.memberId);

      const memberIds = new Set(plan0.roster.map((m) => m.id));
      const unknownMembers = claims.filter((c: any) => !memberIds.has(c.memberId)).map((c: any) => c.memberId);
      if (unknownMembers.length) {
        return reject('UNKNOWN_MEMBER', `这些 memberId 不在编制里: ${unknownMembers.join(', ')}`);
      }
      const reqIds = new Set(plan0.requirements.map((r) => r.id));
      const unknownReqs = claims.flatMap((c: any) => c.requirementIds).filter((id: string) => !reqIds.has(id));
      if (unknownReqs.length) {
        return reject('UNKNOWN_REQUIREMENT', `这些需求 id 不存在: ${[...new Set(unknownReqs)].join(', ')}`);
      }

      const plan = applyTeamClaims(opts.sessionId!, claims)!;
      const missing = unclaimedRequirementIds(plan);
      const dup = duplicateClaimedRequirementIds(plan);
      /* 领地互斥只查写角色 —— reviewer 只读, 允许覆盖全库 */
      const writeRoles = new Set(plan.roster.filter((m) => !/review/i.test(m.role)).map((m) => m.id));
      const scopeOwner = new Map<string, string>();
      const overlaps: string[] = [];
      for (const c of plan.claims) {
        if (!writeRoles.has(c.memberId)) continue;
        for (const sc of c.ownedScope) {
          const prev = scopeOwner.get(sc);
          if (prev && prev !== c.memberId) overlaps.push(`${sc} (${prev} vs ${c.memberId})`);
          scopeOwner.set(sc, c.memberId);
        }
      }
      emitPlan(opts, plan);

      if (missing.length || dup.length || overlaps.length) {
        return wrap('team_claim', 'error',
          `领取还没闭合 · ${missing.length ? `${missing.length} 条没人领 ` : ''}${dup.length ? `${dup.length} 条重复 ` : ''}${overlaps.length ? `${overlaps.length} 处领地重叠` : ''}`.trim(),
          undefined, {
          status: 'incomplete', stage: plan.stage,
          unclaimed: missing, duplicated: dup, scopeOverlaps: overlaps,
          message: '领取还没闭合: '
            + (missing.length ? `没人认领 ${missing.join('、')}; ` : '')
            + (dup.length ? `被多人重复认领 ${dup.join('、')}; ` : '')
            + (overlaps.length ? `写角色领地重叠 ${overlaps.join('、')}; ` : '')
            + '补齐后再调一次 team_claim (整份重发)。',
        });
      }
      cliLogger.info('TEAM_PLAN', `${plan.teamId} ready`, {
        requirements: plan.requirements.length, members: plan.roster.length,
      });
      const daysOf = (id: string) => plan.requirements.find((r) => r.id === id)?.estimateDays ?? 0;
      const load = plan.claims.map((c) => ({
        memberId: c.memberId,
        count: c.requirementIds.length,
        days: Math.round(c.requirementIds.reduce((s, id) => s + daysOf(id), 0) * 10) / 10,
      }));
      const writes = load.filter((l) => writeRoles.has(l.memberId) && l.days > 0);
      const hi = writes.length ? Math.max(...writes.map((l) => l.days)) : 0;
      const lo = writes.length ? Math.min(...writes.map((l) => l.days)) : 0;
      const skewed = lo > 0 && hi / lo >= 2;
      /* 施工批次 + 跨人依赖 —— 并行协作的规则在这里落地:
       * 同一批次内可并行 (领地已互斥), 跨批次串行; 跨人依赖点名"谁在等谁的什么"。
       * 这两样是执行层派兵的输入, 也是讲方案时最该讲清的部分。 */
      const waves = scheduleWaves(plan);
      const ownerOf = (rid: string) => plan.claims.find((c) => c.requirementIds.includes(rid))?.memberId;
      const crossPerson = leafRequirements(plan).flatMap((l) => (l.dependsOn ?? [])
        .filter((d) => ownerOf(d) && ownerOf(l.id) && ownerOf(d) !== ownerOf(l.id))
        .map((d) => ({ who: ownerOf(l.id)!, waitsFor: ownerOf(d)!, node: l.id, on: d })));
      return wrap('team_claim', 'success',
        `方案闭环 · ${leafRequirements(plan).length} 条活分给 ${plan.claims.filter((c) => c.requirementIds.length).length} 人`
        + ` · ${waves.length} 批施工${crossPerson.length ? ` · ${crossPerson.length} 处跨人依赖` : ''}`
        + (skewed ? ` · 负载最重 ${hi}d / 最轻 ${lo}d` : ''),
        load.map((l) => `${l.memberId}: ${l.count} 条 / ${l.days}d`).join('\n')
          + (waves.length ? `\n\n施工批次 (批内并行, 跨批串行):\n${waves.map((w, i) => `第 ${i + 1} 批 (${w.length} 条): ${w.slice(0, 10).join('、')}${w.length > 10 ? '…' : ''}`).join('\n')}` : ''),
        {
        status: 'ready', stage: plan.stage,
        waves: waves.map((w, i) => ({ wave: i + 1, count: w.length, ids: w })),
        crossPersonDependencies: crossPerson,
        assignment: plan.claims.map((c) => ({ memberId: c.memberId, requirementIds: c.requirementIds })),
        load,
        ...(skewed ? { loadWarning: `最重 ${hi}d / 最轻 ${lo}d, 相差 ${(hi / lo).toFixed(1)} 倍 —— 讲方案时说明这是刻意的 (域天然重/依赖顺序要求) 还是该再匀一匀。` } : {}),
        message: '方案闭环了: 需求 → 编制 → 领取三段都齐了, 右栏看板可以逐段核对。'
          + '现在**停下来把方案讲给用户**: 需求怎么分组、团队几个人各是什么职能、谁领了哪些、依赖顺序和风险。'
          + '**不要自己开始实现**: 等用户说开工, 再调 team_execute({confirm:true}) 派兵。',
      });
    },
  };


  const teamMemberReview: Tool = {
    name: 'team_member_review',
    description: '③a 成员发言 —— 领活之前, **每个成员各说一次**: 我想接哪些需求、为什么是我来接、'
      + '我看到的风险和坑、我需要谁先做完什么。以这个成员的身份和视角说 (不是主脑口吻)。'
      + '全员都发言之后才允许 team_claim 落定分配。',
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: true,
    parameters: {
      type: 'object',
      properties: {
        memberId: { type: 'string', description: 'team_roster 里的成员 id' },
        picks: { type: 'array', items: { type: 'string' }, description: '这个成员想认领的需求 id' },
        analysis: { type: 'string', description: '他对这摊活的判断: 范围怎么理解 / 为什么由他来做 / 打算怎么切分推进 (几句话, 有信息量)' },
        concerns: { type: 'string', description: '他看到的风险、坑、不确定项' },
        needs: { type: 'array', items: { type: 'string' }, description: '需要别人先完成的需求 id (跨人依赖)' },
      },
      required: ['memberId', 'picks', 'analysis'],
    },
    async function(args: any) {
      _currentTool = 'team_member_review';
      const got = requirePlan(opts);
      if ('error' in got) return got.error;
      const plan0 = got.plan;
      if (plan0.roster.length === 0) {
        return reject('NO_ROSTER', '编制还没定 —— 先调 team_roster。');
      }
      const memberId = String(args?.memberId ?? '').trim();
      if (!plan0.roster.some((m) => m.id === memberId)) {
        return reject('UNKNOWN_MEMBER', `memberId "${memberId}" 不在编制里。`);
      }
      const analysis = String(args?.analysis ?? '').trim();
      if (analysis.length < 30) {
        return reject('THIN_ANALYSIS',
          '发言太薄 —— 这是这个成员对自己那摊活的判断, 要说清: 范围怎么理解、为什么由他做、'
          + '打算怎么切、依赖谁。一句话糊弄过去等于没让他说话。');
      }
      const picks = (Array.isArray(args?.picks) ? args.picks : []).map((x: any) => String(x).trim()).filter(Boolean);
      const reqIds = new Set(plan0.requirements.map((r) => r.id));
      const unknown = picks.filter((id: string) => !reqIds.has(id));
      if (unknown.length) return reject('UNKNOWN_REQUIREMENT', `这些需求 id 不存在: ${unknown.join(', ')}`);

      const plan = addTeamMemberReview(opts.sessionId!, {
        memberId, picks, analysis,
        concerns: args?.concerns ? String(args.concerns).trim() : undefined,
        needs: Array.isArray(args?.needs) ? args.needs.map((x: any) => String(x).trim()).filter(Boolean) : undefined,
        at: Date.now(),
      })!;
      emitPlan(opts, plan);
      const pending = membersWithoutReview(plan);
      const who = plan.roster.find((m) => m.id === memberId);
      const speaker = `【${memberId}${who?.title ? ` · ${who.title}` : ''}${who?.level ? ` · ${who.level}` : ''}】`;
      return wrap('team_member_review', 'success',
        `${who?.title || memberId} 发言 · 想接 ${picks.length} 条`
        + (pending.length ? ` · 还有 ${pending.length} 人没说` : ' · 全员已发言'),
        `${speaker}\n${analysis}`
          + (args?.concerns ? `\n⚠ 风险: ${String(args.concerns).trim()}` : '')
          + (Array.isArray(args?.needs) && args.needs.length ? `\n→ 需要前置: ${args.needs.join('、')}` : '')
          + (picks.length ? `\n→ 想接: ${picks.join('、')}` : ''),
        {
        status: 'ok',
        spoke: memberId,
        pendingMembers: pending,
        message: pending.length > 0
          ? `${memberId} 的发言已记下。还没发言: ${pending.join('、')} —— 逐个让他们说完再 team_claim。`
          : '全员都发言了。现在 team_claim 落定分配 (以各人的 picks 为基础, 冲突的地方你来裁决并说明理由)。',
      });
    },
  };


  const teamExecute: Tool = {
    name: 'team_execute',
    description: `④ 开工 —— **用户明确说"开始执行/开工/派兵"才调这个**。

按规划算出的施工批次派兵: 批内并行 (领地互斥保证不打架), 跨批串行 (前一批全收口才放行下一批)。
每条活起一个独立子会话 (各自上下文、各自 timeline), 只能写自己领地里的路径 (越界会被闸拒),
前置交付完成时自动给下游发契约通知。

跑完会回报每条活的成败、改了哪些文件、成员之间发生过哪些交流。
方案没闭环 (stage != ready) 不许开工。`,
    group: 'agent',
    resultType: 'contextual',
    parallelSafety: 'unsafe',
    isReadOnly: false,
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: '用户已明确要求开工 (true)。没有用户明确指示不要调这个工具。' },
        taskTimeoutMinutes: { type: 'number', description: '单条活的墙钟上限 (分钟, 默认 20)' },
      },
      required: ['confirm'],
    },
    async function(args: any) {
      _currentTool = 'team_execute';
      const got = requirePlan(opts);
      if ('error' in got) return got.error;
      const plan = got.plan;
      if (args?.confirm !== true) {
        return reject('NEEDS_USER_CONFIRM',
          '开工要用户明确拍板 —— 先把方案讲清 (需求怎么拆、几个人、谁领哪些、几批施工、风险在哪), 等他说开始再调, confirm: true。');
      }
      if (plan.stage !== 'ready') {
        return reject('PLAN_NOT_READY',
          `方案还没闭环 (当前 ${plan.stage}) —— 需求 → 编制 → 领取三段齐了才能开工。`);
      }
      if (!opts.executeTeam) {
        return reject('EXECUTION_UNAVAILABLE',
          '当前宿主没有接执行能力 (缺 agent 工具/并发管理器) —— 只能出方案。');
      }
      const active = getTeamExec(opts.sessionId);
      if (active && active.status === 'running') {
        return reject('ALREADY_RUNNING', `这个团队已经在跑了 (第 ${active.currentWave}/${active.totalWaves} 批)。`);
      }

      /* 开工那一刻把工作目录钉住 —— 之后用户切项目不影响这个团队 (见 teamExecutor 的说明) */
      const st0 = startTeamExec(plan, opts.workDir);
      cliLogger.info('TEAM_EXEC', `${plan.teamId} start`, { tasks: st0.tasks.length, waves: st0.totalWaves });
      const st = await opts.executeTeam(plan, {
        taskTimeoutMs: Number.isFinite(Number(args?.taskTimeoutMinutes))
          ? Math.max(1, Number(args.taskTimeoutMinutes)) * 60_000 : undefined,
      });
      const final = st ?? getTeamExec(opts.sessionId);
      if (!final) return reject('EXECUTION_FAILED', '执行态丢了 —— 看 stall.log。');

      const p = execProgress(final);
      const failed = final.tasks.filter((t) => t.state === 'failed');
      const byMember = new Map<string, { done: number; failed: number }>();
      for (const t of final.tasks) {
        const e = byMember.get(t.memberId) ?? { done: 0, failed: 0 };
        if (t.state === 'done') e.done++;
        if (t.state === 'failed') e.failed++;
        byMember.set(t.memberId, e);
      }
      return wrap('team_execute', failed.length ? 'error' : 'success',
        `执行${final.status === 'done' ? '完成' : final.status === 'failed' ? '有失败' : final.status}`
        + ` · ${p.done}/${p.total} 完成${failed.length ? ` · ${failed.length} 失败` : ''}`
        + ` · ${final.totalWaves} 批 · ${final.messages.length} 条交流`,
        [
          ...[...byMember.entries()].map(([m, e]) => `${m}: 完成 ${e.done}${e.failed ? ` / 失败 ${e.failed}` : ''}`),
          ...(failed.length ? ['', '失败的活:', ...failed.map((t) => `· ${t.id} (${t.memberId}): ${t.note ?? '?'}`)] : []),
        ].join('\n'),
        {
          status: final.status,
          progress: p,
          waves: final.totalWaves,
          failedTasks: failed.map((t) => ({ id: t.id, memberId: t.memberId, note: t.note })),
          messages: final.messages.length,
          message: failed.length
            ? `${failed.length} 条活失败了。逐条看原因: 是领地越界 (该找谁配合)、验收没过, 还是范围理解错了。`
              + '把失败的原因讲给用户, 问他是要重派、改方案, 还是自己接手。'
            : '全部完成。把结果讲给用户: 谁交付了什么、有哪些跨人契约生效过、测试状态如何。',
        });
    },
  };

  return [teamRun, teamDecompose, teamPrune, teamRoster, teamMemberReview, teamClaim, teamMeeting, teamExecute];
}
