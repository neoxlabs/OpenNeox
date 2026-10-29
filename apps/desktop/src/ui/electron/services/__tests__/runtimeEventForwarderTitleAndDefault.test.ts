import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeEventForwarder } from '../runtimeEventForwarder.js';

function makeForwarder() {
  const emitted: any[] = [];
  const f = new RuntimeEventForwarder({ emitStream: (e) => { emitted.push(e); } });
  return { f, emitted };
}
const TRACKER = { contextUsed: 0, startTime: Date.now(), provider: '', model: '' } as any;

describe('RuntimeEventForwarder', () => {
  let warn: any;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('session_title_changed 会被转发给界面 (带 sessionId 和 title)', () => {
    const { f, emitted } = makeForwarder();
    f.forward('s-1', { type: 'session_title_changed', sessionId: 's-1', title: '生成的标题' } as any, TRACKER);
    const hit = emitted.find((e) => e.type === 'session_title_changed');
    expect(hit, '标题事件必须到达界面').toBeTruthy();
    expect(hit.sessionId).toBe('s-1');
    expect(hit.title).toBe('生成的标题');
  });

  it('空标题不转发 — 别把会话改成空名字', () => {
    const { f, emitted } = makeForwarder();
    f.forward('s-1', { type: 'session_title_changed', sessionId: 's-1', title: '   ' } as any, TRACKER);
    expect(emitted.find((e) => e.type === 'session_title_changed')).toBeUndefined();
  });

  it('background_task 整个透传: 快照的 processes / 监控的 monitors 都要到界面', () => {
    const { f, emitted } = makeForwarder();
    f.forward('s-1', { type: 'background_task', action: 'snapshot', generatedAt: 42, processes: [{ pid: 1 }] } as any, TRACKER);
    f.forward('s-1', { type: 'background_task', action: 'monitors', monitors: [{ id: 'mon-1' }] } as any, TRACKER);
    const [snap, mon] = emitted.filter((e) => e.type === 'background_task');
    expect(snap).toMatchObject({ sessionId: 's-1', action: 'snapshot', generatedAt: 42, processes: [{ pid: 1 }] });
    expect(mon).toMatchObject({ sessionId: 's-1', action: 'monitors', monitors: [{ id: 'mon-1' }] });
  });

  it('名单外的事件类型会留下告警, 不再静默消失', () => {
    const { f } = makeForwarder();
    const t = `__probe_unknown_${Date.now()}__`;
    f.forward('s-1', { type: t, sessionId: 's-1' } as any, TRACKER);
    expect(warn.mock.calls.flat().join(' ')).toContain(t);
  });

  it('同一种未知类型只报一次 — 高频事件不刷屏', () => {
    const { f } = makeForwarder();
    const t = `__probe_repeat_${Date.now()}__`;
    for (let i = 0; i < 5; i++) f.forward('s-1', { type: t, sessionId: 's-1' } as any, TRACKER);
    const hits = warn.mock.calls.filter((c: any[]) => c.join(' ').includes(t));
    expect(hits.length).toBe(1);
  });
});
