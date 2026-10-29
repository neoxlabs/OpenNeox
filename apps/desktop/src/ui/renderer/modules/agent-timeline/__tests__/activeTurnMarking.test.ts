
import { describe, it, expect } from 'vitest';
import { buildTimelineRows, type Row } from '../timelineRows';
import type { TimelineRow } from '../types';

const userCell = (id: string): TimelineRow =>
  ({ kind: 'cell', id, cell: { kind: 'user', text: 'q' } } as unknown as TimelineRow);
const asstCell = (id: string): TimelineRow =>
  ({ kind: 'cell', id, cell: { kind: 'assistant_text', text: 'a' } } as unknown as TimelineRow);
/* 工具步在**输入侧**的 kind 是 legacy_step (types.ts: TimelineRow = HistoryCellRow | LegacyStepRow),
 * 不是输出侧的 'single' —— 写错会被 buildTimelineRows 整条丢掉, 测试就成了空跑。 */
const toolStep = (id: string, status = 'done'): TimelineRow =>
  ({ kind: 'legacy_step', step: { id, status, title: '读取', iconKind: 'file' } } as unknown as TimelineRow);

type ActivityRowT = Extract<Row, { kind: 'activity' }>;

/**
 * 收集**所有**层级的 activity —— 已封口的轮次会被折成 turn_fold, 它的 activity 藏在
 * fold.rows 里而不在顶层。只看顶层的话"历史 activity 不活跃"这类断言就没有样本,
 * 等于空跑 (第一版就栽在这: 把打标改成恒 true 测试照样全绿)。
 */
function allActivities(rows: Row[]): ActivityRowT[] {
  const out: ActivityRowT[] = [];
  const walk = (list: Row[]) => {
    for (const r of list) {
      if (r.kind === 'activity') { out.push(r); walk(r.rows); }
      else if (r.kind === 'turn_fold') walk((r as any).rows ?? []);
    }
  };
  walk(rows);
  return out;
}

const build = (items: TimelineRow[], streaming: boolean) =>
  buildTimelineRows(items, true, new Set<string>(), true, streaming);

const turn = (n: string, opts: { lastStepStatus?: string; withAnswer?: boolean } = {}) => [
  userCell(`u${n}`),
  toolStep(`${n}a`), toolStep(`${n}b`),
  ...(opts.withAnswer === false ? [] : [asstCell(`mid${n}`)]),
  toolStep(`${n}c`), toolStep(`${n}d`, opts.lastStepStatus ?? 'done'),
  ...(opts.withAnswer === false ? [] : [asstCell(`m${n}`)]),
];

describe('inActiveTurn · 打标必须区分轮次', () => {
  it('夹具有效性: 确实产出了 activity 行 (否则后面全是空跑)', () => {
    expect(allActivities(build(turn('1'), false)).length).toBeGreaterThan(0);
  });

  it('会话空闲 → 没有任何 activity 被标活跃', () => {
    const acts = allActivities(build([...turn('1'), ...turn('2')], false));
    expect(acts.length).toBeGreaterThan(0);
    for (const a of acts) expect(a.inActiveTurn).not.toBe(true);
  });

  /* ↓↓↓ 核心: 这条能抓住"全标活跃"的错误实现 ↓↓↓ */
  it('会话在跑 → 历史轮的 activity 仍然不活跃, 只有最后一段活跃', () => {
    const rows = build([...turn('1'), ...turn('2'), ...turn('3', { withAnswer: false })], true);
    const acts = allActivities(rows);
    expect(acts.length).toBeGreaterThanOrEqual(2);
    const active = acts.filter((a) => a.inActiveTurn === true);
    const inactive = acts.filter((a) => a.inActiveTurn !== true);
    /* 必须两边都非空 —— 全活跃或全不活跃都是错的 */
    expect(active.length, '应当有活跃的 activity').toBeGreaterThan(0);
    expect(inactive.length, '历史轮的 activity 必须不活跃').toBeGreaterThan(0);
  });

  it('会话在跑时活跃的只能是最后一段 —— 历史轮被折进 turn_fold 且全部不活跃', () => {
    const rows = build([...turn('1'), ...turn('2', { withAnswer: false })], true);
    const folds = rows.filter((r) => r.kind === 'turn_fold');
    expect(folds.length, '已封口的第一轮应被折起').toBeGreaterThan(0);
    for (const f of folds) {
      for (const a of allActivities([(f as any)])) {
        expect(a.inActiveTurn, '被折起的历史轮不可能是活跃轮').not.toBe(true);
      }
    }
  });

  it('段里还有未落定的 step 时, 即使 streaming=false 也算活跃 (等审批 / ask_user 窗口)', () => {
    /* streaming 在等审批期间会翻 false —— 只看 streaming 会把待审那张卡折没,
     * 用户正等着点"同意"却找不到按钮。判据里保留 rowHasActive 就是为这个。 */
    const acts = allActivities(build(turn('1', { lastStepStatus: 'running', withAnswer: false }), false));
    expect(acts.some((a) => a.inActiveTurn === true)).toBe(true);
  });

  it('同样输入两次构建, 打标结果一致 (纯函数, 不带状态)', () => {
    const items = [...turn('1'), ...turn('2', { withAnswer: false })];
    const a = allActivities(build(items, true)).map((x) => x.inActiveTurn);
    const b = allActivities(build(items, true)).map((x) => x.inActiveTurn);
    expect(a).toEqual(b);
  });

  it('空 timeline 不抛', () => {
    expect(() => build([], true)).not.toThrow();
    expect(() => build([], false)).not.toThrow();
  });
});

describe('inActiveTurn · 本轮多段 activity 只亮尾巴 (2026-08-10)', () => {
  const multiActivityTurn = (opts: { lastToolStatus?: string; trailingAnswer?: boolean } = {}): TimelineRow[] => [
    userCell('uM'),
    toolStep('t1a'), toolStep('t1b'),
    asstCell('mMid'), // 非空短评 → 切断 activity, 不会被合并回去
    toolStep('t2a'), toolStep('t2b', opts.lastToolStatus ?? 'done'),
    ...(opts.trailingAnswer === false ? [] : [asstCell('mEnd')]),
  ];

  it('夹具: 同一轮必须产出 ≥2 个 activity', () => {
    const acts = allActivities(
      build(multiActivityTurn({ lastToolStatus: 'running', trailingAnswer: false }), true),
    );
    expect(acts.length, '需要多段 activity 才能测感染').toBeGreaterThanOrEqual(2);
  });

  it('会话在跑 + 本轮多段 activity → 只有最后一个 inActiveTurn', () => {
    /* 后段仍 running → isActiveTurn 为真；若错误地整段全标，前段也会变「正在思考」。 */
    const acts = allActivities(
      build(multiActivityTurn({ lastToolStatus: 'running', trailingAnswer: false }), true),
    );
    expect(acts.length).toBeGreaterThanOrEqual(2);
    const flags = acts.map((a) => a.inActiveTurn === true);
    const activeCount = flags.filter(Boolean).length;
    expect(activeCount, '活跃只能有 1 个').toBe(1);
    expect(flags[flags.length - 1], '必须是最后一个').toBe(true);
    for (let i = 0; i < flags.length - 1; i++) {
      expect(flags[i], `第 ${i} 段已结束不得再标思考`).toBe(false);
    }
  });

  it('前段 tools 全 done、后段仍 running → 前段不活跃、后段活跃', () => {
    const acts = allActivities(
      build(multiActivityTurn({ lastToolStatus: 'running', trailingAnswer: false }), true),
    );
    expect(acts.length).toBeGreaterThanOrEqual(2);
    const early = acts.slice(0, -1);
    const last = acts[acts.length - 1]!;
    for (const a of early) expect(a.inActiveTurn).not.toBe(true);
    expect(last.inActiveTurn).toBe(true);
  });

  it('对照: 本轮已定稿回答 → 全部不活跃 (含多段)', () => {
    const acts = allActivities(build(multiActivityTurn({ trailingAnswer: true }), true));
    for (const a of acts) expect(a.inActiveTurn).not.toBe(true);
  });
});

describe('inActiveTurn · 竞态窗口 (用户连报三次的场景)', () => {
  /**
   * 发新消息时 streaming 先翻 true, 而新的 user message 行还没进 rows ——
   * 这一帧里"最后一段"仍然是**上一轮**。前两版修法在这一帧都会把上一轮点亮,
   * 文案闪成「正在思考」再弹回。
   *
   * 现在的判据只看这一段自己: 上一轮**已有定稿回答** ⇒ 关闭, 与 streaming 无关。
   */
  it('上一轮已定稿 + streaming=true (新 user 行尚未到达) → 仍然不活跃', () => {
    const rows = build([...turn('1'), ...turn('2')], true);
    const acts = allActivities(rows);
    expect(acts.length, '夹具要真的产出 activity').toBeGreaterThan(0);
    for (const a of acts) {
      expect(a.inActiveTurn, '已定稿的轮次在任何情况下都不该活跃').not.toBe(true);
    }
  });

  it('对照: 同样 streaming=true 但最后一段还没定稿 → 必须活跃', () => {
    const rows = build([...turn('1'), ...turn('2', { withAnswer: false })], true);
    const acts = allActivities(rows);
    expect(acts.some((a) => a.inActiveTurn === true), '正在跑的那一轮必须亮').toBe(true);
  });

  it('助手回答仍在流式 (streaming 标记未落定) → 算活跃', () => {
    const items: TimelineRow[] = [
      userCell('u1'), toolStep('a1'), toolStep('a2'), toolStep('a3'),
      ({ kind: 'cell', id: 'm1', cell: { kind: 'assistant_text', text: '写到一半', streaming: true } } as unknown as TimelineRow),
    ];
    const acts = allActivities(build(items, true));
    expect(acts.some((a) => a.inActiveTurn === true)).toBe(true);
  });

  it('会话空闲 + 最后一段没定稿回答 (被中断) → 不活跃, 不能永远转圈', () => {
    const acts = allActivities(build([...turn('1'), ...turn('2', { withAnswer: false })], false));
    for (const a of acts) expect(a.inActiveTurn).not.toBe(true);
  });
});
