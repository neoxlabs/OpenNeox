import { BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { watchSingleFile, type SingleFileWatcher } from './watchSingleFile.js';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  getActiveConfigFile,
} from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

type ProvidersChangedSource = 'fs-watch' | 'ipc';

interface ProvidersChangedPayload {
  source: ProvidersChangedSource;
  path: string;
  exists: boolean;
  mtimeMs: number;
}

let watcher: SingleFileWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let watchedConfigPath: string | null = null;
let lastBroadcastKey = '';

const DEBOUNCE_MS = 200;

function buildBroadcastKey(payload: ProvidersChangedPayload): string {
  return `${payload.path}|${payload.exists ? '1' : '0'}|${Math.round(payload.mtimeMs)}`;
}

function broadcastProvidersChanged(payload: ProvidersChangedPayload): void {
  const key = buildBroadcastKey(payload);
  if (key === lastBroadcastKey) return;
  lastBroadcastKey = key;

  let sent = 0;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send('providers:changed', payload);
    sent++;
  }
  cliLogger.info(
    'PROVIDER_WATCHER',
    `broadcast source=${payload.source} exists=${payload.exists} windows=${sent} path=${payload.path}`,
  );
}

async function resolvePayload(source: ProvidersChangedSource): Promise<ProvidersChangedPayload> {
  const path = getActiveConfigFile();
  let exists = false;
  let mtimeMs = 0;

  try {
    const fileStat = await stat(path);
    exists = true;
    mtimeMs = fileStat.mtimeMs;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      cliLogger.warn('PROVIDER_WATCHER', `stat failed: ${err?.message ?? err}`);
    }
  }

  return { source, path, exists, mtimeMs };
}

async function handleConfigFileChange(source: ProvidersChangedSource): Promise<void> {
  try {
    const payload = await resolvePayload(source);
    broadcastProvidersChanged(payload);
  } catch (err: any) {
    cliLogger.warn('PROVIDER_WATCHER', `handle change failed: ${err?.message ?? err}`);
  }
}

function closeWatcher(): void {
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function installWatcherForActiveConfig(): void {
  const nextConfigPath = getActiveConfigFile();
  if (watcher && watchedConfigPath === nextConfigPath) return;

  closeWatcher();
  watchedConfigPath = nextConfigPath;

  const configDir = dirname(nextConfigPath);
  try {
    mkdirSync(configDir, { recursive: true });
  } catch (err: any) {
    cliLogger.warn('PROVIDER_WATCHER', `mkdir failed: ${err?.message ?? err}`);
  }

  try {
    watcher = watchSingleFile(nextConfigPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void handleConfigFileChange('fs-watch'); }, DEBOUNCE_MS);
    });
    cliLogger.info('PROVIDER_WATCHER', `installed file=${nextConfigPath} dir=${configDir} mode=${watcher.mode()}`);
  } catch (err: any) {
    cliLogger.warn('PROVIDER_WATCHER', `install failed: ${err?.message ?? err}`);
  }
}

export function installProviderConfigWatcher(): void {
  installWatcherForActiveConfig();
}

export function notifyProvidersChanged(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (watchedConfigPath) {
      closeWatcher();
      installWatcherForActiveConfig();
    }
    void handleConfigFileChange('ipc');
  }, DEBOUNCE_MS);
}

export function uninstallProviderConfigWatcher(): void {
  closeWatcher();
  watchedConfigPath = null;
}
