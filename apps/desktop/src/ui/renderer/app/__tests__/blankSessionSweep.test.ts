import { describe, it, expect } from 'vitest';
import { isRecyclableBlankSession, sweepCandidates, SWEEP_MIN_AGE_MS, type BlankSweepDeps } from '../blankSessionSweep';

const ID = 'session-1790211672689-77abc';
const deps = (over: Partial<BlankSweepDeps> & { session?: any } = {}): BlankSweepDeps => ({
  getSession: async () => ('session' in over ? over.session : { name: 'New Chat - 18:01:02', kind: 'chat', messageCount: 0, messages: [] }),
  memoryTimelineLength: () => 0,
  loadTimelineLength: async () => 0,
  isBusy: () => false,
  ...over,
});

describe('isRecyclableBlankSession', () => {
  it('新建按钮建的、自动名字、真空 → 回收', async () => {
    expect(await isRecyclableBlankSession(ID, deps())).toBe(true);
    expect(await isRecyclableBlankSession(ID, deps({ session: { name: '工作·9月23日', kind: 'chat' } }))).toBe(true);
  });
  /* 第一版删过 Explorer-1..6 (子 agent, 内容存在别处) 和几条老会话 */
  it('不是普通会话 id / 用户改过名 → 不删, 哪怕看着是空的', async () => {
    expect(await isRecyclableBlankSession('Explorer-3', deps())).toBe(false);
    expect(await isRecyclableBlankSession(ID, deps({ session: { name: '子 Agent Explorer', kind: 'chat' } }))).toBe(false);
    expect(await isRecyclableBlankSession(ID, deps({ session: { name: '季度预算', kind: 'chat' } }))).toBe(false);
  });
  it('发出去就失败的那一轮: messageCount 没回填, 但 timeline 里有 → 不删', async () => {
    expect(await isRecyclableBlankSession(ID, deps({ memoryTimelineLength: () => 1 }))).toBe(false);
    expect(await isRecyclableBlankSession(ID, deps({ loadTimelineLength: async () => 3 }))).toBe(false);
  });
  it('有消息的 → 不删', async () => {
    expect(await isRecyclableBlankSession(ID, deps({ session: { kind: 'chat', messageCount: 2 } }))).toBe(false);
    expect(await isRecyclableBlankSession(ID, deps({ session: { kind: 'chat', messages: [{}] } }))).toBe(false);
  });
  it('图片会话 / 置顶 / 正在跑 / 查不到 → 不删', async () => {
    expect(await isRecyclableBlankSession(ID, deps({ session: { kind: 'image' } }))).toBe(false);
    expect(await isRecyclableBlankSession(ID, deps({ session: { kind: 'chat', pinned: true } }))).toBe(false);
    expect(await isRecyclableBlankSession(ID, deps({ isBusy: () => true }))).toBe(false);
    expect(await isRecyclableBlankSession(ID, deps({ session: null }))).toBe(false);
  });
  it('查磁盘这会儿刚发了第一句 → 不删', async () => {
    let n = 0;
    expect(await isRecyclableBlankSession(ID, deps({ memoryTimelineLength: () => (n++ === 0 ? 0 : 1) }))).toBe(false);
  });
});

describe('sweepCandidates (启动扫)', () => {
  const now = 10_000_000;
  it('当前会话、刚建的、有消息的、图片会话都不进候选', () => {
    const ids = sweepCandidates([
      { id: 'session-1000000001-a', name: 'New Chat - 1', createdAt: 0, messageCount: 0 },
      { id: 'session-1000000002-b', name: 'New Chat - 2', createdAt: now - 5_000, messageCount: 0 },
      { id: 'session-1000000003-c', name: 'New Chat - 3', createdAt: 0, messageCount: 4 },
      { id: 'session-1000000004-d', name: 'New Chat - 4', createdAt: 0, kind: 'image', messageCount: 0 },
      { id: 'Explorer-1', name: '子 Agent Explorer', createdAt: 0, messageCount: 0 },
      { id: 'session-1000000005-e', name: '季度预算', createdAt: 0, messageCount: 0 },
      { id: 'session-1000000006-f', name: 'New Chat - 6', createdAt: now - SWEEP_MIN_AGE_MS - 1, messageCount: 0 },
    ], 'session-1000000001-a', now);
    expect(ids).toEqual(['session-1000000006-f']);
  });
});
