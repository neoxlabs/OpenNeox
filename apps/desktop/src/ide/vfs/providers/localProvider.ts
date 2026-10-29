/**
 * LocalFileSystemProvider —— 把已有 `FileSystemPort` (read/write) 包装成
 * 完整 `FileSystemProvider`.
 *
 * 向下兼容策略:
 *   - 现有 `VfsService` 构造时接受 `FileSystemPort`, 那是 2-method 的 minimal
 *     接口. LocalFileSystemProvider 就是把这个 port 升级成 file: scheme 的
 *     完整 provider.
 *   - stat / list / delete / watch 是可选扩展; Port 不提供时, provider 暴露
 *     为 "不支持" 让 Registry 处理.
 *
 * path 语义:
 *   - file:///abs/path → 传给 port 的是 absPath (path 去掉前导 `/`,
 *     Windows 盘符前导 `/` 也去掉)
 */

import type {
  FileSystemProvider,
  ProviderReadResult,
  ProviderWriteResult,
} from '../fileSystemProvider.js';
import type { FileSystemPort } from '../types.js';
import type { VfsUri } from '../uri.js';

export class LocalFileSystemProvider implements FileSystemProvider {
  readonly label = 'local-fs';

  constructor(private readonly port: FileSystemPort) {}

  async readFile(uri: VfsUri): Promise<ProviderReadResult> {
    const abs = toAbsPath(uri);
    return this.port.readFile(abs);
  }

  async writeFile(uri: VfsUri, content: string): Promise<ProviderWriteResult> {
    const abs = toAbsPath(uri);
    return this.port.writeFile(abs, content);
  }

  // stat / list / delete / watch: 当前 FileSystemPort 不暴露这些能力, 所以
  // LocalFileSystemProvider 也不提供. 调用方通过 Registry 判定 "undefined"
  // 走退化路径 (Electron 场景下可直接用 main 进程 IPC file:stat / file:list
  // 那些已有 handler, 未来可再加第二个构造参数注入).
}

function toAbsPath(uri: VfsUri): string {
  if (uri.scheme !== 'file') {
    throw new Error(`LocalFileSystemProvider: expected file:// scheme, got "${uri.scheme}"`);
  }
  return uri.fsPath;
}
