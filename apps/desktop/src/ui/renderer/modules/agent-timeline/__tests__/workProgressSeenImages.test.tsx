import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, expect } from 'vitest';
import { buildTimelineRows, __resetBuildSegmentCacheForTests } from '../timelineRows';
import { WorkProgressCard } from '../WorkProgressCard';

const SHOT = '/h/.neox/run/seen/0cd9f7b1ef71da2a2f1a.jpg';

const items = [
  { kind: 'message', id: 'u1', role: 'user', text: '打开 example.com 截个图', timestamp: new Date(1700000000000).toISOString() },
  {
    kind: 'tool', id: 't1', title: 'browser_run', iconKind: 'read', status: 'done',
    content: { type: 'seen_images', images: [{ path: SHOT }] },
  },
];

const rows = () => {
  __resetBuildSegmentCacheForTests();
  return buildTimelineRows(items as never, false, new Set(), true, true);
};

describe('WorkProgressCard 显示看过的图', () => {
  test('运行中 (live)', () => {
    const html = renderToStaticMarkup(<WorkProgressCard rows={rows()} live zh />);
    expect(html).toContain('nx-wp__seen');
    expect(html).toContain(encodeURIComponent('0cd9f7b1ef71da2a2f1a.jpg'));
  });

  test('跑完点开 (static)', () => {
    const html = renderToStaticMarkup(<WorkProgressCard rows={rows()} live={false} zh />);
    expect(html).toContain('nx-wp__seen');
  });
});
