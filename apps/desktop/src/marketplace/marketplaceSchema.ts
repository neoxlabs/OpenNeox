import { posix } from 'node:path';
import { z } from 'zod';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const marketplaceAbilitySchema = z.object({
  type: z.enum(['plugin', 'skill']),
  slug: z.string().regex(SLUG),
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.string().regex(VERSION),
  category: z.string().default(''),
  tags: z.array(z.string()).default([]),
  source: z.object({ path: z.string().min(1) }),
}).passthrough();

export const marketplaceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().regex(SLUG),
  displayName: z.string().min(1).optional(),
  marketplaceVersion: z.string().regex(VERSION),
  repository: z.string().url(),
  minAppVersion: z.string().min(1),
  abilities: z.array(marketplaceAbilitySchema),
}).passthrough();

export type MarketplaceManifest = z.infer<typeof marketplaceManifestSchema>;
export type MarketplaceAbility = z.infer<typeof marketplaceAbilitySchema>;

export function normalizeMarketplacePath(value: string): string {
  const slashPath = value.replace(/\\/g, '/');
  if (slashPath.includes('\0') || slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath)) {
    throw new Error(`Marketplace source path must be relative: ${value}`);
  }
  const normalized = posix.normalize(slashPath).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Marketplace source path escapes root: ${value}`);
  }
  return normalized;
}

export function parseMarketplaceManifest(input: unknown): MarketplaceManifest {
  const parsed = marketplaceManifestSchema.parse(input);
  const manifest: MarketplaceManifest = {
    ...parsed,
    abilities: parsed.abilities.map((ability) => ({
      ...ability,
      source: { ...ability.source, path: normalizeMarketplacePath(ability.source.path) },
    })),
  };
  const seen = new Set<string>();
  for (const ability of manifest.abilities) {
    const key = `${ability.type}:${ability.slug}`;
    if (seen.has(key)) throw new Error(`Duplicate marketplace ability: ${key}`);
    seen.add(key);
  }
  return manifest;
}
