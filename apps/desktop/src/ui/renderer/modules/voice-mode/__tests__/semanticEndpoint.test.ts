
import { describe, expect, test } from 'vitest';
import { isSemanticallyComplete } from '../semanticEndpoint';

describe('isSemanticallyComplete — 完整句 (提前收口)', () => {
  test('终止标点收尾', () => {
    expect(isSemanticallyComplete('帮我定明早八点的闹钟。')).toBe(true);
    expect(isSemanticallyComplete('上海今天天气怎么样？')).toBe(true);
    expect(isSemanticallyComplete('太好了！')).toBe(false); // 有效字数不足, 兜底等后文
    expect(isSemanticallyComplete('把空调温度调到二十六度！')).toBe(true);
  });

  test('疑问语气词收尾 (partial 无标点)', () => {
    expect(isSemanticallyComplete('你吃过午饭了吗')).toBe(true);
    expect(isSemanticallyComplete('这个方案靠谱么')).toBe(true);
    expect(isSemanticallyComplete('明天会下雨吧')).toBe(true);
    expect(isSemanticallyComplete('现在过去来得及吗')).toBe(true);
  });

  test('明确疑问句式收尾 (无标点)', () => {
    expect(isSemanticallyComplete('上海天气怎么样')).toBe(true);
    expect(isSemanticallyComplete('现在几点')).toBe(true);
    expect(isSemanticallyComplete('这台电脑多少钱')).toBe(true);
    expect(isSemanticallyComplete('离这最近的地铁站在哪里')).toBe(true);
    expect(isSemanticallyComplete('今天星期几')).toBe(true);
    expect(isSemanticallyComplete('周末出去玩要不要')).toBe(true);
  });

  test('英文完整句', () => {
    expect(isSemanticallyComplete('What time is it now?')).toBe(true);
    expect(isSemanticallyComplete('Set an alarm for eight tomorrow.')).toBe(true);
  });
});

describe('isSemanticallyComplete — 不完整句 (保持 700ms 兜底)', () => {
  test('空 / 碎片', () => {
    expect(isSemanticallyComplete('')).toBe(false);
    expect(isSemanticallyComplete('   ')).toBe(false);
    expect(isSemanticallyComplete('嗯。')).toBe(false);
    expect(isSemanticallyComplete('好的')).toBe(false);
    expect(isSemanticallyComplete('1.')).toBe(false);
  });

  test('悬挂连接词/介词收尾 — 后面必有话', () => {
    expect(isSemanticallyComplete('帮我查一下明天的')).toBe(false);
    expect(isSemanticallyComplete('我想去上海和')).toBe(false);
    expect(isSemanticallyComplete('先定闹钟然后')).toBe(false);
    expect(isSemanticallyComplete('这个方案不错但是')).toBe(false);
    expect(isSemanticallyComplete('如果明天下雨的话就')).toBe(false);
    expect(isSemanticallyComplete('帮我')).toBe(false);
    expect(isSemanticallyComplete('麻烦')).toBe(false);
  });

  test('ASR 给悬挂词补了逗号/句号也不早收', () => {
    expect(isSemanticallyComplete('帮我查一下明天的,')).toBe(false);
    expect(isSemanticallyComplete('我想去上海和。')).toBe(false);
    expect(isSemanticallyComplete('然后,')).toBe(false);
  });

  test('陈述句无标点 — 拿不准, 不早收', () => {
    expect(isSemanticallyComplete('帮我定明早八点的闹钟')).toBe(false);
    expect(isSemanticallyComplete('我今天中午吃了牛肉面')).toBe(false);
  });

  test('小数/序号断口不算英文句点收尾', () => {
    expect(isSemanticallyComplete('圆周率大约是 3.')).toBe(false);
    expect(isSemanticallyComplete('The price is 3.')).toBe(false);
  });

  test('英文悬挂词', () => {
    expect(isSemanticallyComplete('I want to go to the')).toBe(false);
    expect(isSemanticallyComplete('Set an alarm for')).toBe(false);
  });
});
