import { describe, expect, test } from 'vitest';
import { pickOrphanInsets, pickRailPull, pickSide } from '../orphanInsets';

describe('pickSide — 按几何定边', () => {
  const none = -Infinity;
  test('两边都空: 跟上一张交替 (第一张落右); 矮的才能去左边', () => {
    expect(pickSide({ top: 100, lastSide: 'left', leftBottom: none, rightBottom: none, height: 120 })).toBe('right');
    expect(pickSide({ top: 100, lastSide: 'right', leftBottom: none, rightBottom: none, height: 120 })).toBe('left');
  });
  test('高的插图 (> 170px) 永远右浮 —— 左浮让正文左缘跳动, 读起来累 (用户实拍)', () => {
    expect(pickSide({ top: 100, lastSide: 'right', leftBottom: none, rightBottom: none, height: 260 })).toBe('right');
  });
  test('右边还活着 → 叠在右边下面 (去左边会跟它并存, 中间正文被挤成窄条 — 实拍)', () => {
    expect(pickSide({ top: 100, lastSide: 'right', leftBottom: none, rightBottom: 300 })).toBe('right');
  });
  test('左边还活着 → 叠在左边下面', () => {
    expect(pickSide({ top: 100, lastSide: 'left', leftBottom: 300, rightBottom: none })).toBe('left');
  });
  test('两边都活着 (实拍: 左图 + 右网页卡把中间挤成 160px) → 去先结束的那边叠着', () => {
    expect(pickSide({ top: 100, lastSide: 'right', leftBottom: 260, rightBottom: 400 })).toBe('left');
    expect(pickSide({ top: 100, lastSide: 'left', leftBottom: 500, rightBottom: 320 })).toBe('right');
  });
  test('刚好结束 (底边 ≤ 顶 + 8px) 不算活着', () => {
    expect(pickSide({ top: 100, lastSide: 'right', leftBottom: none, rightBottom: 106, height: 120 })).toBe('left');
  });
});

describe('pickRailPull — 右栏打包', () => {
  test('实拍: 图表 68–200, 下一张网页卡 344 起 → 中间 144px 的缝, 该把第 1 张往上贴', () => {
    expect(pickRailPull([{ top: 68, bottom: 200 }, { top: 344, bottom: 449 }, { top: 464, bottom: 534 }])).toBe(1);
  });
  test('正常间距 (≤20px) 不动', () => {
    expect(pickRailPull([{ top: 0, bottom: 100 }, { top: 112, bottom: 200 }])).toBe(-1);
  });
  test('拉的距离超过上限就不动 —— 插图要留在它讲的那段话旁边', () => {
    expect(pickRailPull([{ top: 0, bottom: 100 }, { top: 700, bottom: 800 }])).toBe(-1);
    expect(pickRailPull([{ top: 0, bottom: 100 }, { top: 400, bottom: 500 }])).toBe(-1);
  });
  test('每次只报第一处缝, 挪完重量再来', () => {
    expect(pickRailPull([{ top: 0, bottom: 100 }, { top: 200, bottom: 300 }, { top: 500, bottom: 600 }])).toBe(1);
  });
});

describe('pickOrphanInsets', () => {
  test('实拍版式: 只有最后一张落在正文底边之下', () => {
    expect(pickOrphanInsets(450, [233, 353, 437, 659])).toEqual([false, false, false, true]);
  });
  test('容差: 顶边只比正文底高 3px 的也算孤儿 (那 3px 绕不进一个字)', () => {
    expect(pickOrphanInsets(450, [448])).toEqual([true]);
    expect(pickOrphanInsets(450, [440])).toEqual([false]);
  });
  test('孤儿之后全是孤儿 —— 同一根右柱, 后面的只会更低, 就算量到的 top 更小也不回头', () => {
    expect(pickOrphanInsets(300, [100, 320, 250])).toEqual([false, true, true]);
  });
  test('正文足够长时一张都不是', () => {
    expect(pickOrphanInsets(2000, [233, 353, 437, 659])).toEqual([false, false, false, false]);
  });
  test('没有插图', () => {
    expect(pickOrphanInsets(450, [])).toEqual([]);
  });
});
