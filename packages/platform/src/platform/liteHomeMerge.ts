
import path from 'path';
import os from 'os';
import fs from 'fs';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

const LITE_HOME_DIRNAME = '.neox-lite';
const LITE_MERGE_SKIP_TOP = new Set([
  'logs', 'chrome-profiles', 'checkpoints', 'tasks', 'image-cache',
  '.migrated_to_global_v2', '.migrated_db_to_global_v2', '.merged_from_lite_v1',
]);
/* 极简版自己的库 (含 wal/shm) 一律不搬 */
function isLiteDbArtifact(name: string): boolean {
  return /\.db(-wal|-shm)?$/.test(name);
}

/** 递归合并 src → dst: 目标没有的搬过来, 两边都有的新的赢 (旧的留 .pre-lite-merge)。返回搬动的文件数。 */
function mergeTreeNewerWins(srcDir: string, dstDir: string, depth: number): number {
  let moved = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return 0; }
  fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  for (const ent of entries) {
    if (depth === 0 && (LITE_MERGE_SKIP_TOP.has(ent.name) || isLiteDbArtifact(ent.name))) continue;
    if (ent.isSymbolicLink()) continue;
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      moved += mergeTreeNewerWins(src, dst, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    let srcStat: fs.Stats;
    try { srcStat = fs.statSync(src); } catch { continue; }
    let dstStat: fs.Stats | null = null;
    try { dstStat = fs.statSync(dst); } catch { /* 目标没有 */ }
    if (dstStat) {
      /* 同一秒内的差别不算"更新" —— 两边可能是同一份被两个版本各写了一次 */
      if (srcStat.mtimeMs <= dstStat.mtimeMs + 1000) continue;
      try { fs.renameSync(dst, `${dst}.pre-lite-merge`); } catch { continue; }
    }
    try {
      fs.copyFileSync(src, dst);
      fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
      moved += 1;
    } catch { /* 单个文件失败不阻塞其它 */ }
  }
  return moved;
}

export function migrateLiteHomeToStandard(opts: { liteDir?: string; stdDir?: string } = {}): {
  skipped: boolean; files: number;
} {
  const liteDir = opts.liteDir ?? path.join(os.homedir(), LITE_HOME_DIRNAME);
  const stdDir = opts.stdDir ?? neoxHome();
  const markerFile = path.join(stdDir, '.merged_from_lite_v1');
  const writeMarker = () => {
    try { fs.mkdirSync(stdDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(markerFile, new Date().toISOString(), { mode: 0o600 }); } catch { /* 下次重试 */ }
  };
  try { if (fs.existsSync(markerFile)) return { skipped: true, files: 0 }; } catch { /* ignore */ }
  /* 同一个目录 (lite 分支上 neoxHome 就是 .neox-lite) 或压根没有极简版目录 → 没什么可合 */
  if (path.resolve(liteDir) === path.resolve(stdDir) || !fs.existsSync(liteDir)) {
    writeMarker();
    return { skipped: true, files: 0 };
  }

  let files = 0;
  try {
    files = mergeTreeNewerWins(liteDir, stdDir, 0);
    writeMarker();
  } catch (err) {
    console.warn('[lite-merge] file merge failed:', err);
  }
  return { skipped: false, files };
}
