/**
 * deviceFingerprint (platform) — 任何进程都能自算的设备指纹, 与 CLI / 桌面逐字节一致。
 *
 *   为什么在这一层
 *   ----------------
 *   网关 v2 签名要求 X-Device-FP 非空 (服务端 sigverify → devicebind TOFU)。fp 原本靠**每个宿主
 *   入口**调 setNeoxDeviceFp 注入: CLI main.ts / 桌面 electron main.ts / cloud pod hmacSigner /
 *   worker entry。 又发现第五个入口 —— `remote.enabled=true` (手机联动) 时 CLI 走
 *   daemon 子进程 (server/main.ts), 那个入口从来没注入过 → 发出去的请求 fp 为空 → 服务端拒 →
 *   客户端显示"请求签名校验失败, 请确认客户端版本"。
 *
 *   "每加一个宿主入口就得记得注入一次"本身就是缺陷。这里把算法下沉成共享实现, 宿主不注入时
 *   也能自算, 入口只剩"可选的显式覆盖"。
 *
 *   算法 (必须与 neox-cli/src/auth/deviceFingerprint.ts、桌面 deviceFingerprint.ts 完全一致):
 *     blob 按 key 字典序拼 `k=v\n` → sha256 → base64url → 取前 32
 *     字段: machineId / installUuid / cpuModel / cpuCount / ramGb / platform / osRelease / arch
 *   改任一字段 = 全端设备指纹变化 = 所有已登录用户被服务端当成新设备。三处必须同步改。
 */
import * as os from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  neoxSecretDataDir,
  getStableMachineId,
  encryptLocalSecret,
  decryptLocalSecret,
  isLocalSecretBlob,
} from './localSecretCipher.js';

let cachedFpHash: string | null = null;
let cachedInstallUuid: string | null = null;

/**
 * installUuid — 与 CLI/桌面读写同一个 <dataDir>/install.id。
 * 谁先跑谁建; 三端读同一文件, 所以值一致。
 */
function readOrCreateInstallUuid(): string {
  if (cachedInstallUuid) return cachedInstallUuid;
  const path = join(neoxSecretDataDir(), 'install.id');
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path);
      if (isLocalSecretBlob(raw)) {
        try {
          cachedInstallUuid = decryptLocalSecret(raw);
          return cachedInstallUuid;
        } catch { /* 解不开 → 往下重建 */ }
      } else {
        const utf = raw.toString('utf-8').trim();
        if (utf && utf.length < 256 && /^[\w-]+$/.test(utf)) {
          cachedInstallUuid = utf;
          return cachedInstallUuid;
        }
      }
    }
  } catch { /* ignore */ }

  const uuid = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encryptLocalSecret(uuid), { mode: 0o600 });
  } catch { /* 写不进去 = 下次启动换 uuid; CLI 侧那份会打醒目告警, 这里不重复刷屏 */ }
  cachedInstallUuid = uuid;
  return uuid;
}

/** 设备指纹 hash — 32 字符 base64url。算不出来返 null (调用方按空 fp 处理)。 */
export function computeDeviceFpHash(): string | null {
  if (cachedFpHash) return cachedFpHash;
  try {
    const cpu = os.cpus()[0];
    const blob: Record<string, string> = {
      machineId: getStableMachineId() || 'unknown',
      installUuid: readOrCreateInstallUuid(),
      cpuModel: cpu?.model?.trim().replace(/\s+/g, ' ') ?? 'unknown',
      cpuCount: String(os.cpus().length),
      ramGb: String(Math.round(os.totalmem() / 1e9)),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
    };
    const stable = Object.keys(blob).sort().map((k) => `${k}=${blob[k]}\n`).join('');
    cachedFpHash = createHash('sha256').update(stable).digest('base64url').slice(0, 32);
    return cachedFpHash;
  } catch {
    return null;
  }
}
