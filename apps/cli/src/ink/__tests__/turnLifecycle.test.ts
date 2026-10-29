/**
 * Turn lifecycle: updateStatus must never own isRunning.
 *
 * Regression for: late shell heartbeats / explore_complete / tool_call status
 * re-lighting interrupt UI after the turn already settled.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InkUIAdapter } from '../InkUIAdapter.js';

function makeAdapter(): InkUIAdapter {
  return new InkUIAdapter({
    version: 'test',
    provider: 'test',
    model: 'test-model',
    workDir: process.cwd(),
  });
}

function isRunning(adapter: InkUIAdapter): boolean {
  return (adapter as any).runtime.getIsRunning() as boolean;
}

describe('TurnLifecycle (status vs running)', () => {
  let ui: InkUIAdapter;

  beforeEach(() => {
    ui = makeAdapter();
  });

  it('beginTurn / endTurn own isRunning; updateStatus does not re-light after end', () => {
    expect(isRunning(ui)).toBe(false);

    ui.beginTurn();
    expect(isRunning(ui)).toBe(true);

    ui.updateStatus('Streaming: write_file (12 chars)', 'tool_call');
    expect(isRunning(ui)).toBe(true);

    ui.endTurn();
    expect(isRunning(ui)).toBe(false);

    // Late heartbeat / progress — historically setRunning(true) via tool_call/thinking
    ui.updateStatus('Shell running... 5m 5s', 'info');
    ui.updateStatus('Streaming: bash (99 chars)', 'tool_call');
    ui.updateStatus('Still thinking…', 'thinking');
    expect(isRunning(ui)).toBe(false);
  });

  it('explore_complete does not end the main turn', () => {
    ui.beginTurn();
    ui.updateStatus('Explore complete', 'explore_complete');
    expect(isRunning(ui)).toBe(true);
    ui.endTurn();
    expect(isRunning(ui)).toBe(false);
  });

  it('complete / error status alone do not clear a live turn', () => {
    ui.beginTurn();
    ui.updateStatus('Complete!', 'complete');
    expect(isRunning(ui)).toBe(true);
    ui.updateStatus('boom', 'error');
    expect(isRunning(ui)).toBe(true);
    ui.endTurn();
    expect(isRunning(ui)).toBe(false);
  });

  it('idle compact owns busy; endCompaction releases; mid-turn compact does not', () => {
    // Idle compact
    expect(isRunning(ui)).toBe(false);
    ui.beginCompaction();
    expect(isRunning(ui)).toBe(true);
    ui.updateStatus('Compact starting…', 'compacting');
    expect(isRunning(ui)).toBe(true);
    ui.endCompaction();
    expect(isRunning(ui)).toBe(false);

    // Mid-turn compact: agent already running → endCompaction must not clear
    ui.beginTurn();
    ui.beginCompaction();
    expect(isRunning(ui)).toBe(true);
    ui.endCompaction();
    expect(isRunning(ui)).toBe(true);
    ui.endTurn();
    expect(isRunning(ui)).toBe(false);
  });

  it('startTaskTimer / stopTaskTimer alias beginTurn / endTurn', () => {
    ui.startTaskTimer();
    expect(isRunning(ui)).toBe(true);
    ui.stopTaskTimer();
    expect(isRunning(ui)).toBe(false);
  });

  it('addCompacting terminal releases idle compact busy', () => {
    ui.beginCompaction();
    expect(isRunning(ui)).toBe(true);
    // Chinese / English terminal phrases recognized by isCompactTerminalMessage
    ui.addCompacting('无需压缩');
    expect(isRunning(ui)).toBe(false);
  });
});
