import { describe, expect, test, beforeEach } from 'vitest';
import {
  __resetRowHeightGeometryForTests,
  estimateRowHeightWithGeometry,
  isTimelineGeometryReady,
  kindSampleCount,
  medianKindHeight,
  rememberMeasuredRowHeight,
  rowGeometryKind,
} from '../rowHeightGeometry';
import type { Row } from '../timelineRows';
import type { TimelineStep } from '../types';

function mkActivity(): Row {
  return {
    kind: 'activity',
    id: 'a1',
    items: [],
  } as unknown as Row;
}

function mkMessage(text = 'hello'): Row {
  return {
    kind: 'message',
    message: { id: 'm1', role: 'assistant', text },
  } as unknown as Row;
}

function mkSingle(): Row {
  const step = {
    kind: 'tool',
    id: 's1',
    title: 'read',
    status: 'done',
    iconKind: 'file',
  } as unknown as TimelineStep;
  return { kind: 'single', step } as Row;
}

describe('rowHeightGeometry', () => {
  beforeEach(() => {
    __resetRowHeightGeometryForTests();
  });

  test('rowGeometryKind 区分 message/activity/single', () => {
    expect(rowGeometryKind(mkMessage())).toBe('message');
    expect(rowGeometryKind(mkActivity())).toBe('activity');
    expect(rowGeometryKind(mkSingle())).toBe('single');
  });

  test('中位数学习后覆盖静态估高', () => {
    for (let i = 0; i < 6; i++) rememberMeasuredRowHeight('activity', 300);
    expect(medianKindHeight('activity')).toBe(300);
    expect(estimateRowHeightWithGeometry(mkActivity())).toBe(300);
  });

  test('geometryReady 需要三类样本', () => {
    expect(isTimelineGeometryReady()).toBe(false);
    for (let i = 0; i < 4; i++) {
      rememberMeasuredRowHeight('message', 160 + i);
      rememberMeasuredRowHeight('activity', 270 + i);
      rememberMeasuredRowHeight('single', 60 + i);
    }
    expect(kindSampleCount('message')).toBe(4);
    expect(isTimelineGeometryReady()).toBe(true);
  });

  test('冷启动 activity 兜底已抬到接近真高', () => {
    expect(estimateRowHeightWithGeometry(mkActivity())).toBeGreaterThanOrEqual(260);
  });
});
