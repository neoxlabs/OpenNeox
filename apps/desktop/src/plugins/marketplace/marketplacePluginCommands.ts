/**
 * /plugins 里依赖官方市场的子命令: search / featured / categories / updates / update。
 * 由 registerOfficialMarketplace() 注册进 cli/pluginCommands 的子命令表。
 */
import type { PluginCommandResult, PluginSubcommand } from '../cli/pluginCommands.js';

async function handleSearch(query: string): Promise<PluginCommandResult> {
  if (!query) return { output: 'Usage: /plugins search <keyword>', success: false };

  const { createDefaultMarketplaceClient } = await import('./marketplaceClient.js');
  const client = createDefaultMarketplaceClient();

  try {
    const result = await client.search({ query, sort: 'downloads', pageSize: 10 });
    if (result.plugins.length === 0) {
      return { output: `No plugins found for "${query}".`, success: true };
    }

    const lines = [`Plugin Marketplace — ${result.total} result(s) for "${query}"`, ''];
    for (const p of result.plugins) {
      const stars = '★'.repeat(Math.round(p.rating)) + '☆'.repeat(5 - Math.round(p.rating));
      const official = p.official ? ' [official]' : '';
      lines.push(`  ${p.name} v${p.version}  ${stars} ${p.rating.toFixed(1)}${official}`);
      lines.push(`  ${p.description}`);
      lines.push(`  by ${p.author.name} · ${p.downloads.toLocaleString()} installs · ${p.category}`);
      lines.push('');
    }
    lines.push('Install: /plugins install <name>');
    return { output: lines.join('\n'), success: true };
  } catch (err: any) {
    return { output: `Search failed: ${err.message}\n\nFor local plugins: /plugins install ./path`, success: false };
  }
}

async function handleFeatured(): Promise<PluginCommandResult> {
  const { createDefaultMarketplaceClient } = await import('./marketplaceClient.js');
  const client = createDefaultMarketplaceClient();
  try {
    const featured = await client.getFeatured();
    if (featured.length === 0) return { output: 'No featured plugins available.', success: true };
    const lines = ['★ Featured Plugins', ''];
    for (const p of featured) {
      lines.push(`  ${p.name} v${p.version} — ${p.description}`);
      lines.push(`  ${p.downloads.toLocaleString()} installs · ★${p.rating.toFixed(1)}`);
      lines.push('');
    }
    return { output: lines.join('\n'), success: true };
  } catch (err: any) {
    return { output: `Failed to fetch featured plugins: ${err.message}`, success: false };
  }
}

async function handleCheckUpdates(): Promise<PluginCommandResult> {
  const { checkForUpdates, formatUpdateNotice } = await import('./updateChecker.js');
  const updates = await checkForUpdates();
  const notice = formatUpdateNotice(updates);
  return { output: notice ?? '✅ All plugins are up to date.', success: true };
}

async function handleUpdate(name: string): Promise<PluginCommandResult> {
  const { checkForUpdates } = await import('./updateChecker.js');
  const { installFromMarketplace } = await import('./marketplaceInstaller.js');

  const updates = await checkForUpdates();
  if (name) {
    const hit = updates.find((u) => u.name === name);
    if (!hit) {
      return { output: `✅ "${name}" is already up to date (or not installed from marketplace).`, success: true };
    }
    const result = await installFromMarketplace(name);
    return result.success
      ? { output: `✓ Updated ${name}: ${hit.currentVersion} → ${hit.latestVersion}`, success: true }
      : { output: `✗ Failed to update ${name}: ${result.errors.join('; ')}`, success: false };
  }

  if (updates.length === 0) return { output: '✅ All plugins are up to date.', success: true };
  const lines: string[] = [];
  let failed = 0;
  for (const u of updates) {
    const result = await installFromMarketplace(u.name);
    if (result.success) {
      lines.push(`  ✓ ${u.name}: ${u.currentVersion} → ${u.latestVersion}`);
    } else {
      failed++;
      lines.push(`  ✗ ${u.name}: ${result.errors.join('; ')}`);
    }
  }
  lines.unshift(`Updated ${updates.length - failed}/${updates.length} plugin(s):`);
  if (failed === 0) lines.push('\nRestart Neox (or /plugins list) to load the new versions.');
  return { output: lines.join('\n'), success: failed === 0 };
}

async function handleCategories(): Promise<PluginCommandResult> {
  const { createDefaultMarketplaceClient } = await import('./marketplaceClient.js');
  const client = createDefaultMarketplaceClient();
  try {
    const categories = await client.getCategories();
    if (categories.length === 0) return { output: 'No categories available.', success: true };
    const lines = ['Plugin Categories:', ''];
    for (const c of categories) {
      lines.push(`  ${c.id.padEnd(15)} ${c.name} (${c.count})`);
    }
    lines.push('\nBrowse: /plugins search --category=devops');
    return { output: lines.join('\n'), success: true };
  } catch (err: any) {
    return { output: `Failed to fetch categories: ${err.message}`, success: false };
  }
}

export const marketplacePluginSubcommands: PluginSubcommand[] = [
  { names: ['search'], run: handleSearch },
  { names: ['featured'], run: () => handleFeatured() },
  { names: ['update'], run: handleUpdate },
  { names: ['updates', 'check-updates'], run: () => handleCheckUpdates() },
  { names: ['categories'], run: () => handleCategories() },
];

export const marketplacePluginHelp = {
  install: ['  /plugins install --marketplace <name>      Install from marketplace registry'],
  section: [
    '  /plugins search <keyword>                  Search marketplace',
    '  /plugins featured                          Show featured plugins',
    '  /plugins categories                        Browse by category',
    '  /plugins updates                           Check for updates',
    '  /plugins update [name]                     Install updates',
  ],
};
