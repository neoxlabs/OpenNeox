import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { parseMarketplaceManifest, type MarketplaceManifest } from './marketplaceSchema.js';
import type { MarketplaceSource } from './marketplaceSourceStore.js';
import { marketplaceArchiveUrl } from './marketplaceSourceUrl.js';

export interface MarketplaceSnapshotEntry {
  type: 'plugin' | 'skill';
  slug: string;
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  sourcePath: string;
}

export interface MarketplaceSnapshot {
  sourceId: string;
  repository: string;
  ref: string;
  manifest: MarketplaceManifest;
  entries: MarketplaceSnapshotEntry[];
  fetchedAt: string;
}

export interface MarketplaceArchiveOptions {
  fetch?: typeof globalThis.fetch;
  token?: string;
  cacheDirectory?: string;
  now?: () => Date;
  refresh?: boolean;
}

export interface MarketplaceSyncResult {
  snapshot: MarketplaceSnapshot | null;
  fromCache: boolean;
  error?: string;
}

function snapshotPath(cacheDirectory: string, sourceId: string): string {
  return path.join(cacheDirectory, `${sourceId}.json`);
}

function archivePath(cacheDirectory: string, sourceId: string): string {
  return path.join(cacheDirectory, `${sourceId}.zip`);
}

async function readCached(cacheDirectory: string, sourceId: string): Promise<MarketplaceSnapshot | null> {
  try { return JSON.parse(await fs.readFile(snapshotPath(cacheDirectory, sourceId), 'utf8')) as MarketplaceSnapshot; } catch { return null; }
}

async function readCachedArchive(cacheDirectory: string, sourceId: string): Promise<Uint8Array | null> {
  try { return new Uint8Array(await fs.readFile(archivePath(cacheDirectory, sourceId))); } catch { return null; }
}

export async function downloadMarketplaceArchive(url: string, token: string | undefined, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<Uint8Array> {
  if (url.startsWith('file://')) return new Uint8Array(await fs.readFile(new URL(url)));
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response = await fetchImpl(url, { headers, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error(`Marketplace archive redirect missing location (HTTP ${response.status})`);
    response = await fetchImpl(new URL(location, url), { headers: { Accept: 'application/zip' }, redirect: 'follow' });
  }
  if (!response.ok) throw new Error(`Marketplace archive download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function archiveRoot(names: string[]): string {
  const roots = new Set(names.map((name) => name.split('/')[0]).filter(Boolean));
  if (roots.size !== 1) throw new Error('Marketplace archive must contain exactly one repository root');
  return [...roots][0]!;
}

export async function extractMarketplaceArchive(bytes: Uint8Array): Promise<{ manifest: MarketplaceManifest; files: Map<string, Uint8Array> }> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
  if (names.length > 10000) throw new Error('Marketplace archive contains too many files');
  const root = archiveRoot(names);
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    const relative = name.slice(root.length + 1).replace(/\\/g, '/');
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('Marketplace archive contains an unsafe path');
    files.set(relative, await zip.files[name]!.async('uint8array'));
  }
  const manifestBytes = files.get('.neox/marketplace.json');
  if (!manifestBytes) throw new Error('Marketplace archive is missing .neox/marketplace.json');
  if (manifestBytes.byteLength > 2 * 1024 * 1024) throw new Error('Marketplace manifest is too large');
  const manifest = parseMarketplaceManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  return { manifest, files };
}

export async function syncMarketplaceSource(source: MarketplaceSource, options: MarketplaceArchiveOptions = {}): Promise<MarketplaceSyncResult> {
  const cacheDirectory = options.cacheDirectory ?? path.join(os.homedir(), '.neox', 'marketplace-cache');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const cached = await readCached(cacheDirectory, source.id);
  if (options.refresh === false) {
    return { snapshot: cached, fromCache: cached !== null, error: cached ? undefined : 'Marketplace source has not been refreshed yet' };
  }
  try {
    const url = marketplaceArchiveUrl(source.repository, source.ref);
    const archive = await downloadMarketplaceArchive(url, options.token, fetchImpl);
    const { manifest } = await extractMarketplaceArchive(archive);
    if (!source.repository.startsWith('file://') && manifest.repository !== source.repository) {
      throw new Error('Marketplace manifest repository does not match its source');
    }
    const snapshot: MarketplaceSnapshot = {
      sourceId: source.id,
      repository: source.repository,
      ref: source.ref,
      manifest,
      entries: manifest.abilities.map((ability) => ({
        type: ability.type,
        slug: ability.slug,
        name: ability.name,
        description: ability.description,
        version: ability.version,
        category: ability.category,
        tags: ability.tags,
        sourcePath: ability.source.path,
      })),
      fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    await fs.mkdir(cacheDirectory, { recursive: true });
    await fs.writeFile(snapshotPath(cacheDirectory, source.id), JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.writeFile(archivePath(cacheDirectory, source.id), archive);
    return { snapshot, fromCache: false };
  } catch (error) {
    return { snapshot: cached, fromCache: true, error: error instanceof Error ? error.message : 'Marketplace source sync failed' };
  }
}

/** Read the source archive for installation, preferring the snapshot cache. */
export async function readMarketplaceArchive(source: MarketplaceSource, options: MarketplaceArchiveOptions = {}): Promise<Uint8Array> {
  const cacheDirectory = options.cacheDirectory ?? path.join(os.homedir(), '.neox', 'marketplace-cache');
  const cached = await readCachedArchive(cacheDirectory, source.id);
  if (cached) return cached;
  const url = marketplaceArchiveUrl(source.repository, source.ref);
  const archive = await downloadMarketplaceArchive(url, options.token, options.fetch ?? globalThis.fetch);
  await fs.mkdir(cacheDirectory, { recursive: true });
  await fs.writeFile(archivePath(cacheDirectory, source.id), archive);
  return archive;
}
