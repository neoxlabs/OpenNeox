import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/*
 * 回归: watcher.node 先于 node-pty 加载时, pty 原生层抛的 Napi::Error 会直接 abort 进程。
 * 用子进程复现: 先走 loadParcelWatcher (内部先 preload node-pty), 再让 pty.fork 抛参数错误 ——
 * 必须是 JS 里接得住的异常, 进程正常退出 0。
 */
describe('preloadPtyNative', () => {
  const req = createRequire(import.meta.url);
  let ptyPath: string | null = null;
  let watcherPath: string | null = null;
  try { ptyPath = req.resolve('node-pty'); watcherPath = req.resolve('@parcel/watcher'); } catch { /* 没装就跳过 */ }

  it.skipIf(!ptyPath || !watcherPath || process.platform === 'win32')('pty 先加载后, watcher 在场时 pty 抛错不再 abort', () => {
    const script = `
      require(${JSON.stringify(ptyPath)});
      require(${JSON.stringify(watcherPath)});
      const native = require(${JSON.stringify(ptyPath)}).native;
      try { native.fork(); } catch (e) { console.log('caught'); }
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000 });
    expect(r.stdout).toContain('caught');
    expect(r.status).toBe(0);
  });
});
