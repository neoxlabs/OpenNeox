
import type { VfsUri } from './uri.js';

// ─── Shape of provider results ───────────────────────────────────────────────

export interface ProviderReadResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface ProviderWriteResult {
  success: boolean;
  error?: string;
}

export interface ProviderStatResult {
  success: boolean;
  stat?: {
    type: 'file' | 'directory';
    size: number;
    /** epoch ms. 未知时为 0. */
    mtime: number;
  };
  error?: string;
}

export interface ProviderListResult {
  success: boolean;
  /** 子项名字 (不含路径). 调用方用 `parent.withPath(parent.path + '/' + name)` 组装. */
  entries?: Array<{ name: string; type: 'file' | 'directory' }>;
  error?: string;
}

export interface ProviderDeleteResult {
  success: boolean;
  error?: string;
}

// ─── The provider interface ─────────────────────────────────────────────────

export interface FileSystemProvider {
  /** 供诊断/错误提示的可读名字, e.g. "memory", "local fs", "git blob". */
  readonly label: string;

  /** 必选: 读文件内容. URI 对应的 path 解析由 provider 自己负责. */
  readFile(uri: VfsUri): Promise<ProviderReadResult>;

  /** 必选: 写文件内容. 覆盖已有, 不做 diff. */
  writeFile(uri: VfsUri, content: string): Promise<ProviderWriteResult>;

  /** 可选: 查 stat. 不支持时省略 —— 调用方自己容错. */
  stat?(uri: VfsUri): Promise<ProviderStatResult>;

  /** 可选: 列子项. 对 directory URI 有效. */
  list?(uri: VfsUri): Promise<ProviderListResult>;

  /** 可选: 删除 (文件或空目录). */
  delete?(uri: VfsUri): Promise<ProviderDeleteResult>;

  /**
   * 可选: 文件变更监听. 返回 unsubscribe.
   * provider 不支持时调用方应通过 VfsRegistry.watch() 得到 no-op 句柄.
   */
  watch?(uri: VfsUri, listener: (event: ProviderWatchEvent) => void): () => void;

  /** 可选: 释放底层资源 (关闭句柄 / 清理 buffer). */
  dispose?(): void | Promise<void>;
}

export interface ProviderWatchEvent {
  type: 'created' | 'changed' | 'deleted';
  uri: VfsUri;
}
