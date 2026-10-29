/**
 * 增量 dump 的合并 —— 桥只回"变了的 + 没变的编号 + 消失的编号", 完整视图在我们手里。
 *
 * 这层最凶的失效方式是**静默残缺**: 合并写错了不会报错, 只会让模型看到一份
 * 少了一半元素的界面, 然后它去点一个"不存在"的按钮。所以这里逐条钉死。
 */
import { describe, it, expect } from 'vitest';
import { mergeIncrementalDump } from '../computerRun.js';
import type { BridgeDump, BridgeElement } from '../osBridgeClient.js';

function el(id: number, label: string, extra: Partial<BridgeElement> = {}): BridgeElement {
  return {
    id, role: 'AXButton', label, x: 0, y: 0, w: 10, h: 10,
    actionable: true, actions: ['AXPress'], enabled: true, focused: false, ...extra,
  };
}

function dump(elements: BridgeElement[], extra: Partial<BridgeDump> = {}): BridgeDump {
  return {
    ok: true, app: 'Calculator', pid: 1, epoch: 1, ms: 1,
    visited: elements.length, elements, axBlind: false, ...extra,
  } as BridgeDump;
}

describe('mergeIncrementalDump', () => {
  it('没变的元素从上一份铺底带过来', () => {
    const prev = dump([el(1, 'A'), el(2, 'B'), el(3, 'C')]);
    const inc = dump([], { incremental: true, unchanged: [1, 2, 3], epoch: 2 });
    const out = mergeIncrementalDump(prev, inc);
    expect(out.elements.map((e) => e.label)).toEqual(['A', 'B', 'C']);
  });

  it('变了的元素用新值覆盖旧值 (不是追加成两条)', () => {
    const prev = dump([el(1, 'A'), el(2, '16')]);
    const inc = dump([el(2, '17')], { incremental: true, unchanged: [1], epoch: 2 });
    const out = mergeIncrementalDump(prev, inc);
    expect(out.elements).toHaveLength(2);
    expect(out.elements.find((e) => e.id === 2)?.label).toBe('17');
  });

  it('removed 的元素真的消失', () => {
    const prev = dump([el(1, 'A'), el(2, 'B'), el(3, 'C')]);
    const inc = dump([], { incremental: true, unchanged: [1], removed: [2, 3], epoch: 2 });
    expect(mergeIncrementalDump(prev, inc).elements.map((e) => e.id)).toEqual([1]);
  });

  it('新出现的元素接进来', () => {
    const prev = dump([el(1, 'A')]);
    const inc = dump([el(9, '新弹出的 sheet 按钮')], { incremental: true, unchanged: [1], epoch: 2 });
    expect(mergeIncrementalDump(prev, inc).elements.map((e) => e.id)).toEqual([1, 9]);
  });

  it('结果按编号排序 —— 同一个界面在模型眼里不能每次顺序都不一样', () => {
    const prev = dump([el(5, 'E'), el(1, 'A'), el(3, 'C')]);
    const inc = dump([el(2, 'B'), el(4, 'D')], { incremental: true, unchanged: [1, 3, 5], epoch: 2 });
    expect(mergeIncrementalDump(prev, inc).elements.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('合并结果不再带增量标记 —— 下游拿到的是一份完整视图', () => {
    const prev = dump([el(1, 'A')]);
    const inc = dump([el(2, 'B')], { incremental: true, unchanged: [1], removed: [], epoch: 2 });
    const out = mergeIncrementalDump(prev, inc);
    expect(out.incremental).toBeUndefined();
    expect(out.unchanged).toBeUndefined();
    expect(out.removed).toBeUndefined();
  });

  it('epoch / app / window 这些元信息取新的那份', () => {
    const prev = dump([el(1, 'A')], { epoch: 7, ms: 900 });
    const inc = dump([], { incremental: true, unchanged: [1], epoch: 8, ms: 12 });
    const out = mergeIncrementalDump(prev, inc);
    expect(out.epoch).toBe(8);
    expect(out.ms).toBe(12);
  });

  it('removed 和 elements 同时提到一个编号时, elements 赢 (它是"变了", 不是"没了")', () => {
    /* 桥不该同时发这两个, 但真发了也得有确定行为 —— 保留元素比凭空丢掉安全。 */
    const prev = dump([el(1, 'A')]);
    const inc = dump([el(1, 'A2')], { incremental: true, removed: [1], epoch: 2 });
    expect(mergeIncrementalDump(prev, inc).elements.map((e) => e.label)).toEqual(['A2']);
  });
});
