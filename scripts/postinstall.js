#!/usr/bin/env node

/**
 * Smart postinstall script
 *
 * Only rebuild Electron native modules if:
 * 1. Electron UI dependencies are needed (electron is installed)
 * 2. Native module installation succeeded
 * 3. Not in CI environment
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Check if we're in CI environment
const isCI = process.env.CI === 'true' || process.env.CONTINUOUS_INTEGRATION === 'true';

if (isCI) {
  console.log('⏭️  Skipping postinstall in CI environment');
  process.exit(0);
}

// Check if electron is installed (indicates UI development)
const electronPath = join(rootDir, 'node_modules', 'electron');
const hasElectron = existsSync(electronPath);

// Check if native modules are installed
const nodePtyPath = join(rootDir, 'node_modules', 'node-pty');
const betterSqlite3Path = join(rootDir, 'node_modules', 'better-sqlite3');
const hasNodePty = existsSync(nodePtyPath);
const hasBetterSqlite3 = existsSync(betterSqlite3Path);

if (!hasElectron && !hasNodePty && !hasBetterSqlite3) {
  console.log('');
  console.log('✅ Neox CLI installed successfully (lightweight mode)');
  console.log('');
  console.log('📦 Installed: CLI + Terminal UI only');
  console.log('💡 To install Electron UI (optional):');
  console.log('   npm install --include=optional');
  console.log('');
  process.exit(0);
}

if (!hasElectron && (hasNodePty || hasBetterSqlite3)) {
  console.log('');
  console.log('⚠️  Note: Electron native modules installed but Electron not found');
  console.log('   Electron UI features will be unavailable');
  console.log('');
  process.exit(0);
}

if (!hasNodePty || !hasBetterSqlite3) {
  console.log('');
  console.log('⚠️  Electron found but native modules are incomplete');
  if (!hasNodePty) {
    console.log('   - missing: node-pty');
  }
  if (!hasBetterSqlite3) {
    console.log('   - missing: better-sqlite3');
  }
  console.log('   Terminal or storage features in Electron UI will be unavailable');
  console.log('   Run: npm install --include=optional');
  console.log('');
  process.exit(0);
}

// Try to rebuild native modules for Electron
console.log('');
console.log('🔨 Rebuilding Electron native modules...');

try {
  execSync('electron-rebuild -f -w node-pty,better-sqlite3', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  execSync('node scripts/fix-native-module-signatures.cjs', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log('');
  console.log('✅ Neox CLI + Electron UI installed successfully');
  console.log('');
  console.log('📦 Installed: CLI + Terminal UI + Electron UI');
  console.log('🚀 Run: npm run ui:dev (Electron UI)');
  console.log('🚀 Run: neox (Terminal UI)');
  console.log('');
} catch (error) {
  console.error('');
  console.error('❌ Electron native module rebuild failed');
  console.error('   Electron UI terminal or storage features may not work');
  console.error('   Error:', error.message);
  console.error('');
  console.error('💡 Solutions:');
  console.error('   Windows: npm install --global windows-build-tools');
  console.error('   macOS: xcode-select --install');
  console.error('   Linux: sudo apt-get install build-essential');
  console.error('');

  // Don't fail the installation
  process.exit(0);
}
