/**
 * Run/Debug 平台类型定义
 *
 * 灵感来自 IntelliJ Platform 的 Execution 框架:
 *   ConfigurationType → ConfigurationFactory → RunConfiguration → SettingsEditor
 *   + Executor (Run / Debug / ...) + RunManager 作为 workspace service
 *
 * 设计原则 (跟 src/ide 其他平台层保持一致)
 * ------------------------------------------
 * - **零环境依赖**: 本文件不 import React / Electron / Node.js. 这些类型可以
 *   同时跑在 renderer / main / cli / vitest.
 * - **可扩展 (EP-style)**: ConfigurationType / Executor 都通过 Registry 注册,
 *   任何插件/内置模块都能在 IDE 启动后挂新的类型进来, 不需要修改核心代码.
 * - **类型化**: 不用 string-based switch, 每个 ConfigurationType 有一个 typeId,
 *   每个 Executor 有一个 executorId, 两者都是 extensible 的标识符 (string).
 *
 * 跟 IDEA 的差异 (v1 简化)
 * -----------------------
 * - 不引入 ProgramRunner 这一层: RunConfiguration 自己给出 LaunchSpec,
 *   RunManager 的 execute() 直接丢给 LaunchAdapter 跑.
 * - 不引入 Before-launch task chain: 暂不支持 build → run 这种依赖.
 * - 不引入多存储档位 (WORKSPACE/PROJECT/ARBITRARY): v1 只有 workspace-local
 *   一个 JSON 文件 (.neox/runConfigurations.json).
 * - 不引入 run target (本机以外): 所有配置都在本机运行.
 * - 不引入 per-runner settings: SettingsEditor 就是整个表单.
 */

import { createServiceToken } from '../container/ServiceContainer.js';
import { createTopic } from '../bus/MessageBus.js';
import type { ServiceToken } from '../container/ServiceContainer.js';
import type { Topic } from '../bus/MessageBus.js';

// ═══════════════════════════════════════════════════════════════════════════
// Executor —— "Run" / "Debug" / (未来) "Coverage" / "Profile" / ...
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Executor —— 一种启动方式的描述.
 *
 * IDEA 里 Run / Debug 是两个分开的 Executor; 每个 RunConfiguration 通过
 * `canRun(executor)` 决定自己支不支持这个启动方式, 通过 `buildLaunchSpec(executor)`
 * 产出不同的命令行 (比如 debug 会多加 --inspect-brk).
 *
 * Executor 是通过 ExecutorRegistry 注册的, 插件可以加新的 executor. 但大部分
 * 场景只会用到内置的 RUN / DEBUG.
 */
export interface Executor {
  /** 全局唯一, 约定 'category.name' 或单词形式. 例: 'run' / 'debug' / 'coverage' */
  readonly id: string;
  /** UI 显示名, 支持 i18n key 或字面量 */
  readonly displayName: string;
  /** 图标名 (Icons 组件里的 key), 避免在 ide 层直接依赖 React */
  readonly icon: string;
  /** 可选的描述, 用于 tooltip */
  readonly description?: string;
}

/** 内置的两个 executor id —— 核心代码里用这两个常量, 第三方 executor 用自己的 id */
export const RUN_EXECUTOR_ID = 'run' as const;
export const DEBUG_EXECUTOR_ID = 'debug' as const;

// ═══════════════════════════════════════════════════════════════════════════
// ConfigurationType / Factory —— IDEA 的 "运行类型" 扩展点
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ConfigurationType —— "这是哪一类运行配置".
 *
 * 例子: NpmConfigurationType (id='npm') 代表 "npm 脚本" 类;
 *       GoBuildConfigurationType (id='go.build') 代表 "Go 构建" 类.
 *
 * 一个 type 下面可以有多个 factory (大部分情况只有 1 个; npm 可能拆成
 * `npm run` 和 `npm test` 两个 factory).
 */
export interface ConfigurationType {
  /** 全局唯一 id, 约定 dot-separated 小写: 'npm' / 'go.build' / 'compound' */
  readonly id: string;
  /** 列表显示名, 例如 "npm" / "Go 构建" */
  readonly displayName: string;
  /** 更长的说明, 用于 "+ 添加配置" 弹出菜单里 */
  readonly description?: string;
  /** 图标 (Icons key), 展示在树节点和下拉里 */
  readonly icon: string;
  /** 该 type 下的所有 factory. 至少 1 个. */
  getFactories(): ConfigurationFactory[];
}

export interface ConfigurationFactory {
  /** 所属 type (反向引用) */
  readonly type: ConfigurationType;
  /** 同 type 下唯一 id. 大部分情况等于 type.id */
  readonly id: string;
  /** UI 显示名. 单 factory 时可以留空, 显示时 fallback 到 type.displayName */
  readonly displayName?: string;
  /**
   * 创建 **模板** 配置 (isTemplate=true).
   * 一个 factory 有且仅有一条模板, 由 RunManager 缓存; 新建实例时用 template.clone()
   * 作为初始值, 然后 factory.createConfiguration(name, template) 最后调整.
   */
  createTemplateConfiguration(ctx: ConfigurationCreationContext): RunConfiguration;
  /**
   * 基于 template 创建一个命名的新实例. 默认实现 (在 abstract base class 里)
   * 就是 `template.clone() + setName(name)`.
   */
  createConfiguration(name: string, template: RunConfiguration): RunConfiguration;
}

/** 创建配置时能拿到的上下文 (工程路径等) —— 让 factory 能读 package.json 之类的文件 */
export interface ConfigurationCreationContext {
  readonly workspacePath: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// RunConfiguration —— 一条具体配置实例 (用户编辑的对象)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 校验结果 —— RunConfiguration.checkConfiguration() 的返回值.
 * 用于 SingleConfigurationConfigurable 底部的警告条 (例如 "没有为模块指定 SDK").
 */
export interface ValidationResult {
  /** 'ok' 不显示; 'warning' 黄色; 'error' 红色, Run 按钮 disabled */
  readonly severity: 'ok' | 'warning' | 'error';
  readonly message?: string;
}

/**
 * LaunchSpec —— 最终交给执行层的 "怎么启动这个进程" 的描述.
 *
 * 这一层故意做得跟 node:child_process.spawn 对齐, LaunchAdapter 拿到后直接
 * forward 到 main-process 的 spawn handler. 不同语言 / 调试模式的区别全部压到
 * RunConfiguration.buildLaunchSpec 里, 执行层只管 "spawn 一个命令".
 */
export interface LaunchSpec {
  /** 可执行命令 (node / python / npm / go / bash / ...). 必须是 PATH 里能找到的 bin 或绝对路径 */
  readonly command: string;
  /** argv */
  readonly args: readonly string[];
  /** 工作目录 (绝对路径) */
  readonly cwd: string;
  /** 额外环境变量 (会 merge 到 process.env 之上) */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * 调试元数据 —— 只在 executor='debug' 时填.
   * 具体调试协议由消费者按 protocol 字段分支. v1 只用到 node-inspector.
   */
  readonly debug?: DebugLaunchExtras;
}

export interface DebugLaunchExtras {
  /** 协议标识, 例: 'node-inspector' / 'dap' / 'chrome-devtools' */
  readonly protocol: string;
  /** 监听端口 (node --inspect-brk=9229 之类) */
  readonly port?: number;
  /** 额外透传数据, 供未来不同协议扩展 */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * RunConfiguration —— 一条具体运行配置 (用户在左侧树里看到的一行).
 *
 * **这是一个可变对象**: SettingsEditor.applyEditorTo 会直接写它的字段,
 * 然后 RunManager 拿到 snapshot (通过 serialize) 做 dirty detection.
 *
 * 具体类型自己继承 RunConfigurationBase (后续阶段写), 填实 serialize/deserialize/clone/
 * buildLaunchSpec. 核心契约要求:
 *   - clone() 必须返回同类型的新实例, 字段深拷贝, name/id 可以由调用方 reset
 *   - serialize() 返回纯数据, 必须能够通过 deserialize() 完整恢复
 *   - checkConfiguration() 不能抛错, 必须返回 ValidationResult
 *   - buildLaunchSpec() 在校验通过后调用, 允许抛错 (RunManager 会 catch 并 toast)
 */
export interface RunConfiguration {
  /** 所属 type */
  readonly type: ConfigurationType;
  /** 创建用的 factory */
  readonly factory: ConfigurationFactory;
  /** 用户可编辑的名字 (左侧树里显示的) */
  name: string;
  /**
   * 是否允许并行多实例运行. 对应 IDEA 的 "允许多个实例".
   * v1 默认 false (同一条配置重复点 Run 会先停老进程).
   */
  allowRunningInParallel: boolean;

  /** 深拷贝一份 (用于 edit buffer / 撤销 / 克隆) */
  clone(): RunConfiguration;

  /**
   * 序列化为纯 JSON (不要 Date / Map / class instance). 这份数据会进
   * .neox/runConfigurations.json 的 `data` 字段.
   */
  serialize(): Record<string, unknown>;

  /**
   * 从 serialize() 的数据恢复. 允许 data 是空对象 (新建场景).
   * 应该宽容处理未知字段 (向前兼容).
   */
  deserialize(data: Record<string, unknown>): void;

  /** 校验当前字段组合是否合法. 不能抛错. */
  checkConfiguration(): ValidationResult;

  /** 能不能用这个 executor 跑? (例: 有些配置不支持 debug) */
  canRun(executorId: string): boolean;

  /**
   * 产出 LaunchSpec. 只在 canRun 返回 true 的前提下调用.
   * 允许抛错: 比如找不到 package.json 时抛 "package.json 不存在".
   */
  buildLaunchSpec(executorId: string): LaunchSpec;

  /**
   * 返回这条配置的 SettingsEditor. IDEA 每次 getConfigurationEditor 都返回
   * 新实例, 我们这里也一样 —— 每次打开 Edit Configurations 对话框创建新的编辑器,
   * 关闭时 dispose.
   *
   * 用 <any> 是因为不同 type 的 editor 泛型参数不一样. 具体 editor 内部会
   * 强转成 self.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConfigurationEditor(): SettingsEditor<any>;
}

// ═══════════════════════════════════════════════════════════════════════════
// SettingsEditor —— 表单基类 (事务式 reset/apply + snapshot 级 dirty)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SettingsEditor —— 一条 RunConfiguration 的表单编辑器.
 *
 * 这一层契约完全照搬 IDEA 的 `com.intellij.openapi.options.SettingsEditor`.
 * 核心概念:
 *   1. `resetEditorFrom(config)` —— 把 config 的当前值载入表单
 *   2. `applyEditorTo(config)`   —— 把表单值写回 config (用户点 Apply/OK 时)
 *   3. `getSnapshot()`           —— 给一个纯数据快照, 用于计算 isModified
 *   4. `createEditor()`          —— 返回 React 组件 (ide 层不知道 React,
 *                                   所以这里只声明 returnType = unknown,
 *                                   具体实现 (renderer 层的 base class) 会
 *                                   把它 narrow 成 React.ReactElement)
 *
 * **快照级 dirty 检测**:
 *   - resetEditorFrom 完成后, 立刻 getSnapshot() 存为 baseline
 *   - 表单任何字段变化 → fireStateChanged() → 消费者比较当前 getSnapshot()
 *     vs baseline → 决定 Apply/OK 按钮启用状态
 *   - 对象比较用 JSON.stringify 深比, 足够 v1 用
 *
 * 这个基类故意不依赖 React: ide 层要跑在 vitest / main / cli 里. 真正的
 * React 具体实现在 `src/ui/renderer/modules/run/core/SettingsEditor.ts` 里
 * extend 这个 interface.
 */
export interface SettingsEditor<T extends RunConfiguration> {
  /** 载入 config 当前值 (打开 dialog / 切换选中项时调用) */
  resetEditorFrom(config: T): void;
  /** 把表单值写回 config (点 Apply/OK 时调用) */
  applyEditorTo(config: T): void;
  /**
   * 产出当前表单的纯数据快照. 用于 dirty detection.
   * 必须是可 JSON.stringify 的.
   */
  getSnapshot(): unknown;
  /**
   * 创建 UI. renderer 层基类会 narrow 成 React.ReactElement;
   * ide 平台层保持 unknown 以避免依赖 React.
   */
  createEditor(): unknown;
  /**
   * 订阅表单值变化. 表单内部每次 setState 时应该触发.
   * 返回 unsubscribe.
   */
  addSettingsEditorListener(listener: () => void): () => void;
  /** 销毁编辑器 (关闭 dialog 时调用) */
  dispose(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// ConfigurationType 注册事件
// ═══════════════════════════════════════════════════════════════════════════

export interface ConfigurationTypeRegistryEvents {
  onRegistered(type: ConfigurationType): void;
  onUnregistered(typeId: string): void;
}

export const CONFIGURATION_TYPES_TOPIC: Topic<ConfigurationTypeRegistryEvents> =
  createTopic<ConfigurationTypeRegistryEvents>('run.configurationTypes');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export const CONFIGURATION_TYPE_REGISTRY: ServiceToken<
  import('./ConfigurationTypeRegistry.js').ConfigurationTypeRegistry
> = createServiceToken('run.configurationTypes', 'app');

// ═══════════════════════════════════════════════════════════════════════════
// Executor 注册事件
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecutorRegistryEvents {
  onRegistered(executor: Executor): void;
  onUnregistered(executorId: string): void;
}

export const EXECUTORS_TOPIC: Topic<ExecutorRegistryEvents> =
  createTopic<ExecutorRegistryEvents>('run.executors');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export const EXECUTOR_REGISTRY: ServiceToken<
  import('./ExecutorRegistry.js').ExecutorRegistry
> = createServiceToken('run.executors', 'app');

// ═══════════════════════════════════════════════════════════════════════════
// RunManager —— 每个 workspace 一个, 持有配置列表 + 选中 + 运行状态
// ═══════════════════════════════════════════════════════════════════════════

/**
 * RunManager 上发布的事件.
 *
 * 订阅者 (顶栏下拉, Edit 对话框的列表) 通过 useTopicSubscription 订阅这个
 * topic 保持 UI 同步.
 */
export interface RunManagerEvents {
  /** 新增一条配置 */
  onAdded(settings: RunnerAndConfigurationSettings): void;
  /** 某条配置被修改 (字段变, 包括 name) */
  onChanged(settings: RunnerAndConfigurationSettings): void;
  /** 某条配置被删除 */
  onRemoved(id: string): void;
  /** 选中项变化 (顶栏下拉的当前项) */
  onSelectionChanged(id: string | null): void;
  /** 某条配置开始运行 */
  onExecutionStarted(event: ExecutionStartedEvent): void;
  /** 某条配置结束运行 (正常退出 / 被 stop / 崩溃) */
  onExecutionEnded(event: ExecutionEndedEvent): void;
  /** 运行输出 (stdout / stderr) */
  onExecutionOutput(event: ExecutionOutputEvent): void;
}

export interface ExecutionStartedEvent {
  readonly processId: string;
  readonly configurationId: string;
  readonly configurationName: string;
  readonly executorId: string;
  readonly pid: number;
  readonly command: string;
}

export interface ExecutionEndedEvent {
  readonly processId: string;
  readonly configurationId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error?: string;
}

export interface ExecutionOutputEvent {
  readonly processId: string;
  readonly configurationId: string;
  readonly stream: 'stdout' | 'stderr';
  readonly data: string;
}

export const RUN_MANAGER_TOPIC: Topic<RunManagerEvents> =
  createTopic<RunManagerEvents>('run.manager');

/**
 * RunnerAndConfigurationSettings —— 一条配置的完整 "存档".
 *
 * 对应 IDEA 的 `RunnerAndConfigurationSettings`. 在 IDEA 里这层保存很多
 * metadata (temporary / folderName / perRunnerSettings / beforeRunTasks / ...),
 * v1 先只保留:
 *   - id        稳定标识 (uuid)
 *   - configuration  具体实例
 *   - folderName 左侧树里的分组名 (v1 扁平, 暂留字段为 null)
 *   - temporary  是否是临时配置 (v1 先不用)
 *
 * 为什么单独一个 wrapper 层而不是把 id 直接塞到 RunConfiguration 里:
 * IDEA 的设计里 RunConfiguration 本身是 "数据" (能 clone, 能 serialize),
 * 不带身份; 身份属于 Settings 层. 这样模板 (template) 和实例共享同一个
 * RunConfiguration 子类, 只是 Settings 不同. 我们照搬这个分离.
 */
export interface RunnerAndConfigurationSettings {
  readonly id: string;
  readonly configuration: RunConfiguration;
  folderName: string | null;
  isTemplate: boolean;
  isTemporary: boolean;
}

/**
 * RunManager —— workspace 作用域的 service.
 *
 * 具体实现在 renderer 层 (`src/ui/renderer/modules/run/core/RunManagerImpl.ts`),
 * 因为需要调 IPC 存盘. 但接口在 ide 平台层, 方便其他模块 (键盘快捷键,
 * 顶栏下拉, Edit 对话框) 通过 service token 依赖注入拿实例.
 */
export interface RunManager {
  /** 当前 workspace 的绝对路径. 构造 RunManager 时固定, 不变. */
  readonly workspacePath: string;

  // ── 生命周期 ───────────────────────────────────────────
  /**
   * 从磁盘加载本 workspace 的配置. 如果发现旧的 launch.json, 会自动迁移成
   * 新格式然后重命名备份. 返回 void (加载完毕会发 onAdded 事件).
   */
  load(): Promise<void>;
  /** 等到 load 完成 (用于启动时 block 顶栏渲染到数据到位) */
  whenReady(): Promise<void>;

  // ── 查询 ──────────────────────────────────────────────
  getAllSettings(): readonly RunnerAndConfigurationSettings[];
  findById(id: string): RunnerAndConfigurationSettings | undefined;
  findByTypeAndName(typeId: string, name: string): RunnerAndConfigurationSettings | undefined;
  /** 分组后的列表: `{ type, folders: { folderName | null, items } }`. 用于构建左树. */
  getConfigurationsGroupedByTypeAndFolder(): readonly TypeGroup[];

  // ── 选中项 (顶栏下拉当前选) ────────────────────────────
  getSelectedId(): string | null;
  setSelectedId(id: string | null): void;

  // ── 模板 ──────────────────────────────────────────────
  /** 拿或懒创建一个 factory 的模板 (isTemplate=true) */
  getTemplateFor(factory: ConfigurationFactory): RunnerAndConfigurationSettings;

  // ── 变更 ──────────────────────────────────────────────
  /** 基于 factory 创建一条新配置并注册到列表 (发 onAdded) */
  createConfiguration(name: string, factory: ConfigurationFactory): RunnerAndConfigurationSettings;
  /** 添加一条外部创建的配置 (例如 Edit 对话框里新建后一次性 apply) */
  addConfiguration(settings: RunnerAndConfigurationSettings): void;
  /** 标记配置已修改, 需要持久化并发 onChanged 事件 */
  notifyChanged(id: string): void;
  /** 删除 */
  removeConfiguration(id: string): void;
  /** 批量替换整份列表 (Edit 对话框 Apply 时使用). 会计算 diff 发事件. */
  setAllSettings(settings: readonly RunnerAndConfigurationSettings[]): Promise<void>;

  // ── 持久化 ─────────────────────────────────────────────
  save(): Promise<void>;

  // ── 执行 ──────────────────────────────────────────────
  /** 跑一条配置 (用指定 executor). 返回 processId. */
  execute(settingsId: string, executorId: string): Promise<string>;
  /** 停止某个运行中的进程 */
  stop(processId: string): Promise<void>;
  /** 停止某条配置的所有运行中的进程 */
  stopByConfigurationId(configurationId: string): Promise<void>;
  /** 当前运行中的进程快照 */
  getRunningProcesses(): readonly RunningProcessInfo[];
}

export interface TypeGroup {
  readonly type: ConfigurationType;
  readonly folders: readonly FolderGroup[];
}

export interface FolderGroup {
  /** null 表示 "直接在 type 节点下" (没有在文件夹里) */
  readonly folderName: string | null;
  readonly items: readonly RunnerAndConfigurationSettings[];
}

export interface RunningProcessInfo {
  readonly processId: string;
  readonly configurationId: string;
  readonly configurationName: string;
  readonly executorId: string;
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * RunManager 在 ServiceContainer 的 token.
 * 作用域 = 'workspace': 每个 workspace 自己一个 manager, 跟着 workspace 切换
 * 重建 (配置文件在 .neox/runConfigurations.json, 切工程要重读).
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export const RUN_MANAGER: ServiceToken<RunManager> = createServiceToken(
  'run.manager',
  'workspace',
);
