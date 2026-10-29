import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runStructuredCommandFromRuntimeTools } from '../structuredCommand.js';
import { setShellOutputStreamCallback } from '../../shell/shellUiCallbacks.js';

/* Structured commands emit complete shell output for the matching terminal card;
 * this test verifies the stream payload and association. */

const baseParams = {
  resolveWorkspacePath: (p?: string) => p || '/ws',  truncateText: (t: string, n: number) => ({ text: t.slice(0, n), truncated: t.length > n }),
  maxCommandOutputChars: 12000,
  maxErrorSnippetChars: 4000,
};

describe('structuredCommand → UI shell_output_stream (bug #7)', () => {
  let streamed: any[] = [];
  beforeEach(() => {
    streamed = [];
    setShellOutputStreamCallback((p) => streamed.push(p));
  });
  afterEach(() => setShellOutputStreamCallback(null));

  it('emits the full build output to the terminal card on success', async () => {
    const runCommand = async () => ({
      stdout: 'vite build\n✓ built in 3.2s', stderr: '', exitCode: 0, durationMs: 3200,
    });
    const res = await runStructuredCommandFromRuntimeTools({
      ...baseParams,
      toolName: 'run_tests', kind: 'test',
      args: { command: 'npm run build' },
      runCommand,
      toolCallId: 'call_abc',
    });

    // UI 收到完整输出
    expect(streamed).toHaveLength(1);
    expect(streamed[0].toolId).toBe('call_abc');
    expect(streamed[0].output).toContain('✓ built in 3.2s');
    expect(streamed[0].isComplete).toBe(true);
    expect(streamed[0].exitCode).toBe(0);
    // LLM 那边仍是摘要(不含全文 → 不污染上下文)
    const parsed = JSON.parse(res);
    expect(parsed.status).toBe('success');
    expect(parsed.summary).toContain('run_tests succeeded');
  });

  it('also streams output on failure', async () => {
    const runCommand = async () => ({
      stdout: '', stderr: 'error TS2304: Cannot find name x', exitCode: 1, durationMs: 800,
    });
    await runStructuredCommandFromRuntimeTools({
      ...baseParams,
      toolName: 'run_tests', kind: 'test',
      args: { command: 'npm run build' },
      runCommand,
      toolCallId: 'call_def',
    });
    expect(streamed).toHaveLength(1);
    expect(streamed[0].output).toContain('TS2304');
    expect(streamed[0].exitCode).toBe(1);
  });

  it('does not emit when toolCallId is missing', async () => {
    const runCommand = async () => ({ stdout: 'out', stderr: '', exitCode: 0, durationMs: 10 });
    await runStructuredCommandFromRuntimeTools({
      ...baseParams,
      toolName: 'run_tests', kind: 'test',
      args: { command: 'npm run build' },
      runCommand,
    });
    expect(streamed).toHaveLength(0);
  });
});
