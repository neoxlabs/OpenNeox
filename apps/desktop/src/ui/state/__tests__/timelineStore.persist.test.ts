import { beforeEach, describe, expect, test, vi } from 'vitest';
import { __persistTestSurface as S, flushPendingWrites } from '../timelineStore';
import type { TimelineEntry } from '../../renderer/utils/workspaceUtils';

const SID = 'sess-persist';
const entry = (id: string): TimelineEntry =>
  ({ id, type: 'assistant_message', title: id, timestamp: 1, sequence: 1 } as unknown as TimelineEntry);
const anomalyEntry = (id: string): TimelineEntry =>
  ({ id, type: 'runner_error', title: id, timestamp: 1, sequence: 1 } as unknown as TimelineEntry);

type Upsert = (sid: string, items: TimelineEntry[]) => Promise<{ ok: boolean }>;
let upsert: ReturnType<typeof vi.fn<Upsert>>;

beforeEach(() => {
  S.pendingWrites.clear();
  S.deletedTombstones.clear();
  S.clearGenerations.clear();
  upsert = vi.fn<Upsert>(async () => ({ ok: true }));
  (globalThis as any).window = {
    neox: { timelineUpsertBatch: upsert, timelinePage: async () => ({ ok: true, entries: [] }) },
  };
});

const flushedIds = () => upsert.mock.calls.flatMap(([, items]) => items.map((e) => e.id));

describe('timelineStore · 删除追上未落盘的写', () => {
  test('入队后被删的条目不会被 flush 写回真源', async () => {
    S.queueWrite(SID, entry('err-A'));
    S.queueWrite(SID, entry('keep'));
    S.dequeueWrite(SID, 'err-A');
    await flushPendingWrites();
    expect(flushedIds()).toEqual(['keep']);
  });

  test('flush 正在 await 上一批时发生的删除, 后一批也追得上', async () => {
    /* 401 条: 第 401 条落在第二批。第一批 IPC 挂起时删掉它。 */
    for (let i = 0; i < 401; i++) S.queueWrite(SID, entry(`e-${i}`));
    let release!: () => void;
    upsert.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true }); }));
    const flushing = flushPendingWrites();
    await Promise.resolve();
    S.dequeueWrite(SID, 'e-400');
    release();
    await flushing;
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(flushedIds()).not.toContain('e-400');
    expect(flushedIds()).toHaveLength(400);
  });

  test('同 id 再次入队 = 合法复活 (错误卡 id 按轮稳定, 重试再失败要能重新落地)', async () => {
    S.queueWrite(SID, entry('err-A'));
    S.dequeueWrite(SID, 'err-A');
    S.queueWrite(SID, entry('err-A'));
    await flushPendingWrites();
    expect(flushedIds()).toEqual(['err-A']);
    expect(S.deletedTombstones.get(SID)?.has('err-A')).toBe(false);
  });

  test('对照组: 没删过的条目照常落盘 (闸本身能亮绿)', async () => {
    S.queueWrite(SID, entry('a'));
    S.queueWrite(SID, entry('b'));
    await flushPendingWrites();
    expect(flushedIds()).toEqual(['a', 'b']);
  });
});

describe('timelineStore · 清空追得上飞行中的 flush', () => {
  test('flush 挂在第一批时清空 → 后续批次全部丢弃, 不写回真源', async () => {
    for (let i = 0; i < 401; i++) S.queueWrite(SID, entry(`e-${i}`));
    let release!: () => void;
    upsert.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true }); }));
    const flushing = flushPendingWrites();
    await Promise.resolve();
    /* 用户此刻点了「清空会话」 */
    S.bumpClearGeneration(SID);
    release();
    await flushing;
    /* 第一批已经在路上拦不住 (IPC 已发出), 但第二批必须被丢掉 —— 关键是**不再有新的写** */
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(flushedIds()).toHaveLength(400);
    expect(flushedIds()).not.toContain('e-400');
  });

  test('清空后写失败也不许重排队 —— 重排等于换个时机再复活一次', async () => {
    for (let i = 0; i < 10; i++) S.queueWrite(SID, entry(`e-${i}`));
    upsert.mockImplementationOnce(async () => {
      S.bumpClearGeneration(SID);          /* 写的过程中被清空 */
      return { ok: false } as any;
    });
    await flushPendingWrites();
    expect(S.pendingWrites.get(SID) ?? []).toHaveLength(0);
  });

  test('对照组: 没清空过就照常落盘 + 失败照常重排队', async () => {
    S.queueWrite(SID, entry('a'));
    await flushPendingWrites();
    expect(flushedIds()).toEqual(['a']);
  });
});

describe('timelineStore · 异常态不落盘', () => {
  test('错误卡入队即被丢弃, 不写真源', async () => {
    S.queueWrite(SID, anomalyEntry('timeline-error-msg-u1-RUNTIME_ERROR'));
    expect(S.pendingWrites.get(SID) ?? []).toHaveLength(0);
    await flushPendingWrites();
    expect(flushedIds()).toEqual([]);
  });

  test('「已停止」notice 同样不落盘', async () => {
    S.queueWrite(SID, ({ id: 'timeline-interrupted-msg-u1', type: 'log', title: '已停止', timestamp: 1 } as unknown as TimelineEntry));
    await flushPendingWrites();
    expect(flushedIds()).toEqual([]);
  });

  test('正文照常落盘 —— 闸只挡异常态, 别把对话一起挡了', async () => {
    S.queueWrite(SID, entry('keep-me'));
    S.queueWrite(SID, anomalyEntry('timeline-error-x-A'));
    await flushPendingWrites();
    expect(flushedIds()).toEqual(['keep-me']);
  });
});
