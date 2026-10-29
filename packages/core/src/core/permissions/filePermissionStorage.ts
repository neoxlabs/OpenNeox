
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PermissionMemoryStorage } from '@neoxlabs/kernel/core/permissions/PermissionManager.js';
import type { PermissionMemory } from '@neoxlabs/kernel/types/permissions.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 默认落点: ~/.neox/permissions.json (lite 分支的 NEOX_HOME_DIRNAME 不同, 跟着走)。 */
export function defaultPermissionsFilePath(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'permissions.json');
}

/**
 * 建一个文件后端。不传路径就用默认落点。
 *
 * 读: 文件不存在 / JSON 坏了都返 null —— 权限记忆丢了顶多多问一次, 绝不能让它挡住启动。
 * 写: 临时文件 + rename, 保证不会读到写了一半的 JSON。
 */
export function createFilePermissionStorage(filePath = defaultPermissionsFilePath()): PermissionMemoryStorage {
  return {
    load(): Record<string, PermissionMemory> | null {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, PermissionMemory>;
      return parsed && typeof parsed === 'object' ? parsed : null;
    },
    save(entries: Record<string, PermissionMemory>): void {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    },
  };
}
