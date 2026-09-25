
import { existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const neoxHome = (): string => join(os.homedir(), NEOX_HOME_DIRNAME);

const SENSITIVE_FILES = (): string[] => [
  join(neoxHome(), 'auth.enc'),
  join(neoxHome(), 'gateway-key.enc'),
  join(neoxHome(), 'routing.json'),
  join(neoxHome(), 'test-account.json'),
];

const SENSITIVE_DIRS = (): string[] => [neoxHome()];

const REQUIRED_FILE_MODE = 0o600;
const REQUIRED_DIR_MODE = 0o700;

export interface SecurityAuditResult {
  checked: number;
  fixed: string[];      /* 路径 — 我们 chmod 修了 */
  warnings: string[];   /* 路径 — 修不了 / 不归我们 */
  errors: string[];     /* stat / chmod 异常 */
}

export function auditSensitiveFiles(): SecurityAuditResult {
  const result: SecurityAuditResult = { checked: 0, fixed: [], warnings: [], errors: [] };

  /* Windows 用 ACL 不用 octal mode — 跳过 */
  if (process.platform === 'win32') return result;

  /* 1. 文件 0600 */
  for (const path of SENSITIVE_FILES()) {
    enforceMode(path, REQUIRED_FILE_MODE, false, result);
  }

  /* 2. 父目录 0700 — 防 ls 列举文件名 */
  for (const dir of SENSITIVE_DIRS()) {
    enforceMode(dir, REQUIRED_DIR_MODE, true, result);
  }

  return result;
}

function enforceMode(
  path: string,
  required: number,
  isDir: boolean,
  result: SecurityAuditResult,
): void {
  if (!existsSync(path)) return;
  result.checked += 1;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (e: any) {
    result.errors.push(`stat ${path}: ${e?.message}`);
    return;
  }
  /* type sanity check — 防有人把 ~/.neox 弄成 symlink/file */
  if (isDir && !stat.isDirectory()) {
    result.warnings.push(`${path}: 期望目录但是 ${stat.isFile() ? '文件' : '其它'}, 跳过`);
    return;
  }
  const currentMode = stat.mode & 0o777;
  if (currentMode === required) return;

  if (stat.uid !== process.getuid?.()) {
    result.warnings.push(`${path}: mode=${currentMode.toString(8)}, 不是当前用户拥有 (uid=${stat.uid}), 跳过. 手动 chmod ${required.toString(8)} + 改 owner.`);
    return;
  }
  try {
    chmodSync(path, required);
    result.fixed.push(`${path}: ${currentMode.toString(8)} → ${required.toString(8)}`);
  } catch (e: any) {
    result.errors.push(`chmod ${path}: ${e?.message}`);
  }
}
