/**
 * Version management - single source of truth
 * All version numbers should be read from package.json
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedVersion: string | null = null;

/**
 * Build-time 版本注入 (Bun --compile / esbuild --define).
 *   bun build src/main.ts --compile --define '__NEOX_VERSION__="2.2.0"'  → 把 __NEOX_VERSION__
 *   字面替换成 "2.2.0", runtime 不再需要读 package.json (Bun binary 里 path 失效).
 *
 *   dev path (tsx / Electron) 走 fallback 读 package.json 三个候选 path.
 *   两条路径都不工作时, fallback 到硬编码版本.
 */
declare const __NEOX_VERSION__: string | undefined;

/**
 * Get application version from package.json
 * This is the single source of truth for version numbers
 */
export function getVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  /* Build-time 注入优先 — Bun --compile binary 路径走这里 */
  if (typeof __NEOX_VERSION__ !== 'undefined' && __NEOX_VERSION__) {
    cachedVersion = __NEOX_VERSION__;
    return cachedVersion;
  }

  try {
    // Try multiple possible locations for package.json
    const possiblePaths = [
      join(__dirname, '../package.json'),           // Development: src/ → package.json
      join(__dirname, '../../package.json'),        // Built: dist/cli/ → package.json
      join(__dirname, '../../../package.json'),     // Built in nested: dist/ui-electron/electron/ → package.json
    ];

    for (const packageJsonPath of possiblePaths) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        if (typeof packageJson.name === 'string' && /^@(neoxlabs|mk-co)\//.test(packageJson.name)) {
          continue;
        }
        if (packageJson.version) {
          cachedVersion = packageJson.version;
          return cachedVersion!;
        }
      } catch {
        // Try next path
        continue;
      }
    }

    // If all paths fail, use fallback
    throw new Error('package.json not found');
  } catch (error) {
    // Fallback version if package.json cannot be read
    // This should match the version in package.json
    cachedVersion = '3.1.9';
  }

  return cachedVersion!;
}

/**
 * Get version with 'v' prefix (e.g., 'v2.0.6')
 */
export function getVersionWithPrefix(): string {
  return `v${getVersion()}`;
}

/**
 * Current version (cached at module load time)
 */
export const VERSION = getVersion();
