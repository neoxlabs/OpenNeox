/**
 * 账本 → 报告 (重做)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这一版锁的是用户连着骂了四轮之后定下来的规矩:
 *   ·「为什么还分这么多 C1、C2 的点?」→ 渲染结果里**一个 cid 都不许出现**
 *   ·「还原始隐句, 谁教你这么写的?」→ 不许有引句块
 *   ·「不需要来源, 来源就废话, 附录也没有」→ 不许有来源表、不许有附录
 *   ·「你就是个整理报告的」→ 正文只能是归纳出来的分析, 不是账本转储
 *   ·「你这个图表什么玩意, 比例这么大」→ 纵轴必须从 0 起
 *
 * cid 不是被扔掉了, 是**降级成校验手段**: synthesis 那层用它确认每句话/每行表格都挂得上
 * 真实结论, 挂不上就丢; 校验完在渲染层剥干净。原始证据仍在 ledger.json 和 archive/。
 */
import { describe, expect, it } from 'vitest';
import { renderReportMarkdown } from '../report.js';
import type { ResearchLedger, ResearchNarrative } from '../ledger.js';

const narrative = (over: Partial<ResearchNarrative> = {}): ResearchNarrative => ({
  summary: ['折叠形态拿到正面口碑，但配置取舍是共识槽点 [C1][C2]'],
  sections: [{
    title: '配置取舍',
    body: '负面集中在「为折叠而牺牲」而非折叠本身 [C1]。',
    tables: [{
      title: '取舍清单',
      headers: ['维度', '折叠款'],
      rows: [['生物识别', '侧边 Touch ID [C1]'], ['影像', '双摄|无长焦 [C2]']],
    }],
    charts: [{ title: '涨幅', labels: ['1TB', '2TB'], values: [2500, 3500], yLabel: '元' }],
  }],
  disputes: [{ point: '折痕是否明显', sideA: '中文区：明显 [C1]', sideB: '渠道商：看不出 [C2]', judgement: '缺同条件实测，暂不采信' }],
  recommendations: ['重度拍照用户不建议本代 [C2]'],
  openQuestions: ['折痕的客观程度'],
  limits: ['销量只有机构预期'],
  generatedAt: '2026-09-12T00:00:00.000Z',
  ...over,
});

const makeLedger = (nar?: ResearchNarrative): ResearchLedger => ({
  topic: 'iPhone 18 市场评价',
  slug: 't',
  startedAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  sources: [
    { sid: 'S1', url: 'https://a.example/x', title: 'A', hostname: 'a.example', kind: 'primary', chars: 10, fetchedAt: '2026-09-12T00:00:00.000Z' },
  ] as ResearchLedger['sources'],
  claims: [
    { cid: 'C1', text: '甲', support: [{ sid: 'S1', quote: 'q1' }], contradict: [], status: 'single-source' },
    { cid: 'C2', text: '乙', support: [{ sid: 'S1', quote: 'q2' }], contradict: [], status: 'supported' },
  ],
  ...(nar ? { narrative: nar } : {}),
});

describe('⭐️ 报告里不许出现的东西', () => {
  const md = renderReportMarkdown(makeLedger(narrative()));

  it('一个 C 编号都没有 —— 它只是校验手段, 不是给读者看的', () => {
    expect(md).not.toMatch(/\[C\d+\]/);
    expect(md).not.toContain('溯源');
  });

  it('没有引句块、没有出处编号', () => {
    expect(md).not.toContain('原始引句');
    expect(md).not.toContain('出处：');
  });

  it('没有来源清单、没有附录', () => {
    expect(md).not.toContain('## 来源');
    expect(md).not.toContain('附录');
  });
});

describe('报告正文', () => {
  const md = renderReportMarkdown(makeLedger(narrative()));

  it('摘要 / 章节 / 分析都来自归纳', () => {
    expect(md).toContain('## 摘要');
    expect(md).toContain('## 1. 配置取舍');
    expect(md).toContain('负面集中在');
  });

  it('表格照常渲染, 竖线被转义不会把表撑散', () => {
    expect(md).toContain('<p class="nx-figcap">表 1 · 取舍清单</p>');
    expect(md).toContain('| 维度 | 折叠款 |');
    expect(md).toContain('双摄\\|无长焦');
  });

  it('⭐️ 图走产品自带的 chart 卡, 数值和单位原样进 JSON', () => {
    expect(md).toContain('```neox-card:chart');
    expect(md).not.toContain('```mermaid');
    const line = md.split('\n').find((l) => l.startsWith('{"type"'))!;
    const chart = JSON.parse(line);
    expect(chart.type).toBe('column');
    expect(chart.unit).toBe('元');
    expect(chart.series.map((s: any) => s.value)).toEqual([2500, 3500]);
  });

  it('争议单独成表, 两边和判断都在', () => {
    expect(md).toContain('## 未定论：分歧在哪、靠什么能定');
    /* 争议使用独立小节，避免长文本挤在表格单元格中。 */
    expect(md).not.toContain('| 争点 | 一方 | 另一方 | 判断 |');
    expect(md).toContain('### 争点 1 · 折痕是否明显');
    expect(md).toContain('**一方**：中文区：明显');
    expect(md).toContain('**判断**：缺同条件实测，暂不采信');
    expect(md).toContain('暂不采信');
  });

  it('结论建议 / 未定论 / 方法与局限 都在', () => {
    expect(md).toContain('## 接下来看什么');
    /* 「还没定论的」不再自己占一节 —— 并进「未定论」那一节, 免得连着说两遍"我们也不知道" */
    expect(md).not.toContain('## 还没定论的');
    expect(md).toContain('### 还缺的证据');
    expect(md).toContain('## 方法与局限');
    /* 局限里要照实说证据强度 */
    expect(md).toContain('只有单一来源支撑');
  });
});

describe('归纳没跑成', () => {
  const md = renderReportMarkdown(makeLedger());

  it('⭐️ 照实说写不出正文, 但**绝不**回落成逐条转储', () => {
    expect(md).toContain('归纳没有完成');
    expect(md).not.toMatch(/\[C\d+\]/);
    expect(md).not.toContain('原始引句');
    /* 不许把账本里的结论正文摊出来充数 */
    expect(md).not.toContain('甲');
  });

  it('抬头照常给出覆盖范围', () => {
    expect(md).toContain('**调研期间**');
    expect(md).toContain('篇资料');
  });
});

/* 图表标签保持完整，由卡片按长度和条目数选择布局，避免不同标签碰撞。 */
describe('图的标签不许被截成一样', () => {
  const ledgerWith = (labels: string[]) => ({
    topic: '对比', slug: 'duibi', startedAt: '2026-09-12T00:00:00.000Z',
    sources: [], claims: [],
    narrative: {
      summary: ['一句话'],
      sections: [{
        title: '第一章', body: '正文', tables: [],
        charts: [{ title: '机型对比', labels, values: labels.map((_, i) => (i + 1) * 100), yLabel: 'mAh' }],
      }],
      disputes: [], recommendations: [], openQuestions: [], limits: [],
      generatedAt: '2026-09-12T00:00:00.000Z',
    },
  }) as any;

  const chartOf = (md: string) => JSON.parse(md.split('\n').find((l) => l.startsWith('{"type"'))!);

  it('长得像的两个长标签原样保留, 不再被截成同一个', () => {
    const chart = chartOf(renderReportMarkdown(ledgerWith(['iPhone 18 Pro', 'iPhone 18 Pro Max'])));
    expect(chart.series.map((s: any) => s.label)).toEqual(['iPhone 18 Pro', 'iPhone 18 Pro Max']);
  });

  it('超长标签也原样给卡片 —— 截断和降级横条是卡片自己的事', () => {
    const long = 'A'.repeat(40);
    const chart = chartOf(renderReportMarkdown(ledgerWith([long, 'B'])));
    expect(chart.series[0].label).toBe(long);
  });
});

/* 报告包含 SCR 执行摘要、关键指标表、章节 lead 和图表来源；缺少新字段时仍可降级渲染。 */
describe('咨询报告形态', () => {
  const full = renderReportMarkdown(makeLedger(narrative({
    execSummary: [
      { lead: '总量弱是汽车拖的，不是消费在萎缩 [C1]', points: ['剔除汽车 +2.8% [C1]', '大盘 +1.3% [C2]'] },
    ],
    kpis: {
      rows: [
        { name: '社零总额', value: '248,722 亿元', change: '+1.3%', read: '含汽车的大盘 [C1]' },
        { name: '剔除汽车', value: '229,034 亿元', change: '+2.8%', read: '真实商品温度 [C2]' },
      ],
      source: '国家统计局 · 2026-07-15',
    },
    sections: [{
      title: '大盘',
      lead: '增速差几乎全部来自汽车 [C1]',
      body: '正文 [C1]。',
      tables: [{ title: '对照', headers: ['口径', '增速'], rows: [['大盘', '+1.3% [C1]']], source: '国家统计局 · 2026-07-15' }],
      charts: [{ title: '各口径增速', labels: ['大盘', '剔除汽车'], values: [1.3, 2.8], yLabel: '%', source: '国家统计局 · 2026-07-15' }],
    }],
  })));

  it('执行摘要是加粗主句 + 子弹, 只读加粗就能拿到论点', () => {
    expect(full).toContain('## 执行摘要');
    expect(full).toContain('**总量弱是汽车拖的，不是消费在萎缩**');
    expect(full).toContain('- 剔除汽车 +2.8%');
    expect(full).not.toMatch(/\[C\d+\]/);
  });

  it('关键指标表带"怎么读"那一列和来源行', () => {
    expect(full).toContain('| 指标 | 数值 | 变化 | 怎么读 |');
    expect(full).toContain('| 社零总额 | 248,722 亿元 | +1.3% | 含汽车的大盘 |');
    expect(full).toContain('数据来源：国家统计局 · 2026-07-15');
  });

  it('章首先给结论句, 图和表下面各有一行来源', () => {
    expect(full).toContain('**增速差几乎全部来自汽车**');
    expect((full.match(/数据来源：/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('⭐️ 老账本没有这些字段也能出报告 —— 退回摘要列表, 不许渲染塌掉', () => {
    const old = renderReportMarkdown(makeLedger(narrative()));
    expect(old).toContain('## 摘要');
    expect(old).not.toContain('## 执行摘要');
    expect(old).not.toContain('## 关键指标');
    expect(old).toContain('## 1. 配置取舍');
  });
});

/* 已有覆盖范围说明时不重复追加来源统计。 */
describe('方法与局限不重复', () => {
  it('模型已经说过覆盖面/单一来源, 代码就不再补一句', () => {
    const md = renderReportMarkdown(makeLedger(narrative({
      limits: ['本次只归纳了筛选出的 60 条结论，其余单一来源结论未进入归纳，覆盖面小于实际证据量'],
    })));
    expect(md).not.toMatch(/本轮 \d+ 条核对过的结论中/);
  });

  it('模型没提时照旧补上 —— 这句话本身是有用的', () => {
    const md = renderReportMarkdown(makeLedger(narrative({ limits: ['销量只有机构预期'] })));
    expect(md).toMatch(/本轮 \d+ 条核对过的结论中/);
  });
});

describe('信息图渲染', () => {
  const md = renderReportMarkdown(makeLedger(narrative({
    sections: [{
      title: '章', body: '正文', tables: [], charts: [],
      infographics: [{
        kind: 'timeline', title: '上市节奏',
        items: [{ time: '9/10', title: '发布会' }, { time: '10/23', title: '到店' }],
        source: '苹果官网 · 2026-09-10',
      }],
    }],
  })));

  it('发成 neox-card 围栏, 和图共用「图 N」编号', () => {
    expect(md).toContain('<p class="nx-figcap">图 1 · 上市节奏</p>');
    expect(md).toContain('```neox-card:timeline');
    expect(md).toContain('"time":"10/23"');
  });

  it('来源行照样跟着走', () => {
    expect(md).toContain('数据来源：苹果官网 · 2026-09-10');
  });

  it('⭐️ 老账本没有这个字段也不炸', () => {
    expect(() => renderReportMarkdown(makeLedger(narrative()))).not.toThrow();
  });
});

/* 归纳失败时标记 narrative 过期，报告不会把上一轮正文当作新结果。 */
describe('上一轮的正文必须标出来', () => {
  it('stale 的 narrative 在抬头给出警示, 并写明它是哪一轮的', () => {
    const md = renderReportMarkdown(makeLedger(narrative({ stale: true } as any)));
    expect(md).toContain('[!WARNING]');
    expect(md).toContain('上一轮归纳');
    expect(md).toContain('2026-09-12 00:00');
  });

  it('正常的那版一个字都不多', () => {
    expect(renderReportMarkdown(makeLedger(narrative()))).not.toContain('上一轮归纳');
  });
});

/* 信息图 items 统一经过 cell/stripCites，避免内部引用编号出现在报告中。 */
describe('信息图里也不许漏 C 编号', () => {
  const md = renderReportMarkdown(makeLedger(narrative({
    sections: [{
      title: '章', body: '正文', tables: [], charts: [],
      infographics: [{
        kind: 'timeline', title: '节奏 [C9]',
        items: [
          { time: '9/9', title: '发布会 [C64]', desc: '三款齐发 [C49][C12]' },
          { time: '10/23', title: '到店', desc: '可实测 [C7]' },
        ],
      }],
    }],
  })));

  it('标题和每个字段都剥干净', () => {
    expect(md).not.toMatch(/\[C\d+\]/);
    expect(md).toContain('三款齐发');
    expect(md).toContain('图 1 · 节奏');
  });
});
