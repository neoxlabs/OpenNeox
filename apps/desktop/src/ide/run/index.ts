/**
 * @neox/ide/run —— Run/Debug 配置平台层
 *
 * 对标 IntelliJ Platform 的 Execution framework. 详见 types.ts 头部注释.
 *
 * 本模块只导出 **接口 + registry 类**, 不包含具体 RunManager 实现 ——
 * 那个要调 IPC 存盘, 属于 renderer 层, 见
 * `src/ui/renderer/modules/run/core/RunManagerImpl.ts`.
 */

export {
  ConfigurationTypeRegistry,
} from './ConfigurationTypeRegistry.js';
export type {
  ConfigurationTypeRegistryOptions,
  ConfigurationTypeUnregister,
} from './ConfigurationTypeRegistry.js';

export { ExecutorRegistry } from './ExecutorRegistry.js';
export type {
  ExecutorRegistryOptions,
  ExecutorUnregister,
} from './ExecutorRegistry.js';

export {
  CONFIGURATION_TYPES_TOPIC,
  CONFIGURATION_TYPE_REGISTRY,
  EXECUTORS_TOPIC,
  EXECUTOR_REGISTRY,
  RUN_MANAGER_TOPIC,
  RUN_MANAGER,
  RUN_EXECUTOR_ID,
  DEBUG_EXECUTOR_ID,
} from './types.js';

export type {
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
} from './types.js';
