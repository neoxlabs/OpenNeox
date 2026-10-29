/**
 * petStorage — 用户导入的桌宠 .glb 文件存储 + 元数据管理
 *
 * 文件: <userData>/pets/<uuid>.glb           — 二进制
 * 索引: <userData>/pets/index.json           — { skins: [{ id, name, fileName, sizeBytes, importedAt }] }
 *
 * <userData> = app.getPath('userData') — macOS 是 ~/Library/Application Support/Neox,
 * Windows 是 %APPDATA%\Neox, Linux 是 ~/.config/Neox. 跟 config.json 同目录, 不污染
 * workspace, 也不进 git.
 *
 * 校验:
 *   · 文件大小 < 20MB (避免用户拖 game-quality model)
 *   · 前 4 字节 == "glTF" (magic bytes, 防伪造扩展名)
 *
 * 删除策略: 用户删某 skin → 同时删 .glb 文件 + 从 index 移除. 删失败 (文件被锁等)
 * 不阻塞索引更新, 文件留到下次 startup gc.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import JSZip from 'jszip';

const MAX_BYTES = 20 * 1024 * 1024; /* 20MB */

/* Codex Pets / OpenPets 图集约定: 8 列 × 9 行 */
const ATLAS_COLS = 8;
const ATLAS_ROWS = 9;
const GLTF_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46]); /* "glTF" */

/* PNG magic bytes (89 50 4E 47), WebP magic ("RIFF" + ..."WEBP"). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
function isWebP(buf: Buffer): boolean {
  /* RIFF....WEBP — 前 4 字节 RIFF, 第 8-11 字节 WEBP */
  return buf.length >= 12
    && buf.slice(0, 4).toString('ascii') === 'RIFF'
    && buf.slice(8, 12).toString('ascii') === 'WEBP';
}

export interface PetCustomSkin {
  /** 'custom-<uuid>', 跟内置 'robo-orange' 等区分 */
  id: string;
  /** 用户给的名字 (默认是源文件名去掉 .glb 扩展名) */
  name: string;
  /** userData/pets/<fileName>, 仅文件名, 不含路径 */
  fileName: string;
  /** 字节数, 显示用 */
  sizeBytes: number;
  /** 导入时间戳 (ms) */
  importedAt: number;
}

export interface PetCustomSprite {
  /** 'sprite-<uuid>' */
  id: string;
  name: string;
  /** 在 userData/pets/sprites/ 下的文件名 (含 .webp / .png 扩展名) */
  fileName: string;
  sizeBytes: number;
  importedAt: number;
  /** 单元格宽 (px) — 整图宽 / 8. 渲染器据此定位帧, 缺省回退内置 192. */
  cellWidth?: number;
  /** 单元格高 (px) — 整图高 / 9. 缺省回退内置 208. */
  cellHeight?: number;
  /** 来源描述 (Codex Pets manifest.description / 用户备注), 卡片显示用 */
  description?: string;
}

interface PetIndex {
  skins: PetCustomSkin[];
  sprites?: PetCustomSprite[];
}

function petsDir(): string {
  return join(app.getPath('userData'), 'pets');
}

function spritesDir(): string {
  return join(petsDir(), 'sprites');
}

function indexPath(): string {
  return join(petsDir(), 'index.json');
}

async function ensureDir(): Promise<void> {
  const dir = petsDir();
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function readIndex(): Promise<PetIndex> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.skins)) {
      return { skins: parsed.skins, sprites: Array.isArray(parsed.sprites) ? parsed.sprites : [] };
    }
  } catch { /* 文件不存在 / 损坏 → 返默认 */ }
  return { skins: [], sprites: [] };
}

async function writeIndex(index: PetIndex): Promise<void> {
  await ensureDir();
  await fs.writeFile(indexPath(), JSON.stringify(index, null, 2), 'utf-8');
}

export async function listCustomSkins(): Promise<PetCustomSkin[]> {
  const index = await readIndex();
  /* 顺便 GC: 索引里有但文件没了的, 静默剔除 (用户手动删过 .glb) */
  const alive: PetCustomSkin[] = [];
  let changed = false;
  for (const skin of index.skins) {
    const fp = join(petsDir(), skin.fileName);
    if (existsSync(fp)) alive.push(skin);
    else changed = true;
  }
  if (changed) await writeIndex({ skins: alive });
  return alive;
}

/**
 * 导入用户选好的 .glb 文件. 校验 + 复制 + 更新 index. 返回新 skin 的元数据.
 *
 * @param srcPath  用户文件系统中的 .glb 绝对路径
 * @param displayName  用户提供的名字, 缺省取 basename
 */
export async function importGlbFile(
  srcPath: string,
  displayName?: string,
): Promise<{ ok: true; skin: PetCustomSkin } | { ok: false; error: string }> {
  try {
    const stat = await fs.stat(srcPath);
    if (!stat.isFile()) return { ok: false, error: '不是文件' };
    if (stat.size > MAX_BYTES) {
      return { ok: false, error: `文件太大 (${Math.round(stat.size / 1024 / 1024)}MB), 上限 20MB` };
    }
    /* 校验 glTF magic — 防扩展名伪造 (.glb 实际是 PNG / EXE 等) */
    const fd = await fs.open(srcPath, 'r');
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 0);
    await fd.close();
    if (!buf.equals(GLTF_MAGIC)) {
      return { ok: false, error: '文件头不是 glTF binary (.glb), 拒绝导入' };
    }

    /* 复制到 userData/pets/<uuid>.glb */
    await ensureDir();
    const uuid = randomUUID();
    const fileName = `${uuid}.glb`;
    const destPath = join(petsDir(), fileName);
    await fs.copyFile(srcPath, destPath);

    const skin: PetCustomSkin = {
      id: `custom-${uuid}`,
      name: displayName?.trim() || basename(srcPath, '.glb') || 'My Pet',
      fileName,
      sizeBytes: stat.size,
      importedAt: Date.now(),
    };

    const index = await readIndex();
    index.skins.push(skin);
    await writeIndex(index);

    return { ok: true, skin };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function deleteCustomSkin(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const index = await readIndex();
    const idx = index.skins.findIndex((s) => s.id === id);
    if (idx < 0) return { ok: false, error: '找不到该 skin' };
    const skin = index.skins[idx];
    /* 先删 .glb 文件 (失败也继续 — 索引更重要, 孤儿文件下次 list 时 GC) */
    try {
      await fs.unlink(join(petsDir(), skin.fileName));
    } catch (e) {
      console.warn('[petStorage] delete .glb failed:', e);
    }
    index.skins.splice(idx, 1);
    await writeIndex(index);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * 解析 fileName → 绝对路径. 仅给 protocol handler 用, 严格校验文件名 — 防路径遍历.
 * 返回 null 表示拒绝 (不存在 / 不合法).
 *
 * 同时处理 .glb (用户 .glb 导入) 和 sprite/<file>.webp|png (用户 sprite 导入).
 * URL 格式: neox-pet://local/<fileName>     → userData/pets/<fileName>.glb
 *           neox-pet://local/sprite/<file>  → userData/pets/sprites/<file>
 */
export function resolveCustomSkinPath(fileName: string): string | null {
  if (fileName.includes('..')) return null;
  /* sprite/<actual>.webp|png 子路径 */
  if (fileName.startsWith('sprite/')) {
    const inner = fileName.slice('sprite/'.length);
    if (inner.includes('/') || inner.includes('\\')) return null;
    if (!/\.(webp|png)$/i.test(inner)) return null;
    const full = join(spritesDir(), inner);
    if (!existsSync(full)) return null;
    return full;
  }
  /* .glb 文件 */
  if (!fileName.endsWith('.glb')) return null;
  if (fileName.includes('/') || fileName.includes('\\')) return null;
  const full = join(petsDir(), fileName);
  if (!existsSync(full)) return null;
  return full;
}

/* ============================================================
 * Sprite sheet 导入 / 列表 / 删除
 * ============================================================ */

async function ensureSpritesDir(): Promise<void> {
  const dir = spritesDir();
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

export async function listCustomSprites(): Promise<PetCustomSprite[]> {
  const index = await readIndex();
  const sprites = index.sprites ?? [];
  /* GC: index 有但文件没了 → 剔除 */
  const alive: PetCustomSprite[] = [];
  let changed = false;
  for (const sp of sprites) {
    const fp = join(spritesDir(), sp.fileName);
    if (existsSync(fp)) alive.push(sp);
    else changed = true;
  }
  if (changed) await writeIndex({ ...index, sprites: alive });
  return alive;
}

export async function importSpriteFile(
  srcPath: string,
  displayName?: string,
): Promise<{ ok: true; sprite: PetCustomSprite } | { ok: false; error: string }> {
  try {
    const stat = await fs.stat(srcPath);
    if (!stat.isFile()) return { ok: false, error: '不是文件' };
    if (stat.size > MAX_BYTES) {
      return { ok: false, error: `文件太大 (${Math.round(stat.size / 1024 / 1024)}MB), 上限 20MB` };
    }
    /* 校验 png / webp magic — 防扩展名伪造 */
    const fd = await fs.open(srcPath, 'r');
    const buf = Buffer.alloc(12);
    await fd.read(buf, 0, 12, 0);
    await fd.close();
    const isPng = buf.slice(0, 4).equals(PNG_MAGIC);
    const isWebPok = isWebP(buf);
    if (!isPng && !isWebPok) {
      return { ok: false, error: '文件不是有效的 PNG / WebP, 拒绝导入' };
    }
    /* 扩展名按 magic 推, 不信原始扩展名 */
    const ext = isPng ? '.png' : '.webp';

    /* 读图集尺寸 — sharp 解出整图宽高, 校验能否切成 8×9. 不能整除则拒绝
     * (跟 OpenPets 一致: 防止用户拖普通截图当 sprite sheet). */
    const atlas = await readSpriteAtlas(srcPath);
    if (!atlas.ok) return { ok: false, error: atlas.error };

    await ensureSpritesDir();
    const uuid = randomUUID();
    const fileName = `${uuid}${ext}`;
    const destPath = join(spritesDir(), fileName);
    await fs.copyFile(srcPath, destPath);

    const sprite: PetCustomSprite = {
      id: `sprite-${uuid}`,
      name: displayName?.trim() || basename(srcPath).replace(/\.(webp|png)$/i, '') || 'My Sprite',
      fileName,
      sizeBytes: stat.size,
      importedAt: Date.now(),
      cellWidth: atlas.cellWidth,
      cellHeight: atlas.cellHeight,
    };

    const index = await readIndex();
    const sprites = [...(index.sprites ?? []), sprite];
    await writeIndex({ ...index, sprites });
    return { ok: true, sprite };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function deleteCustomSprite(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const index = await readIndex();
    const sprites = index.sprites ?? [];
    const idx = sprites.findIndex((s) => s.id === id);
    if (idx < 0) return { ok: false, error: '找不到该 sprite' };
    const sprite = sprites[idx];
    try {
      await fs.unlink(join(spritesDir(), sprite.fileName));
    } catch (e) {
      console.warn('[petStorage] delete sprite file failed:', e);
    }
    const next = sprites.filter((_, i) => i !== idx);
    await writeIndex({ ...index, sprites: next });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}


interface CodexPetManifest {
  id?: string;
  displayName?: string;
  description?: string;
  spritesheetPath?: string;
}

/** 用 sharp 读整图尺寸, 校验能否切成 8×9 图集 */
async function readSpriteAtlas(
  filePath: string,
): Promise<{ ok: true; cellWidth: number; cellHeight: number } | { ok: false; error: string }> {
  try {
    const meta = await sharp(filePath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) {
      return { ok: false, error: '无法读取图片尺寸' };
    }
    if (width % ATLAS_COLS !== 0 || height % ATLAS_ROWS !== 0) {
      return {
        ok: false,
        error: `图集尺寸 ${width}×${height} 不是 8×9 网格 (宽需被 8 整除、高需被 9 整除). 这看起来不是有效的 sprite 图.`,
      };
    }
    return { ok: true, cellWidth: width / ATLAS_COLS, cellHeight: height / ATLAS_ROWS };
  } catch (err: any) {
    return { ok: false, error: `读取图片失败: ${err?.message ?? String(err)}` };
  }
}

/** 在目录里找 pet.json (顶层或单层子目录) — zip 解压后常多一层文件夹 */
async function locateManifestDir(rootDir: string): Promise<string | null> {
  if (existsSync(join(rootDir, 'pet.json'))) return rootDir;
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const sub = join(rootDir, e.name);
        if (existsSync(join(sub, 'pet.json'))) return sub;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 导入一个 Codex Pets bundle.
 * @param srcPath  用户选的路径 — 可以是 .zip 文件, 也可以是含 pet.json 的目录
 */
export async function importPetBundle(
  srcPath: string,
): Promise<{ ok: true; sprite: PetCustomSprite } | { ok: false; error: string }> {
  const tmpFiles: string[] = [];
  try {
    const stat = await fs.stat(srcPath);

    if (stat.isDirectory()) {
      return await importBundleFromDir(srcPath);
    }

    if (/\.zip$/i.test(srcPath)) {
      if (stat.size > MAX_BYTES) {
        return { ok: false, error: `压缩包太大 (${Math.round(stat.size / 1024 / 1024)}MB), 上限 20MB` };
      }
      const zip = await JSZip.loadAsync(await fs.readFile(srcPath));

      /* 找 pet.json — 取路径层级最浅的那个 */
      const manifestEntry = Object.values(zip.files)
        .filter((f) => !f.dir && /(^|\/)pet\.json$/i.test(f.name))
        .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
      if (!manifestEntry) {
        return { ok: false, error: '压缩包里未找到 pet.json — 这不是有效的宠物包' };
      }
      const baseDir = manifestEntry.name.includes('/')
        ? manifestEntry.name.slice(0, manifestEntry.name.lastIndexOf('/') + 1)
        : '';

      let manifest: CodexPetManifest;
      try {
        manifest = JSON.parse(await manifestEntry.async('string'));
      } catch (e: any) {
        return { ok: false, error: `pet.json 解析失败: ${e?.message ?? String(e)}` };
      }

      /* 定位 spritesheet entry */
      const names = [
        manifest.spritesheetPath,
        'spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png',
      ].filter(Boolean) as string[];
      let sheetEntry: JSZip.JSZipObject | null = null;
      for (const n of names) {
        if (n.includes('..')) continue;
        sheetEntry = zip.file(baseDir + n) ?? zip.file(n) ?? null;
        if (sheetEntry) break;
      }
      if (!sheetEntry) {
        return { ok: false, error: '压缩包里未找到 spritesheet (pet.json 的 spritesheetPath 指向的文件不存在)' };
      }

      /* 落临时文件 → 复用单图导入的 magic 校验 + 图集解析 + 落盘 */
      const ext = /\.png$/i.test(sheetEntry.name) ? '.png' : '.webp';
      const tmpSheet = join(app.getPath('temp'), `neox-pet-sheet-${randomUUID()}${ext}`);
      tmpFiles.push(tmpSheet);
      await fs.writeFile(tmpSheet, await sheetEntry.async('nodebuffer'));

      return await finalizeBundle(tmpSheet, manifest);
    }

    return { ok: false, error: '请选择宠物包目录或 .zip 压缩包' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    for (const f of tmpFiles) {
      try { await fs.unlink(f); } catch { /* ignore */ }
    }
  }
}

/** 目录形式的 bundle — 直接从磁盘读 */
async function importBundleFromDir(
  bundleDir: string,
): Promise<{ ok: true; sprite: PetCustomSprite } | { ok: false; error: string }> {
  const manifestDir = await locateManifestDir(bundleDir);
  if (!manifestDir) {
    return { ok: false, error: '未找到 pet.json — 这不是有效的宠物包' };
  }
  let manifest: CodexPetManifest;
  try {
    manifest = JSON.parse(await fs.readFile(join(manifestDir, 'pet.json'), 'utf-8'));
  } catch (e: any) {
    return { ok: false, error: `pet.json 解析失败: ${e?.message ?? String(e)}` };
  }
  const candidates = [
    manifest.spritesheetPath,
    'spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png',
  ].filter(Boolean) as string[];
  let sheetPath: string | null = null;
  for (const c of candidates) {
    const p = join(manifestDir, c);
    if (!p.startsWith(manifestDir)) continue; /* 防 ../ 路径遍历 */
    if (existsSync(p)) { sheetPath = p; break; }
  }
  if (!sheetPath) {
    return { ok: false, error: '未找到 spritesheet (pet.json 的 spritesheetPath 指向的文件不存在)' };
  }
  return finalizeBundle(sheetPath, manifest);
}

/** 把定位到的 spritesheet + manifest 落到 customSprites (复用单图导入逻辑 + 补 manifest 元数据) */
async function finalizeBundle(
  sheetPath: string,
  manifest: CodexPetManifest,
): Promise<{ ok: true; sprite: PetCustomSprite } | { ok: false; error: string }> {
  const baseName = manifest.displayName?.trim() || manifest.id?.trim() || basename(sheetPath);
  const result = await importSpriteFile(sheetPath, baseName);
  if (!result.ok) return result;

  if (manifest.description?.trim()) {
    const index = await readIndex();
    const sprites = index.sprites ?? [];
    const idx = sprites.findIndex((s) => s.id === result.sprite.id);
    if (idx >= 0) {
      sprites[idx] = { ...sprites[idx], description: manifest.description.trim() };
      await writeIndex({ ...index, sprites });
      result.sprite.description = manifest.description.trim();
    }
  }
  return { ok: true, sprite: result.sprite };
}

/* ============================================================
 * 发现"已安装"的社区桌宠包 (PetDex CLI / Codex 等装到约定目录里的)
 *
 * PetDex 的 `npx petdex install <name>` 会把宠物装到 ~/.petdex/pets/<id>/,
 * Codex 桌宠装到 ~/.codex/pets/<id>/. 我们扫这些约定目录, 让用户在 Neox 里
 * 一键把它们加进来 —— 不用手动在文件对话框翻目录.
 * ============================================================ */

export interface DiscoveredPack {
  /** 来源目录绝对路径 (导入时传给 importPetBundle) */
  dir: string;
  id: string;
  displayName: string;
  description?: string;
  /** idle 首帧缩略图 (data URL), 给设置页卡片预览用 */
  previewDataUrl?: string;
}

/** 用户机器上可能存在的社区桌宠安装目录 */
function discoveryDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.petdex', 'pets'),
    join(home, '.codex', 'pets'),
    join(home, '.local', 'share', 'openpets', 'pets'),
    join(home, '.config', 'openpets', 'pets'),
  ];
}

/** 给发现到的 bundle 切 idle 首帧 (左上角 cell) 缩略图, 返回 data URL (失败返 undefined) */
async function packPreviewDataUrl(dir: string, manifest: CodexPetManifest): Promise<string | undefined> {
  try {
    const candidates = [
      manifest.spritesheetPath, 'spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png',
    ].filter(Boolean) as string[];
    let sheet: string | null = null;
    for (const c of candidates) {
      const p = join(dir, c);
      if (!p.startsWith(dir)) continue;
      if (existsSync(p)) { sheet = p; break; }
    }
    if (!sheet) return undefined;
    const meta = await sharp(sheet).metadata();
    const w = meta.width ?? 0, h = meta.height ?? 0;
    if (w % ATLAS_COLS !== 0 || h % ATLAS_ROWS !== 0) return undefined;
    const cw = w / ATLAS_COLS, ch = h / ATLAS_ROWS;
    const buf = await sharp(sheet)
      .extract({ left: 0, top: 0, width: cw, height: ch })
      .resize(128, 128, { fit: 'inside' })
      .webp({ quality: 80 })
      .toBuffer();
    return `data:image/webp;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** 扫描约定目录, 列出所有含 pet.json 的桌宠包 (不导入, 只发现). 按 displayName 去重. */
export async function discoverInstalledPacks(): Promise<DiscoveredPack[]> {
  const found = new Map<string, DiscoveredPack>(); /* key=id, 去重 */
  for (const root of discoveryDirs()) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      const dirents = await fs.readdir(root, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    } catch { continue; }
    for (const name of entries) {
      const dir = join(root, name);
      const manifestPath = join(dir, 'pet.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as CodexPetManifest;
        const id = (m.id || name).trim();
        if (found.has(id)) continue;
        found.set(id, {
          dir,
          id,
          displayName: m.displayName?.trim() || id,
          description: m.description?.trim(),
          previewDataUrl: await packPreviewDataUrl(dir, m),
        });
      } catch { /* 损坏的 pet.json 跳过 */ }
    }
  }
  return [...found.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** 从发现到的目录导入 (带路径白名单校验, 防越权读任意目录). */
export async function importDiscoveredPack(
  dir: string,
): Promise<{ ok: true; sprite: PetCustomSprite } | { ok: false; error: string }> {
  /* 安全: dir 必须落在已知发现目录之下 */
  const allowed = discoveryDirs().some((root) => {
    const norm = dir.replace(/\/+$/, '');
    return norm === root.replace(/\/+$/, '') || norm.startsWith(root.replace(/\/+$/, '') + '/');
  });
  if (!allowed) return { ok: false, error: '路径不在允许的桌宠目录内' };
  if (dir.includes('..')) return { ok: false, error: '非法路径' };
  return importPetBundle(dir);
}
