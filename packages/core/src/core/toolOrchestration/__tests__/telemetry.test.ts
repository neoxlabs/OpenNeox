import { describe, it, expect } from 'vitest';
import { runTelemetryStage } from '@neoxlabs/kernel/core/toolOrchestration/stages/telemetry.js';
import { makeCtx } from './fixtures.js';
import type { ToolUseOutcome } from '@neoxlabs/kernel/core/toolOrchestration/types.js';

describe('Stage 6 · telemetry', () => {
  const makeOutcome = (): ToolUseOutcome => ({
    toolCallId: 'call-1',
    toolName: 'readfile',
    resolvedToolName: 'readfile',
    stage: 'telemetry',
    success: true,
    output: 'ok',
    stageTimings: { validate: 1, execute: 2 },
    totalDurationMs: 5,
  });

  it('calls onToolComplete with outcome', () => {
    let received: ToolUseOutcome | undefined;
    const ctx = makeCtx({
      telemetry: { onToolComplete: (o) => { received = o; } },
    });
    const r = runTelemetryStage(makeOutcome(), ctx);
    expect(r.kind).toBe('ok');
    expect(received?.toolCallId).toBe('call-1');
  });

  it('no-op when telemetry is not configured', () => {
    const ctx = makeCtx();
    const r = runTelemetryStage(makeOutcome(), ctx);
    expect(r.kind).toBe('ok');
  });

  it('swallows telemetry sink errors (never crashes caller)', () => {
    const ctx = makeCtx({
      telemetry: { onToolComplete: () => { throw new Error('sink dead'); } },
    });
    expect(() => runTelemetryStage(makeOutcome(), ctx)).not.toThrow();
  });
});
