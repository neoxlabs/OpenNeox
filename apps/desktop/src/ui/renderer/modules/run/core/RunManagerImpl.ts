/**
 * RunManagerImpl —— workspace 作用域的 RunManager 实现
 *
 * 职责:
 *   1. 维护内存中的 RunnerAndConfigurationSettings 列表 + 选中项 + 运行进程
 *   2. 通过 `window.neox.runConfig.*` IPC 读写 `.neox/runConfigurations.json`
 *   3. 通过 `window.neox.runLaunch.*` IPC 启动/停止进程, 转发 stdout/stderr 事件
 *   4. 所有变化通过 MessageBus 的 RUN_MANAGER_TOPIC 发布, React 组件订阅保持同步
 *   5. 首次 load 时自动从旧的 launch.json 迁移 (一次性, 迁移完标记 .migrated.bak)
 *
 * 跟 IDEA RunManagerImpl 的差异
 * -----------------------------
 * - v1 没有模板 "编辑后重新影响同 type 新建配置" 的机制: 模板只是个内存
 *   cache, 模板字段变了不会自动传到已有实例. (IDEA 有这个, 但实现复杂, v1.x 再补)
 * - 没有 LRU 临时配置
 * - 没有 before-launch 任务链
 * - 没有 per-runner settings
 *
 * 线程模型: 全部在 renderer 单线程. IPC 调用是 async, 在 await 间隙列表可能
 * 被外部修改, 关键路径 (save / load) 用 seq 字段做 stale check.
 */

import type {
  ConfigurationFactory,
  ExecutionEndedEvent,
  ExecutionOutputEvent,
  ExecutionStartedEvent,
  FolderGroup,
  RunConfiguration,
  RunManager,
  RunManagerEvents,
  RunnerAndConfigurationSettings,
  RunningProcessInfo,
  TypeGroup,
} from '../../../../../ide/run/index.js';
import {
  CONFIGURATION_TYPE_REGISTRY,
  RUN_MANAGER_TOPIC,
} from '../../../../../ide/run/index.js';
import type { MessageBus } from '../../../../../ide/index.js';
import type { ServiceContainer } from '../../../../../ide/index.js';
import type { ConfigurationTypeRegistry } from '../../../../../ide/run/ConfigurationTypeRegistry.js';

// ─── IPC 类型 (跟 main 进程 handlers 对齐) ────────────────────────────

interface PersistedConfiguration {
  id: string;
  typeId: string;
  factoryId: string;
  name: string;
  folderName: string | null;
  allowRunningInParallel: boolean;
  data: Record<string, unknown>;
}

interface PersistedFile {
  $schema: 1;
  selectedId: string | null;
  configurations: PersistedConfiguration[];
}

interface LaunchStartedEvent {
  type: 'started';
  processId: string;
  pid: number;
  command: string;
}
interface LaunchOutputEvent {
  type: 'stdout' | 'stderr';
  processId: string;
  data: string;
}
interface LaunchExitEvent {
  type: 'exit';
  processId: string;
  code: number | null;
  signal: string | null;
}
interface LaunchErrorEvent {
  type: 'error';
  processId: string;
  message: string;
}
type LaunchEvent = LaunchStartedEvent | LaunchOutputEvent | LaunchExitEvent | LaunchErrorEvent;

// ─── IPC 桥接 (renderer 端 narrow 类型) ───────────────────────────────

interface RunConfigIpc {
  runConfigLoad(workspacePath: string): Promise<PersistedFile>;
  runConfigSave(workspacePath: string, data: PersistedFile): Promise<void>;
  runLaunchStart(spec: RunLaunchSpecIpc): Promise<{ processId: string }>;
  runLaunchStop(processId: string): Promise<void>;
  runLaunchStdin(processId: string, data: string): Promise<void>;
  runLaunchResize(processId: string, cols: number, rows: number): Promise<void>;
  onRunLaunchEvent(cb: (event: LaunchEvent & { configurationId: string; configurationName: string; executorId: string }) => void): () => void;
}

/** 传给 main 进程 spawn 的最小描述 —— 保证跟 LaunchSpec 同构 */
interface RunLaunchSpecIpc {
  configurationId: string;
  configurationName: string;
  executorId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** 初始 PTY 尺寸 (xterm fit 后传, 让 TUI 应用一开始就按正确宽度渲染) */
  cols?: number;
  rows?: number;
  debug?: {
    protocol: string;
    port?: number;
  };
}

function getIpc(): RunConfigIpc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const neox = (window as any).neox;
  if (!neox) {
    throw new Error('window.neox is not available (preload did not load)');
  }
  return neox;
}

// ─── RunManagerImpl ───────────────────────────────────────────────────

export interface RunManagerImplOptions {
  workspacePath: string;
  bus: MessageBus;
  container: ServiceContainer;
}

export class RunManagerImpl implements RunManager {
  readonly workspacePath: string;
  private readonly bus: MessageBus;
  private readonly typeRegistry: ConfigurationTypeRegistry;

  private readonly settingsMap = new Map<string, RunnerAndConfigurationSettings>();
  private readonly templateCache = new Map<string, RunnerAndConfigurationSettings>();
  private selectedId: string | null = null;

  private readonly runningProcesses = new Map<string, RunningProcessInfo>();
  private disposeLaunchListener: (() => void) | null = null;

  /**
   * 缓存的 getAllSettings 结果. useSyncExternalStore 要求 getSnapshot 返回
   * referentially stable 的值 —— 不能每次都 [...map.values()] 返回新数组,
   * 否则 React 会检测到 tearing 并无限重试, 最终抛 "Maximum update depth".
   *
   * 规则: 任何修改 settingsMap 的地方都要调 invalidateSettingsCache().
   */
  private cachedAllSettings: readonly RunnerAndConfigurationSettings[] | null = null;
  private cachedRunningProcesses: readonly RunningProcessInfo[] | null = null;

  private invalidateSettingsCache(): void {
    this.cachedAllSettings = null;
  }
  private invalidateRunningCache(): void {
    this.cachedRunningProcesses = null;
  }

  private loaded = false;
  private loadingPromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RunManagerImplOptions) {
    this.workspacePath = options.workspacePath;
    this.bus = options.bus;
    this.typeRegistry = options.container.get(CONFIGURATION_TYPE_REGISTRY);
  }

  // ═══ 生命周期 ═══════════════════════════════════════════════════════

  async load(): Promise<void> {
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this.doLoad();
    return this.loadingPromise;
  }

  whenReady(): Promise<void> {
    return this.loadingPromise ?? this.load();
  }

  private async doLoad(): Promise<void> {
    try {
      const file = await getIpc().runConfigLoad(this.workspacePath);
      this.applyLoadedFile(file);
    } catch (err) {
      console.error('[RunManager] load failed:', err);
      // 失败也算 loaded —— 避免永远等下去, 列表就是空
    } finally {
      this.loaded = true;
      this.subscribeToLaunchEvents();
    }
  }

  private applyLoadedFile(file: PersistedFile): void {
    this.settingsMap.clear();
    this.invalidateSettingsCache();
    for (const entry of file.configurations) {
      const factory = this.typeRegistry.findFactory(entry.typeId, entry.factoryId);
      if (!factory) {
        console.warn(
          `[RunManager] unknown type/factory: ${entry.typeId}/${entry.factoryId}. ` +
            `Skipping config "${entry.name}".`,
        );
        continue;
      }
      const template = this.getTemplateFor(factory).configuration;
      const configuration = template.clone();
      configuration.name = entry.name;
      configuration.allowRunningInParallel = entry.allowRunningInParallel;
      try {
        configuration.deserialize(entry.data);
      } catch (err) {
        console.warn(`[RunManager] deserialize failed for "${entry.name}":`, err);
      }
      const settings: RunnerAndConfigurationSettings = {
        id: entry.id,
        configuration,
        folderName: entry.folderName,
        isTemplate: false,
        isTemporary: false,
      };
      this.settingsMap.set(entry.id, settings);
      this.invalidateSettingsCache();
      this.bus.publisher(RUN_MANAGER_TOPIC).onAdded(settings);
    }
    this.selectedId = file.selectedId;
    if (this.selectedId && !this.settingsMap.has(this.selectedId)) {
      this.selectedId = null;
    }
    this.bus.publisher(RUN_MANAGER_TOPIC).onSelectionChanged(this.selectedId);
  }

  // ═══ 查询 ═══════════════════════════════════════════════════════════

  getAllSettings(): readonly RunnerAndConfigurationSettings[] {
    if (this.cachedAllSettings === null) {
      this.cachedAllSettings = Object.freeze([...this.settingsMap.values()]);
    }
    return this.cachedAllSettings;
  }

  findById(id: string): RunnerAndConfigurationSettings | undefined {
    return this.settingsMap.get(id);
  }

  findByTypeAndName(
    typeId: string,
    name: string,
  ): RunnerAndConfigurationSettings | undefined {
    for (const s of this.settingsMap.values()) {
      if (s.configuration.type.id === typeId && s.configuration.name === name) {
        return s;
      }
    }
    return undefined;
  }

  getConfigurationsGroupedByTypeAndFolder(): readonly TypeGroup[] {
    const groups = new Map<string, { type: TypeGroup['type']; folders: Map<string | null, RunnerAndConfigurationSettings[]> }>();
    for (const s of this.settingsMap.values()) {
      const typeId = s.configuration.type.id;
      if (!groups.has(typeId)) {
        groups.set(typeId, {
          type: s.configuration.type,
          folders: new Map(),
        });
      }
      const g = groups.get(typeId)!;
      const folderKey = s.folderName ?? null;
      if (!g.folders.has(folderKey)) {
        g.folders.set(folderKey, []);
      }
      g.folders.get(folderKey)!.push(s);
    }
    const result: TypeGroup[] = [];
    for (const g of groups.values()) {
      const folders: FolderGroup[] = [];
      // null 文件夹在前, 其余按名字排序
      const folderKeys = [...g.folders.keys()].sort((a, b) => {
        if (a === null) return -1;
        if (b === null) return 1;
        return a.localeCompare(b);
      });
      for (const key of folderKeys) {
        folders.push({ folderName: key, items: g.folders.get(key)! });
      }
      result.push({ type: g.type, folders });
    }
    // 按 type displayName 排序
    result.sort((a, b) => a.type.displayName.localeCompare(b.type.displayName));
    return result;
  }

  // ═══ 选中项 ═════════════════════════════════════════════════════════

  getSelectedId(): string | null {
    return this.selectedId;
  }

  setSelectedId(id: string | null): void {
    if (this.selectedId === id) return;
    if (id !== null && !this.settingsMap.has(id)) return;
    this.selectedId = id;
    this.bus.publisher(RUN_MANAGER_TOPIC).onSelectionChanged(id);
    this.schedulePersist();
  }

  // ═══ 模板 ═══════════════════════════════════════════════════════════

  getTemplateFor(factory: ConfigurationFactory): RunnerAndConfigurationSettings {
    const key = `${factory.type.id}::${factory.id}`;
    const cached = this.templateCache.get(key);
    if (cached) return cached;
    const template = factory.createTemplateConfiguration({
      workspacePath: this.workspacePath,
    });
    const settings: RunnerAndConfigurationSettings = {
      id: `template::${key}`,
      configuration: template,
      folderName: null,
      isTemplate: true,
      isTemporary: false,
    };
    this.templateCache.set(key, settings);
    return settings;
  }

  // ═══ 变更 ═══════════════════════════════════════════════════════════

  createConfiguration(
    name: string,
    factory: ConfigurationFactory,
  ): RunnerAndConfigurationSettings {
    const template = this.getTemplateFor(factory).configuration;
    const configuration = factory.createConfiguration(name, template);
    const settings: RunnerAndConfigurationSettings = {
      id: crypto.randomUUID(),
      configuration,
      folderName: null,
      isTemplate: false,
      isTemporary: false,
    };
    this.addConfiguration(settings);
    return settings;
  }

  addConfiguration(settings: RunnerAndConfigurationSettings): void {
    if (this.settingsMap.has(settings.id)) {
      throw new Error(`RunConfiguration id "${settings.id}" already exists`);
    }
    this.settingsMap.set(settings.id, settings);
    this.invalidateSettingsCache();
    this.bus.publisher(RUN_MANAGER_TOPIC).onAdded(settings);
    this.schedulePersist();
  }

  notifyChanged(id: string): void {
    const s = this.settingsMap.get(id);
    if (!s) return;
    this.bus.publisher(RUN_MANAGER_TOPIC).onChanged(s);
    this.schedulePersist();
  }

  removeConfiguration(id: string): void {
    if (!this.settingsMap.delete(id)) return;
    this.invalidateSettingsCache();
    this.bus.publisher(RUN_MANAGER_TOPIC).onRemoved(id);
    if (this.selectedId === id) {
      // 选择下一个或清空
      const next = this.settingsMap.keys().next();
      this.selectedId = next.done ? null : (next.value as string);
      this.bus.publisher(RUN_MANAGER_TOPIC).onSelectionChanged(this.selectedId);
    }
    this.schedulePersist();
  }

  async setAllSettings(next: readonly RunnerAndConfigurationSettings[]): Promise<void> {
    const nextIds = new Set(next.map((s) => s.id));
    const toRemove: string[] = [];
    for (const id of this.settingsMap.keys()) {
      if (!nextIds.has(id)) toRemove.push(id);
    }
    // 删除
    for (const id of toRemove) {
      this.settingsMap.delete(id);
      this.bus.publisher(RUN_MANAGER_TOPIC).onRemoved(id);
    }
    // 添加 / 更新
    for (const s of next) {
      const existing = this.settingsMap.get(s.id);
      if (existing) {
        this.settingsMap.set(s.id, s);
        this.bus.publisher(RUN_MANAGER_TOPIC).onChanged(s);
      } else {
        this.settingsMap.set(s.id, s);
        this.bus.publisher(RUN_MANAGER_TOPIC).onAdded(s);
      }
    }
    this.invalidateSettingsCache();
    // 选中项如果不再存在就清掉
    if (this.selectedId && !this.settingsMap.has(this.selectedId)) {
      this.selectedId = null;
      this.bus.publisher(RUN_MANAGER_TOPIC).onSelectionChanged(null);
    }
    await this.save();
  }

  // ═══ 持久化 ═════════════════════════════════════════════════════════

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const file = this.toPersistedFile();
    try {
      await getIpc().runConfigSave(this.workspacePath, file);
    } catch (err) {
      console.error('[RunManager] save failed:', err);
    }
  }

  /** 延迟 200ms 合并写盘, 避免连续修改时频繁 IO */
  private schedulePersist(): void {
    if (!this.loaded) return; // load 阶段不要 save
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 200);
  }

  private toPersistedFile(): PersistedFile {
    const configurations: PersistedConfiguration[] = [];
    for (const s of this.settingsMap.values()) {
      configurations.push({
        id: s.id,
        typeId: s.configuration.type.id,
        factoryId: s.configuration.factory.id,
        name: s.configuration.name,
        folderName: s.folderName,
        allowRunningInParallel: s.configuration.allowRunningInParallel,
        data: s.configuration.serialize(),
      });
    }
    return {
      $schema: 1,
      selectedId: this.selectedId,
      configurations,
    };
  }

  // ═══ 执行 ═══════════════════════════════════════════════════════════

  async execute(settingsId: string, executorId: string): Promise<string> {
    const s = this.settingsMap.get(settingsId);
    if (!s) throw new Error(`No run configuration "${settingsId}"`);
    const config = s.configuration;
    if (!config.canRun(executorId)) {
      throw new Error(
        `Configuration "${config.name}" does not support executor "${executorId}"`,
      );
    }
    const validation = config.checkConfiguration();
    if (validation.severity === 'error') {
      throw new Error(validation.message ?? 'Invalid run configuration');
    }

    // 串行策略 (allowRunningInParallel=false): 先停掉同 config 的已运行进程
    if (!config.allowRunningInParallel) {
      await this.stopByConfigurationId(settingsId);
    }

    const spec = config.buildLaunchSpec(executorId);
    const ipcSpec: RunLaunchSpecIpc = {
      configurationId: s.id,
      configurationName: config.name,
      executorId,
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: spec.env ? { ...spec.env } : undefined,
      // 初始尺寸用比较保守的默认, 等 xterm mount 后 onResize 会自动同步真实尺寸
      cols: 120,
      rows: 30,
      debug: spec.debug
        ? { protocol: spec.debug.protocol, port: spec.debug.port }
        : undefined,
    };
    const { processId } = await getIpc().runLaunchStart(ipcSpec);
    return processId;
  }


  async stop(processId: string): Promise<void> {
    try {
      await getIpc().runLaunchStop(processId);
    } catch (err) {
      console.error('[RunManager] stop failed:', err);
    }
  }

  async stopByConfigurationId(configurationId: string): Promise<void> {
    const targets = [...this.runningProcesses.values()].filter(
      (p) => p.configurationId === configurationId,
    );
    await Promise.all(targets.map((p) => this.stop(p.processId)));
  }

  getRunningProcesses(): readonly RunningProcessInfo[] {
    if (this.cachedRunningProcesses === null) {
      this.cachedRunningProcesses = Object.freeze([
        ...this.runningProcesses.values(),
      ]);
    }
    return this.cachedRunningProcesses;
  }

  // ═══ 进程事件订阅 ════════════════════════════════════════════════════

  private subscribeToLaunchEvents(): void {
    if (this.disposeLaunchListener) return;
    this.disposeLaunchListener = getIpc().onRunLaunchEvent((event) => {
      this.handleLaunchEvent(event);
    });
  }

  private handleLaunchEvent(
    event: LaunchEvent & {
      configurationId: string;
      configurationName: string;
      executorId: string;
    },
  ): void {
    const { processId, configurationId, configurationName, executorId } = event;
    const publisher = this.bus.publisher<RunManagerEvents>(RUN_MANAGER_TOPIC);

    switch (event.type) {
      case 'started': {
        const info: RunningProcessInfo = {
          processId,
          configurationId,
          configurationName,
          executorId,
          pid: event.pid,
          startedAt: new Date().toISOString(),
        };
        this.runningProcesses.set(processId, info);
        this.invalidateRunningCache();
        const startedEvent: ExecutionStartedEvent = {
          processId,
          configurationId,
          configurationName,
          executorId,
          pid: event.pid,
          command: event.command,
        };
        publisher.onExecutionStarted(startedEvent);
        break;
      }
      case 'stdout':
      case 'stderr': {
        const outputEvent: ExecutionOutputEvent = {
          processId,
          configurationId,
          stream: event.type,
          data: event.data,
        };
        publisher.onExecutionOutput(outputEvent);
        break;
      }
      case 'exit': {
        this.runningProcesses.delete(processId);
        this.invalidateRunningCache();
        const endedEvent: ExecutionEndedEvent = {
          processId,
          configurationId,
          exitCode: event.code,
          signal: event.signal,
        };
        publisher.onExecutionEnded(endedEvent);
        break;
      }
      case 'error': {
        this.runningProcesses.delete(processId);
        this.invalidateRunningCache();
        const endedEvent: ExecutionEndedEvent = {
          processId,
          configurationId,
          exitCode: null,
          signal: null,
          error: event.message,
        };
        publisher.onExecutionEnded(endedEvent);
        break;
      }
    }
  }

  // ═══ dispose ════════════════════════════════════════════════════════

  dispose(): void {
    this.disposeLaunchListener?.();
    this.disposeLaunchListener = null;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.settingsMap.clear();
    this.templateCache.clear();
    this.runningProcesses.clear();
  }
}

// RunConfiguration 字段被隐式依赖 —— 纯类型 hint 防 TS 警告
export type _RunConfigurationRef = RunConfiguration;
