/**
 * VfsService —— 客户端文件 IO 的统一入口。
 *
 * 设计目标
 * --------
 * 1. **唯一入口**：所有需要读写文件的 service / 组件都通过这里走，
 *    不再各自调 `window.neox.readFile/writeFile`。
 * 2. **类型化事件**：写入成功后通过 MessageBus 发 onChanged 事件，
 *    任何关心的 service 订阅就能立刻看到（编辑器、Project View、agent UI…）。
 * 3. **source 区分**：每个事件带 source 标签，让订阅者能跳过自己造成的
 *    那一份事件，避免循环（典型场景：编辑器自己 save 不应该触发自己 reload）。
 * 4. **极简 API**：当前只 read / write，故意不引入 watch / list / stat。
 *    后续按需增量加，每次扩展都是局部、可回滚的小改动。
 *
 * 不变式
 * ------
 * - read 不发任何事件（读不改状态）
 * - write 成功 → 同步在 await 链路上发 onChanged
 * - write 失败 → 不发任何事件，把 fs 的错误结构体原样返回
 * - 事件 publish 在 fs.writeFile resolve **之后**：保证订阅者看到的是
 *   真实落盘的状态，不会出现"事件先到、磁盘还没写完"的窗口
 *
 * 性能考量
 * --------
 * - read / write 路径几乎是 fs 的 1:1 转发，开销可忽略
 * - 事件 dispatch 由 MessageBus.publisher 完成，O(订阅者数量)
 * - 当前没有缓存层 —— 加缓存的右时机是出现重复读热点之后，不要预先优化
 *
 * 跟 IDEA VirtualFileSystem 的关系
 * --------------------------------
 * 这是一个**裁剪到极致**的 VFS：
 *   - 不引入 VirtualFile 句柄（path 直接当 key）
 *   - 不引入 URI 协议路由（暂时只支持本地路径）
 *   - 不引入 PSI / FileType / Pointer 等高级概念
 * 这些概念按需后续加，每加一个都是单独 PR。
 */

import type { MessageBus } from '../bus/MessageBus.js';
import { FILES_TOPIC } from './types.js';
import type {
  FileChangeSource,
  FileSystemPort,
  VfsWriteOptions,
} from './types.js';
import type { VfsUri } from './uri.js';
import { VfsRegistry, UnknownSchemeError } from './vfsRegistry.js';
import { LocalFileSystemProvider } from './providers/localProvider.js';

export interface VfsServiceOptions {
  /** 底层文件 IO 端口（renderer 端是 window.neox 适配器，测试是内存 fs） */
  fs: FileSystemPort;
  /** MessageBus，用来发 file events。必填 —— 没有 bus 就失去了 VFS 的核心价值 */
  bus: MessageBus;
  /**
   * 可选: 外部注入的 VfsRegistry. 省略时 VfsService 自建一个, 并自动注册
   * `file:` scheme = LocalFileSystemProvider(fs). 测试 / 插件场景可以先
   * 构造一个 registry 注册自己的 provider, 再传给 VfsService.
   */
  registry?: VfsRegistry;
}

export class VfsService {
  private readonly fs: FileSystemPort;
  private readonly bus: MessageBus;
  private readonly registry: VfsRegistry;

  constructor(options: VfsServiceOptions) {
    this.fs = options.fs;
    this.bus = options.bus;
    this.registry = options.registry ?? new VfsRegistry();
    // 自动挂 file: provider, 除非外部 registry 已注册
    if (!this.registry.has('file')) {
      this.registry.register('file', new LocalFileSystemProvider(this.fs));
    }
  }

  /** 暴露 registry 让调用方注册自定义 scheme (memory://, git://, etc.). */
  getRegistry(): VfsRegistry {
    return this.registry;
  }

  /**
   * 读文件。**不发任何事件** —— 读不改变状态，没有什么值得通知的。
   *
   * 调用方拿到的结构跟 FileSystemPort.readFile 一致 —— 失败时
   * `success: false`，错误信息在 `error` 字段。
   */
  async readFile(filePath: string): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    return this.fs.readFile(filePath);
  }

  /**
   * 可选的 stat —— fs port 实现了就用, 没实现返回 success:false.
   * EditorService 用来在 readFile 之前提前检查文件大小.
   */
  async stat(filePath: string): Promise<{
    success: boolean;
    size?: number;
    isFile?: boolean;
    error?: string;
  }> {
    if (!this.fs.stat) return { success: false, error: 'stat not supported by fs port' };
    return this.fs.stat(filePath);
  }

  async writeFile(
    filePath: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.fs.writeFile(filePath, content);
    if (result.success) {
      this.publishChanged(filePath, options?.source ?? 'unknown');
    }
    return result;
  }

  /**
   * 主动声明一个文件变更事件 —— 用于"VFS 没参与写入但我们知道文件变了"
   * 的场景。
   *
   * 典型用例：
   *   - agent 通过另一条路径写了文件（比如直接走主进程 IPC），renderer
   *     端要让其他 service 知道
   *   - 文件 watcher 检测到外部修改
   *   - 测试夹具想模拟"外部进程改了文件"
   *
   * 直接调用方式比 writeFile 更明确：调用方在告诉 VFS"事件本身"，
   * 而不是请求 VFS 去落盘。
   */
  notifyChanged(filePath: string, source: FileChangeSource = 'unknown'): void {
    this.publishChanged(filePath, source);
  }

  /** 同上，针对创建场景 */
  notifyCreated(filePath: string, source: FileChangeSource = 'unknown'): void {
    this.bus.publisher(FILES_TOPIC).onCreated({ path: filePath, source });
  }

  /** 同上，针对删除场景 */
  notifyDeleted(filePath: string, source: FileChangeSource = 'unknown'): void {
    this.bus.publisher(FILES_TOPIC).onDeleted({ path: filePath, source });
  }

  // ============================================================================
  // URI 路径 —— P6 新增, 与旧 `readFile(path)` 并存.
  //
  // 语义:
  //   - 按 uri.scheme 走 registry 路由到对应 provider
  //   - 未注册 scheme → 抛 UnknownSchemeError (让 bug 尽早可见)
  //   - 事件路径: 复用 FILES_TOPIC, 把 uri.toString() 当作 path 字段传出
  //     (兼容 string-based 订阅者; 未来可以加 uriChanged event 类型)
  // ============================================================================

  /** 按 URI 读. 走 registry 按 scheme 分发. */
  async readUri(uri: VfsUri): Promise<{ success: boolean; content?: string; error?: string }> {
    const provider = this.registry.resolve(uri);
    return provider.readFile(uri);
  }

  /** 按 URI 写. 成功后复用旧 FILES_TOPIC 发 onChanged. */
  async writeUri(
    uri: VfsUri,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const provider = this.registry.resolve(uri);
    const result = await provider.writeFile(uri, content);
    if (result.success) {
      this.publishChanged(uri.toString(), options?.source ?? 'unknown');
    }
    return result;
  }

  /**
   * 可选的 stat —— provider 不支持时 `success:false`. 调用方不要当必须可用.
   */
  async statUri(uri: VfsUri): Promise<{
    success: boolean;
    stat?: { type: 'file' | 'directory'; size: number; mtime: number };
    error?: string;
  }> {
    const provider = this.registry.resolve(uri);
    if (!provider.stat) return { success: false, error: `${provider.label}: stat not supported` };
    return provider.stat(uri);
  }

  /** 删除. Provider 不支持则 `success:false`. */
  async deleteUri(uri: VfsUri): Promise<{ success: boolean; error?: string }> {
    const provider = this.registry.resolve(uri);
    if (!provider.delete) return { success: false, error: `${provider.label}: delete not supported` };
    const result = await provider.delete(uri);
    if (result.success) {
      this.bus.publisher(FILES_TOPIC).onDeleted({ path: uri.toString(), source: 'unknown' });
    }
    return result;
  }

  /** 返回 UnknownSchemeError 类型便于调用方 instanceof 检查. */
  static readonly UnknownSchemeError = UnknownSchemeError;

  // ============================================================================
  // 内部
  // ============================================================================

  private publishChanged(filePath: string, source: FileChangeSource): void {
    this.bus.publisher(FILES_TOPIC).onChanged({ path: filePath, source });
  }
}
