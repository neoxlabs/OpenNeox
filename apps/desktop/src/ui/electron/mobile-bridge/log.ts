import * as fs from 'node:fs';
import { isDiagLogEnabled } from '@neoxlabs/kernel/platform/diagLogGate.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const LOG_FILE = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'mobile-bridge.log');
const FLUSH_MS = 250;
const FLUSH_BYTES = 64 * 1024;

let ensured = false;
let buffer = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writing = false;

function writeOut(chunk: string): void {
  try {
    if (!ensured) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      ensured = true;
    }
    writing = true;
    fs.appendFile(LOG_FILE, chunk, () => {
      writing = false;
      /* flush 期间又攒了新行 → 立即再写, 保持行序 (单飞行写, 不并发 appendFile) */
      if (buffer.length > 0) {
        const next = buffer;
        buffer = '';
        writeOut(next);
      }
    });
  } catch {
    writing = false;
    /* swallow — 写日志失败不能影响主流程 */
  }
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (writing || buffer.length === 0) return;
  const chunk = buffer;
  buffer = '';
  writeOut(chunk);
}

export function bridgeLog(tag: string, msg: string): void {
  if (!isDiagLogEnabled('mobile-bridge')) return;
  try {
    buffer += `${new Date().toISOString()} [${tag}] ${msg}\n`;
    if (buffer.length >= FLUSH_BYTES) {
      flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
      flushTimer.unref?.();
    }
  } catch {
    /* swallow */
  }
}

/** 进程退出前尽力把残留 buffer 同步落盘 (退出路径允许一次同步写). */
export function flushBridgeLogSync(): void {
  try {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buffer.length === 0) return;
    const chunk = buffer;
    buffer = '';
    if (!ensured) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      ensured = true;
    }
    fs.appendFileSync(LOG_FILE, chunk, { mode: 0o600 });
  } catch {
    /* swallow */
  }
}

export const BRIDGE_LOG_FILE = LOG_FILE;
