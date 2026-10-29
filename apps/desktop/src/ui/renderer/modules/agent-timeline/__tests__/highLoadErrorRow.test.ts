
import { describe, expect, test } from 'vitest';
import { mapTimelineEntriesToRows } from '../mapTimelineToRows';
import { rowStepToTimelineStep } from '../timelineRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

function highLoadEntry(): TimelineEntry {
  return {
    id: 'err-busy',
    type: 'runner_error',
    title: '当前使用人数较多',
    timestamp: 10,
    level: 'warning',
    errorCode: 'system.busy',
    errorMessage: '当前使用人数较多',
    errorRequestId: 'a1b2c3d4e5f60718',
    errorAction: { kind: 'switch_model', label: '换个模型' },
  } as unknown as TimelineEntry;
}

function errorRow(entry: TimelineEntry) {
  const rows = mapTimelineEntriesToRows([entry]);
  return rows.find((r) => (r as { cell?: { subtype?: string } }).cell?.subtype === 'error') as any;
}

describe('高负载错误行', () => {
  test('requestId 走到 ErrorView 的 payload 里 (报障能对上 request_logs)', () => {
    const row = errorRow(highLoadEntry());
    expect(row).toBeTruthy();
    expect(row.cell.payload.requestId).toBe('a1b2c3d4e5f60718');
  });

  test('BYOK 直连没有 requestId 时不该凭空造一个', () => {
    const row = errorRow({
      id: 'err-byok', type: 'runner_error', timestamp: 10,
      errorCode: 'auth.invalid_key', errorMessage: 'API 密钥被拒绝',
    } as unknown as TimelineEntry);
    expect(row.cell.payload.requestId).toBeUndefined();
  });

  test('tone=busy 一路传到 TimelineStep —— 否则红色"失败"pill 又回来了', () => {
    const row = errorRow(highLoadEntry());
    expect(row.tone).toBe('busy');
    expect(rowStepToTimelineStep(row).tone).toBe('busy');
  });

  test('高负载标题不叫「执行器错误」', () => {
    expect(errorRow(highLoadEntry()).title).toBe('服务繁忙');
  });

  test('普通错误保持原样: 没有 tone, 标题仍是通用失败标题', () => {
    const row = errorRow({
      id: 'err-plain', type: 'runner_error', timestamp: 10,
      errorCode: 'auth.invalid_key', errorMessage: 'API 密钥被拒绝',
    } as unknown as TimelineEntry);
    expect(row.tone).toBeUndefined();
    expect(row.title).toBe('这一轮没跑成');
  });
});

describe('额度用尽错误行', () => {
  const quotaEntry = (code: string) => ({
    id: 'err-quota', type: 'runner_error', timestamp: 10,
    errorCode: code, errorMessage: '当前套餐的额度已用完。',
  } as unknown as TimelineEntry);

  test('标题不叫「执行器错误」', () => {
    expect(errorRow(quotaEntry('INSUFFICIENT_BALANCE')).title).toBe('额度已用尽');
  });

  test('dot-namespace 的 quota.exhausted 同样命中', () => {
    expect(errorRow(quotaEntry('quota.exhausted')).title).toBe('额度已用尽');
  });

  test('限流仍归高负载, 没被额度分支抢走 (它是等一下就好, 不是没额度)', () => {
    expect(errorRow(quotaEntry('HTTP_429')).title).toBe('服务繁忙');
  });

  test('普通技术错误保持原样, 仍用通用失败标题', () => {
    expect(errorRow(quotaEntry('STREAM_INCOMPLETE')).title).toBe('这一轮没跑成');
  });
});
