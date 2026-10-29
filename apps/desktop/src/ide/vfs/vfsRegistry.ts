/**
 * VfsRegistry —— scheme 到 FileSystemProvider 的映射表.
 *
 * 一个 scheme 一个 provider. 重复注册同 scheme → 抛 `SchemeConflictError`
 * (避免插件/核心互相覆盖). 明确用 unregister 来替换.
 *
 * 与 VfsService 的分工:
 *   - Registry: 只负责 "scheme → provider" 映射 + 生命周期
 *   - VfsService: 业务 facade, 调用 Registry.resolve(uri) 拿到 provider,
 *     转调其 read/write, 再负责 event 广播
 *
 * 未来扩展:
 *   - plugin 注册自定义 scheme (e.g. `git://` / `zip://`)
 *   - workspace 级子 registry (在 app-scope registry 之上做 override)
 */

import type { FileSystemProvider } from './fileSystemProvider.js';
import type { VfsUri } from './uri.js';

export class SchemeConflictError extends Error {
  constructor(
    public readonly scheme: string,
    public readonly existingLabel: string,
    public readonly incomingLabel: string,
  ) {
    super(
      `VfsRegistry: scheme "${scheme}" already registered by "${existingLabel}"; ` +
      `cannot register "${incomingLabel}". Call unregister first.`,
    );
    this.name = 'SchemeConflictError';
  }
}

export class UnknownSchemeError extends Error {
  constructor(public readonly scheme: string, public readonly uri: string) {
    super(`VfsRegistry: no provider registered for scheme "${scheme}" (uri=${uri})`);
    this.name = 'UnknownSchemeError';
  }
}

export class VfsRegistry {
  private readonly providers = new Map<string, FileSystemProvider>();

  /**
   * 注册 provider. 同 scheme 重复注册 → 抛 SchemeConflictError.
   * 返回 unregister 句柄, 方便插件按生命周期卸载.
   */
  register(scheme: string, provider: FileSystemProvider): () => void {
    const key = normalizeScheme(scheme);
    const existing = this.providers.get(key);
    if (existing) {
      throw new SchemeConflictError(key, existing.label, provider.label);
    }
    this.providers.set(key, provider);
    return () => { this.unregister(key); };
  }

  /** 解注册. 返回是否真的移除了. 同时 dispose 对应 provider (若 provider 实现 dispose). */
  unregister(scheme: string): boolean {
    const key = normalizeScheme(scheme);
    const provider = this.providers.get(key);
    if (!provider) return false;
    this.providers.delete(key);
    try { void provider.dispose?.(); } catch { /* swallow */ }
    return true;
  }

  /**
   * 按 URI 解析 provider. 未注册 → 抛 UnknownSchemeError.
   * 用在 hot path: 错误尽早可见比默默 fallback 好.
   */
  resolve(uri: VfsUri): FileSystemProvider {
    const provider = this.providers.get(uri.scheme);
    if (!provider) throw new UnknownSchemeError(uri.scheme, uri.toString());
    return provider;
  }

  /** 同 resolve 但找不到返回 null 而非抛, 供调用方判断是否 fallback. */
  tryResolve(uri: VfsUri): FileSystemProvider | null {
    return this.providers.get(uri.scheme) ?? null;
  }

  /** 某 scheme 是否有 provider. */
  has(scheme: string): boolean {
    return this.providers.has(normalizeScheme(scheme));
  }

  /** 诊断 snapshot, 返回已注册 scheme 列表 + provider label. */
  snapshot(): Array<{ scheme: string; label: string }> {
    return Array.from(this.providers.entries()).map(([scheme, p]) => ({
      scheme,
      label: p.label,
    }));
  }

  /**
   * 销毁所有 provider. 测试 / HMR 重置用; 生产中 VFS 是 app 级单例,
   * 通常随进程生命周期存在, 不主动 dispose.
   */
  async dispose(): Promise<void> {
    const all = Array.from(this.providers.values());
    this.providers.clear();
    for (const provider of all) {
      try { await provider.dispose?.(); } catch { /* swallow */ }
    }
  }
}

function normalizeScheme(scheme: string): string {
  if (!scheme) throw new Error('VfsRegistry: empty scheme');
  return scheme.toLowerCase();
}
