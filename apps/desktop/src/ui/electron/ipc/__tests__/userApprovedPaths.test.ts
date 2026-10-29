import { describe, expect, it, vi } from 'vitest';
import {
  hasUserApprovedPath,
  listApprovedRoots,
  rememberApprovedRoot,
  rememberUserApprovedPath,
} from '../userApprovedPaths.js';

function fakeSender(id = 1) {
  return {
    id,
    once: vi.fn(),
  } as any;
}

describe('userApprovedPaths', () => {
  it('remembers exact file paths for read/write', () => {
    const sender = fakeSender(42);
    rememberUserApprovedPath(sender, '/tmp/a.md', 'read');
    expect(hasUserApprovedPath(sender, '/tmp/a.md', 'read')).toBe(true);
    expect(hasUserApprovedPath(sender, '/tmp/a.md', 'write')).toBe(false);
    rememberUserApprovedPath(sender, '/tmp/b.md', 'write');
    expect(hasUserApprovedPath(sender, '/tmp/b.md', 'write')).toBe(true);
    expect(hasUserApprovedPath(sender, '/tmp/b.md', 'read')).toBe(true);
  });

  it('approved roots grant read for nested files after workspace switch', () => {
    const sender = fakeSender(77);
    rememberApprovedRoot(sender, '/Users/me/proj-a');
    expect(listApprovedRoots(sender)).toContain('/Users/me/proj-a');
    expect(hasUserApprovedPath(sender, '/Users/me/proj-a/docs/x.md', 'read')).toBe(true);
    expect(hasUserApprovedPath(sender, '/Users/me/proj-b/docs/x.md', 'read')).toBe(false);
    /* write still requires explicit path approval or workspace base paths */
    expect(hasUserApprovedPath(sender, '/Users/me/proj-a/docs/x.md', 'write')).toBe(false);
  });
});
