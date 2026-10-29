import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { __testing } from '../pluginInstaller.js';

const { looksLikeGit, findPluginRoot } = __testing;

describe('pluginInstaller helpers', () => {
  describe('looksLikeGit', () => {
    it('detects .git suffix', () => {
      expect(looksLikeGit('https://github.com/foo/bar.git')).toBe(true);
    });
    it('detects git@host: form', () => {
      expect(looksLikeGit('git@github.com:foo/bar')).toBe(true);
    });
    it('detects git+ scheme', () => {
      expect(looksLikeGit('git+https://github.com/foo/bar')).toBe(true);
    });
    it('treats github.com non-tarball as git', () => {
      expect(looksLikeGit('https://github.com/foo/bar')).toBe(true);
    });
    it('treats github.com tarball as NOT git', () => {
      expect(looksLikeGit('https://github.com/foo/bar/archive/main.tar.gz')).toBe(false);
    });
    it('returns false for generic tarball urls', () => {
      expect(looksLikeGit('https://example.com/plugin.tar.gz')).toBe(false);
      expect(looksLikeGit('https://cdn.example.com/p.tgz')).toBe(false);
    });
  });

  describe('findPluginRoot', () => {
    it('finds plugin.json at root', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-findroot-'));
      await fs.writeFile(path.join(tmp, 'plugin.json'), '{}');
      const found = await findPluginRoot(tmp);
      expect(found).toBe(tmp);
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('finds plugin.json one level deep', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-findroot-'));
      const inner = path.join(tmp, 'my-plugin-v1');
      await fs.mkdir(inner, { recursive: true });
      await fs.writeFile(path.join(inner, 'plugin.json'), '{}');
      const found = await findPluginRoot(tmp);
      expect(found).toBe(inner);
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('returns null when no plugin.json within max depth', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-findroot-'));
      // depth=3 (beyond maxDepth=2): should not find
      const deep = path.join(tmp, 'a', 'b', 'c');
      await fs.mkdir(deep, { recursive: true });
      await fs.writeFile(path.join(deep, 'plugin.json'), '{}');
      const found = await findPluginRoot(tmp);
      expect(found).toBeNull();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('skips node_modules and dotdirs', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-findroot-'));
      await fs.mkdir(path.join(tmp, 'node_modules', 'foo'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'node_modules', 'foo', 'plugin.json'), '{}');
      await fs.mkdir(path.join(tmp, '.hidden'), { recursive: true });
      await fs.writeFile(path.join(tmp, '.hidden', 'plugin.json'), '{}');
      const found = await findPluginRoot(tmp);
      expect(found).toBeNull();
      await fs.rm(tmp, { recursive: true, force: true });
    });
  });
});
