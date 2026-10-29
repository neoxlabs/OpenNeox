/**
 * pickStatus 优先级矩阵单测 — 固化 B7 修复 (subagent error 提到 pending 前).
 *
 * 防止 "agentStatus='error' + pending=true → 'running' (掩盖错误)" 这类回归.
 */

import { describe, expect, test } from 'vitest';
import { pickStatus } from '../mapTimeline';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

function e(extra: Partial<TimelineEntry> & Record<string, unknown>): TimelineEntry {
  return {
    id: 't',
    type: 'tool_call',
    timestamp: 0,
    ...extra,
  } as TimelineEntry;
}

describe('pickStatus 优先级矩阵 (B7 2026-06-28)', () => {
  test('① interrupted → "interrupted" (即便 pending=true)', () => {
    expect(pickStatus(e({ interrupted: true, pending: true }))).toBe('interrupted');
    expect(pickStatus(e({ errorReason: 'interrupted', pending: true }))).toBe('interrupted');
  });

  test('② type=tool_error / runner_error → "failed"', () => {
    expect(pickStatus(e({ type: 'tool_error' }))).toBe('failed');
    expect(pickStatus(e({ type: 'runner_error' }))).toBe('failed');
  });

  test('③ errorCode / errorMessage → "failed"', () => {
    expect(pickStatus(e({ errorCode: 'X' }))).toBe('failed');
    expect(pickStatus(e({ errorMessage: 'bad' }))).toBe('failed');
  });

  test('④ level=error → "failed"', () => {
    expect(pickStatus(e({ level: 'error' }))).toBe('failed');
  });

  test('⑤ success=false → "failed"', () => {
    expect(pickStatus(e({ success: false }))).toBe('failed');
  });

  test('⑥ edit_file 完成判定 (editIsComplete + !editStreaming) → "done"', () => {
    expect(pickStatus(e({
      type: 'edit_file',
      editIsComplete: true,
      editStreaming: false,
    }))).toBe('done');
  });

  test('⑦ B7 核心: agentStatus=error + pending=true → "failed" (旧实现会错判 running)', () => {
    expect(pickStatus(e({ agentStatus: 'error', pending: true }))).toBe('failed');
  });

  test('⑦ workerStatus=failed + pending=true → "failed"', () => {
    expect(pickStatus(e({ workerStatus: 'failed', pending: true }))).toBe('failed');
  });

  test('⑦ exploreStatus=error + pending=true → "failed"', () => {
    expect(pickStatus(e({ exploreStatus: 'error', pending: true }))).toBe('failed');
  });

  test('⑦ delegationStatus=error + pending=true → "failed"', () => {
    expect(pickStatus(e({ delegationStatus: 'error', pending: true }))).toBe('failed');
  });

  test('⑧ pending=true + awaitingApproval=true → "awaiting"', () => {
    expect(pickStatus(e({ pending: true, awaitingApproval: true }))).toBe('awaiting');
  });

  test('⑧ pending=true 单独 → "running"', () => {
    expect(pickStatus(e({ pending: true }))).toBe('running');
  });

  test('⑨ agentStatus=running (无 pending) → "running"', () => {
    expect(pickStatus(e({ agentStatus: 'running' }))).toBe('running');
  });

  test('⑨ workerStatus=running (无 pending) → "running"', () => {
    expect(pickStatus(e({ workerStatus: 'running' }))).toBe('running');
  });

  test('⑩ 默认 → "done"', () => {
    expect(pickStatus(e({}))).toBe('done');
  });
});
