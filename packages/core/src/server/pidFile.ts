import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/* pid file 是 runtime 资源 (机器重启即失效), 挪到 /tmp 不再污染 ~/.neox/.
 * XDG_RUNTIME_DIR 若存在 (systemd 用户会话) 优先用. */
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || '/tmp';
const NEOX_DIR = path.join(RUNTIME_DIR, 'neox-runtime');
try { fs.mkdirSync(NEOX_DIR, { recursive: true }); } catch { /* /tmp 一般可写 */ }
const PID_FILE = path.join(NEOX_DIR, 'server.pid');

export interface PidInfo {
  pid: number;
  port: number;
  workDir: string;
  startedAt: number;
  daemon?: boolean;
  /** dist/server/main.js 的修改时间哈希，用于检测 build 后的代码更新 */
  buildHash?: string;
  /** Bearer token (server 启动时生成). reuse daemon 时通过 pid file 把 token 回灌给 client. */
  token?: string;
  /** 启动该 daemon 时用的 --identity-dir (阶段4): 复用时核对身份目录是否一致。 */
  identityDir?: string;
  /** 身份纪元 = 当时登录 userId(或 'anon') (阶段4): 复用前比对, 不一致(换户/登出)即回收重启。 */
  identityEpoch?: string;
}

function getWorkDirHash(workDir: string): string {
  let hash = 0;
  for (let i = 0; i < workDir.length; i++) {
    const char = workDir.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

function getPidFilePath(workDir: string, identityEpoch?: string): string {
  /* 方案 C : pid 文件按 workdir + 身份 编号 → 同身份共享 daemon、异身份各起、永不 thrash
   * (根治 CLI(~/.neox) 与桌面(userData) 同 workdir 但身份不同时互杀 daemon, 以及换户回收)。
   * 不传 identityEpoch 时退回旧的纯 workdir 编号 (向后兼容, 全局查询用)。 */
  const key = identityEpoch ? `${workDir}::${identityEpoch}` : workDir;
  const hash = getWorkDirHash(key);
  return path.join(NEOX_DIR, `server-${hash}.pid`);
}

/**
 * 获取当前 dist/server/main.js 的 build hash（基于文件 mtime + size）
 */
export function getServerBuildHash(): string {
  try {
    /* fileURLToPath, 不能写 `.pathname` : Windows 上 pathname 是
     * `/E:/code/...`, 盘符前多一个斜杠 —— path.resolve 会把它当"当前盘的相对路径",
     * 拼出 `E:\E:\code\...`, existsSync 永远 false。后果是 hash 拿不到、pid 文件名
     * 退化成兜底值, 而报错看起来跟路径无关。 */
    const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const serverEntry = path.join(distDir, 'server', 'main.js');
    if (fs.existsSync(serverEntry)) {
      const stat = fs.statSync(serverEntry);
      // 用 mtime + size 的组合作为简易 hash
      return `${stat.mtimeMs.toFixed(0)}_${stat.size}`;
    }
  } catch {
    // ignore
  }
  return '';
}

export function writePidFile(info: PidInfo): void {
  if (!fs.existsSync(NEOX_DIR)) {
    fs.mkdirSync(NEOX_DIR, { recursive: true, mode: 0o700 });
  }

  //  自动附加 buildHash
  const enrichedInfo = { ...info, buildHash: info.buildHash || getServerBuildHash() };
  // 身份隔离编号: 用 info.identityEpoch (server 启动时已据 --identity-dir 算好)。
  const scopedPidFile = getPidFilePath(info.workDir, info.identityEpoch);
  const data = JSON.stringify(enrichedInfo, null, 2);
  /* 安全 (企业级审计): pid 文件含 daemon 的 Bearer token, 任何能读它的本机进程都能
   * 冒充 client 调 daemon (执行 shell / 用已解密凭据)。所以 0600 (仅本用户) + 目录 0700。
   * writeFileSync 的 mode 只在【创建】时生效, 覆盖已有文件不改权限 → 再 chmodSync 兜底。
   * Windows 忽略 mode, 靠 NTFS 用户目录隔离。 */
  fs.writeFileSync(scopedPidFile, data, { mode: 0o600 });
  fs.writeFileSync(PID_FILE, data, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(scopedPidFile, 0o600); } catch { /* ignore */ }
    try { fs.chmodSync(PID_FILE, 0o600); } catch { /* ignore */ }
    try { fs.chmodSync(NEOX_DIR, 0o700); } catch { /* ignore */ }
  }
}

export function removePidFile(workDir: string, identityEpoch?: string): void {
  try {
    const scopedPidFile = getPidFilePath(workDir, identityEpoch);
    if (fs.existsSync(scopedPidFile)) fs.unlinkSync(scopedPidFile);

    if (fs.existsSync(PID_FILE)) {
      const mainPid = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8')) as PidInfo;
      if (mainPid.workDir === workDir) {
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch {
    // ignore
  }
}

export function readPidFile(workDir?: string, identityEpoch?: string): PidInfo | null {
  try {
    if (workDir) {
      const scopedPidFile = getPidFilePath(workDir, identityEpoch);
      if (fs.existsSync(scopedPidFile)) {
        return JSON.parse(fs.readFileSync(scopedPidFile, 'utf-8'));
      }

      if (fs.existsSync(PID_FILE)) {
        const mainPid = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8')) as PidInfo;
        /* 全局兜底: workDir 匹配 + (若指定身份) 身份也匹配 → 不同身份的 daemon 不会被误认。 */
        const sameWs = mainPid?.workDir && path.resolve(mainPid.workDir) === path.resolve(workDir);
        const sameId = !identityEpoch || mainPid.identityEpoch === identityEpoch;
        if (sameWs && sameId) {
          return mainPid;
        }
      }
      return null;
    }

    if (fs.existsSync(PID_FILE)) {
      return JSON.parse(fs.readFileSync(PID_FILE, 'utf-8'));
    }
    return null;
  } catch {
    return null;
  }
}

