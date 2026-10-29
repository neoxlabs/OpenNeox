import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { isDbFileInUseByOthers } from '../dbFileInUse.js';

describe.skipIf(process.platform === 'win32')('isDbFileInUseByOthers', () => {
  it('别的进程开着 → true; 它退出后 → false; 自己开着不算', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbinuse-'));
    const db = path.join(dir, 'neox-cli.db');
    fs.writeFileSync(db, 'x');
    const self = fs.openSync(db, 'r');
    expect(isDbFileInUseByOthers(db)).toBe(false);

    const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(db)}, 'r'); console.log('ready'); setTimeout(() => {}, 10000)`]);
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    expect(isDbFileInUseByOthers(db)).toBe(true);

    holder.kill();
    await new Promise((r) => holder.once('exit', r));
    expect(isDbFileInUseByOthers(db)).toBe(false);
    fs.closeSync(self);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
