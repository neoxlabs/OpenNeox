
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { lazyElectron } from '../lazyElectron.js';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const app = lazyElectron<typeof import('electron').app>('app');

/* ==================== 包注册表 ==================== */

export interface AssetPackPlatformSpec {
  /** tar.gz 的 sha256 (hex) — 由 scripts/publish/r2-upload-packs.mjs 生成后回填到这里 */
  sha256: string;
  /** 解压后占用, 用于给用户看"要下多少" */
  sizeBytes: number;
}

export type AssetPackId = 'voice-engine';

export interface AssetPackSpec {
  id: AssetPackId;
  title: string;
  /** 说明这包是干什么的 — 直接进设置页 */
  description: string;
  /**
   * 解压后必须存在的相对路径 —— 解压完逐条查, 缺一条就当包坏了整个丢弃。
   * 它同时是 importPackModule 的白名单 (只有 'node_modules/<name>' 形式的才可 import)。
   */
  verifyPaths: string[];
  /** 解压后要 chmod +x 的相对路径 (裸二进制包用; tar 保留权限位, 这里是双保险) */
  executables?: string[];
  /** '<platform>-<arch>' → 规格; 不在表里的平台 = 该平台不提供此包 */
  platforms: Record<string, AssetPackPlatformSpec>;
}

export const PACK_REVISION = 2;

export const ASSET_PACKS: AssetPackSpec[] = [
  {
    id: 'voice-engine',
    title: '本地语音引擎',
    description: '本地识别 / 合成 / 声纹所需的原生引擎。装了它才能下载并使用本地语音模型。',
    /* pinyin-pro: 本地识别定稿时的同音纠错 (localAsr.ts) —— 只有本地识别用, 跟引擎一起按需下, 安装包不带 */
    verifyPaths: ['node_modules/sherpa-onnx-node', 'node_modules/sherpa-onnx-darwin-arm64', 'node_modules/onnxruntime-node', 'node_modules/pinyin-pro'],
    platforms: {
      /* 下载量 19.8 MB (tar.gz), 解压后 73.8 MB */
      'darwin-arm64': { sha256: '7b7c40464d86eb1e5dd710846acc5402157dfa2f46c4f14ae94e7576e9f5041c', sizeBytes: 79986688 },
    },
  },
];

const RETIRED_PACKS = ['node-runtime'];

const BASE_URL = process.env.NEOX_PACK_BASE_URL || 'https://dl.neox-dev.com/packs';

/* ==================== 路径 ==================== */

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function packsRoot(): string {
  return join(app.getPath('userData'), 'packs');
}

function packDir(id: string): string {
  return join(packsRoot(), id);
}

/** 装好的标记 — 记下 revision 和 sha, 包内容换代时能识别出"装的是旧的"。 */
function stampFile(id: string): string {
  return join(packDir(id), '.installed.json');
}

interface Stamp { revision: number; sha256: string; platform: string; installedAt: number }

function readStamp(id: string): Stamp | null {
  try { return JSON.parse(readFileSync(stampFile(id), 'utf-8')) as Stamp; } catch { return null; }
}

export function findPack(id: string): AssetPackSpec | null {
  return ASSET_PACKS.find(p => p.id === id) ?? null;
}

/** 当前平台是否提供这个包 */
export function isPackAvailable(id: string): boolean {
  const spec = findPack(id);
  return !!spec && !!spec.platforms[platformKey()];
}

export function isPackInstalled(id: string): boolean {
  const st = readStamp(id);
  if (!st) return false;
  if (st.revision !== PACK_REVISION || st.platform !== platformKey()) return false;
  /* 标记在但模块目录被人删了 → 不算装好 */
  const spec = findPack(id);
  if (!spec) return false;
  return spec.verifyPaths.every(p => existsSync(join(packDir(id), p)));
}

export interface AssetPackStatus {
  id: string;
  title: string;
  description: string;
  available: boolean;
  installed: boolean;
  sizeBytes: number;
  /** 下载中的进度 0-100; 不在下载则 null */
  progressPct: number | null;
  /** 装过, 但是旧版本 (包换代了) —— 界面写「有更新」而不是「未安装」 */
  outdated: boolean;
}

export function packsStatus(): AssetPackStatus[] {
  return ASSET_PACKS.map(spec => {
    const plat = spec.platforms[platformKey()];
    return {
      id: spec.id,
      title: spec.title,
      description: spec.description,
      available: !!plat,
      installed: isPackInstalled(spec.id),
      sizeBytes: plat?.sizeBytes ?? 0,
      progressPct: inflight.get(spec.id)?.pct ?? null,
      outdated: !isPackInstalled(spec.id) && (readStamp(spec.id)?.revision ?? PACK_REVISION) < PACK_REVISION,
    };
  });
}

/* ==================== 下载 ==================== */

interface Inflight { pct: number; abort: AbortController }
const inflight = new Map<string, Inflight>();

export function cancelPackDownload(id: string): void {
  inflight.get(id)?.abort.abort();
  inflight.delete(id);
}

/**
 * 下载 + 校验 + 解压。
 * 全程写在 <packDir>.tmp 里, 校验通过才 rename 到正式位置 —— 中途失败/断电不会留下
 * 一个"看起来装好了其实是半个"的目录 (这类半成品比没装更难查)。
 */
export async function downloadPack(
  id: string,
  onProgress?: (pct: number, receivedBytes: number, totalBytes: number) => void,
): Promise<void> {
  const spec = findPack(id);
  if (!spec) throw new Error(`未知的引擎包: ${id}`);
  const key = platformKey();
  const plat = spec.platforms[key];
  if (!plat) throw new Error(`${spec.title}暂不支持当前平台 (${key})`);
  if (!plat.sha256) throw new Error(`${spec.title}尚未发布 ${key} 的包 — 缺 sha256, 拒绝下载未校验的原生代码`);
  if (inflight.has(id)) throw new Error(`${spec.title}正在下载中`);

  const url = `${BASE_URL}/${id}/r${PACK_REVISION}/${key}-${plat.sha256.slice(0, 16)}.tar.gz`;
  const dest = packDir(id);
  const tmpDir = `${dest}.tmp`;
  const tarPath = `${tmpDir}.tar.gz`;

  const abort = new AbortController();
  inflight.set(id, { pct: 0, abort });
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tarPath, { force: true });
    mkdirSync(packsRoot(), { recursive: true });

    /* ── 下载 ── */
    const resp = await fetch(url, { signal: abort.signal });
    if (!resp.ok || !resp.body) throw new Error(`下载失败 HTTP ${resp.status} — ${url}`);
    const total = Number(resp.headers.get('content-length') || 0);
    const hash = createHash('sha256');
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tarPath);
      out.on('error', reject);
      out.on('finish', () => resolve());
      (async () => {
        try {
          // @ts-expect-error — undici 的 body 是 async iterable
          for await (const chunk of resp.body) {
            const buf = Buffer.from(chunk);
            hash.update(buf);
            received += buf.length;
            if (total > 0) {
              const pct = Math.min(99, Math.floor((received / total) * 100));
              const cur = inflight.get(id);
              if (cur) cur.pct = pct;
              onProgress?.(pct, received, total);
            }
            if (!out.write(buf)) await new Promise<void>(r => out.once('drain', () => r()));
          }
          out.end();
        } catch (e) { out.destroy(); reject(e); }
      })();
    });

    /* ── 校验: 不过就地删, 绝不落到正式目录 ── */
    const got = hash.digest('hex');
    if (got !== plat.sha256) {
      rmSync(tarPath, { force: true });
      throw new Error(`校验失败 — 期望 ${plat.sha256.slice(0, 16)}… 实得 ${got.slice(0, 16)}…`);
    }

    /* ── 解压 ── */
    mkdirSync(tmpDir, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'ignore' });
    rmSync(tarPath, { force: true });

    for (const p of spec.verifyPaths) {
      if (!existsSync(join(tmpDir, p))) {
        rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`包内容不完整 — 缺 ${p}`);
      }
    }
    /* tar 本来就保留权限位, 这里是双保险: 二进制丢了 +x 就是个"装好了但一跑就
     * permission denied"的故障, 比没装更难查。 */
    for (const p of spec.executables ?? []) {
      try { chmodSync(join(tmpDir, p), 0o755); } catch { /* 权限已对就无所谓 */ }
    }
    writeFileSync(
      join(tmpDir, '.installed.json'),
      JSON.stringify({ revision: PACK_REVISION, sha256: got, platform: key, installedAt: Date.now() } satisfies Stamp),
    );

    rmSync(dest, { recursive: true, force: true });
    renameSync(tmpDir, dest);
    onProgress?.(100, received, total || received);
  } finally {
    inflight.delete(id);
  }
}

export function removePack(id: string): void {
  cancelPackDownload(id);
  rmSync(packDir(id), { recursive: true, force: true });
  rmSync(`${packDir(id)}.tmp`, { recursive: true, force: true });
  rmSync(`${packDir(id)}.tmp.tar.gz`, { force: true });
}

/* ==================== 加载 ==================== */

/**
 * 从已装的包里 import 一个模块。没装就抛一句用户看得懂的话 —— 调用方**不要**
 * try/catch 掉它去走别的路: 引擎不在就是不在, 静默降级只会让用户以为功能坏了。
 */
export async function importPackModule(packId: string, moduleName: string): Promise<any> {
  const spec = findPack(packId);
  if (!spec) throw new Error(`未知的引擎包: ${packId}`);
  if (!spec.verifyPaths.includes(`node_modules/${moduleName}`)) throw new Error(`${moduleName} 不在 ${packId} 包内`);
  if (!isPackInstalled(packId)) {
    throw new Error(`${spec.title}未安装 — 设置 → 语音 → 本地语音引擎, 点下载 (约 ${Math.round((spec.platforms[platformKey()]?.sizeBytes ?? 0) / 1048576)} MB)`);
  }
  /* 必须走 createRequire 而不是 `import(dirUrl)`:
   *   1) ESM 不能 import 一个目录 —— 得先解析出包的入口文件。
   *   2) 这三个包都是 CJS 原生绑定, require 是它们原生的加载方式。
   *   3) require 的基准点设在 <packDir>/node_modules/ 里的一个虚拟文件上, 于是
   *      sherpa-onnx-node 内部 require('sherpa-onnx-darwin-arm64') 会在同一层
   *      node_modules 里找到兄弟包。基准点若设在 app 目录, 兄弟包就找不到。 */
  const req = createRequire(join(packDir(packId), 'node_modules', '__neox_pack_anchor__.cjs'));
  const m = req(moduleName);
  return (m as any)?.default ?? m;
}

/**
 * 删掉已下线的包在盘上留下的目录 (含下到一半的 .tmp)。启动时调一次。
 * 只认 RETIRED_PACKS 里的名字 —— 不按"不在注册表里就删"去扫, packs 目录里别的东西不归这里管。
 */
export function sweepRetiredPacks(): string[] {
  const removed: string[] = [];
  for (const id of RETIRED_PACKS) {
    for (const dir of [packDir(id), `${packDir(id)}.tmp`]) {
      if (!existsSync(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  if (removed.length) console.log(`[assetpack] 已清理下线组件: ${removed.join(', ')}`);
  return removed;
}

/** 给设置页显示"已占多少盘" */
export function packDiskBytes(id: string): number {
  const dir = packDir(id);
  if (!existsSync(dir)) return 0;
  try {
    const out = execFileSync('du', ['-sk', dir], { encoding: 'utf-8' });
    return parseInt(out.trim().split(/\s+/)[0], 10) * 1024;
  } catch { try { return statSync(dir).size; } catch { return 0; } }
}
