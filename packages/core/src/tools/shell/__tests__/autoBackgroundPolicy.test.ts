/**
 * isAutoBackgroundAllowed + detectBlockedSleepPattern — policy helpers tests
 */

import { describe, it, expect } from 'vitest';
import {
  isAutoBackgroundAllowed,
  detectBlockedSleepPattern,
} from '../shellCommandGuards.js';

describe('isAutoBackgroundAllowed', () => {
  it('allows regular long-running server commands', () => {
    expect(isAutoBackgroundAllowed('npm run dev')).toBe(true);
    expect(isAutoBackgroundAllowed('yarn start')).toBe(true);
    expect(isAutoBackgroundAllowed('next dev')).toBe(true);
    expect(isAutoBackgroundAllowed('docker-compose up')).toBe(true);
    expect(isAutoBackgroundAllowed('vite')).toBe(true);
  });

  it('rejects commands that shouldnt be auto-backgrounded', () => {
    expect(isAutoBackgroundAllowed('sleep 60')).toBe(false);
    expect(isAutoBackgroundAllowed('wait')).toBe(false);
    expect(isAutoBackgroundAllowed('vim foo.txt')).toBe(false);
    expect(isAutoBackgroundAllowed('top')).toBe(false);
    expect(isAutoBackgroundAllowed('htop')).toBe(false);
    expect(isAutoBackgroundAllowed('watch date')).toBe(false);
    expect(isAutoBackgroundAllowed('ssh user@host')).toBe(false);
    expect(isAutoBackgroundAllowed('psql mydb')).toBe(false);
    expect(isAutoBackgroundAllowed('python')).toBe(false); // bare REPL
  });

  it('peers through leading cd', () => {
    expect(isAutoBackgroundAllowed('cd /tmp && npm run dev')).toBe(true);
    expect(isAutoBackgroundAllowed('cd /tmp && vim file')).toBe(false);
    expect(isAutoBackgroundAllowed('cd /tmp && sleep 60')).toBe(false);
  });

  it('handles path-prefixed commands', () => {
    expect(isAutoBackgroundAllowed('/usr/bin/sleep 10')).toBe(false);
    expect(isAutoBackgroundAllowed('./scripts/dev.sh')).toBe(true);
  });

  it('empty command returns true (no block)', () => {
    expect(isAutoBackgroundAllowed('')).toBe(true);
  });
});

describe('detectBlockedSleepPattern (2026-06-28: 阈值 ≥ 5, 命中=外层自动转 bg)', () => {
  it('flags bare sleep N where N >= 5', () => {
    expect(detectBlockedSleepPattern('sleep 5')).toMatch(/sleep 5/);
    expect(detectBlockedSleepPattern('sleep 30')).toMatch(/sleep 30/);
  });

  it('flags sleep N && follow-up (N >= 5)', () => {
    const msg = detectBlockedSleepPattern('sleep 10 && curl https://example.com');
    expect(msg).toMatch(/sleep 10/);
    expect(msg).toMatch(/curl/);
  });

  it('flags sleep N ; follow-up (N >= 5)', () => {
    const msg = detectBlockedSleepPattern('sleep 15; echo done');
    expect(msg).toMatch(/sleep 15/);
  });

  it('allows sleep 1..4 (合法短节流)', () => {
    expect(detectBlockedSleepPattern('sleep 1')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 2')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 3')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 4')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 0.5')).toBeNull();
  });

  it('allows sleep when not the leading command', () => {
    expect(detectBlockedSleepPattern('npm install && sleep 30')).toBeNull();
    expect(detectBlockedSleepPattern('echo start; sleep 5')).toBeNull();
  });

  it('allows non-numeric sleep arg (variable)', () => {
    expect(detectBlockedSleepPattern('sleep $VAR')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 10s')).toBeNull();
  });

  it('allows non-sleep commands', () => {
    expect(detectBlockedSleepPattern('npm run dev')).toBeNull();
    expect(detectBlockedSleepPattern('cat file.txt')).toBeNull();
  });
});
