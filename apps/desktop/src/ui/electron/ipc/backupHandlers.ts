
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { getNeoxArtifactsRoot } from '../services/neoxArtifacts.js';
import { app } from 'electron';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

function isZhUi(): boolean {
  try {
    return configService.getLanguagePreference() !== 'en';
  } catch {
    try { return app.getLocale().toLowerCase().startsWith('zh'); } catch { return true; }
  }
}

/* ==================== zip 流式写入 ==================== */

/* zip32 硬上限 — 超限 offset/count 字段溢出会产出坏包, 直接明确报错 */
const ZIP32_MAX_BYTES = 0xffff_0000;
const ZIP32_MAX_ENTRIES = 0xffff;
/* 小文本压一压 (config/session json 压缩比高); 大文件/二进制 STORE 原样 */
const DEFLATE_MAX_BYTES = 8 * 1024 * 1024;
const DEFLATE_EXT_RE = /\.(json|md|txt|log|yaml|yml)$/i;

interface ZipSource {
  /** zip 内路径 (用 / 分隔) */
  zipName: string;
  /** 磁盘绝对路径 (与 content 二选一) */
  absPath?: string;
  /** 内存内容 (manifest 等小文件) */
  content?: Buffer;
  size: number;
}

interface CentralEntry {
  nameBuf: Buffer;
  crc: number;
  compSize: number;
  uncompSize: number;
  method: number;
  offset: number;
}

/* 文件名按 UTF-8 编码, 必须置 EFS 标志位 (bit 11) — 否则解压器按 CP437 解,
 * 中文文件名 (工作区/文档常见) 会乱码甚至解不出 */
const FLAG_UTF8 = 0x0800;

function localHeader(nameBuf: Buffer, method: number, crc: number, compSize: number, uncompSize: number): Buffer {
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4);            // version needed
  buf.writeUInt16LE(FLAG_UTF8, 6);     // flags
  buf.writeUInt16LE(method, 8);        // 0=STORE 8=DEFLATE
  buf.writeUInt16LE(0, 10);            // mod time (跟 createSimpleStoredZip 同: 不记时间)
  buf.writeUInt16LE(0, 12);            // mod date
  buf.writeUInt32LE(crc, 14);
  buf.writeUInt32LE(compSize, 18);
  buf.writeUInt32LE(uncompSize, 22);
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);            // extra len
  nameBuf.copy(buf, 30);
  return buf;
}

/**
 * 把 sources 流式写成 zip. 返回 zip 总字节数.
 *   小文本: 整读 + DEFLATE (内存可控); 其余: 两遍流式 (第一遍算 crc, 第二遍写数据) —
 *   避免 data descriptor (部分老解压器不认), 也避免大文件整包驻内存.
 */
async function writeZipStreaming(targetPath: string, sources: ZipSource[]): Promise<number> {
  if (sources.length > ZIP32_MAX_ENTRIES) {
    throw new Error(isZhUi()
      ? `备份文件数 ${sources.length} 超过 zip 上限 ${ZIP32_MAX_ENTRIES}, 请手动备份`
      : `File count ${sources.length} exceeds the zip limit of ${ZIP32_MAX_ENTRIES}; please back up manually`);
  }
  const out = createWriteStream(targetPath);
  let outError: Error | null = null;
  out.on('error', (e: Error) => { outError = e; });
  let offset = 0;
  const write = async (buf: Buffer): Promise<void> => {
    if (outError) throw outError;
    offset += buf.length;
    if (offset > ZIP32_MAX_BYTES) {
      throw new Error(isZhUi()
        ? '备份数据超过 4GB (zip32 上限), 请手动备份'
        : 'Backup exceeds 4GB (zip32 limit); please back up manually');
    }
    if (!out.write(buf)) await once(out, 'drain');
    if (outError) throw outError;
  };

  const central: CentralEntry[] = [];
  try {
    for (const src of sources) {
      const nameBuf = Buffer.from(src.zipName, 'utf8');
      const entryOffset = offset;

      if (src.content !== undefined || (src.size <= DEFLATE_MAX_BYTES && DEFLATE_EXT_RE.test(src.zipName))) {
        const content = src.content ?? await readFile(src.absPath!);
        const compressed = deflateRawSync(content);
        const crc = crc32(content);
        await write(localHeader(nameBuf, 8, crc, compressed.length, content.length));
        await write(compressed);
        central.push({ nameBuf, crc, compSize: compressed.length, uncompSize: content.length, method: 8, offset: entryOffset });
        continue;
      }

      /* STORE 两遍流式: pass1 crc, pass2 写数据. 备份期间文件被改写会导致长度对不上 —
       * 直接报错重来, 不产出坏包. */
      let crc = 0;
      let measured = 0;
      for await (const chunk of createReadStream(src.absPath!)) {
        crc = crc32(chunk as Buffer, crc);
        measured += (chunk as Buffer).length;
      }
      await write(localHeader(nameBuf, 0, crc, measured, measured));
      const modifiedDuringBackup = () => new Error(isZhUi()
        ? `备份期间文件被修改: ${src.zipName}, 请重试`
        : `File changed during backup: ${src.zipName}; please retry`);
      let written = 0;
      for await (const chunk of createReadStream(src.absPath!)) {
        written += (chunk as Buffer).length;
        if (written > measured) throw modifiedDuringBackup();
        await write(chunk as Buffer);
      }
      if (written !== measured) throw modifiedDuringBackup();
      central.push({ nameBuf, crc, compSize: measured, uncompSize: measured, method: 0, offset: entryOffset });
    }

    /* central directory + EOCD */
    const cdStart = offset;
    for (const e of central) {
      const cd = Buffer.alloc(46 + e.nameBuf.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(FLAG_UTF8, 8);
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.compSize, 20);
      cd.writeUInt32LE(e.uncompSize, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(e.offset, 42);
      e.nameBuf.copy(cd, 46);
      await write(cd);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await write(eocd);

    out.end();
    await once(out, 'close');
    return offset;
  } catch (err) {
    out.destroy();
    try { await unlink(targetPath); } catch { /* 半截 zip 清不掉就留着, 报错已让用户重试 */ }
    throw err;
  }
}

/* ==================== 备份内容收集 ==================== */

/** ~/.neox 下整目录排除的一级子目录 (见文件头注释) */
const NEOX_DIR_EXCLUDES = new Set(['logs', 'models', 'bin', 'chrome-profiles']);
/** 原子写残留: config.json.tmp.<pid> / foo.tmp */
const TMP_FILE_RE = /\.tmp(\.|$)/;

/** 递归收集 ~/.neox 下要备份的文件 (跳过 symlink/socket 等非常规文件) */
async function collectNeoxHomeFiles(root: string): Promise<ZipSource[]> {
  const result: ZipSource[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录读不了 (权限/竞态删除) — 跳过, 不让单目录失败毁掉整个备份
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!rel && NEOX_DIR_EXCLUDES.has(ent.name)) continue;
        await walk(join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        if (TMP_FILE_RE.test(ent.name)) continue;
        try {
          const st = await stat(join(dir, ent.name));
          result.push({ zipName: `.neox/${relPath}`, absPath: join(dir, ent.name), size: st.size });
        } catch { /* 竞态删除 — 跳过 */ }
      }
      /* symlink/socket (如 daemon sock) 不进备份 */
    }
  };
  await walk(root, '');
  return result;
}

async function collectArtifactsFiles(root: string): Promise<ZipSource[]> {
  const result: ZipSource[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 (从没生成过图) / 读不了 — 跳过, 不影响其余备份
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        if (TMP_FILE_RE.test(ent.name)) continue;
        try {
          const st = await stat(join(dir, ent.name));
          result.push({ zipName: `neox-artifacts/${relPath}`, absPath: join(dir, ent.name), size: st.size });
        } catch { /* 竞态删除 — 跳过 */ }
      }
    }
  };
  await walk(root, '');
  return result;
}

/** 会话 SQLite 三件套 (+同目录 CLI 库) — 拷前 best-effort checkpoint, 风险见文件头 */
async function collectSqliteFiles(): Promise<ZipSource[]> {
  const raw = getDatabase().getRawDb();
  try {
    raw.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* 其他连接持锁 — 照拷 db+wal, 见文件头一致性注释 */ }

  const activeDbPath = String(raw.name);
  const result: ZipSource[] = [];
  const candidates = [activeDbPath, join(dirname(activeDbPath), 'neox-cli.db')];
  for (const dbPath of candidates) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      try {
        const st = await stat(p);
        if (st.isFile()) result.push({ zipName: `sqlite/${basename(p)}`, absPath: p, size: st.size });
      } catch { /* 不存在 (wal 已 checkpoint / 无 CLI 库) — 正常 */ }
    }
  }
  return result;
}

/* ==================== IPC ==================== */

export function registerBackupIpcHandlers(): void {
  /* 一键备份: 选保存路径 → ~/.neox + 会话库 + neox-artifacts 打成一个 zip.
   * 返回 { ok, path, sizeBytes } / 取消 { ok:false, canceled:true } / 失败 { ok:false, error } */
  ipcMain.handle('storage:backup-all', async (event) => {
    try {
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const dialogOptions = {
        title: 'Backup Neox data',
        defaultPath: `Neox-backup-${ymd}.zip`,
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      };
      const senderWindow = BrowserWindow.fromWebContents(event?.sender);
      const target = senderWindow
        ? await dialog.showSaveDialog(senderWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (target.canceled || !target.filePath) return { ok: false, canceled: true };

      const neoxHome = join(homedir(), NEOX_HOME_DIRNAME);
      const artifactsRoot = getNeoxArtifactsRoot();
      const sources = [
        ...await collectNeoxHomeFiles(neoxHome),
        ...await collectSqliteFiles(),
        ...await collectArtifactsFiles(artifactsRoot),
      ];
      if (sources.length === 0) return { ok: false, error: isZhUi() ? '没有找到可备份的数据' : 'No data found to back up' };

      /* manifest: 记录原始路径映射, 恢复时知道各文件该回哪个根目录 */
      const manifest = Buffer.from(JSON.stringify({
        createdAt: new Date().toISOString(),
        roots: {
          '.neox/': neoxHome,
          'sqlite/': dirname(String(getDatabase().getRawDb().name)),
          'neox-artifacts/': artifactsRoot,
        },
        /* manifest 是恢复时的机读参考 — 统一英文, 不随 UI 语言变 */
        excluded: [...NEOX_DIR_EXCLUDES].map(name => `${name}/`).concat(['*.tmp', 'IndexedDB timeline (migrated to SQLite single source of truth)']),
        fileCount: sources.length,
      }, null, 2));
      sources.unshift({ zipName: 'manifest.json', content: manifest, size: manifest.length });

      const sizeBytes = await writeZipStreaming(target.filePath, sources);
      return { ok: true, path: target.filePath, sizeBytes };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
