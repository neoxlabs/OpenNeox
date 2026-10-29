import fs from 'fs';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { peekLooksLikePlaintextSqliteFile } from './databasePerUserMigrate.js';
import { isDbFileInUseByOthers } from './dbFileInUse.js';

export function setAsideEncryptedDbForBun(finalPath: string): void {
  try {
    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0 || peekLooksLikePlaintextSqliteFile(finalPath)) return;
    if (isDbFileInUseByOthers(finalPath)) {
      throw Object.assign(
        new Error(`会话库 ${finalPath} 是加密格式, 正被另一个 Neox 进程 (开发版 / 桌面端) 使用, 这个版本打不开它。请先退出那个进程再启动。`),
        { dbInUse: true },
      );
    }
    const keptPath = `${finalPath}.encrypted.${Date.now()}`;
    fs.renameSync(finalPath, keptPath);
    for (const suffix of ['-wal', '-shm']) {
      try { if (fs.existsSync(finalPath + suffix)) fs.renameSync(finalPath + suffix, keptPath + suffix); } catch { /* best-effort */ }
    }
    cliLogger.warn('DATABASE', `encrypted db from an older Node build can't be opened here; kept at ${keptPath}, starting a fresh one`);
  } catch (err: any) {
    if (err?.dbInUse) throw err;
    try { cliLogger.warn('DATABASE', `encrypted-db check failed: ${err?.message ?? err}`); } catch { /* logger 没起 */ }
  }
}
