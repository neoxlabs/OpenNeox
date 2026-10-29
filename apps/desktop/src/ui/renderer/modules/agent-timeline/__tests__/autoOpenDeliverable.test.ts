import { describe, it, expect } from 'vitest';
import { pickDeliverableToOpen } from '../hooks/useAutoOpenDeliverable';

const a = (path: string, ts: number, deleted = false) => ({ path, ts, deleted });

describe('Work 一轮结束自动打开成品', () => {
  it('这一轮写出的成品里挑交付物 (pptx 优先于 png / md)', () => {
    const arts = [a('/w/x/notes.md', 120), a('/w/x/图.png', 130), a('/w/x/课件.pptx', 110), a('/w/old.docx', 50)];
    expect(pickDeliverableToOpen(arts, 100, false)).toBe('/w/x/课件.pptx');
  });

  it('agent 已经在右栏展示过东西 → 不动', () => {
    expect(pickDeliverableToOpen([a('/w/x/课件.pptx', 110)], 100, true)).toBeNull();
  });

  it('上一轮的 / 删掉的不算', () => {
    expect(pickDeliverableToOpen([a('/w/old.pptx', 50), a('/w/gone.docx', 120, true)], 100, false)).toBeNull();
  });
});
