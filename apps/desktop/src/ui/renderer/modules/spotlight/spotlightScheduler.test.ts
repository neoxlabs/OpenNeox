/* 聚光卡调度的规矩 —— 「随机弹」最容易滑成「老是弹」, 这里把不许弹的情况一条条钉住。 */
import { describe, it, expect } from 'vitest';
import type { SpotlightCardDef, SpotlightContext } from './spotlightCards';
import { COOLDOWN_MS, FIRST_RUN_GRACE_MS, emptyState, markShown, pickSpotlight } from './spotlightScheduler';

const card = (id: string, extra: Partial<SpotlightCardDef> = {}): SpotlightCardDef => ({
  id,
  kind: 'tip',
  image: '',
  title: { zh: id, en: id },
  body: { zh: '', en: '' },
  ...extra,
});

const T0 = Date.UTC(2026, 8, 27, 8);
const settled = { ...emptyState(T0 - FIRST_RUN_GRACE_MS - 1) };
const ctx = (over: Partial<SpotlightContext> = {}): SpotlightContext => ({
  now: T0, hasAccount: false, modelReady: true, ...over,
});

describe('pickSpotlight', () => {
  it('刚装好那段时间不弹', () => {
    expect(pickSpotlight([card('a')], emptyState(T0 - 1000), ctx())).toBeNull();
  });

  it('还没接模型不弹 —— 那时候该做的是接模型', () => {
    expect(pickSpotlight([card('a')], settled, ctx({ modelReady: false }))).toBeNull();
  });

  it('冷却期内不弹, 过了冷却才弹下一张', () => {
    const s = markShown(settled, 'a', T0 - COOLDOWN_MS + 60_000);
    expect(pickSpotlight([card('a'), card('b')], s, ctx())).toBeNull();
    const later = ctx({ now: T0 + 120_000 });
    expect(pickSpotlight([card('a'), card('b')], s, later)?.id).toBe('b');
  });

  it('看过的卡默认不再出, repeatAfterDays 到期才再出', () => {
    const s = markShown(settled, 'a', T0 - 3 * 86_400_000);
    expect(pickSpotlight([card('a')], s, ctx())).toBeNull();
    expect(pickSpotlight([card('a', { repeatAfterDays: 2 })], s, ctx())?.id).toBe('a');
    expect(pickSpotlight([card('a', { repeatAfterDays: 7 })], s, ctx())).toBeNull();
  });

  it('活动窗口外不出', () => {
    const promo = card('p', { startsAt: '2026-10-01', endsAt: '2026-10-07' });
    expect(pickSpotlight([promo], settled, ctx())).toBeNull();
    expect(pickSpotlight([promo], settled, ctx({ now: Date.parse('2026-10-03') }))?.id).toBe('p');
    expect(pickSpotlight([promo], settled, ctx({ now: Date.parse('2026-10-09') }))).toBeNull();
  });

  it('when 条件不满足不出', () => {
    const mobile = card('m', { when: (c) => c.hasAccount });
    expect(pickSpotlight([mobile], settled, ctx())).toBeNull();
    expect(pickSpotlight([mobile], settled, ctx({ hasAccount: true }))?.id).toBe('m');
  });

  it('用户关了就一张都不出', () => {
    expect(pickSpotlight([card('a')], { ...settled, off: true }, ctx())).toBeNull();
  });

  it('按权重抽: rand 落在哪一段就是哪张, 权重 0 的永远抽不到', () => {
    const cards = [card('a', { weight: 1 }), card('z', { weight: 0 }), card('b', { weight: 3 })];
    expect(pickSpotlight(cards, settled, ctx(), () => 0)?.id).toBe('a');
    expect(pickSpotlight(cards, settled, ctx(), () => 0.24)?.id).toBe('a');
    expect(pickSpotlight(cards, settled, ctx(), () => 0.26)?.id).toBe('b');
    expect(pickSpotlight(cards, settled, ctx(), () => 0.999)?.id).toBe('b');
  });
});
