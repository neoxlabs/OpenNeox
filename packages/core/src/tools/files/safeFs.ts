/**
 * safeFs — fs/promises 的限流 wrapper, 所有 file ops 经过 fileLimiter.
 *
 *  H1 创建. 替换工具内裸 `import * as fs from 'fs/promises'` 改用本模块,
 * 避免 K=N explore 子 agent 并发 fs.open 爆 EMFILE。
 *
 * 用法:
 *   import { safeFs } from '<path>/files/safeFs.js';
 *   const content = await safeFs.readFile(path, 'utf-8');
 *
 * 不在限流范围: 文件不存在判定 (existsSync 同步) / path 操作 / glob 索引读 (它们自己有控制)。
 */

import * as fs from 'node:fs/promises';
import { runWithFileLimit } from './fileLimiter.js';

export const safeFs = {
  readFile: ((path: Parameters<typeof fs.readFile>[0], options?: Parameters<typeof fs.readFile>[1]) =>
    runWithFileLimit(() => fs.readFile(path, options as any))) as typeof fs.readFile,

  writeFile: ((path: Parameters<typeof fs.writeFile>[0], data: Parameters<typeof fs.writeFile>[1], options?: Parameters<typeof fs.writeFile>[2]) =>
    runWithFileLimit(() => fs.writeFile(path, data, options))) as typeof fs.writeFile,

  appendFile: ((path: Parameters<typeof fs.appendFile>[0], data: Parameters<typeof fs.appendFile>[1], options?: Parameters<typeof fs.appendFile>[2]) =>
    runWithFileLimit(() => fs.appendFile(path, data, options))) as typeof fs.appendFile,

  stat: ((path: Parameters<typeof fs.stat>[0], options?: Parameters<typeof fs.stat>[1]) =>
    runWithFileLimit(() => fs.stat(path, options as any))) as typeof fs.stat,

  lstat: ((path: Parameters<typeof fs.lstat>[0], options?: Parameters<typeof fs.lstat>[1]) =>
    runWithFileLimit(() => fs.lstat(path, options as any))) as typeof fs.lstat,

  readdir: ((path: Parameters<typeof fs.readdir>[0], options?: Parameters<typeof fs.readdir>[1]) =>
    runWithFileLimit(() => fs.readdir(path, options as any))) as typeof fs.readdir,

  mkdir: ((path: Parameters<typeof fs.mkdir>[0], options?: Parameters<typeof fs.mkdir>[1]) =>
    runWithFileLimit(() => fs.mkdir(path, options as any))) as typeof fs.mkdir,

  unlink: ((path: Parameters<typeof fs.unlink>[0]) =>
    runWithFileLimit(() => fs.unlink(path))) as typeof fs.unlink,

  rename: ((oldPath: Parameters<typeof fs.rename>[0], newPath: Parameters<typeof fs.rename>[1]) =>
    runWithFileLimit(() => fs.rename(oldPath, newPath))) as typeof fs.rename,

  rm: ((path: Parameters<typeof fs.rm>[0], options?: Parameters<typeof fs.rm>[1]) =>
    runWithFileLimit(() => fs.rm(path, options))) as typeof fs.rm,

  access: ((path: Parameters<typeof fs.access>[0], mode?: Parameters<typeof fs.access>[1]) =>
    runWithFileLimit(() => fs.access(path, mode))) as typeof fs.access,
};
