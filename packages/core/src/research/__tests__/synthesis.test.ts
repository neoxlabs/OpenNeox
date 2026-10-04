/**
 * 收敛 —— 归纳出结论, 但不许编
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户点名要的一步:「是让你多个 Agent 获取这些信息, 最后你总结出一个报告,
 * 不是让你把这些都平铺给我」。
 *
 * 这一步是整条链上**唯一让模型自由写字**的地方, 所以两道闸必须锁死:
 *   ① 引了账本里不存在的编号 → 剔掉 (我们卖的就是"每句话都能追到出处")
 *   ② 归纳失败 → 返回 null 让报告回落, 绝不阻断产出 (调研已经花掉几分钟和一堆 token)
 */
import { describe, expect, it } from 'vitest';
import { synthesizeNarrative, extractJson, pruneCitations , clipAt } from '../synthesis.js';
import type { ResearchLedger } from '../ledger.js';

const ledger = (): ResearchLedger => ({
  topic: 'T',
  slug: 't',
  startedAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  sources: [],
  claims: [
    { cid: 'C1', text: '甲', support: [], contradict: [], status: 'supported', angle: '角度一' },
    { cid: 'C2', text: '乙', support: [], contradict: [], status: 'disputed', angle: '角度一' },
  ],
});

const ok = JSON.stringify({
  summary: ['甲成立 [C1]', '乙有分歧 [C2]'],
  sections: [{
    title: '主题一',
    body: '把甲乙合并成一个判断 [C1][C2]',
    tables: [{ title: '对照', headers: ['项', '值'], rows: [['甲', '成立 [C1]'], ['丙', '没有依据']] }],
    /* 坐标轴图至少需要 3 项；更少的项目回落为文本表达。 */
    charts: [{ title: '对比', labels: ['甲', '乙', '丙'], values: [1, 2, 3], yLabel: '条' }],
  }],
  disputes: [{ point: '乙到底成不成立', sideA: '成立 [C2]', sideB: '不成立 [C1]', judgement: '证据不足' }],
  recommendations: ['先按甲做 [C1]'],
  openQuestions: ['乙还没定'],
  limits: ['只查了两条'],
});

describe('抠 JSON', () => {
  it('裹了代码块围栏也认', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('前后带废话也认', () => {
    expect(extractJson('好的，结果如下：{"a":1} 以上。')).toEqual({ a: 1 });
  });
  it('压根不是 JSON 就返回 null', () => {
    expect(extractJson('我搜了一下没找到')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('⭐️ 编出来的编号一律剔掉', () => {
  it('账本里没有的 cid 连方括号一起删, 并计数', () => {
    const r = pruneCitations('甲 [C1] 且 丙 [C99]', new Set(['C1']));
    expect(r.text).toContain('[C1]');
    expect(r.text).not.toContain('C99');
    expect(r.dropped).toBe(1);
  });
});

describe('归纳', () => {
  it('正常一趟: 摘要/章节/表/图/争议/建议/未决/局限都拿到', async () => {
    const r = await synthesizeNarrative(ledger(), { runLeader: async () => ok, model: 'leader-x' });
    expect(r.narrative?.summary).toHaveLength(2);
    expect(r.narrative?.sections[0].title).toBe('主题一');
    expect(r.narrative?.sections[0].charts).toHaveLength(1);
    expect(r.narrative?.disputes[0].point).toContain('乙');
    expect(r.narrative?.recommendations).toHaveLength(1);
    expect(r.narrative?.openQuestions).toHaveLength(1);
    expect(r.narrative?.limits).toHaveLength(1);
    expect(r.narrative?.model).toBe('leader-x');
  });

  it('⭐️ 挂不上依据的表格行被丢掉 —— 表里的字是模型写的, 这是唯一的兜底', async () => {
    /* 夹具里「丙 / 没有依据」那一行一个编号都没有 —— 必须被丢掉, 只留「甲」那行 */
    const r = await synthesizeNarrative(ledger(), { runLeader: async () => ok });
    const t = r.narrative?.sections[0].tables[0];
    expect(t?.rows).toHaveLength(1);
    expect(t?.rows[0].join(' ')).toContain('甲');
  });

  it('标签和数值对不上的图不画 —— 画错的图比没有图更糟', async () => {
    const bad = JSON.stringify({
      summary: ['x [C1]'],
      sections: [{ title: 't', body: 'b [C1]', tables: [], charts: [{ title: 'c', labels: ['a', 'b', 'c'], values: [1, 2] }] }],
    });
    const r = await synthesizeNarrative(ledger(), { runLeader: async () => bad });
    expect(r.narrative?.sections[0].charts).toHaveLength(0);
  });

  it('⭐️ 归纳里编的编号会被剔掉, 真的那条留着', async () => {
    const raw = JSON.stringify({
      summary: ['甲成立 [C1]，另外丙也成立 [C77]'],
      chapters: [], tradeoffs: [], openQuestions: [],
    });
    const r = await synthesizeNarrative(ledger(), { runLeader: async () => raw });
    expect(r.narrative?.summary[0]).toContain('[C1]');
    expect(r.narrative?.summary[0]).not.toContain('C77');
    expect(r.droppedCitations).toBe(1);
  });

  it('⭐️ 调用炸了不抛, 返回 null 让报告回落', async () => {
    const r = await synthesizeNarrative(ledger(), {
      runLeader: async () => { throw new Error('余额不足'); },
    });
    expect(r.narrative).toBeNull();
    expect(r.error).toContain('余额不足');
  });

  it('输出不是 JSON 也返回 null', async () => {
    const r = await synthesizeNarrative(ledger(), { runLeader: async () => '我没查到什么' });
    expect(r.narrative).toBeNull();
  });

  it('空账本不调模型', async () => {
    let called = false;
    const empty = { ...ledger(), claims: [] };
    const r = await synthesizeNarrative(empty, {
      runLeader: async () => { called = true; return ok; },
    });
    expect(called).toBe(false);
    expect(r.narrative).toBeNull();
  });
});

/* 超长指标文本在句读处截断，保留完整语义片段。 */
describe('截断要断在句读处', () => {
  it('没超长就原样留着, 一个字不动', () => {
    expect(clipAt('254 克', 48)).toBe('254 克');
  });

  it('超长时退到最近的句读, 不留半句话', () => {
    const s = '苹果史上最重 iPhone；Galaxy Z Fold8 只有 201 克，轻了 53 克';
    const got = clipAt(s, 24);
    expect(got.endsWith('…')).toBe(true);
    /* 断点在分号处 —— 不会出现「Galaxy Z F」这种半个词 */
    expect(got).toBe('苹果史上最重 iPhone…');
  });

  it('整段没有句读可退时才硬切', () => {
    const got = clipAt('A'.repeat(60), 20);
    expect(got).toBe(`${'A'.repeat(20)}…`);
  });

  it('句读退得太狠 (不到一半) 也走硬切', () => {
    const got = clipAt('短，' + 'B'.repeat(40), 20);
    expect(got.length).toBeGreaterThan(11);
  });
});

/* figurePlan 预先安排图表，每章最多 2 张以限制集中堆叠。 */
describe('配图规划与防扎堆', () => {
  const run = async (payload: any) => {
    const ledger = {
      topic: 't', slug: 't', startedAt: 'x', updatedAt: 'x',
      sources: [{ sid: 'S1', url: 'u', title: 'a', hostname: 'h', kind: 'primary', chars: 1, fetchedAt: 'x' }],
      claims: [{ cid: 'C1', text: '甲', support: [{ sid: 'S1', quote: 'q' }], contradict: [], status: 'supported' }],
    } as any;
    return synthesizeNarrative(ledger, { runLeader: async () => JSON.stringify(payload) });
  };
  /* 三个点起步 —— 坐标轴图有"至少 3 项"的下限, 两项的图在归纳层就被丢掉了 */
  const chart = (title: string) => ({ title, labels: ['A', 'B', 'C'], values: [1, 2, 3] });
  const base = {
    summary: ['一句 [C1]'],
    sections: [{ title: '章', body: '正文 [C1]', tables: [], charts: [chart('图1'), chart('图2'), chart('图3')] }],
  };

  it('⭐️ 两个点的坐标轴图丢掉 —— 两根柱子的"对比"一句话就说完了, 画成通栏图只会空荡荡', async () => {
    const r = await run({
      ...base,
      sections: [{
        title: '章', body: '正文 [C1]', tables: [],
        charts: [{ title: '两项对比', type: 'column', labels: ['甲', '乙'], values: [1, 2] }],
      }],
    });
    expect(r.narrative!.sections[0].charts).toHaveLength(0);
  });

  it('⚠️ 词云不受"至少 3 项"约束 —— 它靠长尾表达分布, 点数规则跟坐标轴图不是一回事', async () => {
    const r = await run({
      ...base,
      sections: [{
        title: '章', body: '正文 [C1]', tables: [],
        charts: [{ title: '热词', type: 'cloud', labels: ['甲', '乙'], values: [9, 4] }],
      }],
    });
    expect(r.narrative!.sections[0].charts).toHaveLength(1);
  });

  it('一章最多 2 张图 —— 第 3 张直接丢掉', async () => {
    const r = await run(base);
    expect(r.narrative!.sections[0].charts).toHaveLength(2);
  });

  it('收下 figurePlan, 但它不进报告正文', async () => {
    const r = await run({
      ...base,
      figurePlan: [
        { section: '章', figures: [
          { kind: 'chart', type: 'column', shows: '说明这句判断' },
          { kind: 'info', type: 'timeline', shows: '讲清节奏' },
        ] },
        { section: '只有文字的那章', figures: [{ kind: 'info', type: 'steps', shows: '验证路径' }] },
      ],
    });
    expect(r.narrative!.figurePlan).toHaveLength(2);
    /* 每章的 figures 使用数组，因此可以同时规划多张图并包含信息图。 */
    expect(r.narrative!.figurePlan![0].figures).toHaveLength(2);
    expect(r.narrative!.figurePlan![0].figures[1].kind).toBe('info');
    expect(r.narrative!.figurePlan![1].figures[0].type).toBe('steps');
  });

  it('⚠️ 旧形状的 figurePlan 仍然收得住 —— 续跑的账本里躺着老数据', async () => {
    const r = await run({
      ...base,
      figurePlan: [{ section: '章', chart: 'column', shows: '说明这句判断' }],
    });
    expect(r.narrative!.figurePlan![0].figures[0]).toMatchObject({ kind: 'chart', type: 'column' });
  });

  it('没写 section 的计划行丢掉 —— 对不上章的计划没有意义', async () => {
    const r = await run({ ...base, figurePlan: [{ chart: 'pie', shows: 'x' }, { section: '章', chart: 'pie', shows: 'y' }] });
    expect(r.narrative!.figurePlan).toHaveLength(1);
  });
});

/* 信息图 (需求：「信息图这个东西在调研报告里是非常习惯的, 不局限于饼状这些
 * 普通的图表」)。三种形态复用产品已有的卡: metrics / timeline / steps。 */
describe('信息图', () => {
  const run = async (infographics: any) => {
    const ledger = {
      topic: 't', slug: 't', startedAt: 'x', updatedAt: 'x',
      sources: [{ sid: 'S1', url: 'u', title: 'a', hostname: 'h', kind: 'primary', chars: 1, fetchedAt: 'x' }],
      claims: [{ cid: 'C1', text: '甲', support: [{ sid: 'S1', quote: 'q' }], contradict: [], status: 'supported' }],
    } as any;
    const payload = {
      summary: ['一句 [C1]'],
      sections: [{ title: '章', body: '正文 [C1]', tables: [], charts: [], infographics }],
    };
    const r = await synthesizeNarrative(ledger, { runLeader: async () => JSON.stringify(payload) });
    return r.narrative!.sections[0].infographics;
  };

  it('认三种形态, 字段按形态各取各的', async () => {
    const got = await run([{
      kind: 'timeline',
      title: '上市节奏',
      items: [{ time: '9/10', title: '发布会', desc: '三款机型' }, { time: '10/23', title: '到店', desc: '可实测' }],
    }]);
    expect(got).toHaveLength(1);
    expect(got![0].kind).toBe('timeline');
    expect(got![0].items[1].time).toBe('10/23');
  });

  it('不认的形态直接丢 —— 渲染层认不出来的 kind 会塌成裸 JSON', async () => {
    expect(await run([{ kind: 'sankey', title: 'x', items: [{ a: '1' }, { b: '2' }] }])).toBeUndefined();
  });

  it('只有一项的不要 —— 那是一句话, 不值当占一块版面', async () => {
    expect(await run([{ kind: 'metrics', title: 'x', items: [{ label: '仅一条', value: '1' }] }])).toBeUndefined();
  });

  it('空壳子项被剔掉 (渲出来是一排空框)', async () => {
    const got = await run([{
      kind: 'metrics', title: 'x',
      items: [{ label: '价', value: '15999' }, {}, { label: '重', value: '254g' }],
    }]);
    expect(got![0].items).toHaveLength(2);
  });
});

/* 输出被截断时按安全切点补齐括号，尽可能保留已经完成的 JSON 结构。 */
describe('被截断的 JSON 要能救回来', () => {
  it('结尾停在半个字符串上, 丢掉最后那个残缺元素后照样解析', () => {
    const truncated = '{"summary":["第一条","第二条"],"sections":[{"title":"章一","body":"正文"},{"title":"章二未写完';
    const got = extractJson(truncated) as any;
    expect(got).not.toBeNull();
    expect(got.summary).toEqual(['第一条', '第二条']);
    expect(got.sections).toHaveLength(1);
    expect(got.sections[0].title).toBe('章一');
  });

  it('结尾停在数组中间也能补上括号', () => {
    const got = extractJson('{"a":[1,2,3') as any;
    expect(got.a).toEqual([1, 2, 3]);
  });

  it('完整的 JSON 走原路, 不受修复逻辑影响', () => {
    expect(extractJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('带围栏的完整 JSON 照旧能认', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('压根不是 JSON 的还是返回 null —— 不许硬凑出一个空对象', () => {
    expect(extractJson('这不是 JSON, 只是一段话')).toBeNull();
  });
});
