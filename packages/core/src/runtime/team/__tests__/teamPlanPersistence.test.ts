/**
 * 团队规划落盘/重建的**字段完整性**
 * ═══════════════════════════════════════════════════════════════════════════
 * 落盘和重建两侧都是**逐字段序列化**, 漏一个字段就是静默丢失 —— 今天已经栽了三次:
 *   · isRetry     被进程内 client 的白名单吃掉 → 重试把用户消息搬到下面
 *   · teamSpec    被 plan_target 的整份重建丢掉 → 团队会话退回「目标」
 *   · documentPath 被 persist 的 JSON 白名单丢掉 → 看板「文档」页永远空
 * 所以这条测试不测某一个字段, 而是**逐字段比对整份 plan**: 以后谁加字段忘了同步序列化,
 * 这里直接红。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setTeamPlanPersistence, startTeamPlan, setTeamRequirements, setTeamRoster,
  applyTeamClaims, getTeamPlan, clearTeamPlan, purgeTeamPlan, type TeamPlan,
} from '../teamPlanStore.js';

const SID = 'sess-persist';

/** 模拟 server 那侧的落盘/重建 —— 跟 runtimeBridgeSetup 里那对函数同构 */
function makeFakeDb() {
  let row: string | null = null;
  return {
    /* 跟真实实现 (runtimeBridgeSetup) 保持同一种做法: **整包**序列化, 不是逐字段白名单。
     * 白名单是这一晚三次静默丢字段的病根 (isRetry / teamSpec / documentPath), 桩也不许再示范它。 */
    persist: (plan: TeamPlan) => { row = JSON.stringify(plan); },
    load: (sessionId: string): TeamPlan | null => {
      if (!row) return null;
      const g = JSON.parse(row);
      return {
        ...g, sessionId, stage: g.stage ?? 'requirements',
        requirements: g.requirements ?? [], roster: g.roster ?? [], reviews: g.reviews ?? [], claims: g.claims ?? [],
      };
    },
    purge: (_sessionId: string) => { row = null; },
    raw: () => row,
  };
}

beforeEach(() => clearTeamPlan(SID));

describe('落盘 → 重建', () => {
  it('整份 plan 逐字段一致 (加了字段忘同步序列化就会红)', () => {
    const db = makeFakeDb();
    setTeamPlanPersistence(db);
    startTeamPlan(SID, '做一个完整的财务系统');
    setTeamRequirements(SID, [
      { id: 'R1', title: '登录与权限', module: 'auth', priority: 'P0', acceptance: '越权 403', detail: 'RBAC', dependsOn: [], estimateHours: 8 },
      { id: 'R2', title: '对账与流水', module: 'ledger', priority: 'P0', acceptance: '日终差额 0' },
    ], './finance/REQUIREMENTS.md');
    setTeamRoster(SID, [{ id: 'M1', role: 'implementer', title: '账务域负责人', why: '两条都在账务域' }]);
    applyTeamClaims(SID, [{ memberId: 'M1', requirementIds: ['R1', 'R2'], ownedScope: ['src/finance'], why: '同一领地' }]);

    const before = getTeamPlan(SID)!;
    /* 清掉内存缓存, 强制走 load —— 等价于 renderer 刷新 / app 重启 */
    clearTeamPlan(SID);
    const after = getTeamPlan(SID)!;

    expect(after).toEqual(before);
    expect(after.documentPath, 'documentPath 丢过一次, 单独再钉一遍').toBe('./finance/REQUIREMENTS.md');
    expect(after.requirements[0].module).toBe('auth');
    expect(after.requirements[0].priority).toBe('P0');
    expect(after.claims[0].ownedScope).toEqual(['src/finance']);
  });

  it('没有落盘实现时不炸 (纯内存也能跑)', () => {
    setTeamPlanPersistence(null);
    startTeamPlan(SID, 'g');
    expect(getTeamPlan(SID)!.goal).toBe('g');
  });
});

/* ============================================================
 * 解散团队 (输入框药丸 ✕) —— 必须内存 + 存档一起删
 *
 * 用 clearTeamPlan 当"删除"是假删: 下次 getTeamPlan 走 load 又把队伍捞回来。
 * 这条就是"判清空必须同时量界面 / 模型记忆 / 底层存档三处"的那第三处。
 * ============================================================ */
describe('解散团队', () => {
  it('purge 之后重建也捞不回来 (存档真删了)', () => {
    const db = makeFakeDb();
    setTeamPlanPersistence(db);
    startTeamPlan(SID, '做个记事本');
    expect(db.raw(), '先确认真落过盘').not.toBeNull();

    purgeTeamPlan(SID);

    expect(db.raw(), '存档行必须没了').toBeNull();
    expect(getTeamPlan(SID), '重建也不该复活').toBeNull();
  });

  it('clearTeamPlan 只清内存 —— 存档还在, 会自己回来 (对照组, 钉住两者的区别)', () => {
    const db = makeFakeDb();
    setTeamPlanPersistence(db);
    startTeamPlan(SID, '做个记事本');
    clearTeamPlan(SID);
    expect(getTeamPlan(SID)?.goal, '这就是"假删"的样子').toBe('做个记事本');
  });

  it('没注入 purge 实现时不炸 (纯内存宿主)', () => {
    setTeamPlanPersistence({ persist: () => {}, load: () => null });
    startTeamPlan(SID, 'g');
    expect(() => purgeTeamPlan(SID)).not.toThrow();
    expect(getTeamPlan(SID)).toBeNull();
  });
});
