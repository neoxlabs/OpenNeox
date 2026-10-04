/**
 * A tool result that arrives truncated must never be printed raw.
 *
 * Found in a CLI trial: browser_run results carry a base64 screenshot, get truncated on the way
 * to the UI, stop parsing as JSON, and were shown verbatim — `{"type":"contextual",…
 * "content":"__NEOX_IMAGE_RESULT__{…/9j/2wBD…` — as a timeline line.
 */
import { describe, it, expect } from 'vitest';
import { formatToolCallEndDetail } from '../runtimeEvents.js';

describe('tool result display', () => {
  it('shows only the summary of a truncated structured result', () => {
    const truncated = '{"type":"contextual","status":"success","tool":"browser_run","summary":"localhost · 8/8 步 9487ms","content":"__NEOX_IMAGE_RESULT__{\\"type\\":\\"image\\",\\"images\\":[{\\"data\\":\\"/9j/2wBDAAkGBwgHBgkIBwgKCgkLDR';
    const out = formatToolCallEndDetail('browser_run', truncated, undefined, true);
    expect(out).toBe('localhost · 8/8 步 9487ms');
    expect(out).not.toContain('NEOX_IMAGE_RESULT');
  });

  it('keeps the error text of a truncated failure', () => {
    const truncated = '{"type":"contextual","status":"error","tool":"browser_run","summary":"localhost · 第 4 步失败","content":"__NEOX_IMAGE_RESULT__{\\"images\\":[{\\"data\\":\\"/9j/';
    const out = formatToolCallEndDetail('browser_run', truncated, undefined, true) ?? '';
    expect(out).toContain('第 4 步失败');
    expect(out).not.toContain('/9j/');
  });

  it('still formats a complete structured result', () => {
    const full = JSON.stringify({ type: 'ephemeral', status: 'success', summary: 'ok' });
    expect(formatToolCallEndDetail('write_file', full, undefined, false)).toBe('ok');
  });
});

import { friendlyRecoverableError } from '../runtimeEvents.js';

describe('recoverable edit errors', () => {
  it.each(['file_not_read', 'stale_read', 'string_not_found', 'stale_snapshot'])('%s reads as a retry', (code) => {
    const out = JSON.stringify({ type: 'ephemeral', status: 'error', tool: 'edit', error: code, summary: 'Cannot edit x.ts' });
    expect(friendlyRecoverableError(out)).toBeTruthy();
  });
  it('other errors stay errors', () => {
    const out = JSON.stringify({ type: 'ephemeral', status: 'error', tool: 'edit', error: 'permission_denied' });
    expect(friendlyRecoverableError(out)).toBeUndefined();
  });
});
