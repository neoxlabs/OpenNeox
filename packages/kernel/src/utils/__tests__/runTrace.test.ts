import { describe, it, expect, afterEach } from 'vitest';
import {
  beginRun,
  endRun,
  runWithRunTrace,
  getCurrentRunTrace,
  withRunPhase,
  getActiveRunDiagnostics,
  getRuntimeDiagnostics,
  __resetRunTraceForTest,
  __activeRunCount,
} from '../runTrace.js';

describe('runTrace', () => {
  afterEach(() => {
    __resetRunTraceForTest();
  });

  it('begin/end registers and unregisters a run', () => {
    expect(__activeRunCount()).toBe(0);
    const t = beginRun({ sessionId: 's1', agentName: 'main' });
    expect(__activeRunCount()).toBe(1);
    expect(getActiveRunDiagnostics()[0].runId).toBe(t.runId);
    endRun(t, 'iteration_limit');
    expect(__activeRunCount()).toBe(0);
    expect(t.ended).toBe(true);
    expect(t.stopReason).toBe('iteration_limit');
  });

  it('endRun is idempotent and tolerates null', () => {
    const t = beginRun({ sessionId: 's1' });
    endRun(t);
    endRun(t);
    endRun(null);
    expect(__activeRunCount()).toBe(0);
  });

  it('supersedes an abandoned run on the same session', () => {
    const a = beginRun({ sessionId: 'sX' });
    expect(__activeRunCount()).toBe(1);
    // 用户发新消息 → 同 session 新 run,旧的被弃且没人 endRun
    const b = beginRun({ sessionId: 'sX' });
    expect(__activeRunCount()).toBe(1);
    expect(a.ended).toBe(true);
    expect(getActiveRunDiagnostics()[0].runId).toBe(b.runId);
  });

  it('different sessions coexist', () => {
    beginRun({ sessionId: 's1' });
    beginRun({ sessionId: 's2' });
    expect(__activeRunCount()).toBe(2);
  });

  it('tracks iteration and tool calls in snapshot', () => {
    const t = beginRun({ sessionId: 's1' });
    t.setIteration(5);
    t.incToolCalls();
    t.incToolCalls(2);
    const snap = t.snapshot();
    expect(snap.iteration).toBe(5);
    expect(snap.toolCalls).toBe(3);
  });

  it('push/pop phase builds the current location chain', () => {
    const t = beginRun({ sessionId: 's1' });
    t.setIteration(12);
    const idTool = t.pushPhase('tool', 'tool:edit_file');
    const idLock = t.pushPhase('lock', 'lock:/a.ts');
    let snap = t.snapshot();
    expect(snap.current).toBe('loop#12 › tool:edit_file › lock:/a.ts');
    expect(snap.frames).toHaveLength(2);
    t.popPhase(idLock);
    snap = t.snapshot();
    expect(snap.current).toBe('loop#12 › tool:edit_file');
    t.popPhase(idTool);
    expect(t.snapshot().frames).toHaveLength(0);
  });

  it('ALS: getCurrentRunTrace inside runWithRunTrace, undefined outside', async () => {
    const t = beginRun({ sessionId: 's1' });
    expect(getCurrentRunTrace()).toBeUndefined();
    await runWithRunTrace(t, async () => {
      expect(getCurrentRunTrace()).toBe(t);
      await withRunPhase('lock', 'lock:/x', async () => {
        expect(t.snapshot().current).toContain('lock:/x');
      });
      // withRunPhase 退出后帧已弹出
      expect(t.snapshot().frames).toHaveLength(0);
    });
    expect(getCurrentRunTrace()).toBeUndefined();
  });

  it('withRunPhase pops frame even when fn throws', async () => {
    const t = beginRun({ sessionId: 's1' });
    await expect(
      runWithRunTrace(t, () =>
        withRunPhase('tool', 'tool:boom', async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(t.snapshot().frames).toHaveLength(0);
  });

  it('withRunPhase degrades gracefully with no active run', async () => {
    const r = await withRunPhase('x', 'y', async () => 42);
    expect(r).toBe(42);
  });

  it('auto-links child run to parent via ALS (sub-agent / explore)', async () => {
    const parent = beginRun({ sessionId: 'main' });
    expect(parent.parentRunId).toBeUndefined();
    // 模拟: 子 agent 的 runner.run() 在父的 ALS 上下文里被消费 → beginRun 自动认父
    await runWithRunTrace(parent, async () => {
      const child = beginRun({ sessionId: 'explore_1', agentName: 'Explorer-1' });
      expect(child.parentRunId).toBe(parent.runId);
      endRun(child);
    });
    // 父子并存(不同 session),子结束后父仍在
    expect(parent.ended).toBe(false);
  });

  it('child reusing parent session does NOT supersede the parent', async () => {
    const parent = beginRun({ sessionId: 'shared' });
    await runWithRunTrace(parent, async () => {
      const child = beginRun({ sessionId: 'shared', agentName: 'sub' });
      expect(child.parentRunId).toBe(parent.runId);
      // 父没被 supersede(因为子有 parent)
      expect(parent.ended).toBe(false);
      expect(__activeRunCount()).toBe(2);
      endRun(child);
    });
  });

  it('getRuntimeDiagnostics aggregates runs + inflight shape', () => {
    beginRun({ sessionId: 's1' });
    const diag = getRuntimeDiagnostics();
    expect(Array.isArray(diag.runs)).toBe(true);
    expect(Array.isArray(diag.inflight)).toBe(true);
    expect(diag.runs).toHaveLength(1);
  });

  it('minAgeMs filters out fresh runs', () => {
    beginRun({ sessionId: 's1' });
    // 刚开的 run age≈0,被 1s 阈值过滤掉
    expect(getActiveRunDiagnostics(1000)).toHaveLength(0);
  });
});
