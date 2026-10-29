import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

function logDir(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
}

function filePath(): string {
  return path.join(logDir(), 'startup-last.log');
}

/** 写失败一律静默 —— 这是诊断设施, 不能反过来把启动搞挂。 */
function safeWrite(line: string): void {
  try {
    fs.appendFileSync(filePath(), line);
  } catch { /* 磁盘满 / 目录没权限 / 只读盘: 都不该影响启动 */ }
}

let startedAt = 0;

/** 启动最开头调一次: 轮转上一份, 开新的一份. */
export function beginStartupBreadcrumb(meta: Record<string, unknown>): void {
  startedAt = Date.now();
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const p = filePath();
    if (fs.existsSync(p)) {
      /* 上一次的留一份 —— "重开一次就好了"的情况要能两份对照看 */
      try { fs.renameSync(p, p + '.prev'); } catch { /* 占用中就直接覆盖 */ }
    }
    fs.writeFileSync(p, '');
  } catch { /* 同 safeWrite: 不影响启动 */ }
  safeWrite(`=== startup ${new Date().toISOString()} ===\n${JSON.stringify(meta)}\n`);
}

/** 记一步. 卡住时最后一行就是卡住的那一步 —— 这就是全部用法. */
export function breadcrumb(step: string, detail?: string): void {
  const dt = startedAt ? Date.now() - startedAt : 0;
  safeWrite(`+${dt}ms ${step}${detail ? ' — ' + detail : ''}\n`);
}
