import { describe, it, expect } from 'vitest';
import { FlushGate } from '../flushGate.js';

describe('FlushGate', () => {
  it('enqueue returns false when not active', () => {
    const gate = new FlushGate<string>();
    expect(gate.enqueue('msg1')).toBe(false);
    expect(gate.pendingCount).toBe(0);
  });

  it('enqueue returns true and buffers when active', () => {
    const gate = new FlushGate<string>();
    gate.start();
    expect(gate.active).toBe(true);

    expect(gate.enqueue('a', 'b')).toBe(true);
    expect(gate.pendingCount).toBe(2);
  });

  it('end() returns buffered items and deactivates', () => {
    const gate = new FlushGate<string>();
    gate.start();
    gate.enqueue('x');
    gate.enqueue('y');

    const drained = gate.end();
    expect(drained).toEqual(['x', 'y']);
    expect(gate.active).toBe(false);
    expect(gate.pendingCount).toBe(0);
  });

  it('drop() discards buffered items', () => {
    const gate = new FlushGate<number>();
    gate.start();
    gate.enqueue(1, 2, 3);

    gate.drop();
    expect(gate.active).toBe(false);
    expect(gate.pendingCount).toBe(0);
  });

  it('deactivate() returns items without clearing', () => {
    const gate = new FlushGate<string>();
    gate.start();
    gate.enqueue('a');
    gate.enqueue('b');

    const items = gate.deactivate();
    expect(items).toEqual(['a', 'b']);
    expect(gate.active).toBe(false);
  });

  it('lifecycle: start → enqueue → end → enqueue returns false', () => {
    const gate = new FlushGate<string>();

    // Before start
    expect(gate.enqueue('pre')).toBe(false);

    // Active
    gate.start();
    expect(gate.enqueue('during')).toBe(true);

    // After end
    gate.end();
    expect(gate.enqueue('post')).toBe(false);
  });
});
