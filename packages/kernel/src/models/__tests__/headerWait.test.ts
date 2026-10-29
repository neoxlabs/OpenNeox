import { describe, it, expect } from 'vitest';
import { headerWaitMs } from '../headerWait.js';

describe('headerWaitMs', () => {
  it('small requests keep the base header wait', () => {
    expect(headerWaitMs(30_000, { messages: [{ role: 'user', content: 'hi' }] })).toBeLessThan(31_000);
  });
  it('a ~1MB long-session body gets time to upload at 64kbps', () => {
    const ms = headerWaitMs(30_000, { messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }] });
    expect(ms).toBeGreaterThan(30_000 + 120_000);
  });
  it('counts UTF-8 bytes, not chars', () => {
    const ascii = headerWaitMs(0, 'a'.repeat(8192));
    const cjk = headerWaitMs(0, '中'.repeat(8192));
    expect(cjk).toBeGreaterThan(ascii * 2.5);
  });
});
