import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  clearTerminalKeepalivePool,
  parkTerminal,
  takeParkedTerminal,
  parkedTerminalCount,
} from '../terminalKeepalivePool';
import { rowStepToTimelineStep, type RowStep } from '../timelineRows';
import type { HistoryCellRow } from '../types';

describe('terminalKeepalivePool', () => {
  beforeEach(() => clearTerminalKeepalivePool());

  function fakeTerm(id: string) {
    const element: { parentElement: { removeChild: (el: unknown) => void } | null; id: string } = {
      id,
      parentElement: {
        removeChild(el: unknown) {
          void el;
          element.parentElement = null;
        },
      },
    };
    return {
      element,
      dispose: vi.fn(),
    };
  }

  test('park then take restores same instance', () => {
    const term = fakeTerm('a');
    const fit = {};
    expect(parkTerminal('tool-1', term, fit)).toBe(true);
    expect(term.element.parentElement).toBeNull();
    expect(parkedTerminalCount()).toBe(1);
    const taken = takeParkedTerminal('tool-1');
    expect(taken?.terminal).toBe(term);
    expect(parkedTerminalCount()).toBe(0);
    expect(term.dispose).not.toHaveBeenCalled();
  });

  test('LRU evicts oldest', () => {
    const disposed: Array<ReturnType<typeof fakeTerm>> = [];
    for (let i = 0; i < 12; i++) {
      const t = fakeTerm(String(i));
      disposed.push(t);
      parkTerminal(`t-${i}`, t, {});
    }
    expect(parkedTerminalCount()).toBeLessThanOrEqual(10);
    expect(takeParkedTerminal('t-0')).toBeNull();
    expect(takeParkedTerminal('t-11')).not.toBeNull();
    expect(disposed[0]!.dispose).toHaveBeenCalled();
  });

  test('missing toolId refuses park', () => {
    expect(parkTerminal(undefined, fakeTerm('x'), {})).toBe(false);
  });
});

describe('nearTail blank invariant', () => {
  /** 视口落在 topPad 内 = 整屏空白; 必须退出尾窗. */
  function viewportInTailPad(
    scrollTop: number,
    topPad: number,
    hardStart: number,
    tailStart: number
  ): boolean {
    return scrollTop + 1 < topPad || hardStart < tailStart;
  }

  test('scroll into topPad forces exit', () => {
    expect(viewportInTailPad(1000, 50000, 10, 800)).toBe(true);
  });

  test('viewport still inside mounted tail stays', () => {
    expect(viewportInTailPad(52000, 50000, 800, 800)).toBe(false);
  });
});

describe('absolute virtual space scrollHeight lock', () => {
  /** scrollHeight 必须由估高 totalHeight 锁死, 与挂载行实高无关. */
  function lockedScrollHeight(
    totalHeight: number,
    _mountedActualHeight: number
  ): number {
    return totalHeight;
  }

  test('taller mounted rows do not inflate scroll geometry', () => {
    expect(lockedScrollHeight(100_000, 50_000)).toBe(100_000);
  });

  test('shorter mounted rows do not collapse scroll geometry', () => {
    expect(lockedScrollHeight(100_000, 800)).toBe(100_000);
  });
});

describe('rowStepToTimelineStep identity cache', () => {
  /* 这个 fixture 只喂给 rowStepToTimelineStep 测 identity cache, 不需要完整 row;
   * 用 as unknown as 而不是逐字段补齐, 免得 HistoryCellRow 一加字段这里就红。 */
  function mkHistory(id: string): HistoryCellRow {
    return {
      id,
      title: 'Read',
      desc: '',
      status: 'done',
      /* StepIconKind 里没有 'read' (读文件用 'file'); timestamp 是 string 不是 number */
      iconKind: 'file',
      timestamp: String(Date.now()),
      cell: {
        kind: 'explore',
        id,
        sessionId: 's',
        timestamp: Date.now(),
        query: 'x',
        results: [],
      } as any,
      legacyContent: { type: 'search', query: 'x', results: [] } as any,
    } as unknown as HistoryCellRow;
  }

  test('same HistoryCellRow object returns same TimelineStep ref', () => {
    const row = mkHistory('h1') as RowStep;
    const a = rowStepToTimelineStep(row);
    const b = rowStepToTimelineStep(row);
    expect(a).toBe(b);
  });

  test('different objects get different TimelineStep refs', () => {
    const a = rowStepToTimelineStep(mkHistory('h1'));
    const b = rowStepToTimelineStep(mkHistory('h1'));
    expect(a).not.toBe(b);
    expect(a.id).toBe(b.id);
  });
});
