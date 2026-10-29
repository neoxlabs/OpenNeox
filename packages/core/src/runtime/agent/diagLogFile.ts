
import * as fs from 'node:fs';
import { isDiagLogEnabled } from '@neoxlabs/kernel/platform/diagLogGate.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

function resolveLogPath(): string {
  try {
    const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录已存在 */ }
    return path.join(dir, 'explore-debug.log');
  } catch {
    return '/tmp/neox-explore-debug.log';
  }
}

const DEBUG_LOG_PATH = resolveLogPath();
let lastWriteError: string | null = null;
let consecutiveFailCount = 0;

export function appendDiagLog(tag: string, payload: any): void {
  if (!isDiagLogEnabled('explore')) return;
  /* 写失败连续 5 次后停止重试 (避免无限刷错), 但前几次失败要把原因留在 console
   * 让用户能看到 "diag log path X 写不进去, 原因 Y" — 不再是静默吞掉. */
  if (consecutiveFailCount >= 5) return;
  try {
    const ts = new Date().toISOString();
    let body: string;
    if (typeof payload === 'string') {
      body = payload;
    } else {
      try {
        body = JSON.stringify(payload, (_k, v) => {
          if (v instanceof Error) {
            return {
              __error_name: v.name,
              __error_message: v.message,
              __error_stack: v.stack,
              __error_cause: (v as any).cause,
            };
          }
          return v;
        }, 2);
      } catch {
        body = String(payload);
      }
    }
    const line = `[${ts}] [${tag}] ${body}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line, { encoding: 'utf8', mode: 0o600 });
    /* 写成功后重置计数, 让间歇性失败也能在恢复后继续记录 */
    consecutiveFailCount = 0;
  } catch (err: any) {
    consecutiveFailCount++;
    const msg = err?.message || String(err);
    if (msg !== lastWriteError) {
      lastWriteError = msg;
      /* 第一次遇到这种错误时 console.error 出来 — 用户能马上看到为啥没写 */
      console.error(`[appendDiagLog] write failed (path=${DEBUG_LOG_PATH}): ${msg}`);
    }
  }
}
