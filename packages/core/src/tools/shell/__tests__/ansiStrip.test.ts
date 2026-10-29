import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../ansiStrip.js';

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;32mbold green\x1b[0m')).toBe('bold green');
  });

  it('removes cursor/erase codes', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Aprogress')).toBe('progress');
    expect(stripAnsi('foo\x1b[31m→\x1b[0mbar')).toBe('foo→bar');
  });

  it('preserves plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('')).toBe('');
  });

  it('handles multi-line with mixed ANSI', () => {
    const input = 'line1\n\x1b[33mwarning\x1b[0m\nline3';
    expect(stripAnsi(input)).toBe('line1\nwarning\nline3');
  });

  it('handles real npm install progress line', () => {
    const input = '\x1b[2K\x1b[1G\x1b[90m[####-----]\x1b[39m 42% installing lodash';
    const stripped = stripAnsi(input);
    expect(stripped).toContain('42%');
    expect(stripped).toContain('installing lodash');
    expect(stripped).not.toContain('\x1b');
  });
});
