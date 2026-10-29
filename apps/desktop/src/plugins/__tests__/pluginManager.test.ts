import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const TEST_HOME = path.join(os.tmpdir(), `neox-plugin-home-${process.pid}-${Date.now()}`);
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { installFromPath, uninstallPlugin, getPluginInfo, listPlugins, reloadPlugin, enablePlugin, disablePlugin, devLoadPlugin } =
  await import('../pluginManager.js');
const { pluginRegistry, PluginRegistry } = await import('../pluginRegistry.js');

afterAll(async () => {
  try { await fs.rm(TEST_HOME, { recursive: true, force: true }); } catch { /* 清不掉也不该让测试红 */ }
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE;
});

/* 这条闸盯的就是"别再装到用户家里": 装完之后插件目录必须落在 TEST_HOME 之下。 */
describe('单测不许碰用户真实的 ~/.neox', () => {
  it('插件根目录落在临时 HOME 里', () => {
    /* pluginsDir 是**静态** getter, 从实例上取是 undefined (第一版就这么写错过) */
    expect(PluginRegistry.pluginsDir.startsWith(TEST_HOME)).toBe(true);
    expect(PluginRegistry.pluginsDir).not.toContain(String(REAL_HOME));
  });
});

describe('pluginManager', () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `neox-plugin-test-${Date.now()}`);
    pluginDir = path.join(tmpDir, 'test-plugin');
    await fs.mkdir(pluginDir, { recursive: true });

    // Create a valid plugin
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin for unit tests',
      author: { name: 'Test Author' },
      skills: ['skills/'],
      permissions: { tools: ['readfile'] },
    }));

    await fs.mkdir(path.join(pluginDir, 'skills'), { recursive: true });
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('installs from local path', async () => {
    const result = await installFromPath(pluginDir, { skipScan: true });
    expect(result.success).toBe(true);
    expect(result.manifest?.name).toBe('test-plugin');
    expect(result.manifest?.version).toBe('1.0.0');
  });

  it('rejects invalid plugin.json', async () => {
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), '{"invalid": true}');
    const result = await installFromPath(pluginDir, { skipScan: true });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects plugin with dangerous files', async () => {
    await fs.writeFile(path.join(pluginDir, 'malware.exe'), 'bad');
    const result = await installFromPath(pluginDir);
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('Dangerous'))).toBe(true);
  });

  it('rejects marketplace-era engines when the client is too old', async () => {
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin for unit tests',
      author: { name: 'Test Author' },
      skills: ['skills/'],
      permissions: { tools: ['readfile'] },
      engines: { neox: '>=3.7.0' },
    }));
    const old = await installFromPath(pluginDir, { skipScan: true, neoxVersion: '3.6.9' });
    expect(old.success).toBe(false);
    expect(old.errors.some(e => e.includes('3.6.9'))).toBe(true);
    const next = await installFromPath(pluginDir, { skipScan: true, neoxVersion: '3.7.0' });
    expect(next.success).toBe(true);
  });

  describe('平台声明', () => {
    async function writeMacOnlyManifest(): Promise<void> {
      await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'test-plugin',
        version: '1.0.0',
        description: 'A test plugin for unit tests',
        author: { name: 'Test Author' },
        skills: ['skills/'],
        permissions: { tools: ['readfile'] },
        platform: ['darwin'],
      }));
    }

    it('声明不支持当前系统 → 拒装, 且说清双方平台', async () => {
      await writeMacOnlyManifest();
      const rejected = await installFromPath(pluginDir, { skipScan: true, currentPlatform: 'win32' });
      expect(rejected.success).toBe(false);
      expect(rejected.errors[0]).toContain('macOS');
      expect(rejected.errors[0]).toContain('Windows');
    });

    it('同一声明在目标平台上正常装', async () => {
      await writeMacOnlyManifest();
      const ok = await installFromPath(pluginDir, { skipScan: true, currentPlatform: 'darwin' });
      expect(ok.success).toBe(true);
    });

    it('没写 platform 的照常装 —— 绝大多数插件都是这个状态', async () => {
      const ok = await installFromPath(pluginDir, { skipScan: true, currentPlatform: 'win32' });
      expect(ok.success).toBe(true);
    });

    it('dev 加载放行 —— 作者在非目标平台上开发是正常的事, 不是用户装错', async () => {
      await writeMacOnlyManifest();
      const dev = await devLoadPlugin(pluginDir);
      expect(dev.success).toBe(true);
    });
  });

  describe('reloadPlugin', () => {
    it('returns error for non-installed plugin', async () => {
      const result = await reloadPlugin('does-not-exist');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not installed/);
    });

    it('reload returns ESM caveat warning(acknowledges Node module cache limit)', async () => {
      await installFromPath(pluginDir, { skipScan: true, enable: true });
      const result = await reloadPlugin('test-plugin');
      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => /ESM cache/i.test(w))).toBe(true);
    });
  });
});
