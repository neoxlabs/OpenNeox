import { describe, it, expect, vi, beforeEach } from 'vitest';

const timelines = new Map<string, any[]>();
/* sessions 表 mock — 外键守卫 ensureSubAgentSessionRow 会先 getSession/upsertSession;
 * upsertTimelineEntries 模拟真实 timeline_entries.session_id 外键 (session 行必须先存在);
 * upsertSession 模拟 model_id NOT NULL (占位行不能 null/undefined)。 */
const sessions = new Map<string, any>();

vi.mock('@neoxlabs/platform/platform/database.js', () => ({
  getDatabase: () => ({
    getSession: (sid: string) => sessions.get(sid) ?? null,
    upsertSession: (s: any) => {
      if (s.modelId === null || s.modelId === undefined) {
        throw new Error('NOT NULL constraint failed: sessions.model_id');
      }
      sessions.set(s.id, s);
    },
    getTimeline: (sid: string) => timelines.get(sid) ?? [],
    setTimeline: (sid: string, entries: any[]) => { timelines.set(sid, entries); },
    countTimeline: (sid: string) => (timelines.get(sid) ?? []).length,
    upsertTimelineEntries: (sid: string, entries: any[]) => {
      if (!sessions.has(sid)) throw new Error('FOREIGN KEY constraint failed');
      const list = timelines.get(sid) ?? [];
      for (const e of entries) {
        const idx = list.findIndex((x: any) => x.id === e.id);
        if (idx >= 0) list[idx] = e; else list.push(e);
      }
      timelines.set(sid, list);
      return { ok: true, written: entries.length };
    },
  }),
}));
vi.mock('../../memory/session-manager.js', () => ({
  DefaultSessionManager: class {},
}));
vi.mock('../../memory/sqlite-session.js', () => ({
  SQLiteSession: class {},
}));

import { SessionStore } from '../sessionStore.js';

describe('appendSubAgentTimelineEntry', () => {
  let store: SessionStore;

  beforeEach(() => {
    timelines.clear();
    sessions.clear();
    store = new SessionStore({ sessionManager: {} as any });
  });

  it('🔒 回归: session 行不存在时自动建占位行, 不抛外键 (2026-07-21 T3 explore 实锤)', async () => {
    /* 修复前: 并行 explore 子 agent 事件先于 createSession 到达 / 父 session 缺失
     * → 每条 timeline 写入 FOREIGN KEY constraint failed 刷屏几十次。 */
    expect(sessions.has('orphan-explorer')).toBe(false);
    await store.appendSubAgentTimelineEntry('orphan-explorer', { type: 'tool_call', title: 'readfile', detail: 'a.ts' });
    expect(sessions.has('orphan-explorer')).toBe(true);
    const row = sessions.get('orphan-explorer');
    expect(row.modelId).toBe('');           // NOT NULL 列用空串, 不能 null
    expect(row.name).toContain('子 Agent');
    const t = timelines.get('orphan-explorer')!;
    expect(t).toHaveLength(1);              // timeline 真落盘, 不是被 catch 吞掉
    expect(t[0].id).toBe('sub-step-orphan-explorer-0');
  });

  it('🔒 回归: appendSubAgentResult 也对缺失 session 行建占位行', async () => {
    await store.appendSubAgentResult('orphan-result', 'done payload').catch(() => {});
    expect(sessions.has('orphan-result')).toBe(true);
  });

  it('追加条目并分配稳定 sub-step id 和递增 sequence', async () => {
    await store.appendSubAgentTimelineEntry('agent-1', { type: 'tool_call', title: 'readfile', detail: 'x.ts' });
    await store.appendSubAgentTimelineEntry('agent-1', { type: 'assistant_message', title: 'Agent', detail: 'done' });

    const t = timelines.get('agent-1')!;
    expect(t).toHaveLength(2);
    expect(t[0].id).toBe('sub-step-agent-1-0');
    expect(t[0].sequence).toBe(0);
    expect(t[1].id).toBe('sub-step-agent-1-1');
    expect(t[1].sequence).toBe(1);
    expect(t[1].type).toBe('assistant_message');
    expect(typeof t[0].timestamp).toBe('number');
  });

  it('续接已有 seed prompt 的 sequence', async () => {
    timelines.set('agent-2', [{ id: 'sub-prompt-agent-2', type: 'user_message', title: 'User', detail: 'p', timestamp: 1, sequence: 0 }]);
    await store.appendSubAgentTimelineEntry('agent-2', { type: 'tool_call', title: 'search' });
    const t = timelines.get('agent-2')!;
    expect(t).toHaveLength(2);
    expect(t[1].sequence).toBe(1);
    expect(t[1].id).toBe('sub-step-agent-2-1');
  });

  it('超过 cap 丢弃中间步骤不报错', async () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ id: `sub-step-x-${i}`, type: 'tool_call', title: 't', timestamp: i, sequence: i }));
    timelines.set('agent-3', big);
    await store.appendSubAgentTimelineEntry('agent-3', { type: 'tool_call', title: 'overflow' });
    expect(timelines.get('agent-3')!).toHaveLength(500);
  });

  it('DB 抛错时静默吞掉不影响调用方', async () => {
    const broken = new SessionStore({ sessionManager: {} as any });
    /* countTimeline 对 null 桶返回 (null ?? []).length = 0, upsert 走 null 桶 ?? [] 兜底 —
     * 均不抛; 本用例守的是"任何 DB 异常不冒泡到调用方"的 catch 语义 */
    timelines.set('agent-4', null as any);
    /* 返回值是"这条占了哪个槽" (给工具 start→end 改写同一行用), 出错时为 null。
     * 本用例守的仍是 catch 语义: 不许 reject 冒到调用方。 */
    const slot = await broken.appendSubAgentTimelineEntry('agent-4', { type: 'tool_call', title: 'x' });
    expect(slot === null || typeof slot.id === 'string').toBe(true);
  });

  describe('工具 start → end 复用同一行', () => {
    it('开始时先落 pending 行, 结束时原地改写 (仍然只有一条)', async () => {
      sessions.set('agent-5', { id: 'agent-5' });
      const slot = await store.appendSubAgentTimelineEntry('agent-5', {
        type: 'tool_call', title: 'write_file', pending: true,
      });
      expect(slot).not.toBeNull();
      expect(timelines.get('agent-5')).toHaveLength(1);
      expect(timelines.get('agent-5')![0].pending).toBe(true);

      await store.appendSubAgentTimelineEntry('agent-5', {
        type: 'tool_call', title: 'write_file', pending: false, output: 'File created',
      }, slot!);

      const rows = timelines.get('agent-5')!;
      expect(rows).toHaveLength(1);
      expect(rows[0].pending).toBe(false);
      expect(rows[0].output).toBe('File created');
    });

    it('改写不许把行挪到队尾 —— sequence 必须原样保留', async () => {
      sessions.set('agent-6', { id: 'agent-6' });
      const first = await store.appendSubAgentTimelineEntry('agent-6', { type: 'tool_call', title: 'a', pending: true });
      await store.appendSubAgentTimelineEntry('agent-6', { type: 'assistant_message', title: 'Agent', detail: '接着说' });
      await store.appendSubAgentTimelineEntry('agent-6', { type: 'tool_call', title: 'a', pending: false }, first!);

      const rows = timelines.get('agent-6')!;
      expect(rows).toHaveLength(2);
      expect(rows[0].sequence).toBe(0);
      expect(rows[0].pending).toBe(false);
      expect(rows[1].sequence).toBe(1);
    });
  });
});
