import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessions = new Map<string, any>();
const timelines = new Map<string, any[]>();

/* DB mock 复刻两条真实约束: timeline_entries 的外键, 和 sessions.model_id NOT NULL。
 * upsertSession 的 ON CONFLICT 语义也要照抄 —— "正规创建能覆盖占位行"整条修法都靠它。 */
vi.mock('@neoxlabs/platform/platform/database.js', () => ({
  getDatabase: () => ({
    getSession: (sid: string) => sessions.get(sid) ?? null,
    upsertSession: (s: any) => {
      if (s.modelId === null || s.modelId === undefined) {
        throw new Error('NOT NULL constraint failed: sessions.model_id');
      }
      const prev = sessions.get(s.id);
      sessions.set(s.id, prev ? { ...prev, ...s } : s);
    },
    getTimeline: (sid: string) => timelines.get(sid) ?? [],
    setTimeline: (sid: string, e: any[]) => { timelines.set(sid, e); },
    countTimeline: (sid: string) => (timelines.get(sid) ?? []).length,
    upsertTimelineEntries: (sid: string, entries: any[]) => {
      if (!sessions.has(sid)) throw new Error('FOREIGN KEY constraint failed');
      const list = timelines.get(sid) ?? [];
      list.push(...entries);
      timelines.set(sid, list);
      return { ok: true, written: entries.length };
    },
  }),
}));
/* SessionStore.createSession 会经 sessionManager 建 SQLiteSession (写 meta entry)。
 * 这里只关心 sessions 表那一行长什么样, 存储层给个不落盘的空实现。 */
vi.mock('../../memory/session-manager.js', () => ({
  DefaultSessionManager: class {
    async createSession() { return {}; }
    async getSession() { return null; }
  },
}));
vi.mock('../../memory/sqlite-session.js', () => ({
  SQLiteSession: class {
    async addItems() { /* noop */ }
    async getItems() { return []; }
  },
}));

const PARENT = 'session-parent-1';
const CHILD = 'agent-child-1';
const WS = '/Users/me/proj';
const WORKDIR = '/Users/me/proj';

let store: any;
let resolveSubAgentSessionOrigin: any;

beforeEach(async () => {
  sessions.clear();
  timelines.clear();
  vi.resetModules();
  store = (await import('../sessionStore.js')).sessionStore;
  ({ resolveSubAgentSessionOrigin } = await import('../subAgentSessionOrigin.js'));
  sessions.set(PARENT, { id: PARENT, workspacePath: WS, modelId: 'm1' });
});

/** 复刻 server 'started' 分支做的两件事: 登记归属 + 正规建行。 */
async function simulateStarted(parent: any, info: any = { agentId: CHILD, model: 'm2' }) {
  const origin = resolveSubAgentSessionOrigin({ info, parentSessionId: PARENT, parent, workDir: WORKDIR });
  store.rememberSubAgentParent(origin.sessionId, PARENT, origin.workspacePath);
  await store.createSession({
    sessionId: origin.sessionId,
    workspacePath: origin.workspacePath,
    modelId: origin.modelId,
    name: origin.name,
    parentSessionId: origin.parentSessionId,
    initialUserMessage: origin.initialUserMessage,
  });
  return origin;
}

const isOrphan = (sid: string) => {
  const row = sessions.get(sid);
  return !row?.parentSessionId || !row?.workspacePath;
};

describe('时序 A —— 占位行先到 (timeline 事件抢在 started 前面)', () => {
  it('还没登记归属时占位行确实是孤儿 (基线, 说明这条路径真的会产生孤儿)', async () => {
    await store.appendSubAgentTimelineEntry(CHILD, { type: 'tool', title: 'read' });
    expect(sessions.has(CHILD)).toBe(true);
    expect(isOrphan(CHILD)).toBe(true);
  });

  it('随后 started 到达, 占位行被 upsert 修正, 不再是孤儿', async () => {
    await store.appendSubAgentTimelineEntry(CHILD, { type: 'tool', title: 'read' });
    await simulateStarted(sessions.get(PARENT));
    expect(isOrphan(CHILD)).toBe(false);
    expect(sessions.get(CHILD).parentSessionId).toBe(PARENT);
    expect(sessions.get(CHILD).workspacePath).toBe(WS);
  });

  it('修正不能把已经写进去的 timeline 冲掉', async () => {
    await store.appendSubAgentTimelineEntry(CHILD, { type: 'tool', title: 'read' });
    await simulateStarted(sessions.get(PARENT));
    expect((timelines.get(CHILD) ?? []).length).toBe(1);
  });
});

describe('时序 B —— started 先到 (归属已登记, 占位行随后才写)', () => {
  it('占位行直接带上父和工作区, 一秒都不进 Unlinked', async () => {
    store.rememberSubAgentParent(CHILD, PARENT, WS);
    sessions.delete(CHILD);                       // 只留提示, 模拟行还没建
    await store.appendSubAgentTimelineEntry(CHILD, { type: 'tool', title: 'read' });
    expect(isOrphan(CHILD)).toBe(false);
    expect(sessions.get(CHILD).parentSessionId).toBe(PARENT);
    expect(sessions.get(CHILD).workspacePath).toBe(WS);
  });

  it('正规创建已经建过行时, 占位是幂等的, 不覆盖名字/模型', async () => {
    await simulateStarted(sessions.get(PARENT));
    const before = { ...sessions.get(CHILD) };
    await store.appendSubAgentTimelineEntry(CHILD, { type: 'tool', title: 'read' });
    expect(sessions.get(CHILD).name).toBe(before.name);
    expect(sessions.get(CHILD).modelId).toBe(before.modelId);
  });
});

describe('父会话查不到 —— 原来 `if (!parent) return` 直接放弃, 孤儿就是这么留下的', () => {
  it('照样建行, workspace 退到 workDir, 父子关系仍然记得住', async () => {
    const origin = await simulateStarted(null);
    expect(origin.usedWorkDirFallback).toBe(true);
    expect(isOrphan(CHILD)).toBe(false);
    expect(sessions.get(CHILD).workspacePath).toBe(WORKDIR);
    expect(sessions.get(CHILD).parentSessionId).toBe(PARENT);
  });

  it('父查不到 + 占位行先到, 两个坑一起踩也不留孤儿', async () => {
    await store.appendSubAgentTimelineEntry(CHILD, { type: 'tool', title: 'read' });
    expect(isOrphan(CHILD)).toBe(true);
    await simulateStarted(null);
    expect(isOrphan(CHILD)).toBe(false);
  });
});

describe('resolveSubAgentSessionOrigin 的取值规则', () => {
  const call = (info: any, parent: any) =>
    resolveSubAgentSessionOrigin({ info, parentSessionId: PARENT, parent, workDir: WORKDIR });

  it('modelId 优先用子 agent 自己的 —— 落父的会显示成错的模型, 比缺失更糟', () => {
    expect(call({ agentId: CHILD, model: 'm2' }, { workspacePath: WS, modelId: 'm1' }).modelId).toBe('m2');
  });

  it('子没指定模型才继承父', () => {
    expect(call({ agentId: CHILD }, { workspacePath: WS, modelId: 'm1' }).modelId).toBe('m1');
  });

  it('两边都没有时给空串 —— model_id 是 NOT NULL, 不能是 undefined', () => {
    const o = call({ agentId: CHILD }, null);
    expect(o.modelId).toBe('');
  });

  it('description 缺失不许炸 (后台 worker 不带这个字段)', () => {
    expect(() => call({ agentId: CHILD }, null)).not.toThrow();
    expect(call({ agentId: CHILD }, null).name).toContain('子 Agent');
  });

  it('name 优先级: name > description 截断 > 兜底', () => {
    expect(call({ agentId: CHILD, name: 'N' }, null).name).toBe('N');
    expect(call({ agentId: CHILD, description: 'D'.repeat(60) }, null).name).toHaveLength(40);
  });

  it('父存在但 workspace 是空串时也走 workDir 兜底 —— 空 workspace 就是 Unlinked 的定义', () => {
    const o = call({ agentId: CHILD }, { workspacePath: '', modelId: 'm1' });
    expect(o.workspacePath).toBe(WORKDIR);
    expect(o.usedWorkDirFallback).toBe(true);
  });

  it('父有 workspace 时绝不动用 workDir', () => {
    const o = resolveSubAgentSessionOrigin({
      info: { agentId: CHILD }, parentSessionId: PARENT,
      parent: { workspacePath: '/real/parent/ws' }, workDir: '/some/other/dir',
    });
    expect(o.workspacePath).toBe('/real/parent/ws');
    expect(o.usedWorkDirFallback).toBe(false);
  });
});
