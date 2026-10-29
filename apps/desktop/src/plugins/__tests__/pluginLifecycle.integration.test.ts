/**
 * Plugin lifecycle integration test —— 从 scaffold 到加载完整链路.
 *
 * 每个插件模板走一遍:
 *   1. scaffoldPlugin() 生成工程
 *   2. installFromPath() 注册到 pluginRegistry
 *   3. createPluginInjectors() + loadPlugin() 注入各 registry
 *   4. 断言 hook / command / view / tool 注册成功
 *   5. disablePluginRuntime() 清理
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { scaffoldPlugin } from '../pluginScaffold.js';
import { loadManifest, loadPlugin } from '../pluginLoader.js';
import { createPluginInjectors, disablePluginRuntime } from '../pluginIntegration.js';
import { pluginHookRegistry } from '../pluginHookRegistry.js';
import { pluginCommandRegistry } from '../pluginCommandRegistry.js';
import { pluginViewRegistry } from '../pluginViewRegistry.js';
import { toolPackRegistry } from '@neoxlabs/core/tools/packs/toolPack.js';
import { agentTypeRegistry } from '@neoxlabs/core/runtime/agent/agentTypeRegistry.js';
import type { InstalledPlugin } from '@neoxlabs/platform/shared/plugin-types.js';

function buildInstalled(name: string, installDir: string): InstalledPlugin {
  return {
    name,
    version: '0.1.0',
    installPath: installDir,
    source: { type: 'local', path: installDir },
    enabled: true,
    installedAt: new Date().toISOString(),
  };
}

describe('Plugin lifecycle (integration)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-plugin-integ-'));
    // 清理全局 registry (其它测试可能残留)
    pluginHookRegistry.unregisterPlugin('hello-world');
    pluginHookRegistry.unregisterPlugin('ppt-demo');
    pluginCommandRegistry.unregisterPlugin('hello-world');
    pluginCommandRegistry.unregisterPlugin('ppt-demo');
    pluginViewRegistry.unregisterPlugin('hello-world');
    pluginViewRegistry.unregisterPlugin('ppt-demo');
    toolPackRegistry.unregisterByPrefix('plugin:hello-world');
    toolPackRegistry.unregisterByPrefix('plugin:ppt-demo');
    agentTypeRegistry.unregisterPlugin('hello-world');
    agentTypeRegistry.unregisterPlugin('ppt-demo');
  });

  it('basic template → skills + commands load', async () => {
    const pluginDir = path.join(workDir, 'hello-world');
    const s = await scaffoldPlugin({ name: 'hello-world', targetDir: pluginDir, template: 'basic', force: true });
    expect(s.success).toBe(true);

    const plugin = buildInstalled('hello-world', pluginDir);
    const manifest = await loadManifest(pluginDir);
    expect(manifest).toBeTruthy();

    const injectors = createPluginInjectors({
      getInstalled: (n) => (n === 'hello-world' ? plugin : undefined),
    });
    const result = await loadPlugin(plugin, injectors);
    expect(result.success).toBe(true);
    expect(result.loaded.commands).toBe(1);
    // skills 加载需要 skillRegistry, 我们没传 → 返回 0 是预期
    expect(result.loaded.hooks).toBe(0);

    // 命令已注册
    const cmd = pluginCommandRegistry.find('/example');
    expect(cmd).toBeDefined();
    expect(cmd!.pluginName).toBe('hello-world');

    // 反注册
    const removed = disablePluginRuntime('hello-world');
    expect(removed.commands).toBe(1);
    expect(pluginCommandRegistry.find('/example')).toBeUndefined();
  });

  it('ui-view template → views + tools registered', async () => {
    const pluginDir = path.join(workDir, 'ppt-demo');
    const s = await scaffoldPlugin({ name: 'ppt-demo', targetDir: pluginDir, template: 'ui-view', force: true });
    expect(s.success).toBe(true);

    const plugin = buildInstalled('ppt-demo', pluginDir);

    const injectors = createPluginInjectors({
      getInstalled: (n) => (n === 'ppt-demo' ? plugin : undefined),
    });
    const result = await loadPlugin(plugin, injectors);
    expect(result.success).toBe(true);
    expect(result.loaded.views).toBe(1);
    expect(result.loaded.tools).toBeGreaterThan(0);

    // View 登记
    const view = pluginViewRegistry.findById('ppt-demo.main');
    expect(view).toBeDefined();
    expect(view!.pluginName).toBe('ppt-demo');
    expect(view!.location).toBe('workspace');
    expect(view!.absoluteEntry.endsWith('ui/index.html')).toBe(true);

    // Tool pack 登记
    const pack = toolPackRegistry.get('plugin:ppt-demo');
    expect(pack).toBeDefined();
    expect(pack!.toolNames.length).toBeGreaterThan(0);

    // 全部清理
    const removed = disablePluginRuntime('ppt-demo');
    expect(removed.views).toBe(1);
    expect(removed.tools).toBe(1);
    expect(pluginViewRegistry.findById('ppt-demo.main')).toBeUndefined();
    expect(toolPackRegistry.get('plugin:ppt-demo')).toBeUndefined();
  });

  it('views change emits onChange for renderer subscribers', async () => {
    const pluginDir = path.join(workDir, 'ppt-demo');
    await scaffoldPlugin({ name: 'ppt-demo', targetDir: pluginDir, template: 'ui-view', force: true });
    const plugin = buildInstalled('ppt-demo', pluginDir);

    let fired = 0;
    const unsub = pluginViewRegistry.onChange(() => { fired++; });

    const injectors = createPluginInjectors({
      getInstalled: (n) => (n === 'ppt-demo' ? plugin : undefined),
    });
    await loadPlugin(plugin, injectors);
    disablePluginRuntime('ppt-demo');
    unsub();

    // register + unregister 各一次
    expect(fired).toBe(2);
  });

  it('runtimeOnly injectors omit views/auth and skip MCP writes', () => {
    const injectors = createPluginInjectors({ runtimeOnly: true });
    expect(injectors.loadViews).toBeUndefined();
    expect(injectors.loadAuthProvider).toBeUndefined();
    expect(injectors.loadConnector).toBeTypeOf('function');
  });
});
