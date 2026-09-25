#!/usr/bin/env node
/**
 * schemas/ lint — pure load + validate. Standalone so CI can run it without
 *   importing the full kernel. Exits 0 on success, 1 on any failure.
 *
 *   Usage: node scripts/schema-lint.mjs
 *   Also wired into package.json as `npm run schema:lint` (TODO once Phase 2).
 */

import { fileURLToPath } from 'node:url';
import { loadSchemas } from '../packages/kernel/dist/schemas/loader.js';

try {
  /* fileURLToPath: Windows 上 .pathname 是 `/E:/...`, 加载器按它找目录会空手而归 */
  const registry = loadSchemas({ dir: fileURLToPath(new URL('../schemas/', import.meta.url)) });
  const { protocols, providers, models } = registry;
  console.log(`✓ schemas valid · ${protocols.size} protocols · ${providers.size} providers · ${models.size} models`);
  process.exit(0);
} catch (e) {
  console.error('✗ schema lint failed:');
  console.error(e?.stack ?? e?.message ?? e);
  process.exit(1);
}
