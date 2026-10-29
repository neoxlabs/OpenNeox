/**
 * @neox/ide/vfs —— VirtualFileSystem
 *
 * 客户端文件 IO 的统一入口 + 类型化的 file events。
 * 详见各文件头部注释。
 */

export { VfsService } from './VfsService.js';
export type { VfsServiceOptions } from './VfsService.js';
export {
  FILES_TOPIC,
  VFS_SERVICE,
} from './types.js';
export type {
  FileSystemPort,
  FileChangeSource,
  FileChangeEvent,
  FileEvents,
  VfsWriteOptions,
} from './types.js';

// ─── P6: URI + Registry + Providers ──────────────────────────────────────────
export { VfsUri, uri } from './uri.js';
export {
  VfsRegistry,
  SchemeConflictError,
  UnknownSchemeError,
} from './vfsRegistry.js';
export type {
  FileSystemProvider,
  ProviderReadResult,
  ProviderWriteResult,
  ProviderStatResult,
  ProviderListResult,
  ProviderDeleteResult,
  ProviderWatchEvent,
} from './fileSystemProvider.js';
export { MemoryFileSystemProvider } from './providers/memoryProvider.js';
export { LocalFileSystemProvider } from './providers/localProvider.js';
