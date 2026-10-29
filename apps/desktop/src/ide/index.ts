/**
 * @neox/ide — IDE 平台层
 *
 * 这是 Neox 客户端架构重构的第一块基石。对标 IntelliJ Platform 的角色：
 * 给"编辑器、Project View、Find in Files、终端、调试、agent 渲染、插件…"
 * 提供一个共同的、可组合的运行时骨架。
 *
 * 当前提供的能力（第一阶段）
 * --------------------------
 * - {@link ServiceContainer}  类型化服务容器，两层作用域（app / workspace）
 * - {@link MessageBus}        类型化 pub/sub 事件总线
 * - {@link CommandRegistry}   命令注册与执行（Keymap / 菜单 / agent 共用）
 *
 * 后续阶段将加入（按顺序）
 * -----------------------
 * - VirtualFileSystem (VFS)        统一的文件抽象层
 * - Document / Editor 三层模型      VirtualFile / Document / Editor 分离
 * - ActionRegistry / 菜单贡献       AnAction-style 注册
 * - ExtensionPoint                   插件命名插槽
 * - ToolWindowRegistry               侧边栏 / 底部栏面板注册
 * - FileEditorProvider               "这种文件用哪个编辑器" 的注册
 *
 * 设计原则
 * --------
 * - 零环境依赖：本目录下的代码不 import React / Electron / Node API，
 *   可以同时跑在 renderer / main / cli / vitest。
 * - additive：每一层都是可独立使用的小模块，不强制整套迁移。
 * - 类型化：不用字符串 event 名、不用 any。
 */

export {
  ServiceContainer,
  createServiceToken,
} from './container/ServiceContainer.js';
export type {
  ServiceToken,
  ServiceScope,
  ServiceFactory,
  ServiceDisposer,
} from './container/ServiceContainer.js';

export { MessageBus, createTopic, MESSAGE_BUS } from './bus/MessageBus.js';
export type { Topic, TopicListener, Unsubscribe } from './bus/MessageBus.js';

export { CommandRegistry, COMMAND_REGISTRY } from './commands/CommandRegistry.js';
export type {
  CommandDescriptor,
  CommandContext,
  CommandHandler,
  CommandUnregister,
} from './commands/CommandRegistry.js';

// ===== VFS 平台层（step 5 起新增） =====
export {
  VfsService,
  VFS_SERVICE,
  FILES_TOPIC,
  // P6: URI + Registry + Providers
  VfsUri,
  uri,
  VfsRegistry,
  SchemeConflictError,
  UnknownSchemeError,
  MemoryFileSystemProvider,
  LocalFileSystemProvider,
} from './vfs/index.js';
export type {
  VfsServiceOptions,
  FileSystemPort,
  FileChangeSource,
  FileChangeEvent,
  FileEvents,
  VfsWriteOptions,
  // P6 types
  FileSystemProvider,
  ProviderReadResult,
  ProviderWriteResult,
  ProviderStatResult,
  ProviderListResult,
  ProviderDeleteResult,
  ProviderWatchEvent,
} from './vfs/index.js';

// ===== Editor 平台层（step 2 起新增） =====
export { EditorService, EDITOR_SERVICE, EDITOR_TOPIC } from './editor/index.js';
export type {
  EditorServiceOptions,
  EditorTab,
  EditorState,
  EditorEvents,
} from './editor/index.js';

// ===== Focus 平台层（step 7B 起新增） =====
export { FocusService, FOCUS_SERVICE, FOCUS_TOPIC } from './focus/index.js';
export type {
  FocusServiceOptions,
  FocusScope,
  FocusEvents,
} from './focus/index.js';

// ===== Tool Window 平台层（step 7C 起新增） =====
export {
  ToolWindowRegistry,
  TOOL_WINDOW_REGISTRY,
  TOOL_WINDOWS_TOPIC,
} from './toolWindow/index.js';
export type {
  ToolWindowRegistryOptions,
  ToolWindowUnregister,
  ToolWindowDescriptor,
  ToolWindowAnchor,
  ToolWindowEvents,
} from './toolWindow/index.js';

export {
  ConfigurationTypeRegistry,
  ExecutorRegistry,
  CONFIGURATION_TYPES_TOPIC,
  CONFIGURATION_TYPE_REGISTRY,
  EXECUTORS_TOPIC,
  EXECUTOR_REGISTRY,
  RUN_MANAGER_TOPIC,
  RUN_MANAGER,
  RUN_EXECUTOR_ID,
  DEBUG_EXECUTOR_ID,
} from './run/index.js';
export type {
  ConfigurationTypeRegistryOptions,
  ConfigurationTypeUnregister,
  ExecutorRegistryOptions,
  ExecutorUnregister,
  Executor,
  ConfigurationType,
  ConfigurationFactory,
  ConfigurationCreationContext,
  RunConfiguration,
  RunnerAndConfigurationSettings,
  SettingsEditor,
  ValidationResult,
  LaunchSpec,
  DebugLaunchExtras,
  RunManager,
  RunManagerEvents,
  ConfigurationTypeRegistryEvents,
  ExecutorRegistryEvents,
  ExecutionStartedEvent,
  ExecutionEndedEvent,
  ExecutionOutputEvent,
  RunningProcessInfo,
  TypeGroup,
  FolderGroup,
} from './run/index.js';

// ===== Semantic 平台层（2026-04 起新增 —— IDEA-like 语义层） =====
// 如果从这里 export，renderer 的 Vite pre-bundle 会扫到 native .node 文件并报错。
//
// 使用方式：
//   - Electron main 进程：直接 import from './semantic/index.js'
//   - Renderer 进程：通过 IPC (window.neox.semantic.*) 间接使用
//   - 纯 JS 部分（FuzzyMatcher / FileIndex）：renderer 可以直接
//     import from './semantic/fuzzy/FuzzyMatcher.js' 等深层路径
//
// 参见 src/ui/electron/services/semanticBridge.ts 的 import 写法。
