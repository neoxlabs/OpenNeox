import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface CloudPrefs {
  /** 用户显式停用了云中继 (远程连接). 缺省 false = 启用. */
  disabled: boolean;
}

function prefsFilePath(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'cloud-prefs.json');
}

function legacyCredFilePath(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'cloud-credentials.json');
}

export function loadCloudPrefs(): CloudPrefs {
  try {
    const j = JSON.parse(fs.readFileSync(prefsFilePath(), 'utf-8'));
    return { disabled: j?.disabled === true };
  } catch {
    try {
      fs.unlinkSync(legacyCredFilePath());
    } catch { /* 本来就没有 */ }
    return { disabled: false };
  }
}

export function saveCloudPrefs(p: CloudPrefs): void {
  const file = prefsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(p, null, 2), { mode: 0o600 });
}

/** 用户是否显式停用了远程连接. 默认 false —— 登录即连. */
export function isCloudRelayDisabledByUser(): boolean {
  return loadCloudPrefs().disabled === true;
}
