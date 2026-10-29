import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeGitHubRepository, validateMarketplaceRef } from './marketplaceSourceUrl.js';

export interface MarketplaceSource {
  id: string;
  name: string;
  repository: string;
  ref: string;
  enabled: boolean;
  autoUpdate: boolean;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
  credentialConfigured?: boolean;
}

interface SourceFile {
  version: 1;
  sources: MarketplaceSource[];
  registeredDefaultRepositories?: string[];
}

const idFor = (repository: string) => {
  const pathname = new URL(repository).pathname.slice(1).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `github-${pathname}`.slice(0, 96);
};

export interface MarketplaceSourceStoreOptions {
  filePath?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export class MarketplaceSourceStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: MarketplaceSourceStoreOptions = {}) {
    this.filePath = options.filePath ?? path.join(os.homedir(), '.neox', 'marketplace-sources.json');
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
  }

  list(): MarketplaceSource[] {
    const file = this.read();
    const sources = file?.sources ?? [];
    const defaults = this.defaultSources();
    let changed = !file;
    for (const source of defaults) {
      const found = sources.find((item) => item.repository === source.repository);
      if (!found && !(file?.registeredDefaultRepositories ?? []).includes(source.repository)) {
        sources.push(source);
        changed = true;
      } else if (found && found.builtin) {
        Object.assign(found, source, { enabled: found.enabled, autoUpdate: found.autoUpdate });
        changed = true;
      }
    }
    if (changed) this.write(sources, file?.registeredDefaultRepositories ?? defaults.map((item) => item.repository));
    return sources.map((source) => ({ ...source }));
  }

  add(input: { repository: string; name?: string; ref?: string }): MarketplaceSource {
    const sources = this.list();
    const repository = normalizeGitHubRepository(input.repository);
    if (sources.some((source) => source.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error(`Marketplace source already exists: ${repository}`);
    }
    const now = this.now().toISOString();
    const source: MarketplaceSource = {
      id: idFor(repository),
      name: input.name?.trim() || repository.split('/').at(-1)!,
      repository,
      ref: validateMarketplaceRef(input.ref),
      enabled: true,
      autoUpdate: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    if (sources.some((item) => item.id === source.id)) throw new Error(`Marketplace source id already exists: ${source.id}`);
    this.write([...sources, source], this.read()?.registeredDefaultRepositories ?? []);
    return { ...source };
  }

  update(id: string, patch: Partial<Pick<MarketplaceSource, 'name' | 'ref' | 'enabled' | 'autoUpdate'>>): MarketplaceSource {
    const sources = this.list();
    const index = sources.findIndex((source) => source.id === id);
    if (index < 0) throw new Error(`Marketplace source not found: ${id}`);
    const current = sources[index]!;
    if (current.builtin && (patch.name !== undefined || patch.ref !== undefined)) {
      throw new Error('Built-in marketplace source cannot be changed');
    }
    const next = {
      ...current,
      ...patch,
      ref: patch.ref === undefined ? current.ref : validateMarketplaceRef(patch.ref),
      updatedAt: this.now().toISOString(),
    };
    sources[index] = next;
    this.write(sources, this.read()?.registeredDefaultRepositories ?? []);
    return { ...next };
  }

  setCredentialConfigured(id: string, configured: boolean): MarketplaceSource {
    const sources = this.list();
    const index = sources.findIndex((source) => source.id === id);
    if (index < 0) throw new Error(`Marketplace source not found: ${id}`);
    const next = { ...sources[index]!, credentialConfigured: configured, updatedAt: this.now().toISOString() };
    sources[index] = next;
    this.write(sources, this.read()?.registeredDefaultRepositories ?? []);
    return { ...next };
  }

  remove(id: string): void {
    const sources = this.list();
    const current = sources.find((source) => source.id === id);
    if (!current) return;
    if (current.builtin) throw new Error('Built-in marketplace source cannot be removed');
    this.write(sources.filter((source) => source.id !== id), this.read()?.registeredDefaultRepositories ?? []);
  }

  private defaultSources(): MarketplaceSource[] {
    const repositoryValue = this.env.NEOX_OPEN_MARKETPLACE_REPOSITORY?.trim();
    if (!repositoryValue) return [];
    const repository = normalizeGitHubRepository(repositoryValue);
    const now = this.now().toISOString();
    return [{
      id: idFor(repository),
      name: repository.split('/').at(-1)!,
      repository,
      ref: validateMarketplaceRef(this.env.NEOX_OPEN_MARKETPLACE_REF),
      enabled: true,
      autoUpdate: true,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    }];
  }

  private read(): SourceFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SourceFile;
      if (raw.version !== 1 || !Array.isArray(raw.sources)) return null;
      return { ...raw, registeredDefaultRepositories: raw.registeredDefaultRepositories ?? [] };
    } catch { return null; }
  }

  private write(sources: MarketplaceSource[], registeredDefaultRepositories: string[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sources, registeredDefaultRepositories }, null, 2), 'utf8');
    fs.renameSync(temporary, this.filePath);
  }
}
