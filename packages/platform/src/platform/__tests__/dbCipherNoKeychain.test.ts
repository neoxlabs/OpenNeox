import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * If dbCipher ever regresses to a static or startup import of keytar, this
 * factory throws and the test fails while loading the module.
 */
vi.mock('keytar', () => {
  throw new Error('keytar must not be loaded by dbCipher startup path');
});

import {
  _resetMasterKeyCache,
  bootstrapMasterKey,
  getMasterKeyHex,
  getMasterKeySource,
} from '../dbCipher.js';

let tempHome: string | null = null;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

function machineIdPath(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Neox', 'machine-id');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Neox', 'machine-id');
  }
  return path.join(home, '.config', 'neox', 'machine-id');
}

afterEach(() => {
  _resetMasterKeyCache();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const name of Object.keys(savedEnv)) delete savedEnv[name];
  if (tempHome) {
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* noop */ }
    tempHome = null;
  }
});

describe('dbCipher startup path', () => {
  it('uses machine-id without loading keytar', async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbcipher-'));
    setEnv('HOME', tempHome);
    setEnv('APPDATA', path.join(tempHome, 'AppData', 'Roaming'));
    setEnv('XDG_CONFIG_HOME', path.join(tempHome, '.config'));

    const idPath = machineIdPath(tempHome);
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, 'test-machine-id');

    await bootstrapMasterKey();

    expect(getMasterKeySource()).toBe('machine-id');
    expect(getMasterKeyHex()).toMatch(/^[0-9a-f]{64}$/);
  });
});
