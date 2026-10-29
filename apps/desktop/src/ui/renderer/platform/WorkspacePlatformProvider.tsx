/**
 * WorkspacePlatformProvider —— 客户端"组合根"。
 *
 * 在 React 树某一层创建一个 ServiceContainer，注册所有 workspace 作用域的
 * 服务（目前只有 EditorService），通过 ServiceContainerContext 暴露给子树。
 *
 * 生命周期
 * --------
 * - **创建一次**（useState 初始化器）：组件挂载时跑一次 bootstrap()，
 *   后续渲染都拿同一个 container 实例。
 * - **不 key 在 workspace.path 上**：当前 useEditorTabs 的行为是切 workspace
 *   时 tab 状态保持不变（WorkspaceContent 没有 key，没有 unmount）。本
 *   Provider 严格保留这个行为 —— 不重建 container，不丢 tab。如果未来想
 *   做"切 workspace 关闭所有 tab"，再加一个显式动作即可。
 * - **故意没有 dispose effect**：React 18 StrictMode 会强制 useEffect
 *   cleanup 跑一次模拟卸载 —— 如果在 cleanup 里 dispose container，重新
 *   挂载后 useState 还是同一个（已被 dispose 的）container，children 调
 *   useService 会立刻抛 "ServiceContainer has been disposed"。
 *
 *   当前 step 5 的 services（VFS / Editor / Commands / Bus）都没有持有
 *   外部资源（文件 watcher / socket / 子进程），让 container 跟着组件
 *   实例的真实生命周期被 GC 回收即可，不需要显式 dispose。
 *
 *   未来如果引入文件 watcher 之类需要显式释放的资源，再用更精细的方案
 *   （例如 beforeunload 信号、ref counting、或把那部分服务挪到模块单例），
 *   不要回退到 useEffect cleanup 的 dispose，那条路在 StrictMode 下走不通。
 *
 * 后续步骤会注册更多服务（Document、ToolWindow…），都加在这里的 useState
 * 初始化器里。这里就是 IDE 客户端的"启动序列"。
 */

import { useState, type ReactNode } from 'react';
import {
  ServiceContainer,
  MessageBus,
  MESSAGE_BUS,
  VfsService,
  VFS_SERVICE,
  EditorService,
  EDITOR_SERVICE,
  CommandRegistry,
  COMMAND_REGISTRY,
  FocusService,
  FOCUS_SERVICE,
  ToolWindowRegistry,
  TOOL_WINDOW_REGISTRY,
  ConfigurationTypeRegistry,
  CONFIGURATION_TYPE_REGISTRY,
  ExecutorRegistry,
  EXECUTOR_REGISTRY,
} from '../../../ide/index.js';
import { ServiceContainerProvider } from './ServiceContainerContext.js';
import { createWindowFsPort } from './createWindowFsPort.js';
import { BUILT_IN_EXECUTORS } from '../modules/run/core/builtins.js';

export interface WorkspacePlatformProviderProps {
  children: ReactNode;
}

interface PlatformBootstrap {
  container: ServiceContainer;
  bus: MessageBus;
  vfs: VfsService;
  editor: EditorService;
  commands: CommandRegistry;
  focus: FocusService;
  toolWindows: ToolWindowRegistry;
  configurationTypes: ConfigurationTypeRegistry;
  executors: ExecutorRegistry;
}

function bootstrap(): PlatformBootstrap {
  const container = new ServiceContainer();
  const bus = new MessageBus();
  // 把 bus 注册到 container —— 让任何想订阅 topic 的组件 / 服务都能
  // 通过 useService(MESSAGE_BUS) 拿到同一根 bus，事件链路是闭环的。
  container.register(MESSAGE_BUS, () => bus);
  const fs = createWindowFsPort();

  // VfsService —— 所有文件 IO 的统一入口。写入成功后自动发 FILES_TOPIC
  // 事件，EditorService 和未来的 Project View 都订阅它来感知变更。
  const vfs = new VfsService({ fs, bus });
  container.register(VFS_SERVICE, () => vfs);

  // EditorService 现在走 VFS 读写，并订阅 FILES_TOPIC 感知外部改动。
  const editor = new EditorService({ vfs, bus });
  container.register(
    EDITOR_SERVICE,
    () => editor,
    (svc) => {
      svc.dispose();
      svc.closeAll();
    },
  );

  // CommandRegistry 是 app 作用域。注册一个，整个应用共用 —— Keymap、
  // 菜单、命令面板、agent 都能通过 commands.execute(id) 触发同一个动作。
  // 工厂函数拿到 container，注册的 command handler 可以反向解析任何服务。
  const commands = new CommandRegistry(container);
  container.register(COMMAND_REGISTRY, () => commands);

  // FocusService 是 app 作用域。追踪当前键盘焦点逻辑 scope（'fileTree' /
  // 'editor' / 自定义），让 useCommandShortcut 能做 scope-aware dispatch。
  const focus = new FocusService({ bus });
  container.register(FOCUS_SERVICE, () => focus);

  // ToolWindowRegistry —— sidebar / bottom panel 的注册插槽（IDEA Tool Window
  // 模型）。step 7C 阶段 registry 已就位但 sidebar 渲染层还没切到 registry
  // 驱动；下一步会让 WorkspacePage 用 byAnchor() 迭代来渲染面板。
  const toolWindows = new ToolWindowRegistry({ bus });
  container.register(TOOL_WINDOW_REGISTRY, () => toolWindows);

  // ConfigurationTypeRegistry —— 运行/调试配置类型的扩展点（IDEA
  // com.intellij.configurationType 对标）。registry 在位等扩展, 当前没有内置 type
  // (npm/RunConfigDropdown/EditRunConfigurationsDialog 死代码已删).
  const configurationTypes = new ConfigurationTypeRegistry({ bus });
  container.register(CONFIGURATION_TYPE_REGISTRY, () => configurationTypes);

  // ExecutorRegistry —— "启动方式" 扩展点 (Run / Debug / Coverage / ...).
  // 内置的 RUN + DEBUG 由 BUILT_IN_EXECUTORS 常量提供, 这里一次性注入.
  // 第三方 executor 通过 container.get(EXECUTOR_REGISTRY).register(...)。
  const executors = new ExecutorRegistry({ bus });
  for (const executor of BUILT_IN_EXECUTORS) {
    executors.register(executor);
  }
  container.register(EXECUTOR_REGISTRY, () => executors);

  return {
    container,
    bus,
    vfs,
    editor,
    commands,
    focus,
    toolWindows,
    configurationTypes,
    executors,
  };
}

export function WorkspacePlatformProvider({
  children,
}: WorkspacePlatformProviderProps) {
  // useState 初始化器在挂载时跑一次。StrictMode 双 render 会调两次但只
  // 保留第一次的结果，第二个 bootstrap() 产物会被立刻丢弃然后 GC。
  // 故意没有 dispose effect —— 详见文件头部注释。
  const [boot] = useState<PlatformBootstrap>(bootstrap);

  return (
    <ServiceContainerProvider container={boot.container}>
      {children}
    </ServiceContainerProvider>
  );
}
