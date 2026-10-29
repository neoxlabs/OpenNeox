import { createRequire } from 'node:module';

let done = false;

export function preloadPtyNative(): void {
  if (done) return;
  done = true;
  if (process.platform === 'win32') return;
  try {
    createRequire(import.meta.url)('node-pty');
  } catch {
    /* 没有 node-pty: shell 会走 execa, 不存在这个冲突 */
  }
}
