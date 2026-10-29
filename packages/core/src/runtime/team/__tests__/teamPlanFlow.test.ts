/**
 * 团队规划测试覆盖三个阶段闸：需求完成后才能定编制，编制完成后才能领取；
 * 领取必须不重不漏且写角色领地互斥；ready 后规划态结束并允许执行层继续。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTeamPlanTools } from '../teamPlanTools.js';
import {
  getTeamPlan, isTeamPlanActive, isTeamPlanReady, clearTeamPlan, setTeamPlanPersistence,
  assignRequirement,
} from '../teamPlanStore.js';

const SID = 'sess-team-plan';
const tools = () => {
  const list = createTeamPlanTools({ sessionId: SID });
  return Object.fromEntries(list.map((t) => [t.name, t])) as Record<string, any>;
};
const call = async (name: string, args: any) => JSON.parse(await tools()[name].function(args));

/* fixture 使用多个业务域和完整条目元数据，覆盖需求规模、验收条件和领取闭环。 */
const DOMAINS: Array<[string, string[]]> = [
  /* 叶子标题保持单一职责，避免触发连接词判据。 */
  ['auth 身份权限', ['用户模型', '登录会话签发', 'RBAC 判定', '越权拒绝', '认证审计日志']],
  ['billing 计费账务', ['计费引擎', '账单生成', '金额精度舍入', '费率配置校验', '账单状态机']],
  ['approval 单据审批', ['申请单创建', '审批状态机', '驳回处置', '金额阈值路由', '审批留痕']],
  ['ledger 对账流水', ['复式记账', '日终对账', '差异处置', '流水分页查询', '期末冻结']],
];
/* 四个域提供 20 个叶子；两个成员各承担 10 条，落在人均负载范围内。 */

/** 用 team_decompose 铺出顶层域和可领取叶子。 */
const LEAF_DETAIL = '数据结构给全字段与类型约束；接口签名与返回值写清楚（入参校验、幂等、分页口径）；'
  + '错误码枚举出来（非法入参/越权/不存在/状态不允许）；边界与异常逐个交代（并发、重复提交、部分失败、金额精度、空数据）。';
const BRANCH_DETAIL = '这一块包含若干条能力, 每条都还带着自己的数据、接口和边界, 现在这个粒度没人能直接开工, 还要继续往下拆。';
async function seedTree(callFn: (n: string, a: any) => Promise<any>) {
  await callFn('team_decompose', {
    documentPath: './REQUIREMENTS.md',
    children: DOMAINS.map(([mod]) => ({
      id: mod.split(' ')[0].toUpperCase(), title: `${mod} 这一块`, kind: 'branch', module: mod, detail: BRANCH_DETAIL,
    })),
  });
  for (const [mod, titles] of DOMAINS) {
    const pid = mod.split(' ')[0].toUpperCase();
    await callFn('team_decompose', {
      parentId: pid,
      children: titles.map((t, i) => ({
        id: `${pid}-${i + 1}`, title: t, kind: 'leaf', module: mod,
        detail: `${t}：${LEAF_DETAIL}`, acceptance: `${t} 的可执行验收判据`,
        estimateDays: 2, priority: i === 0 ? 'P0' : 'P1',
        /* 依赖必须**表态**: 空数组 = 确认无前置; 缺字段会被 NOT_A_LEAF 打回 (新闸) */
        dependsOn: [],
      })),
    });
  }
}
/** 先记录闭环所需的设计、测试和工期会议，供 team_claim 校验。 */
async function holdRequiredMeetings(callFn: (n: string, a: any) => Promise<any>, ids: string[]) {
  for (const [kind, title] of [
    ['design', '开发研讨: 跨域接口契约与数据边界'],
    ['test', '测试研讨: 验收口径与必须覆盖的边界'],
    ['estimate', '工期复核: 按业务语义难度加权, 不按条数'],
  ] as const) {
    await callFn('team_meeting', {
      kind, title, participants: ids,
      notes: ids.map((id) => ({ memberId: id, say: `${id} 的视角: 我这摊的接口谁定、边界在哪、需要谁先给什么, 都在这里说清。` })),
      decisions: ['接口契约以各域负责人给出的签名为准', '验收以可执行断言为准, 不接受"功能正常"'],
    });
  }
}

/** 树里所有叶子 id —— 领取用 */
const LEAF_IDS = DOMAINS.flatMap(([mod, titles]) =>
  titles.map((_, i) => `${mod.split(' ')[0].toUpperCase()}-${i + 1}`));
const MEMBERS = [
  { id: 'M1', role: 'implementer', title: '结算规则负责人', why: 'R1/R2 都在结算主链路' },
  { id: 'M2', role: 'reviewer', title: '质量把关', why: 'R3 验收' },
];

beforeEach(() => { setTeamPlanPersistence(null); clearTeamPlan(SID); });

describe('阶段闸: 跳步跳不过去', () => {
  it('没开团就拆需求 → 拒', async () => {
    const out = await call('team_decompose', { documentPath: './REQUIREMENTS.md', children: [] });
    /* 拒绝也走 ToolResult 信封 (status: 'error' + code), 渲染层据此出错误卡而不是铺裸 JSON */
    expect(out.status).toBe('error');
    expect(out.tool).toBe('team_decompose');
    expect(out.code).toBe('NO_TEAM');
  });

  it('开团后直接定编制 → 拒 (需求还没定)', async () => {
    await call('team_run', { goal: '把仓库按模块做成可交付方案' });
    const out = await call('team_roster', { members: MEMBERS });
    expect(out.code).toBe('NO_REQUIREMENTS');
  });

  it('编制没定就领活 → 拒', async () => {
    await call('team_run', { goal: 'g' });
    await seedTree(call);
    const out = await call('team_claim', { claims: [{ memberId: 'M1', requirementIds: [LEAF_IDS[0]] }] });
    expect(out.code).toBe('NO_ROSTER');
  });
});

describe('领取: 不重不漏 + 领地互斥', () => {
  beforeEach(async () => {
    await call('team_run', { goal: 'g' });
    await seedTree(call);
    await call('team_roster', { members: MEMBERS });
    /* 领取前要求每个成员提交一次范围判断。 */
    for (const m of MEMBERS) {
      await call('team_member_review', {
        memberId: m.id, picks: [LEAF_IDS[0]],
        analysis: `我是 ${m.title}, 这摊活按域切开做, 先打通主流程再补边界, 依赖前置的数据模型。`,
      });
    }
    await holdRequiredMeetings(call, MEMBERS.map((m) => m.id));
  });

  it('全员发言之前不许 claim', async () => {
    /* 构造一个没有成员发言的团队，验证领取闸。 */
    clearTeamPlan(SID);
    await call('team_run', { goal: 'g' });
    await seedTree(call);
    await call('team_roster', { members: MEMBERS });
    const out = await call('team_claim', { claims: [{ memberId: 'M1', requirementIds: LEAF_IDS }] });
    expect(out.code).toBe('MEMBERS_NOT_HEARD');
  });

  it('发言太薄 → 打回 (等于没让他说话)', async () => {
    const out = await call('team_member_review', { memberId: 'M1', picks: [], analysis: '行' });
    expect(out.code).toBe('THIN_ANALYSIS');
  });

  it('漏了一条 → incomplete, 点名是哪条', async () => {
    const out = await call('team_claim', {
      claims: [{ memberId: 'M1', requirementIds: LEAF_IDS.slice(0, -1), ownedScope: ['src/a'] }],
    });
    expect(out.status).toBe('incomplete');
    expect(out.unclaimed).toEqual([LEAF_IDS[LEAF_IDS.length - 1]]);
    expect(isTeamPlanReady(SID)).toBe(false);
  });

  it('两个人领同一条 → incomplete, 点名重复项', async () => {
    const out = await call('team_claim', {
      claims: [
        { memberId: 'M1', requirementIds: LEAF_IDS, ownedScope: ['src/a'] },
        { memberId: 'M2', requirementIds: [LEAF_IDS[2]], ownedScope: ['test'] },
      ],
    });
    expect(out.duplicated).toEqual([LEAF_IDS[2]]);
  });

  it('写角色领地重叠 → incomplete (reviewer 只读不参与互斥)', async () => {
    const three = [
      { id: 'M1', role: 'implementer', title: 'A' },
      { id: 'M2', role: 'implementer', title: 'B' },
      { id: 'M3', role: 'reviewer', title: 'R' },
    ];
    clearTeamPlan(SID);
    await call('team_run', { goal: 'g' });
    await seedTree(call);
    await call('team_roster', { members: three });
    for (const m of three) {
      await call('team_member_review', {
        memberId: m.id, picks: [LEAF_IDS[0]],
        analysis: `我是 ${m.title}, 按域切开推进, 先主流程后边界, 依赖数据模型先落地。`,
      });
    }
    await holdRequiredMeetings(call, three.map((m) => m.id));
    const out = await call('team_claim', {
      claims: [
        { memberId: 'M1', requirementIds: LEAF_IDS.slice(0, 8), ownedScope: ['src/a'] },
        { memberId: 'M2', requirementIds: LEAF_IDS.slice(8, 16), ownedScope: ['src/a'] },
        { memberId: 'M3', requirementIds: LEAF_IDS.slice(16), ownedScope: ['src/a'] },
      ],
    });
    expect(out.scopeOverlaps.length).toBe(1);
    expect(out.scopeOverlaps[0]).toContain('M1');
  });

  it('领满且不重叠 → ready, 规划态结束', async () => {
    const out = await call('team_claim', {
      claims: [
        { memberId: 'M1', requirementIds: LEAF_IDS.slice(0, 5), ownedScope: ['src/app'], why: '业务主链路都在我这' },
        { memberId: 'M2', requirementIds: LEAF_IDS.slice(5), ownedScope: ['test', 'ops'] },
      ],
    });
    expect(out.status).toBe('ready');
    expect(isTeamPlanReady(SID)).toBe(true);
    expect(isTeamPlanActive(SID), 'ready 之后续跑闸必须放行, 否则它会自己接着开打').toBe(false);
    const plan = getTeamPlan(SID)!;
    expect(plan.claims.find((c) => c.memberId === 'M1')!.requirementIds).toEqual(LEAF_IDS.slice(0, 5));
  });
});

describe('看板改派 (用户点着分配, 不是模型调的)', () => {
  beforeEach(async () => {
    await call('team_run', { goal: 'g' });
    await seedTree(call);
    await call('team_roster', { members: MEMBERS });
    for (const m of MEMBERS) {
      await call('team_member_review', {
        memberId: m.id, picks: [LEAF_IDS[0]],
        analysis: `我是 ${m.title}, 这摊活按域切开做, 先打通主流程再补边界, 依赖前置的数据模型。`,
      });
    }
    await holdRequiredMeetings(call, MEMBERS.map((m) => m.id));
    await call('team_claim', {
      claims: [
        { memberId: 'M1', requirementIds: LEAF_IDS.slice(0, 5), ownedScope: ['src/app'] },
        { memberId: 'M2', requirementIds: LEAF_IDS.slice(5), ownedScope: ['test'] },
      ],
    });
  });

  it('改派: 一条需求只能有一个主人 (从旧主人手里摘掉)', () => {
    assignRequirement(SID, LEAF_IDS[0], 'M2');
    const plan = getTeamPlan(SID)!;
    expect(plan.claims.find((c) => c.memberId === 'M1')!.requirementIds).not.toContain(LEAF_IDS[0]);
    expect(plan.claims.find((c) => c.memberId === 'M2')!.requirementIds).toContain(LEAF_IDS[0]);
  });

  it('收回分配 → 退回 assignment 阶段 (方案不再完整)', () => {
    expect(isTeamPlanReady(SID)).toBe(true);
    assignRequirement(SID, LEAF_IDS[0], null);
    expect(isTeamPlanReady(SID)).toBe(false);
    expect(getTeamPlan(SID)!.stage).toBe('assignment');
    /* 重新分配后闭环恢复。 */
    assignRequirement(SID, LEAF_IDS[0], 'M1');
    expect(isTeamPlanReady(SID)).toBe(true);
  });

  it('不存在的成员/需求 → 不动数据 (返回 null)', () => {
    expect(assignRequirement(SID, LEAF_IDS[0], 'M9')).toBeNull();
    expect(assignRequirement(SID, 'R99', 'M1')).toBeNull();
    expect(getTeamPlan(SID)!.claims.find((c) => c.memberId === 'M1')!.requirementIds).toContain(LEAF_IDS[0]);
  });
});

describe('规划过程中续跑闸一直拦着', () => {
  it('三步没走完 isTeamPlanActive 恒为真', async () => {
    await call('team_run', { goal: 'g' });
    expect(isTeamPlanActive(SID)).toBe(true);
    await seedTree(call);
    expect(isTeamPlanActive(SID)).toBe(true);
    await call('team_roster', { members: MEMBERS });
    expect(isTeamPlanActive(SID)).toBe(true);
  });
});

/* 递归拆解以 parentId 维护树形需求，并逐节点校验叶子条件。 */
describe('递归拆解: 一次展开一个节点, 判据是局部的', () => {
  const leaf = (id: string, days = 2) => ({
    id, title: `${id} 具体做一件事`, kind: 'leaf' as const, estimateDays: days, dependsOn: [],
    acceptance: 'node --test 断言具体值', priority: 'P0' as const,
    detail: '数据结构给全字段与类型约束；接口签名与返回值写清楚（入参校验、幂等、分页口径）；错误码枚举出来'
      + '（非法入参/越权/不存在/状态不允许）；边界与异常逐个交代（并发、重复提交、部分失败、金额精度、空数据），领它的人照着能做。',
  });
  const branch = (id: string) => ({
    id, title: `${id} 这一块`, kind: 'branch' as const,
    detail: '这一块包含若干条能力, 每条都还带着自己的数据、接口和边界, 现在这个粒度没人能直接开工, 还要继续往下拆。',
  });

  beforeEach(async () => { await call('team_run', { goal: '做一个多租户财务中台' }); });

  it('顶层展开后, 有 branch 没展开就留在 requirements 阶段', async () => {
    const out = await call('team_decompose', {
      documentPath: './R.md',
      children: [branch('BIL'), branch('LED'), leaf('OPS-1')],
    });
    expect(out.status).toBe('ok');
    expect(out.openBranchIds).toEqual(['BIL', 'LED']);
    expect(getTeamPlan(SID)!.stage).toBe('requirements');
  });

  it('分支全展开完才进 roster', async () => {
    await call('team_decompose', { documentPath: './R.md', children: [branch('BIL'), branch('LED')] });
    await call('team_decompose', { parentId: 'BIL', children: [leaf('BIL-1'), leaf('BIL-2')] });
    expect(getTeamPlan(SID)!.stage).toBe('requirements');
    const out = await call('team_decompose', { parentId: 'LED', children: [leaf('LED-1'), leaf('LED-2')] });
    expect(out.openBranchIds).toEqual([]);
    expect(getTeamPlan(SID)!.stage).toBe('roster');
    expect(out.leaves).toBe(4);
    expect(out.maxDepth).toBe(1);
  });

  it('太大的叶子被打回 —— 让它标 branch 继续拆 (这才是不卡闸线的判据)', async () => {
    const out = await call('team_decompose', {
      documentPath: './R.md',
      children: [leaf('X1'), { ...leaf('X2'), estimateDays: 8 }],
    });
    expect(out.code).toBe('NOT_A_LEAF');
    expect(out.message).toContain('branch');
    expect(out.rejected[0].id).toBe('X2');
  });

  it('标题里"和/及"捆了两件事 → 打回', async () => {
    const out = await call('team_decompose', {
      documentPath: './R.md',
      children: [leaf('Y1'), { ...leaf('Y2'), title: '账单生成和对账差异处置' }],
    });
    expect(out.code).toBe('NOT_A_LEAF');
    expect(out.rejected[0].id).toBe('Y2');
  });

  it('叶子缺验收判据 / 缺工期 → 打回', async () => {
    const a = await call('team_decompose', { documentPath: './R.md', children: [leaf('A1'), { ...leaf('A2'), acceptance: undefined }] });
    expect(a.code).toBe('NOT_A_LEAF');
    const b = await call('team_decompose', { documentPath: './R.md', children: [leaf('B1'), { ...leaf('B2'), estimateDays: undefined }] });
    expect(b.code).toBe('NOT_A_LEAF');
  });

  it('把一个节点"拆"成一个子节点 = 没拆 → 打回', async () => {
    await call('team_decompose', { documentPath: './R.md', children: [branch('BIL'), leaf('Z1')] });
    const out = await call('team_decompose', { parentId: 'BIL', children: [leaf('BIL-1')] });
    expect(out.code).toBe('POINTLESS_SPLIT');
  });

  it('分支其实够小 → closeAsLeaf + 理由, 阶段随之推进', async () => {
    await call('team_decompose', { documentPath: './R.md', children: [branch('BIL'), leaf('Z1')] });
    const bad = await call('team_decompose', { parentId: 'BIL', closeAsLeaf: true, leafReason: '够小' });
    expect(bad.code).toBe('MISSING_LEAF_REASON');
    /* closeAsLeaf 复用叶子判据，避免未完成节点进入领取阶段。 */
    const noFields = await call('team_decompose', { parentId: 'BIL', closeAsLeaf: true, leafReason: '就是一张配置表的读写, 一个人一天能做完' });
    expect(noFields.code).toBe('NOT_A_LEAF');
    const out = await call('team_decompose', {
      parentId: 'BIL', closeAsLeaf: true, leafReason: '就是一张配置表的读写, 一个人一天能做完',
      estimateDays: 1, acceptance: '断言配置表增删改查各一条用例通过',
    });
    expect(out.status).toBe('ok');
    expect(getTeamPlan(SID)!.stage).toBe('roster');
  });

  it('第一次展开没有 documentPath → 打回 (文档才是对齐依据)', async () => {
    const out = await call('team_decompose', { children: [leaf('N1'), leaf('N2')] });
    expect(out.code).toBe('MISSING_DOCUMENT');
  });

  it('领取只发生在叶子上 —— 分支不算未认领', async () => {
    await call('team_decompose', { documentPath: './R.md', children: [branch('BIL'), branch('LED')] });
    await call('team_decompose', { parentId: 'BIL', children: [leaf('BIL-1'), leaf('BIL-2')] });
    await call('team_decompose', { parentId: 'LED', children: [leaf('LED-1'), leaf('LED-2')] });
    await call('team_roster', { members: MEMBERS });
    for (const m of MEMBERS) {
      await call('team_member_review', {
        memberId: m.id, picks: [], analysis: '我按职能接对应的叶子, 先定接口再落实现, 依赖对方的契约要提前对齐。',
      });
    }
    await holdRequiredMeetings(call, MEMBERS.map((m) => m.id));
    const out = await call('team_claim', {
      claims: [
        { memberId: 'M1', requirementIds: ['BIL-1', 'BIL-2'], ownedScope: ['src/bil/'], why: '单据域是我的' },
        { memberId: 'M2', requirementIds: ['LED-1', 'LED-2'], ownedScope: ['src/led/'], why: '账务域是我的' },
      ],
    });
    /* BIL / LED 这两个分支没被任何人领 —— 但方案照样闭环 */
    expect(out.status).toBe('ready');
  });
});

/* 过大的分支必须先建立能力组中间层，再展开为可执行叶子。 */
describe('缺中间层: 一块 >10 人天不许直接摊成一串叶子', () => {
  const LD = '数据结构给全字段与类型约束；接口签名与返回值写清楚（入参校验、幂等、分页口径）；'
    + '错误码枚举出来（非法入参/越权/不存在/状态不允许）；边界与异常逐个交代。';
  const BD = '这一块包含若干条能力, 每条都还带着自己的数据、接口和边界, 现在这个粒度没人能直接开工, 还要继续往下拆。';
  const leaf = (id: string, days: number) => ({
    id, title: `${id} 做一件事`, kind: 'leaf' as const, estimateDays: days, dependsOn: [],
    acceptance: '断言具体值', detail: LD,
  });

  beforeEach(async () => {
    await call('team_run', { goal: '做一个多租户财务中台' });
    await call('team_decompose', {
      documentPath: './R.md',
      children: [{ id: 'BIL', title: '计费域', kind: 'branch', module: '计费', detail: BD },
        { id: 'OPS', title: '运维域', kind: 'branch', module: '运维', detail: BD }],
    });
  });

  it('12.5 人天摊成 5 条叶子 → 打回, 要求先分能力组', async () => {
    const out = await call('team_decompose', {
      parentId: 'BIL',
      children: [leaf('BIL-1', 2.5), leaf('BIL-2', 2.5), leaf('BIL-3', 2.5), leaf('BIL-4', 2.5), leaf('BIL-5', 2.5)],
    });
    expect(out.code).toBe('NEEDS_INTERMEDIATE_LAYER');
    expect(out.sumDays).toBe(12.5);
    expect(out.message).toContain('能力组');
  });

  it('先分能力组, 每组再展开成叶子 → 通过, 树长到 3 层', async () => {
    const g = await call('team_decompose', {
      parentId: 'BIL',
      children: [{ id: 'BIL-A', title: '费率配置', kind: 'branch', detail: BD },
        { id: 'BIL-B', title: '账单生成', kind: 'branch', detail: BD }],
    });
    expect(g.status).toBe('ok');
    const a = await call('team_decompose', { parentId: 'BIL-A', children: [leaf('BIL-A-1', 3), leaf('BIL-A-2', 3)] });
    expect(a.status).toBe('ok');
    expect(a.maxDepth).toBe(2);   // L0 域 / L1 能力组 / L2 叶子
  });

  it('小块 (≤10 人天) 直接摊叶子 → 放行, 不强推层数', async () => {
    const out = await call('team_decompose', {
      parentId: 'OPS',
      children: [leaf('OPS-1', 2), leaf('OPS-2', 2), leaf('OPS-3', 2), leaf('OPS-4', 2)],
    });
    expect(out.status).toBe('ok');
  });
});

/* 空占位、重复或拆错的无子节点必须被删除，而不是被标记为可执行叶子。 */
describe('team_prune: 拆错的节点要能删掉, 不是收成假任务', () => {
  const BD = '这一块包含若干条能力, 每条都还带着自己的数据、接口和边界, 现在这个粒度没人能直接开工, 还要继续往下拆。';
  const LD = '数据结构给全字段与类型约束；接口签名与返回值写清楚（入参校验、幂等、分页口径）；'
    + '错误码枚举出来（非法入参/越权/不存在/状态不允许）；边界与异常逐个交代（并发、重复提交、部分失败）。';
  const leaf = (id: string) => ({
    id, title: `${id} 做一件事`, kind: 'leaf' as const, estimateDays: 2, dependsOn: [], acceptance: '断言具体值', detail: LD,
  });

  beforeEach(async () => {
    await call('team_run', { goal: 'g' });
    await call('team_decompose', {
      documentPath: './R.md',
      children: [{ id: 'PLAT', title: '平台骨架与工程基础设施', kind: 'branch', detail: BD },
        { id: 'BIL', title: '计费域', kind: 'branch', detail: BD }],
    });
    await call('team_decompose', { parentId: 'BIL', children: [leaf('BIL-1'), leaf('BIL-2')] });
  });

  it('空占位分支 → prune 掉, 树上不留假任务, 阶段随之推进', async () => {
    expect(getTeamPlan(SID)!.stage).toBe('requirements');
    const out = await call('team_prune', { nodeId: 'PLAT', reason: '空占位, 内容已全部落在 BIL 域下, 重复' });
    expect(out.status).toBe('ok');
    expect(getTeamPlan(SID)!.requirements.find((r) => r.id === 'PLAT')).toBeUndefined();
    expect(getTeamPlan(SID)!.stage).toBe('roster');
  });

  it('不给理由不许删 / 不存在的节点不许删 / 有子节点的不许删', async () => {
    expect((await call('team_prune', { nodeId: 'PLAT', reason: 'x' })).code).toBe('MISSING_REASON');
    expect((await call('team_prune', { nodeId: 'NOPE', reason: '拆错了要删掉' })).code).toBe('UNKNOWN_NODE');
    expect((await call('team_prune', { nodeId: 'BIL', reason: '它有两个子节点, 删了会留孤儿' })).code).toBe('HAS_CHILDREN');
  });

  it('删掉的节点同时从认领和依赖里摘掉 —— 不留死链', async () => {
    await call('team_decompose', { parentId: 'PLAT', children: [leaf('PLAT-1'), { ...leaf('PLAT-2'), dependsOn: ['PLAT-1'] }] });
    await call('team_roster', { members: MEMBERS });
    for (const m of MEMBERS) {
      await call('team_member_review', { memberId: m.id, picks: [], analysis: '我按自己的职能接这几条: 先把接口契约定下来再落实现, 依赖别人的地方提前对齐, 风险是跨域编号语义。' });
    }
    await holdRequiredMeetings(call, MEMBERS.map((m) => m.id));
    await call('team_claim', {
      claims: [{ memberId: 'M1', requirementIds: ['PLAT-1', 'PLAT-2'], ownedScope: ['src/plat/'], why: '平台是我的' },
        { memberId: 'M2', requirementIds: ['BIL-1', 'BIL-2'], ownedScope: ['src/bil/'], why: '计费是我的' }],
    });
    const out = await call('team_prune', { nodeId: 'PLAT-1', reason: '跟 BIL-1 重复, 删掉' });
    expect(out.status).toBe('ok');
    const plan = getTeamPlan(SID)!;
    expect(plan.claims.find((c) => c.memberId === 'M1')!.requirementIds).toEqual(['PLAT-2']);
    expect(plan.requirements.find((r) => r.id === 'PLAT-2')!.dependsOn).toEqual([]);
  });
});

/* 设计、测试和工期会议是闭环前的硬性记录，缺少任一场都会阻止领取完成。 */
describe('研讨会闸: 跨域契约和验收口径没开会定过, 不许闭环', () => {
  beforeEach(async () => {
    await call('team_run', { goal: 'g' });
    await seedTree(call);
    await call('team_roster', { members: MEMBERS });
    for (const m of MEMBERS) {
      await call('team_member_review', {
        memberId: m.id, picks: [LEAF_IDS[0]], analysis: '我按自己的职能接这一摊: 先把对外接口契约定下来再落实现, 依赖别人的地方提前对齐, 主要风险在跨域编号语义不一致。',
      });
    }
  });

  const fullClaim = () => call('team_claim', {
    claims: [
      { memberId: 'M1', requirementIds: LEAF_IDS.slice(0, 5), ownedScope: ['src/app'] },
      { memberId: 'M2', requirementIds: LEAF_IDS.slice(5), ownedScope: ['test'] },
    ],
  });

  it('一场会都没开 → 打回, 点名缺哪两场', async () => {
    const out = await fullClaim();
    expect(out.code).toBe('MEETINGS_REQUIRED');
    expect(out.missingMeetings).toEqual(['design', 'test', 'estimate']);
    expect(out.message).toContain('开发研讨会');
    expect(out.message).toContain('测试研讨会');
    expect(out.message).toContain('工期复核会');
  });

  it('只开了开发研讨 → 还差测试研讨和工期复核', async () => {
    await call('team_meeting', {
      kind: 'design', title: '开发研讨: 接口契约与数据边界',
      notes: MEMBERS.map((m) => ({ memberId: m.id, say: `${m.title} 的视角: 我这摊的接口谁定、边界在哪。` })),
      decisions: ['接口以各域负责人签名为准'],
    });
    const out = await fullClaim();
    expect(out.code).toBe('MEETINGS_REQUIRED');
    expect(out.missingMeetings).toEqual(['test', 'estimate']);
  });

  it('两场都开了 → 放行闭环', async () => {
    await holdRequiredMeetings(call, MEMBERS.map((m) => m.id));
    expect((await fullClaim()).status).toBe('ready');
  });

  it('一个人自言自语不叫会 → 打回', async () => {
    const out = await call('team_meeting', {
      kind: 'design', title: '开发研讨: 接口契约',
      notes: [{ memberId: 'M1', say: '我觉得这么定就行了。' }],
    });
    expect(out.code).toBe('EMPTY_MEETING');
  });

  it('发言人不在编制里 → 打回', async () => {
    const out = await call('team_meeting', {
      kind: 'test', title: '测试研讨: 验收口径',
      notes: [{ memberId: 'M1', say: '验收要可执行断言。' }, { memberId: 'M99', say: '我是谁?' }],
    });
    expect(out.code).toBe('UNKNOWN_MEMBER');
    expect(out.message).toContain('M99');
  });
});

/* 依赖必须落在节点数据中，供环检测和施工批次计算使用。 */
describe('依赖规则: 顺序要机器可读, 不能只活在会议记录里', () => {
  const LD = '数据结构给全字段与类型约束；接口签名与返回值写清楚（入参校验、幂等、分页口径）；'
    + '错误码枚举出来（非法入参/越权/不存在/状态不允许）；边界与异常逐个交代（并发、部分失败）。';
  const BD = '这一块包含若干条能力, 每条都还带着自己的数据、接口和边界, 现在这个粒度没人能直接开工, 还要继续往下拆。';
  const leaf = (id: string, deps?: string[]) => ({
    id, title: `${id} 做一件事`, kind: 'leaf' as const, estimateDays: 2,
    acceptance: '断言具体值', detail: LD, ...(deps ? { dependsOn: deps } : {}),
  });

  beforeEach(async () => {
    await call('team_run', { goal: 'g' });
    await call('team_decompose', {
      documentPath: './R.md',
      children: [{ id: 'PLT', title: '平台地基', kind: 'branch', detail: BD },
        { id: 'BIL', title: '计费域', kind: 'branch', detail: BD }],
    });
  });

  it('叶子不给 dependsOn → 打回 (顺序不能靠猜)', async () => {
    const noDeps = { ...leaf('PLT-1') };
    delete (noDeps as any).dependsOn;
    const out = await call('team_decompose', { parentId: 'PLT', children: [noDeps, leaf('PLT-2', [])] });
    expect(out.code).toBe('NOT_A_LEAF');
    expect(out.rejected[0].why).toContain('dependsOn');
  });

  it('空数组 = 确认无前置 → 放行', async () => {
    const out = await call('team_decompose', { parentId: 'PLT', children: [leaf('PLT-1', []), leaf('PLT-2', [])] });
    expect(out.status).toBe('ok');
  });

  it('依赖指向不存在的节点 → 打回 (死链会让排序静默漏掉)', async () => {
    const out = await call('team_decompose', { parentId: 'PLT', children: [leaf('PLT-1', ['NOPE']), leaf('PLT-2', [])] });
    expect(out.code).toBe('DANGLING_DEPENDENCY');
    expect(out.danglingDeps[0].missing).toEqual(['NOPE']);
  });

  it('依赖自己 → 打回', async () => {
    const out = await call('team_decompose', { parentId: 'PLT', children: [leaf('PLT-1', ['PLT-1']), leaf('PLT-2', [])] });
    expect(out.code).toBe('SELF_DEPENDENCY');
  });

  it('依赖可以指向兄弟节点和整块分支', async () => {
    await call('team_decompose', { parentId: 'PLT', children: [leaf('PLT-1', []), leaf('PLT-2', ['PLT-1'])] });
    const out = await call('team_decompose', { parentId: 'BIL', children: [leaf('BIL-1', ['PLT']), leaf('BIL-2', ['BIL-1'])] });
    expect(out.status).toBe('ok');
  });

  it('成环 → 闭环时打回并把环打印出来', async () => {
    /* 单次调用里造不出环 (兄弟互指会被 DANGLING 挡), 分两批: 先 A, 再 B 依赖 A, 最后改不了 A
       —— 所以直接用 store 造环, 验的是 claim 那道闸 */
    await call('team_decompose', { parentId: 'PLT', children: [leaf('PLT-1', []), leaf('PLT-2', ['PLT-1'])] });
    await call('team_decompose', { parentId: 'BIL', children: [leaf('BIL-1', ['PLT-2']), leaf('BIL-2', [])] });
    const plan = getTeamPlan(SID)!;
    plan.requirements.find((r) => r.id === 'PLT-1')!.dependsOn = ['BIL-1'];   // 人为造环
    await call('team_roster', { members: MEMBERS });
    for (const m of MEMBERS) {
      await call('team_member_review', { memberId: m.id, picks: [], analysis: '我按职能接这一摊, 先定契约再落实现, 依赖别人的地方提前对齐, 风险在跨域语义。' });
    }
    await holdRequiredMeetings(call, MEMBERS.map((m) => m.id));
    const out = await call('team_claim', {
      claims: [{ memberId: 'M1', requirementIds: ['PLT-1', 'PLT-2'], ownedScope: ['src/plt'] },
        { memberId: 'M2', requirementIds: ['BIL-1', 'BIL-2'], ownedScope: ['src/bil'] }],
    });
    expect(out.code).toBe('DEPENDENCY_CYCLE');
    expect(out.cycle.length).toBeGreaterThan(1);
    expect(out.message).toContain('契约先行');
  });

  it('闭环回执带施工批次 + 跨人依赖 (执行层派兵的输入)', async () => {
    await call('team_decompose', { parentId: 'PLT', children: [leaf('PLT-1', []), leaf('PLT-2', ['PLT-1'])] });
    await call('team_decompose', { parentId: 'BIL', children: [leaf('BIL-1', ['PLT-2']), leaf('BIL-2', [])] });
    await call('team_roster', { members: MEMBERS });
    for (const m of MEMBERS) {
      await call('team_member_review', { memberId: m.id, picks: [], analysis: '我按职能接这一摊, 先定契约再落实现, 依赖别人的地方提前对齐, 风险在跨域语义。' });
    }
    await holdRequiredMeetings(call, MEMBERS.map((m) => m.id));
    const out = await call('team_claim', {
      claims: [{ memberId: 'M1', requirementIds: ['PLT-1', 'PLT-2'], ownedScope: ['src/plt'] },
        { memberId: 'M2', requirementIds: ['BIL-1', 'BIL-2'], ownedScope: ['src/bil'] }],
    });
    expect(out.status).toBe('ready');
    /* PLT-1 / BIL-2 无前置 → 第一批; PLT-2 等 PLT-1 → 第二批; BIL-1 等 PLT-2 → 第三批 */
    expect(out.waves.map((w: any) => w.ids.sort())).toEqual([['BIL-2', 'PLT-1'], ['PLT-2'], ['BIL-1']]);
    /* BIL-1 (M2 的) 等 PLT-2 (M1 的) —— 跨人依赖必须点名, 否则并行派兵时没人知道谁在等谁 */
    expect(out.crossPersonDependencies).toEqual([{ who: 'M2', waitsFor: 'M1', node: 'BIL-1', on: 'PLT-2' }]);
    expect(out.summary).toContain('批施工');
  });
});

/* 团队并发按会话计数，默认只允许一个未完成或正在执行的团队。 */
describe('并发团队闸: 默认只许一个团队在跑', () => {
  const OTHER = 'sess-other-team';
  beforeEach(() => { clearTeamPlan(OTHER); });

  const toolsFor = (sid: string) => {
    const list = createTeamPlanTools({ sessionId: sid });
    return Object.fromEntries(list.map((t) => [t.name, t])) as Record<string, any>;
  };
  const callIn = async (sid: string, name: string, args: any) =>
    JSON.parse(await toolsFor(sid)[name].function(args));

  it('另一个会话已有团队在规划 → 第二个会话开团被挡, 并报出谁占着', async () => {
    await callIn(OTHER, 'team_run', { goal: '海洋救援团队: 做一套调度系统' });
    const out = await callIn(SID, 'team_run', { goal: '另一个活' });
    expect(out.code).toBe('TEAM_LIMIT_REACHED');
    expect(out.maxTeams).toBe(1);
    expect(out.activeTeams[0].sessionId).toBe(OTHER);
    expect(out.message).toContain('海洋救援团队');
    /* 限流回执必须包含占用会话信息，供调用方解释并发状态。 */
    expect(out.message).toContain('原样讲给用户');
  });

  it('同一个会话重开团队不受限 (那是覆盖不是新增)', async () => {
    await callIn(SID, 'team_run', { goal: '第一版' });
    const out = await callIn(SID, 'team_run', { goal: '重新开一版' });
    expect(out.status).toBe('planning');
    expect(getTeamPlan(SID)!.goal).toBe('重新开一版');
  });

  it('对方团队跑完 (stage=ready 且没在执行) → 位子放出来', async () => {
    await callIn(OTHER, 'team_run', { goal: '先占位的团队' });
    await seedTree((n, a) => callIn(OTHER, n, a));
    await callIn(OTHER, 'team_roster', { members: MEMBERS });
    for (const m of MEMBERS) {
      await callIn(OTHER, 'team_member_review', {
        memberId: m.id, picks: [], analysis: '我按职能接这一摊, 先定契约再落实现, 依赖别人的地方提前对齐, 风险在跨域语义。',
      });
    }
    await holdRequiredMeetings((n, a) => callIn(OTHER, n, a), MEMBERS.map((m) => m.id));
    await callIn(OTHER, 'team_claim', {
      claims: [
        { memberId: 'M1', requirementIds: LEAF_IDS.slice(0, 5), ownedScope: ['src/a'] },
        { memberId: 'M2', requirementIds: LEAF_IDS.slice(5), ownedScope: ['test'] },
      ],
    });
    expect(getTeamPlan(OTHER)!.stage).toBe('ready');
    /* ready 且未执行的团队不占用并发名额。 */
    const out = await callIn(SID, 'team_run', { goal: '我可以开工了' });
    expect(out.status).toBe('planning');
  });
});

/* 编制数量随叶子数量校验人均负载，并受团队上下限约束。 */
describe('编制规模要跟需求规模匹配', () => {
  const mkMembers = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `M${i + 1}`, role: 'implementer', title: `负责人${i + 1}`, why: '按域切', level: '中级',
  }));

  beforeEach(async () => {
    await call('team_run', { goal: 'g' });
    await seedTree(call);   // 20 个叶子
  });

  it('20 条活配 12 个人 → 打回 (人均 1.7 条, 协调成本比干活还高)', async () => {
    const out = await call('team_roster', { members: mkMembers(12) });
    expect(out.code).toBe('ROSTER_TOO_MANY');
    expect(out.perMember).toBeLessThan(2);
    expect(out.message).toContain('能力边界');
  });

  it('20 条活只配 1 个人 → 打回 (不叫团队)', async () => {
    expect((await call('team_roster', { members: mkMembers(1) })).code).toBe('BAD_ROSTER_SIZE');
  });

  it('20 条活配 2~10 人 → 放行 (人均 2~10 条)', async () => {
    for (const n of [2, 4, 10]) {
      clearTeamPlan(SID);
      await call('team_run', { goal: 'g' });
      await seedTree(call);
      expect((await call('team_roster', { members: mkMembers(n) })).status).toBe('ok');
    }
  });

  it('上限 20 人 —— 200 个需求也不许排 50 个 agent', async () => {
    const out = await call('team_roster', { members: mkMembers(24) });
    expect(out.code).toBe('BAD_ROSTER_SIZE');
    expect(out.message).toContain('主脑自己就成瓶颈');
  });
});
