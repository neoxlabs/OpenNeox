/**
 * VirtualFileSystem 类型定义
 *
 * 灵感来自 IntelliJ Platform 的 VirtualFileSystem，但做了大幅简化：
 *   - 不引入 PSI / VirtualFilePointer / file system kind 等复杂概念
 *   - 不引入 URI 协议路由（暂时只支持本地路径，未来按需扩展）
 *   - 只保留最核心的 3 件事：read / write / 类型化 file events
 *
 * 核心价值
 * --------
 * 1. **唯一的文件 IO 入口**：所有 service / 组件通过 vfs 读写，不再各自
 *    调 window.neox.readFile/writeFile。未来想加 watch、缓存、远程后端、
 *    worktree、jar、http 等等，都在这一层加，业务代码 0 改动。
 * 2. **类型化 file events**：写文件后通过 MessageBus 发 onChanged，
 *    任何关心的地方（编辑器、Project View、agent UI）订阅同一个 topic。
 * 3. **source 区分**：每个事件带 'editor' / 'agent' / 'external' / 'unknown'
 *    标签 —— 让 EditorService 能跳过自己 save 触发的事件，避免"自己 reload
 *    自己刚写的"循环。
 */

import { createServiceToken } from '../container/ServiceContainer.js';
import { createTopic } from '../bus/MessageBus.js';
import type { ServiceToken } from '../container/ServiceContainer.js';
import type { Topic } from '../bus/MessageBus.js';

/**
 * FileSystemPort —— 底层文件 IO 端口。
 *
 * 这是 VfsService 的"驱动" —— renderer 端实例会绑定 window.neox，
 * 测试 / CLI 端会绑定内存或 node:fs。VfsService 不知道实际驱动是什么。
 *
 * 签名跟 RendererAPI.readFile/writeFile 完全一致，这样 renderer 适配层
 * 就是直接 forward。
 */
export interface FileSystemPort {
  readFile(filePath: string): Promise<{ success: boolean; content?: string; error?: string }>;
  writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }>;
  /**
   * 可选的 stat. 上层 (EditorService) 用它在 readFile 之前提前知道大小,
   * 超过大文件阈值时跳过全读, 改走分页 viewer.
   * 未实现时上层会 fallback 到"先读后分类". 测试 stub 可以不实现.
   */
  stat?(filePath: string): Promise<{ success: boolean; size?: number; isFile?: boolean; error?: string }>;
}

/**
 * 文件变更的来源标签。
 *
 * - 'editor'   编辑器自己的 save —— 编辑器订阅事件时应该跳过这种来源，
 *              避免"自己 save 触发自己 reload"的循环。
 * - 'agent'    agent 工具调用造成的写入（Edit / Write / NotebookEdit 等）。
 *              UI 可以利用这个标签做"agent 改了你的文件，要看 diff 吗？"
 *              这种特殊提示。
 * - 'external' 通过文件 watcher / 系统事件检测到的外部修改（用户在另一个
 *              编辑器改了文件，git checkout 改了文件，等等）。当前阶段还
 *              没接 watcher，预留给未来。
 * - 'unknown'  没有显式标注的来源（兜底）。订阅者应该按"可能是任何来源"
 *              处理。
 */
export type FileChangeSource = 'editor' | 'agent' | 'external' | 'unknown';

/**
 * 一个文件变更事件的载荷。
 *
 * 故意保持极简 —— 不带 oldContent / diff / line range 等。订阅者如果需要
 * 这些信息，自己再 vfs.readFile() 拿当前内容做对比即可。这一层只承诺
 * "某个路径变了"。
 */
export interface FileChangeEvent {
  /** 绝对路径或相对 workspace 的路径，跟 vfs 调用时传的一致 */
  path: string;
  /** 变更来源 */
  source: FileChangeSource;
}

/**
 * VFS 在 MessageBus 上发布的事件接口。
 *
 * 当前只覆盖最常用的 3 个：onCreated / onChanged / onDeleted。
 * onMoved / onRenamed / onPermissionsChanged 等等，按未来需要扩展。
 *
 * **订阅者应该实现关心的方法，缺方法的方法调用会被自动跳过**（MessageBus
 * 的 Proxy 机制保证）。
 */
export interface FileEvents {
  onCreated(event: FileChangeEvent): void;
  onChanged(event: FileChangeEvent): void;
  onDeleted(event: FileChangeEvent): void;
}

/** VFS 在 MessageBus 上的 topic */
export const FILES_TOPIC: Topic<FileEvents> = createTopic<FileEvents>('vfs.files');

/**
 * VfsService 在 ServiceContainer 中的 token。
 * 作用域 = 'app'：VFS 是应用全局的文件 IO 入口，不跟着 workspace 切换重建。
 *
 * （未来如果需要 workspace-specific VFS，比如 worktree 子 VFS，再在
 * workspace 子容器另注册一个 token，subscribers 按需 fallback）。
 */
// 前向引用：VfsService 类在另一文件里定义。
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export const VFS_SERVICE: ServiceToken<import('./VfsService.js').VfsService> =
  createServiceToken('vfs', 'app');

/** writeFile 的可选项 */
export interface VfsWriteOptions {
  source?: FileChangeSource;
}
