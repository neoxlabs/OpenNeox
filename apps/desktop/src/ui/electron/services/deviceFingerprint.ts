/**
 * deviceFingerprint — 主进程构造稳定设备指纹, 通过 IPC 暴露给 renderer.
 *
 *   构成 (持久, 一台机器上变化触发服务端风控):
 *     · machineId        OS 级硬件 UUID (macOS IOPlatformUUID / Win MachineGuid / Linux machine-id)
 *     · installUuid      安装时随机生成, localSecretCipher 加密落 userData/install.id (重装应用会换)
 *     · cpuModel + count + ram(GB) + os.platform() + os.release() + arch
 *
 *   返回:
 *     · fpHash    sha256 base64url 的稳定哈希 — 加在 access_token 申请的 X-Device-FP header
 *     · fpBlob    明细字典 — 服务端 device_fingerprints.fp_blob 留审计, 出问题能查
 *
 *   设计原则:
 *     · 不引第三方包 (node-machine-id 之类), 全用 OS 内置工具
 *     · 兜底路径: 任何一个组件读取失败都退到 'unknown', 不抛
 *     · 同一台机器多次启动稳定 → fpHash 不变 (machineId + installUuid 是同步可读)
 */
import { lazyElectron } from '../lazyElectron.js';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const app = lazyElectron<typeof import('electron').app>('app');
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { encryptLocalSecret, decryptLocalSecret, isLocalSecretBlob, getStableMachineId, neoxDataDir } from './localSecretCipher.js';

/* P1-3: 优先 native compute_fingerprint (Rust .node, 反逆向加固).
 * 找不到 (开发期还没 build, 或 CI 跑测试时) → 回落 Node createHash 实现, 行为完全一致. */
type NativeBindings = {
  computeFingerprint: (blob: Record<string, string>) => string;
};
let nativeBindings: NativeBindings | null = null;
try {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  nativeBindings = require('@neoxlabs/native') as NativeBindings;
} catch {
  nativeBindings = null;
}

let cached: { fpHash: string; fpBlob: Record<string, string> } | null = null;

function readMachineId(): string {
  try {
    const stable = getStableMachineId();
    if (stable) return stable;
  } catch { /* fall through 到现派生 */ }
  try {
    if (process.platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf-8', timeout: 1500 });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } else if (process.platform === 'linux') {
      for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(path)) return readFileSync(path, 'utf-8').trim();
      }
    } else if (process.platform === 'win32') {
      const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { encoding: 'utf-8', timeout: 1500 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([a-fA-F0-9-]+)/);
      if (m) return m[1];
    }
  } catch {
    /* ignore — fallback below */
  }
  /* 最后兜底: MAC + hostname 的稳定哈希; 跨机器不一定唯一但比 'unknown' 好 */
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((n: any) => n?.mac as string)
    .filter(m => m && m !== '00:00:00:00:00:00')
    .sort()
    .join('|');
  return createHash('sha256').update(`${os.hostname()}|${macs}`).digest('base64url').slice(0, 32);
}

const LEGACY_INSTALL_ID_DIRS = (): string[] => {
  const dirs: string[] = [];
  try { dirs.push(app.getPath('userData')); } catch { /* app 还没 ready 也无妨 */ }
  const support = join(homedir(), 'Library', 'Application Support');
  /* 历史散落点 —— 迁移用, 顺序即优先级 (越像"当前这台机器用过的"越靠前) */
  dirs.push(join(support, 'Electron'), join(support, 'neox-monorepo'));
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) dirs.push(join(appData, 'Electron'), join(appData, 'neox-monorepo'));
  }
  return dirs;
};

/** 从一个 install.id 文件里读出 uuid; 读不出返回 null. */
function readInstallIdFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path);
    if (isLocalSecretBlob(raw)) {
      try { return decryptLocalSecret(raw); } catch { return null; }
    }
    /* 历史 plaintext (老 Linux 无 keyring 用户) */
    const utf = raw.toString('utf-8').trim();
    if (utf && utf.length > 0 && utf.length < 256 && /^[\w-]+$/.test(utf)) return utf;
    /* 老 safeStorage 密文 — 不调 safeStorage.decryptString (避免 Keychain 弹框) */
    return null;
  } catch {
    return null;
  }
}

/** 写入 install.id. 失败**必须让调用方知道** —— 静默吞掉就是"每次启动换一台设备". */
function writeInstallIdFile(path: string, uuid: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encryptLocalSecret(uuid), { mode: 0o600 });
}

function readOrCreateInstallUuid(): string {
  const canonical = join(neoxDataDir(), 'install.id');

  /* ① 正规位置有 → 用它 */
  const current = readInstallIdFile(canonical);
  if (current) return current;

  /* ② 迁移: 从历史散落点找第一个能读出来的, 搬到正规位置。
   *    这一步是为了让**老用户的 fp 保持不变** —— 否则升级这一版所有人的指纹都会变一次。 */
  for (const dir of LEGACY_INSTALL_ID_DIRS()) {
    const legacy = join(dir, 'install.id');
    if (legacy === canonical) continue;
    const uuid = readInstallIdFile(legacy);
    if (!uuid) continue;
    try {
      writeInstallIdFile(canonical, uuid);
      console.log(`[deviceFingerprint] install.id 已从旧路径迁移: ${legacy} → ${canonical} (设备指纹保持不变)`);
    } catch (err) {
      /* 迁不动也要用这个值 —— 指纹稳定比文件位置重要 */
      console.error(`[deviceFingerprint] install.id 迁移写入失败 (${canonical}), 本次沿用旧路径的值:`, (err as Error)?.message ?? err);
    }
    return uuid;
  }

  /* ③ 真是新装 —— 生成并落盘。写不进去是**严重故障**: 每次启动都会换一个 uuid,
   *    等于每次启动都变成一台新设备, 已签发的 token 全部作废 (业务接口恒 401)。
   *    所以这里绝不静默吞, 大声报出来。 */
  const uuid = randomUUID();
  try {
    writeInstallIdFile(canonical, uuid);
  } catch (err) {
    console.error(
      `[deviceFingerprint] ⚠️ install.id 写入失败 (${canonical}) —— 设备指纹将在下次启动改变,`
      + ` 表现为"登录着但所有云端接口 401"。请检查该目录权限:`,
      (err as Error)?.message ?? err,
    );
  }
  return uuid;
}

function compute(): { fpHash: string; fpBlob: Record<string, string> } {
  const cpu = os.cpus()[0];
  const blob: Record<string, string> = {
    machineId: readMachineId(),
    installUuid: readOrCreateInstallUuid(),
    cpuModel: cpu?.model?.trim().replace(/\s+/g, ' ') ?? 'unknown',
    cpuCount: String(os.cpus().length),
    ramGb: String(Math.round(os.totalmem() / 1e9)),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
  };
  let fpHash: string;
  if (nativeBindings) {
    /* native path — secret + 算法都编译进二进制, asar 解压看不到 */
    fpHash = nativeBindings.computeFingerprint(blob);
  } else {
    /* fallback: 纯 JS, 跟 Rust 端字符串拼接顺序必须严格一致 (k=v\n, 字典序) */
    const stable = Object.keys(blob).sort().map(k => `${k}=${blob[k]}\n`).join('');
    fpHash = createHash('sha256').update(stable).digest('base64url').slice(0, 32);
  }
  return { fpHash, fpBlob: blob };
}

export function getDeviceFingerprint(): { fpHash: string; fpBlob: Record<string, string> } {
  if (cached) return cached;
  cached = compute();
  return cached;
}
