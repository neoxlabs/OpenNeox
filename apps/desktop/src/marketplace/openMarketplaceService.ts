import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cloud } from '@neoxlabs/cloud';
import { installFromPath } from '../plugins/pluginManager.js';
import { pluginRegistry } from '../plugins/pluginRegistry.js';
import type { InstalledPlugin } from '@neoxlabs/platform/shared/plugin-types.js';
import { MarketplaceSourceStore, type MarketplaceSource } from './marketplaceSourceStore.js';
import { createKeytarMarketplaceCredentialStore, type MarketplaceCredentialStore } from './marketplaceCredentialStore.js';
import { extractMarketplaceArchive, readMarketplaceArchive, syncMarketplaceSource, type MarketplaceSnapshot } from './marketplaceArchive.js';
import { MarketplaceInstallLedger } from './marketplaceInstallLedger.js';
import { skillInstallManager } from '@neoxlabs/core/skills/installManager.js';

export interface MarketplaceSearchOptions { query?: string; type?: 'plugin' | 'skill'; sourceId?: string; page?: number; pageSize?: number; }
export interface MarketplaceSearchResult { items: Array<MarketplaceSnapshot['entries'][number] & { sourceId: string; sourceName: string }>; total: number; page: number; pageSize: number; sources: Array<MarketplaceSource & { error?: string; cached: boolean }>; }

export class OpenMarketplaceService {
  constructor(
    private readonly sources = new MarketplaceSourceStore(),
    private readonly credentials: MarketplaceCredentialStore = createKeytarMarketplaceCredentialStore(),
    private readonly cacheDirectory = path.join(os.homedir(), '.neox', 'marketplace-cache'),
    private readonly ledger = new MarketplaceInstallLedger(),
  ) {}

  listSources(): MarketplaceSource[] { return this.sources.list(); }
  addSource(input: { repository: string; name?: string; ref?: string }): MarketplaceSource { return this.sources.add(input); }
  updateSource(id: string, patch: Partial<Pick<MarketplaceSource, 'name' | 'ref' | 'enabled' | 'autoUpdate'>>): MarketplaceSource { return this.sources.update(id, patch); }
  removeSource(id: string): void { this.sources.remove(id); }

  async setToken(sourceId: string, token: string | undefined): Promise<void> {
    if (!token?.trim()) {
      await this.credentials.delete(sourceId);
      this.sources.setCredentialConfigured(sourceId, false);
    } else {
      await this.credentials.set(sourceId, token.trim());
      this.sources.setCredentialConfigured(sourceId, true);
    }
  }

  async refresh(sourceId: string, force = true): Promise<{ snapshot: MarketplaceSnapshot | null; error?: string }> {
    const source = this.sources.list().find((item) => item.id === sourceId);
    if (!source) throw new Error(`Marketplace source not found: ${sourceId}`);
    const result = await syncMarketplaceSource(source, { cacheDirectory: this.cacheDirectory, token: await this.credentials.get(sourceId), refresh: force });
    return { snapshot: result.snapshot, error: result.error };
  }

  async search(options: MarketplaceSearchOptions = {}): Promise<MarketplaceSearchResult> {
    const selected = this.sources.list().filter((source) => source.enabled && (!options.sourceId || source.id === options.sourceId));
    const results = await Promise.all(selected.map(async (source) => {
      let result = await this.refresh(source.id, source.autoUpdate);
      if (!result.snapshot && !source.autoUpdate) result = await this.refresh(source.id, true);
      return { source, result };
    }));
    const query = options.query?.trim().toLowerCase() ?? '';
    const items = results.flatMap(({ source, result }) => (result.snapshot?.entries ?? [])
      .filter((item) => (!options.type || item.type === options.type) && (!query || [item.name, item.slug, item.description, ...item.tags].join(' ').toLowerCase().includes(query)))
      .map((item) => ({ ...item, sourceId: source.id, sourceName: source.name })));
    if (cloud().enabled && !options.sourceId) {
      const cloudItems = await cloud().marketplace.listCatalog();
      items.push(...cloudItems
        .filter((item) => !query || `${item.id} ${item.name}`.toLowerCase().includes(query))
        .map((item) => ({ type: 'plugin' as const, slug: item.id, name: item.name, description: '', version: 'cloud', category: '', tags: [], sourcePath: '', sourceId: 'cloud', sourceName: 'Cloud marketplace' })));
    }
    const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 24));
    const page = Math.max(1, options.page ?? 1);
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize,
      sources: [
        ...results.map(({ source, result }) => ({ ...source, cached: result.snapshot !== null && !!result.error, ...(result.error ? { error: result.error } : {}) })),
        ...(cloud().enabled ? [{ id: 'cloud', name: 'Cloud marketplace', repository: '', ref: '', enabled: true, autoUpdate: false, builtin: true, createdAt: '', updatedAt: '', cached: false }] : []),
      ] };
  }

  async install(sourceId: string, type: 'plugin' | 'skill', slug: string, confirmConflict = false): Promise<{ success: boolean; error?: string; plugin?: InstalledPlugin }> {
    if (sourceId === 'cloud' && cloud().enabled) {
      if (type !== 'plugin') return { success: false, error: 'Cloud skill installation is not available through the plugin installer' };
      const url = await cloud().marketplace.resolveDownload(slug);
      if (!url) return { success: false, error: 'Cloud marketplace ability is unavailable' };
      await pluginRegistry.load();
      if (pluginRegistry.get(slug) && !confirmConflict) return { success: false, error: `Conflict: plugin ${slug} is already installed; confirmation required` };
      const installed = await import('../plugins/pluginManager.js').then((module) => module.installFromUrl(url));
      if (!installed.success || !installed.plugin) return { success: false, error: installed.errors.join('\n') || 'Cloud marketplace installation failed' };
      await this.ledger.upsert({ sourceId, type, slug, pluginName: installed.plugin.name, version: installed.plugin.version, installedAt: installed.plugin.installedAt, updatedAt: installed.plugin.updatedAt });
      return { success: true, plugin: installed.plugin };
    }
    const source = this.sources.list().find((item) => item.id === sourceId);
    if (!source) return { success: false, error: `Marketplace source not found: ${sourceId}` };
    const result = await this.refresh(sourceId);
    const ability = result.snapshot?.manifest.abilities.find((item) => item.type === type && item.slug === slug);
    if (!ability || !result.snapshot) return { success: false, error: result.error ?? 'Marketplace ability not found' };
    const abilityFiles = await this.readArchiveAbility(source, ability.source.path);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-marketplace-install-'));
    try {
      const abilityDir = path.join(temp, 'ability');
      await fs.mkdir(abilityDir, { recursive: true });
      for (const [relative, bytes] of abilityFiles) {
        const target = path.join(abilityDir, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
      if (type === 'skill') {
        const preview = skillInstallManager.previewLocal(abilityDir);
        if (!preview.success || !preview.skillId) return { success: false, error: preview.error ?? 'Marketplace skill is invalid' };
        const existingSkill = skillInstallManager.getMeta(preview.skillId);
        if (existingSkill && !confirmConflict) {
          return { success: false, error: `Conflict: skill ${preview.skillId} is already installed; confirmation required` };
        }
        if (existingSkill) {
          const removed = await skillInstallManager.uninstall(preview.skillId);
          if (!removed.success) return { success: false, error: removed.error ?? 'Existing marketplace skill could not be replaced' };
        }
        const installed = await skillInstallManager.install(abilityDir);
        if (!installed.success) return { success: false, error: installed.error ?? 'Marketplace skill installation failed' };
        await this.ledger.upsert({ sourceId, type, slug, pluginName: installed.skillId, version: installed.meta?.installedVersion ?? ability.version, installedAt: installed.meta?.installedAt ?? new Date().toISOString() });
        return { success: true };
      }
      const manifest = JSON.parse(await fs.readFile(path.join(abilityDir, 'plugin.json'), 'utf8')) as { name?: string };
      await pluginRegistry.load();
      const existing = manifest.name ? pluginRegistry.get(manifest.name) : undefined;
      if (existing && !confirmConflict) return { success: false, error: `Conflict: plugin ${manifest.name} is already installed; confirmation required` };
      const installed = await installFromPath(abilityDir, { source: { type: 'marketplace', registry: source.id } });
      if (!installed.success || !installed.plugin) return { success: false, error: installed.errors.join('\n') || 'Marketplace plugin installation failed' };
      await this.ledger.upsert({ sourceId, type, slug, pluginName: installed.plugin.name, version: installed.plugin.version, installedAt: installed.plugin.installedAt, updatedAt: installed.plugin.updatedAt });
      return { success: true, plugin: installed.plugin };
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }

  private async readArchiveAbility(source: MarketplaceSource, relativeRoot: string): Promise<Map<string, Uint8Array>> {
    const token = await this.credentials.get(source.id);
    const extracted = await extractMarketplaceArchive(await readMarketplaceArchive(source, { cacheDirectory: this.cacheDirectory, token }));
    const files = new Map<string, Uint8Array>();
    const prefix = `${relativeRoot}/`;
    for (const [file, bytes] of extracted.files) {
      if (file === relativeRoot) files.set(path.posix.basename(relativeRoot), bytes);
      else if (file.startsWith(prefix)) files.set(file.slice(prefix.length), bytes);
    }
    if (!files.has('plugin.json') && !files.has('SKILL.md')) throw new Error('Marketplace ability source is missing plugin.json or SKILL.md');
    return files;
  }
}

export const openMarketplaceService = new OpenMarketplaceService();

export function cloudMarketplaceEnabled(): boolean { return cloud().enabled; }
