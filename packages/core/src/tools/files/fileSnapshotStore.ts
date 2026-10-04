import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

import { getActiveConfigDir } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/** 单个文件超过这个大小就不快照 —— 快照本身不该成为磁盘负担 */
const MAX_SNAPSHOT_BYTES = Number(process.env.NEOX_SNAPSHOT_MAX_BYTES || 8 * 1024 * 1024);
/** 快照保留天数 */
const SNAPSHOT_TTL_MS = Number(process.env.NEOX_SNAPSHOT_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
/** 快照目录总量上限 */
const MAX_TOTAL_BYTES = Number(process.env.NEOX_SNAPSHOT_MAX_TOTAL_BYTES || 256 * 1024 * 1024);

export interface FileSnapshotMeta {
  id: string;
  /** 被快照的文件绝对路径 */
  filePath: string;
  savedAt: number;
  bytes: number;
  lines: number;
}

export interface SaveSnapshotResult {
  /** 存成功时的 id; 跳过时为 undefined */
  id?: string;
  bytes: number;
  lines: number;
  /** 没存的原因 —— 上层要能把"没有保护"如实告诉用户, 不能假装存了 */
  skipped?: 'too_large' | 'write_failed';
}

function snapshotDir(): string {
  return path.join(getActiveConfigDir(), 'file-snapshots');
}

function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

export async function saveFileSnapshot(filePath: string, content: string): Promise<SaveSnapshotResult> {
  const bytes = Buffer.byteLength(content, 'utf-8');
  const lines = content.length === 0 ? 0 : content.split('\n').length;

  if (bytes > MAX_SNAPSHOT_BYTES) {
    return { bytes, lines, skipped: 'too_large' };
  }

  try {
    const dir = snapshotDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const id = newId();
    /* 先写内容再写索引 —— 反过来的话中途崩溃会留下指向不存在文件的索引项 */
    await fs.writeFile(path.join(dir, `${id}.snap`), content, { encoding: 'utf-8', mode: 0o600 });
    const meta: FileSnapshotMeta = { id, filePath, savedAt: Date.now(), bytes, lines };
    await fs.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(meta) + '\n', { encoding: 'utf-8', mode: 0o600 });
    void pruneSnapshots();
    return { id, bytes, lines };
  } catch (e) {
    cliLogger.warn('Snapshot', `保存快照失败 (${filePath}): ${(e as Error)?.message ?? e}`);
    return { bytes, lines, skipped: 'write_failed' };
  }
}

/** 按 id 取回原内容; 取不到返回 null (已过期清理 / id 不存在). */
export async function readFileSnapshot(id: string): Promise<string | null> {
  /* id 只允许我们自己生成的字符集 —— 防路径穿越 (../../ 之类) */
  if (!/^[a-z0-9]+-[a-f0-9]{12}$/.test(id)) return null;
  try {
    return await fs.readFile(path.join(snapshotDir(), `${id}.snap`), 'utf-8');
  } catch {
    return null;
  }
}

/** 读索引 (给"最近快照"这类 UI 用). 索引损坏的行跳过, 不整体失败. */
export async function listFileSnapshots(): Promise<FileSnapshotMeta[]> {
  try {
    const raw = await fs.readFile(path.join(snapshotDir(), 'index.jsonl'), 'utf-8');
    const out: FileSnapshotMeta[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as FileSnapshotMeta;
        if (m && typeof m.id === 'string') out.push(m);
      } catch { /* 单行坏了不影响其它 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/* ── 删除前快照 ────────────────────────────────────────────────────────────
 * agent 的 delete_file 走 fs.rm 永久删, 而用户自己在文件树里删走的是系统回收站(可恢复)。
 * 同一个产品里两条删除路径, 用户删的能找回、agent 删的不能 —— 这是真实的体验断裂。
 * neox-core 是 CLI/桌面共用的, 拿不到 Electron 的 shell.trashItem, 所以这里用快照兜底:
 * 删之前把内容存下来, 至少"救得回来"。
 *
 * 目录删除会产生很多份快照, 但返回给调用方(最终会进 LLM 上下文)的只有**一个** manifest id。
 */

/** 目录快照预算 —— 超了就只保护前面这些, 并如实标 truncated, 不假装全护住了 */
const MAX_DELETE_SNAPSHOT_FILES = Number(process.env.NEOX_DELETE_SNAPSHOT_MAX_FILES || 2000);
const MAX_DELETE_SNAPSHOT_TOTAL_BYTES = Number(process.env.NEOX_DELETE_SNAPSHOT_MAX_BYTES || 64 * 1024 * 1024);

export interface DeletionManifest {
  kind: 'file' | 'directory';
  rootPath: string;
  savedAt: number;
  /** 相对 rootPath 的路径 → 内容快照 id (目录时可能只覆盖了一部分, 见 truncated) */
  entries: Array<{ relPath: string; snapshotId: string }>;
  truncated?: boolean;
  /** 没护住的文件数 (超预算 / 读不出, 例如二进制或权限) */
  skippedCount?: number;
}

export interface DeletionSnapshotResult {
  manifestId?: string;
  fileCount: number;
  truncated?: boolean;
  skippedCount?: number;
  skipped?: 'write_failed';
}

/** 删除前把内容存下来. 绝不抛 —— 快照失败不能阻断删除本身, 但会如实报告覆盖范围. */
export async function saveDeletionSnapshot(absPath: string): Promise<DeletionSnapshotResult> {
  const entries: Array<{ relPath: string; snapshotId: string }> = [];
  let truncated = false;
  let skippedCount = 0;
  let totalBytes = 0;
  let kind: 'file' | 'directory' = 'file';

  const snapshotOne = async (filePath: string, relPath: string): Promise<void> => {
    if (entries.length >= MAX_DELETE_SNAPSHOT_FILES || totalBytes >= MAX_DELETE_SNAPSHOT_TOTAL_BYTES) {
      truncated = true;
      return;
    }
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      skippedCount++; // 二进制 / 权限 / 符号链接 —— 护不住就如实计数
      return;
    }
    const saved = await saveFileSnapshot(filePath, content);
    if (saved.id) {
      entries.push({ relPath, snapshotId: saved.id });
      totalBytes += saved.bytes;
    } else {
      skippedCount++;
    }
  };

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skippedCount++;
      return;
    }
    for (const d of dirents) {
      if (truncated) return;
      const full = path.join(dir, d.name);
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(full, rel);
      else if (d.isFile()) await snapshotOne(full, rel);
      /* 符号链接不跟随 —— 跟了可能走出目录外, 甚至成环 */
    }
  };

  try {
    const stat = await fs.lstat(absPath);
    if (stat.isDirectory()) {
      kind = 'directory';
      await walk(absPath, '');
    } else {
      await snapshotOne(absPath, path.basename(absPath));
    }

    if (entries.length === 0) {
      return { fileCount: 0, truncated, skippedCount };
    }

    const manifest: DeletionManifest = {
      kind, rootPath: absPath, savedAt: Date.now(), entries,
      ...(truncated ? { truncated } : {}),
      ...(skippedCount ? { skippedCount } : {}),
    };
    /* manifest 自己也当成一份快照存 —— 于是返回值只需要带一个 id */
    const saved = await saveFileSnapshot(`${absPath}::deletion-manifest`, JSON.stringify(manifest));
    if (!saved.id) return { fileCount: entries.length, truncated, skippedCount, skipped: 'write_failed' };
    return { manifestId: saved.id, fileCount: entries.length, truncated, skippedCount };
  } catch (e) {
    cliLogger.warn('Snapshot', `删除前快照失败 (${absPath}): ${(e as Error)?.message ?? e}`);
    return { fileCount: entries.length, truncated, skippedCount, skipped: 'write_failed' };
  }
}

/** 按 manifest id 把删掉的东西写回原位. 返回实际恢复的文件数. */
export async function restoreDeletionSnapshot(manifestId: string): Promise<{
  success: boolean; restored: number; total: number; error?: string;
}> {
  const raw = await readFileSnapshot(manifestId);
  if (raw === null) {
    return { success: false, restored: 0, total: 0, error: '快照已过期或不存在(默认保留 7 天)' };
  }
  let manifest: DeletionManifest;
  try {
    manifest = JSON.parse(raw) as DeletionManifest;
  } catch {
    return { success: false, restored: 0, total: 0, error: '快照清单已损坏' };
  }

  let restored = 0;
  for (const entry of manifest.entries) {
    const content = await readFileSnapshot(entry.snapshotId);
    if (content === null) continue;
    const target = manifest.kind === 'directory'
      ? path.join(manifest.rootPath, entry.relPath)
      : manifest.rootPath;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      restored++;
    } catch { /* 单个文件失败不影响其它 */ }
  }
  return { success: restored > 0, restored, total: manifest.entries.length };
}

let pruning = false;

/** 清过期/超量快照. 并发只跑一个; 失败静默 (清理不是关键路径). */
export async function pruneSnapshots(): Promise<void> {
  if (pruning) return;
  pruning = true;
  try {
    const dir = snapshotDir();
    const metas = await listFileSnapshots();
    if (metas.length === 0) return;

    const now = Date.now();
    const keep: FileSnapshotMeta[] = [];
    const drop: FileSnapshotMeta[] = [];

    /* 先按过期切一刀 */
    for (const m of metas) {
      (now - m.savedAt > SNAPSHOT_TTL_MS ? drop : keep).push(m);
    }

    /* 再按总量切 —— 从最旧的开始丢, 直到落回上限内 */
    keep.sort((a, b) => a.savedAt - b.savedAt);
    let total = keep.reduce((s, m) => s + m.bytes, 0);
    while (total > MAX_TOTAL_BYTES && keep.length > 0) {
      const oldest = keep.shift()!;
      total -= oldest.bytes;
      drop.push(oldest);
    }

    if (drop.length === 0) return;

    for (const m of drop) {
      try { await fs.unlink(path.join(dir, `${m.id}.snap`)); } catch { /* 已经没了就算了 */ }
    }
    /* 索引重写成保留项 —— 用临时文件 + rename, 防中途崩溃把索引写残 */
    const tmp = path.join(dir, `index.jsonl.tmp.${process.pid}`);
    await fs.writeFile(tmp, keep.map((m) => JSON.stringify(m)).join('\n') + (keep.length ? '\n' : ''), {
      encoding: 'utf-8', mode: 0o600,
    });
    await fs.rename(tmp, path.join(dir, 'index.jsonl'));
  } catch {
    /* 清理失败不影响任何主流程 */
  } finally {
    pruning = false;
  }
}
