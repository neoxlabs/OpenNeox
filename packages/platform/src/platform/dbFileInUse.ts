import fs from 'fs';
import { execFileSync } from 'child_process';

export function isDbFileInUseByOthers(dbPath: string): boolean {
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) => fs.existsSync(p));
  if (targets.length === 0) return false;
  if (process.platform !== 'win32') {
    try {
      const out = execFileSync('lsof', ['-t', ...targets], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
      return out.split(/\s+/).filter(Boolean).some((pid) => Number(pid) !== process.pid);
    } catch (err: any) {
      /* lsof 没有持有者时退出码 1、stdout 为空 —— 这就是「没人用」 */
      if (err && typeof err.status === 'number' && err.status === 1 && !String(err.stdout ?? '').trim()) return false;
      /* lsof 不存在 / 超时: 落到下面的保守判断 */
    }
  }
  return fs.existsSync(`${dbPath}-shm`);
}
