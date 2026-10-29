import { describe, expect, it } from 'vitest';
import { findDuplicate, sameTitle } from '../pilotReportDedupe';

describe('sameTitle', () => {
  it('前面多了目录名 / 标点不同 = 同一件事 (云端值班收回后本地又报一次的实录)', () => {
    expect(sameTitle('记账工具做完了,26 项测试全过', 'shift-test3 记账工具做完了,26 项测试全过')).toBe(true);
    expect(sameTitle('登录功能做完了', '登录功能做完了！')).toBe(true);
  });
  it('措辞小改也算', () => {
    expect(sameTitle('五种排序 + 性能对比做完了', '五种排序和性能对比都做完了')).toBe(true);
  });
  it('数不一样是不同的事 (五杯拿铁是五次下单, 不是一件事报了五次)', () => {
    expect(sameTitle('第四杯拿铁下单成功', '第五杯拿铁下单成功')).toBe(false);
    expect(sameTitle('第3轮测试过了', '第4轮测试过了')).toBe(false);
    /* 没编号的不吞带编号的 —— 否则「拿铁下单成功」会把第三/四/五杯一路并进来 */
    expect(sameTitle('拿铁下单成功', '第五杯拿铁下单成功')).toBe(false);
  });
  it('不同的事不合并', () => {
    expect(sameTitle('两个小活都做完并验证通过', '五种排序 + 性能对比做完了')).toBe(false);
    expect(sameTitle('订票要你选时段', '登录功能做完了')).toBe(false);
  });
  it('后半句套话一样、主语不同 → 不是一件事', () => {
    expect(sameTitle('词频统计脚本做完了,23 项测试全过', 'CSV 列统计脚本做完了,23 项测试全过')).toBe(false);
    expect(sameTitle('记账工具做完了,26 项测试全过', '记账工具做好了,26 项测试全过')).toBe(true);
  });
});

describe('findDuplicate', () => {
  const now = 1_000_000_000;
  const base = { id: 'a', sessionId: 's1', status: 'done', title: '记账工具做完了', at: now - 60_000 };
  it('同会话同状态窗口内 → 命中', () => {
    expect(findDuplicate([base], { sessionId: 's1', status: 'done', title: 'shift-test3 记账工具做完了' }, now)?.id).toBe('a');
  });
  it('别的 Pilot / 别的状态 / 过了窗口 → 不算', () => {
    expect(findDuplicate([base], { sessionId: 's2', status: 'done', title: '记账工具做完了' }, now)).toBeNull();
    expect(findDuplicate([base], { sessionId: 's1', status: 'failed', title: '记账工具做完了' }, now)).toBeNull();
    expect(findDuplicate([{ ...base, at: now - 7 * 3600_000 }], { sessionId: 's1', status: 'done', title: '记账工具做完了' }, now)).toBeNull();
  });
  it('拍板类答过了, 再问是新问题', () => {
    const asked = { ...base, status: 'blocked', title: '订票要你选时段', answer: '上午' };
    expect(findDuplicate([asked], { sessionId: 's1', status: 'blocked', title: '订票要你选时段' }, now)).toBeNull();
  });
});
