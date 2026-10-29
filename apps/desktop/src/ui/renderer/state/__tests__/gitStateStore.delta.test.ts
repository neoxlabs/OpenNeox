import { describe, expect, it, beforeEach, vi } from 'vitest';

type Listener = (p: unknown) => void;

function setup(initial: any) {
  let push: Listener | null = null;
  const calls: string[] = [];
  let snapshot = initial;
  (globalThis as any).window = {
    neox: {
      gitStatusSubscribe: async (cwd: string) => { calls.push(`sub:${cwd}`); return snapshot; },
      gitStatusUnsubscribe: async (cwd: string) => { calls.push(`unsub:${cwd}`); },
      gitStatus: async () => { calls.push('snapshot'); return snapshot; },
      gitStatusRevalidate: async (_cwd: string, fresh: boolean) => { calls.push(`revalidate:${fresh}`); },
      onGitStatusChanged: (fn: Listener) => { push = fn; return () => { push = null; }; },
    },
  };
  return {
    calls,
    push: (p: unknown) => push?.(p),
    setSnapshot: (s: any) => { snapshot = s; },
    hasPushListener: () => push !== null,
  };
}

const ROOT = '/repo';
const f = (path: string, area: string, extra: Record<string, unknown> = {}) =>
  ({ path, area, indexStatus: area === 'staged' ? 'M' : area === 'untracked' ? '?' : ' ', worktreeStatus: area === 'unstaged' ? 'M' : area === 'untracked' ? '?' : ' ', ...extra });
const snap = (version: number, files: any[], extra: Record<string, unknown> = {}) =>
  ({ branch: 'main', ahead: 0, behind: 0, root: ROOT, unavailableReason: '', files, version, ...extra });
const summary = (extra: Record<string, unknown> = {}) =>
  ({ branch: 'main', ahead: 0, behind: 0, root: ROOT, unavailableReason: '', version: 0, fileCount: 0, ...extra });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function freshStore() {
  vi.resetModules();
  return import('../gitStateStore');
}

beforeEach(() => { delete (globalThis as any).window; });

describe('增量合并', () => {
  it('增 / 改 / 删 合并正确, 顺序与整份一致', async () => {
    const env = setup(snap(1, [f('b.ts', 'unstaged', { add: 1 }), f('c.ts', 'untracked')]));
    const store = await freshStore();
    const states: any[] = [];
    const unsub = store.subscribeGitState(ROOT, (s) => states.push(s));
    await flush();
    expect(store.peekGitState(ROOT).files.map((x) => x.path)).toEqual(['b.ts', 'c.ts']);

    env.push({
      cwds: [ROOT], root: ROOT, version: 2, prevVersion: 1,
      summary: summary({ ahead: 3 }),
      delta: { upserts: [f('a.ts', 'staged'), f('b.ts', 'unstaged', { add: 9 })], removes: ['untracked\0c.ts'] },
    });
    const s = store.peekGitState(ROOT);
    expect(s.files.map((x) => `${x.area}:${x.path}:${x.add ?? ''}`)).toEqual(['staged:a.ts:', 'unstaged:b.ts:9']);
    expect(s.ahead).toBe(3);
    expect(s.status?.version).toBe(2);
    unsub();
  });

  it('版本号接不上 → 重拿整份; 旧推送丢弃', async () => {
    const env = setup(snap(1, [f('a.ts', 'unstaged')]));
    const store = await freshStore();
    const unsub = store.subscribeGitState(ROOT, () => {});
    await flush();

    /* 漏了 v2, 直接来 v3 */
    env.setSnapshot(snap(3, [f('z.ts', 'untracked')]));
    env.push({ cwds: [ROOT], root: ROOT, version: 3, prevVersion: 2, summary: summary(), delta: { upserts: [f('WRONG', 'staged')], removes: [] } });
    await flush();
    expect(env.calls).toContain('snapshot');
    expect(store.peekGitState(ROOT).files.map((x) => x.path)).toEqual(['z.ts']);

    /* 迟到的 v2 */
    env.push({ cwds: [ROOT], root: ROOT, version: 2, prevVersion: 1, summary: summary(), delta: { upserts: [f('LATE', 'staged')], removes: [] } });
    expect(store.peekGitState(ROOT).files.map((x) => x.path)).toEqual(['z.ts']);
    unsub();
  });
});

describe('角标', () => {
  it('只通知真变了的路径; 暂存+未暂存合成一个角标 (工作区优先)', async () => {
    const env = setup(snap(1, [f('a.ts', 'staged'), f('b.ts', 'untracked')]));
    const store = await freshStore();
    const unsub = store.retainGitRepo(ROOT);
    await flush();
    let aHits = 0;
    let bHits = 0;
    const ua = store.subscribeGitBadge(ROOT, `${ROOT}/a.ts`, () => { aHits++; });
    const ub = store.subscribeGitBadge(ROOT, `${ROOT}/b.ts`, () => { bHits++; });
    expect(store.getGitBadge(ROOT, `${ROOT}/a.ts`)).toBe('M');
    expect(store.getGitBadge(ROOT, `${ROOT}/b.ts`)).toBe('U');

    env.push({
      cwds: [ROOT], root: ROOT, version: 2, prevVersion: 1, summary: summary(),
      delta: { upserts: [f('a.ts', 'unstaged', { worktreeStatus: 'D' })], removes: [] },
    });
    expect(store.getGitBadge(ROOT, `${ROOT}/a.ts`)).toBe('D');
    expect(aHits).toBe(1);
    expect(bHits).toBe(0);

    env.push({
      cwds: [ROOT], root: ROOT, version: 3, prevVersion: 2, summary: summary(),
      delta: { upserts: [], removes: ['untracked\0b.ts'] },
    });
    expect(store.getGitBadge(ROOT, `${ROOT}/b.ts`)).toBeUndefined();
    expect(bHits).toBe(1);
    ua(); ub(); unsub();
  });
});

describe('生命周期', () => {
  it('多个使用者共享一条主进程订阅; 最后一个走了才退订', async () => {
    const env = setup(snap(1, []));
    const store = await freshStore();
    const u1 = store.subscribeGitState(ROOT, () => {});
    const u2 = store.retainGitRepo(ROOT);
    const u3 = store.subscribeGitStatusChanges(ROOT, () => {});
    await flush();
    expect(env.calls.filter((c) => c.startsWith('sub:'))).toEqual([`sub:${ROOT}`]);
    u1(); u2();
    await flush();
    expect(env.calls.some((c) => c.startsWith('unsub:'))).toBe(false);
    u3();
    await flush();
    expect(env.calls.filter((c) => c.startsWith('unsub:'))).toEqual([`unsub:${ROOT}`]);
    expect(env.hasPushListener()).toBe(false);
  });

  it('refreshGitState 走 fresh 复核, 不拉整份', async () => {
    const env = setup(snap(1, []));
    const store = await freshStore();
    await store.refreshGitState(ROOT);
    expect(env.calls).toEqual(['revalidate:true']);
  });

  it('没有 git 状态 API 的宿主: 明确报错, 不假装"不是仓库"', async () => {
    (globalThis as any).window = { neox: {} };
    const store = await freshStore();
    const unsub = store.subscribeGitState(ROOT, () => {});
    expect(store.peekGitState(ROOT).error).toMatch(/unavailable/);
    unsub();
  });
});
