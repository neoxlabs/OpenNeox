
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { PluginManifest } from '@neoxlabs/platform/shared/plugin-types.js';
import { installFromPath, type InstallResult } from './pluginManager.js';
import { validateManifest } from './pluginSecurity.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export const PACK_FORMAT = 1;
export const PACK_EXTENSION = '.neox-plugin';
export const PACK_MANIFEST_FILE = '.neox-pack.json';

/** 打包时永远排除 —— 它们要么是构建垃圾, 要么是不该分发的本地状态 */
const EXCLUDED_ENTRIES = new Set([
  'node_modules', '.git', '.DS_Store', '.neox-pack.json',
  'dist-cache', '.turbo', 'coverage',
]);

export type PackSignature = {
  alg: 'ed25519';
  /** DER/SPKI base64 */
  publicKey: string;
  value: string;
};

export type PackManifest = {
  packFormat: number;
  name: string;
  version: string;
  packedAt: string;
  /** 相对路径 → sha256 */
  files: Record<string, string>;
  /** 文件列表的规范化摘要, 签名签的就是它 */
  digest: string;
  signature?: PackSignature;
};

export type TrustLevel = 'official' | 'signed-unknown' | 'unsigned';

// ============================================================================
// 打包
// ============================================================================

async function collectFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_ENTRIES.has(entry.name)) continue;
    const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...await collectFiles(root, childRel));
    } else if (entry.isFile()) {
      out.push(childRel);
    }
    /* symlink 直接跳过: 打进包里等于给了一条指向宿主任意路径的引用 */
  }
  return out;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/** 文件列表的规范化摘要: 路径排序后逐行 `path\0sha256`, 与平台/时间无关 */
function computeDigest(files: Record<string, string>): string {
  const canonical = Object.keys(files).sort().map(p => `${p}\0${files[p]}`).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export type PackOptions = {
  /** 输出文件路径; 缺省为 `<outDir>/<name>-<version>.neox-plugin` */
  outFile?: string;
  outDir?: string;
  /** ed25519 私钥 (PEM)。不给就是未签名包。 */
  privateKeyPem?: string;
};

export type PackResult = {
  outFile: string;
  manifest: PackManifest;
  fileCount: number;
  bytes: number;
};

/**
 * 把一个插件目录打成 `.neox-plugin`。
 *
 *   打包前会跑一遍完整的清单校验 —— 一个装不上的包不该被生产出来, 在作者
 *   机器上报错远比在用户机器上报错便宜。
 */
export async function packPlugin(pluginDir: string, options?: PackOptions): Promise<PackResult> {
  const absDir = path.resolve(pluginDir);
  const raw = await fs.readFile(path.join(absDir, 'plugin.json'), 'utf-8');
  const manifest = JSON.parse(raw) as PluginManifest;

  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`refusing to pack an invalid plugin:\n  ${validation.errors.join('\n  ')}`);
  }

  const relFiles = await collectFiles(absDir);
  if (!relFiles.includes('plugin.json')) {
    throw new Error('plugin.json is missing from the plugin directory');
  }

  const files: Record<string, string> = {};
  for (const rel of relFiles) {
    files[rel] = await sha256File(path.join(absDir, rel));
  }

  const packManifest: PackManifest = {
    packFormat: PACK_FORMAT,
    name: manifest.name,
    version: manifest.version,
    packedAt: new Date().toISOString(),
    files,
    digest: computeDigest(files),
  };

  if (options?.privateKeyPem) {
    const key = crypto.createPrivateKey(options.privateKeyPem);
    const value = crypto.sign(null, Buffer.from(packManifest.digest, 'utf-8'), key);
    packManifest.signature = {
      alg: 'ed25519',
      publicKey: crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
      value: value.toString('base64'),
    };
  }

  const outFile = options?.outFile
    ?? path.join(options?.outDir ?? process.cwd(), `${manifest.name}-${manifest.version}${PACK_EXTENSION}`);

  /* 在临时目录里摆好「打包快照」再 tar: 直接 tar 源目录会把 pack 清单写进
   * 源码树, 而且没法排除 EXCLUDED_ENTRIES 之外的意外新增文件 */
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-pack-'));
  try {
    const stageDir = path.join(stageRoot, manifest.name);
    for (const rel of relFiles) {
      const dest = path.join(stageDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(absDir, rel), dest);
    }
    await fs.writeFile(
      path.join(stageDir, PACK_MANIFEST_FILE),
      JSON.stringify(packManifest, null, 2),
      'utf-8',
    );

    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await runTar(['-czf', outFile, '-C', stageRoot, manifest.name]);
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  }

  const { size } = await fs.stat(outFile);
  cliLogger.info('PLUGIN', `Packed ${manifest.name}@${manifest.version} → ${outFile} (${relFiles.length} files, ${size} bytes)`);
  return { outFile, manifest: packManifest, fileCount: relFiles.length, bytes: size };
}

/** 生成一对 ed25519 密钥, 用于给插件签名 */
export function generateSigningKeypair(): { privateKeyPem: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

// ============================================================================
// 信任
// ============================================================================

/**
 * 官方签名公钥 (ed25519 SPKI, base64)。
 *
 *   对应私钥只在发布机上 (`~/.neox-secrets/plugin-signing.pem`), 不进任何仓库。
 *   官方插件由 neox-plugins 仓的 `build.mjs --key=...` 签, 用户装的时候这里比对
 *   通过才会显示为官方。
 *
 *   **这是个只增不改的清单。** 换钥匙时新公钥加在前面、旧的留着 —— 直接替换会
 *   让所有已发布的旧包一夜之间从「官方」掉成「签名公钥不在受信任列表」, 而那些包
 *   本身并没有任何问题。要真正废掉一把钥匙, 得先把用它签过的包重签发出去, 再删。
 */
const OFFICIAL_PUBLIC_KEYS: string[] = [
  'MCowBQYDK2VwAyEABZCHQmB36+3UX28zQj6y1neKCb0VNVmBHQEuPUB2eo0=',
];

const TRUSTED_KEYS_FILE = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'trusted-keys.json');

async function trustedKeys(): Promise<string[]> {
  try {
    const raw = await fs.readFile(TRUSTED_KEYS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.keys) ? parsed.keys.filter((k: unknown) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

// ============================================================================
// 校验 / 导入
// ============================================================================

export type VerifyResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  trust: TrustLevel;
  manifest?: PackManifest;
};

/**
 * 比对解压后的目录与包清单。
 *
 *   三件事按顺序: 签名 → 摘要 → 逐文件哈希。任何一步不过都是硬失败 ——
 *   这不是「警告一下继续装」的场合, 内容对不上的包本身就是失败的分发。
 */
export async function verifyExtractedPack(dir: string): Promise<VerifyResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let manifest: PackManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, PACK_MANIFEST_FILE), 'utf-8'));
  } catch {
    /* 没有 pack 清单 = 一个裸目录 tar。允许, 但没有任何完整性保证。 */
    return {
      ok: true,
      errors: [],
      warnings: [`包内没有 ${PACK_MANIFEST_FILE}，无法校验完整性（旧格式或手工打的包）`],
      trust: 'unsigned',
    };
  }

  if (manifest.packFormat !== PACK_FORMAT) {
    errors.push(`unsupported packFormat ${manifest.packFormat} (this build understands ${PACK_FORMAT})`);
    return { ok: false, errors, warnings, trust: 'unsigned', manifest };
  }

  // ── 签名 ─────────────────────────────────────────────────────────────
  let trust: TrustLevel = 'unsigned';
  if (manifest.signature) {
    const sig = manifest.signature;
    if (sig.alg !== 'ed25519') {
      errors.push(`unsupported signature algorithm: ${sig.alg}`);
    } else {
      let valid = false;
      try {
        const key = crypto.createPublicKey({
          key: Buffer.from(sig.publicKey, 'base64'),
          format: 'der',
          type: 'spki',
        });
        valid = crypto.verify(
          null,
          Buffer.from(manifest.digest, 'utf-8'),
          key,
          Buffer.from(sig.value, 'base64'),
        );
      } catch (err: any) {
        errors.push(`signature check failed: ${err?.message ?? 'malformed key'}`);
      }
      if (!valid && errors.length === 0) {
        errors.push('signature does not match the package digest');
      }
      if (valid) {
        const trusted = [...OFFICIAL_PUBLIC_KEYS, ...await trustedKeys()];
        trust = trusted.includes(sig.publicKey) ? 'official' : 'signed-unknown';
        if (trust === 'signed-unknown') {
          warnings.push('包已签名，但签名公钥不在受信任列表中');
        }
      }
    }
  } else {
    warnings.push('包未签名 — 无法确认作者身份');
  }

  // ── 摘要 ─────────────────────────────────────────────────────────────
  if (computeDigest(manifest.files) !== manifest.digest) {
    errors.push('pack manifest digest does not match its own file list');
  }

  // ── 逐文件 ───────────────────────────────────────────────────────────
  const actual = new Set(await collectFiles(dir));
  for (const [rel, expected] of Object.entries(manifest.files)) {
    if (!actual.has(rel)) {
      errors.push(`missing file declared in pack manifest: ${rel}`);
      continue;
    }
    actual.delete(rel);
    const got = await sha256File(path.join(dir, rel));
    if (got !== expected) errors.push(`content mismatch: ${rel}`);
  }
  for (const extra of actual) {
    /* 多出来的文件同样是硬失败: 「签过的清单之外还夹带了东西」 */
    errors.push(`file not declared in pack manifest: ${extra}`);
  }

  return { ok: errors.length === 0, errors, warnings, trust, manifest };
}

export type ImportResult = InstallResult & { trust?: TrustLevel };

/**
 * 从本地 `.neox-plugin` / `.tar.gz` 文件导入插件。
 *
 *   这是「用户导入」这条路径的唯一入口: 解压 → 校验 → 交给统一的
 *   installFromPath (清单校验 / 危险文件扫描 / 注册表)。
 */
export async function installFromFile(
  filePath: string,
  options?: { enable?: boolean; userConfig?: Record<string, any>; skipScan?: boolean },
): Promise<ImportResult> {
  const absFile = path.resolve(filePath);
  try {
    await fs.access(absFile);
  } catch {
    return { success: false, errors: [`文件不存在: ${absFile}`], warnings: [] };
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-plugin-import-'));
  try {
    const extractDir = path.join(tmpRoot, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });
    await runTar(['-xzf', absFile, '-C', extractDir]);

    const pluginDir = await findPackRoot(extractDir);
    if (!pluginDir) {
      return { success: false, errors: ['包里没有找到 plugin.json'], warnings: [] };
    }

    const verified = await verifyExtractedPack(pluginDir);
    if (!verified.ok) {
      return { success: false, errors: verified.errors, warnings: verified.warnings, trust: verified.trust };
    }

    /* pack 清单不属于插件本体, 装之前删掉 —— 否则它会被复制进安装目录,
     * 下次重新打包时又被当成源文件 */
    await fs.rm(path.join(pluginDir, PACK_MANIFEST_FILE), { force: true });

    const res = await installFromPath(pluginDir, {
      source: { type: 'local', path: absFile },
      enable: options?.enable,
      userConfig: options?.userConfig,
      skipScan: options?.skipScan,
      /* 信任级别跟着安装记录走 —— 只在安装那一刻提示一次, 用户三个月后
       * 想确认「这个到底是不是官方的」就查不到了 */
      trust: verified.trust,
    });
    return { ...res, warnings: [...verified.warnings, ...res.warnings], trust: verified.trust };
  } catch (err: any) {
    return { success: false, errors: [`导入失败: ${err?.message ?? String(err)}`], warnings: [] };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================
// Internal
// ============================================================================

function runTar(args: string[]): Promise<void> {
  // macOS 自带 bsdtar, Linux 自带 GNU tar, Windows 自 Win10 1803 起自带 tar.exe
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar ${args[0]} failed with code ${code}`));
    });
  });
}

async function findPackRoot(startDir: string, depth = 0): Promise<string | null> {
  try {
    await fs.access(path.join(startDir, 'plugin.json'));
    return startDir;
  } catch { /* keep looking */ }
  if (depth >= 2) return null;
  const entries = await fs.readdir(startDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const found = await findPackRoot(path.join(startDir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

export const __testing = {
  computeDigest,
  collectFiles,
  findPackRoot,
  /* 暴露给测试: 官方公钥被误删/替换时要有东西会红 —— 那会让所有官方包
   * 一夜之间掉成「签名公钥不在受信任列表」 */
  officialPublicKeys: () => [...OFFICIAL_PUBLIC_KEYS],
};
