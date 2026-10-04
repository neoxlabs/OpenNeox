import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanupWorktree, createWorktree, removeWorktree } from '../worktreeIsolation.js';

let repo: string;
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf-8' });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-wt-files-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@neox.local'], repo);
  git(['config', 'user.name', 'neox-test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('cleanupWorktree changedFiles', () => {
  it('a modified tracked file keeps its full name', () => {
    const info = createWorktree(repo, 'ext-test');
    expect(info).not.toBeNull();
    try {
      fs.appendFileSync(path.join(info!.path, 'math.js'), 'export const pow = (a, b) => a ** b;\n');
      fs.writeFileSync(path.join(info!.path, 'notes.md'), 'new\n');
      const result = cleanupWorktree(info!, repo);
      expect(result.hasChanges).toBe(true);
      expect(result.changedFiles.sort()).toEqual(['math.js', 'notes.md']);
    } finally {
      removeWorktree(info!, repo);
    }
  });
});
