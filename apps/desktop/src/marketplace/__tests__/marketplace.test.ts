import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { parseMarketplaceManifest } from '../marketplaceSchema.js';
import { MarketplaceSourceStore } from '../marketplaceSourceStore.js';
import { extractMarketplaceArchive, readMarketplaceArchive, syncMarketplaceSource } from '../marketplaceArchive.js';

const manifest = {
  schemaVersion: 1, name: 'demo-market', displayName: 'Demo', marketplaceVersion: '1.0.0',
  repository: 'https://github.com/acme/demo', minAppVersion: '1.0.0',
  abilities: [{ type: 'plugin', slug: 'hello', name: 'Hello', version: '1.0.0', source: { path: 'plugins/hello' } }],
};

async function archive(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('demo-main/.neox/marketplace.json', JSON.stringify(manifest));
  zip.file('demo-main/plugins/hello/plugin.json', JSON.stringify({ name: 'hello', version: '1.0.0' }));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('open marketplace', () => {
  it('normalizes paths and rejects duplicates or traversal', () => {
    expect(parseMarketplaceManifest(manifest).abilities[0]!.source.path).toBe('plugins/hello');
    expect(() => parseMarketplaceManifest({ ...manifest, abilities: [{ ...manifest.abilities[0], source: { path: '../escape' } }] })).toThrow();
    expect(() => parseMarketplaceManifest({ ...manifest, abilities: [manifest.abilities[0], manifest.abilities[0]] })).toThrow(/Duplicate/);
  });

  it('migrates source files and does not register an unset default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-market-source-'));
    const store = new MarketplaceSourceStore({ filePath: path.join(dir, 'sources.json'), env: {} });
    expect(store.list()).toEqual([]);
    const source = store.add({ repository: 'acme/demo', ref: 'main' });
    expect(source.repository).toBe('https://github.com/acme/demo');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'sources.json'), 'utf8')).version).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('downloads zip archives and falls back to the cached snapshot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-market-cache-'));
    const bytes = await archive();
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    const source = { id: 'github-acme-demo', name: 'demo', repository: 'https://github.com/acme/demo', ref: 'main', enabled: true, autoUpdate: true, builtin: false, createdAt: '', updatedAt: '' };
    const first = await syncMarketplaceSource(source, { cacheDirectory: dir, fetch: fetchMock as any });
    expect(first.fromCache).toBe(false);
    expect(first.snapshot?.entries[0]?.slug).toBe('hello');
    const failed = await syncMarketplaceSource(source, { cacheDirectory: dir, fetch: vi.fn(async () => new Response(null, { status: 503 })) as any });
    expect(failed.fromCache).toBe(true);
    expect(failed.snapshot?.entries[0]?.slug).toBe('hello');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('supports file archive fixtures and keeps auto-update disabled sources offline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-market-file-'));
    const archivePath = path.join(dir, 'marketplace.zip');
    await fs.writeFile(archivePath, await archive());
    const source = {
      id: 'file-demo', name: 'demo', repository: `file://${archivePath}`, ref: 'main',
      enabled: true, autoUpdate: false, builtin: false, createdAt: '', updatedAt: '',
    };
    const first = await syncMarketplaceSource(source, { cacheDirectory: path.join(dir, 'cache') });
    expect(first.snapshot?.entries[0]?.slug).toBe('hello');
    const offlineFetch = vi.fn();
    const cached = await syncMarketplaceSource(source, { cacheDirectory: path.join(dir, 'cache'), fetch: offlineFetch, refresh: false });
    expect(cached.fromCache).toBe(true);
    expect(offlineFetch).not.toHaveBeenCalled();
    expect((await extractMarketplaceArchive(await readMarketplaceArchive(source, { cacheDirectory: path.join(dir, 'cache') }))).manifest.name).toBe('demo-market');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not forward a token across archive redirects', async () => {
    const bytes = await archive();
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://signed.example/archive.zip' } });
      return new Response(bytes, { status: 200 });
    });
    const extracted = await (await import('../marketplaceArchive.js')).extractMarketplaceArchive(bytes);
    expect(extracted.manifest.name).toBe('demo-market');
    const source = { id: 'github-acme-demo', name: 'demo', repository: 'https://github.com/acme/demo', ref: 'main', enabled: true, autoUpdate: true, builtin: false, createdAt: '', updatedAt: '' };
    await syncMarketplaceSource(source, { cacheDirectory: await fs.mkdtemp(path.join(os.tmpdir(), 'neox-market-')), fetch: fetchMock as any, token: 'secret-token' });
    expect(new Headers(calls[0]?.headers).get('authorization')).toBe('Bearer secret-token');
    expect(new Headers(calls[1]?.headers).get('authorization')).toBeNull();
  });
});
