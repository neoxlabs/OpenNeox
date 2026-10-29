import { describe, it, expect } from 'vitest';
import { semverLess } from '../marketplaceInstaller.js';

describe('semverLess', () => {
  it('1.0.0 < 1.0.1', () => {
    expect(semverLess('1.0.0', '1.0.1')).toBe(true);
  });
  it('1.2.0 >= 1.1.9', () => {
    expect(semverLess('1.2.0', '1.1.9')).toBe(false);
  });
  it('1.0.0 == 1.0.0 (neither less)', () => {
    expect(semverLess('1.0.0', '1.0.0')).toBe(false);
  });
  it('0.9 < 1.0', () => {
    expect(semverLess('0.9', '1.0')).toBe(true);
  });
  it('missing parts treated as 0', () => {
    expect(semverLess('1', '1.0.1')).toBe(true);
  });
});
