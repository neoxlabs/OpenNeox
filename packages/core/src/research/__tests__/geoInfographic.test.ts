/** 几何信息图的 value 支持数字，并决定环的大小、层的宽度和带子的粗细。 */
import { describe, expect, it } from 'vitest';
import { synthesizeNarrative } from '../synthesis.js';
import type { ResearchLedger } from '../ledger.js';

const ledger = (): ResearchLedger => ({
  topic: 'T',
  slug: 't',
  startedAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  sources: [],
  claims: [
    { cid: 'C1', text: '甲', support: [], contradict: [], status: 'supported', angle: '角度一' },
  ],
} as unknown as ResearchLedger);

const run = async (infographics: unknown[]) => {
  const raw = JSON.stringify({
    summary: ['甲成立 [C1]'],
    sections: [{ title: '章', body: '正文 [C1]', tables: [], charts: [], infographics }],
  });
  return synthesizeNarrative(ledger(), { runLeader: async () => raw });
};

describe('几何信息图的 value', () => {
  it('value 是**数字**时不能被丢掉 —— 丢了就画出四个一样大的环', async () => {
    const r = await run([{
      kind: 'target',
      title: '收敛',
      items: [{ label: '全部争议', value: 12 }, { label: '能实测的', value: 1 }],
    }]);
    const info = r.narrative?.sections[0].infographics?.[0];
    expect(info?.items.map((i) => i.value)).toEqual(['12', '1']);
  });

  it('⚠️ 拿不到数就整张丢 —— 全 0 的图比没有图更糟 (看着像正经图, 读出来是"差不多")', async () => {
    const r = await run([{
      kind: 'funnel',
      title: '流失',
      items: [{ label: '预约' }, { label: '成交' }],
    }]);
    expect(r.narrative?.sections[0].infographics ?? []).toHaveLength(0);
  });

  it('文字型信息图不受这条约束 —— 它本来就不靠数值画形状', async () => {
    const r = await run([{
      kind: 'timeline',
      title: '节奏',
      items: [{ time: '9/9', title: '发布' }, { time: '10/23', title: '到店' }],
    }]);
    expect(r.narrative?.sections[0].infographics).toHaveLength(1);
  });

  it('几何形状进得了白名单 —— 上一版只有文字型三种, 排了 pyramid 也被静默丢掉', async () => {
    const r = await run([{
      kind: 'pyramid',
      title: '证据分层',
      items: [{ label: '多来源一致', value: 30 }, { label: '单一来源', value: 12 }],
    }]);
    expect(r.narrative?.sections[0].infographics?.[0].kind).toBe('pyramid');
  });
});
