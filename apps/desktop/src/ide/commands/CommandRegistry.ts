/**
 * CommandRegistry — 命令注册与执行
 *
 * 灵感来源：VSCode 的 Command 模型 + IntelliJ Platform 的 ActionManager。
 *
 * 设计目标
 * --------
 * 1. **唯一可执行入口**：任何"动作"都通过命令 id 触发。
 *    - 快捷键 → keymap 解析后调 `commands.execute('editor.save')`
 *    - 菜单项 → 配置里写 `commandId: 'editor.save'`
 *    - Agent 工具 → 发出 `executeCommand` 调用
 *    - 命令面板 → 列出 + 执行
 *    - 插件 → 注册自己的命令到这里
 * 2. **handler 拿到 container**：执行时收到 ServiceContainer，
 *    可以解析任何已注册的服务（不需要 import）。
 * 3. **可启用判定**：command 可以声明 `isEnabled`，UI 据此决定按钮灰不灰。
 * 4. **零依赖**：不知道 Keymap、不知道 React、不知道菜单 — 这些都是它的"消费者"。
 *
 * 与 Keymap 的关系
 * ---------------
 * Keymap 是把 (按键 → command id) 的映射，CommandRegistry 是把 (command id → handler)
 * 的映射。**两层独立** — 用户改快捷键不影响 command 实现；插件注册新 command
 * 不需要 Keymap 配合。
 */

import type { ServiceContainer, ServiceToken } from '../container/ServiceContainer.js';
import { createServiceToken } from '../container/ServiceContainer.js';

/** 命令执行上下文 */
export interface CommandContext {
  /** 当前作用域的 service 容器 */
  readonly container: ServiceContainer;
  /** 调用方传入的参数（无类型约束 — 由具体 command 自己定义协议） */
  readonly args: unknown;
}

/** 命令处理函数。返回值类型由调用方在 `execute<R>` 时声明 */
export type CommandHandler<R = unknown> = (ctx: CommandContext) => R | Promise<R>;

export interface CommandDescriptor {
  /**
   * 全局唯一 id。约定 'category.action' 形式，例如：
   *   - 'editor.save'
   *   - 'editor.closeTab'
   *   - 'file.newFile'
   *   - 'workspace.openSettings'
   */
  id: string;
  /** 显示名（命令面板 / 设置 UI 用） */
  title?: string;
  /** 分类（命令面板按它分组） */
  category?: string;
  /**
   * 是否可执行的判定。返回 false 时：
   *   - 调 execute() 会抛 "command disabled" 错
   *   - UI 应该把对应按钮 / 菜单项置灰
   * 默认认为永远可执行。
   */
  isEnabled?: (ctx: CommandContext) => boolean;
  /** 实际执行函数 */
  handler: CommandHandler;
}

/** register() 返回一个反注册函数，让插件 / 测试可以干净地清理 */
export type CommandUnregister = () => void;

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDescriptor>();

  constructor(private readonly container: ServiceContainer) {}

  /**
   * 注册一个命令。
   * 同一个 id 重复注册会抛错（避免插件 / 内置命令静默互相覆盖）。
   * 返回反注册函数。
   */
  register(descriptor: CommandDescriptor): CommandUnregister {
    if (this.commands.has(descriptor.id)) {
      throw new Error(`Command "${descriptor.id}" already registered`);
    }
    this.commands.set(descriptor.id, descriptor);
    return () => {
      // 只删除"自己注册的那一个"，避免取消注册了别人后来注册的同名命令
      const current = this.commands.get(descriptor.id);
      if (current === descriptor) this.commands.delete(descriptor.id);
    };
  }

  /** 批量注册 — 返回一个统一的反注册函数 */
  registerAll(descriptors: CommandDescriptor[]): CommandUnregister {
    const offs = descriptors.map((d) => this.register(d));
    return () => {
      for (const off of offs) off();
    };
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): CommandDescriptor | undefined {
    return this.commands.get(id);
  }

  /** 列出所有命令（用于命令面板） */
  list(): CommandDescriptor[] {
    return [...this.commands.values()];
  }

  /**
   * 执行命令。
   * - 找不到 id → 抛错
   * - isEnabled 返回 false → 抛错
   * - handler 抛错 → 原样向上抛
   *
   * 调用方可以用泛型声明返回类型：
   * ```ts
   * const result = await commands.execute<string>('editor.getActiveContent')
   * ```
   */
  async execute<R = unknown>(id: string, args?: unknown): Promise<R> {
    const descriptor = this.commands.get(id);
    if (!descriptor) {
      throw new Error(`Command "${id}" not found`);
    }
    const ctx: CommandContext = { container: this.container, args };
    if (descriptor.isEnabled && !descriptor.isEnabled(ctx)) {
      throw new Error(`Command "${id}" is currently disabled`);
    }
    return (await descriptor.handler(ctx)) as R;
  }

  /**
   * 仅判定是否可执行（不抛错，不实际执行）。
   * UI 应该用这个来决定按钮是否灰色。
   */
  isEnabled(id: string): boolean {
    const descriptor = this.commands.get(id);
    if (!descriptor) return false;
    if (!descriptor.isEnabled) return true;
    const ctx: CommandContext = { container: this.container, args: undefined };
    try {
      return descriptor.isEnabled(ctx);
    } catch {
      return false;
    }
  }
}

/**
 * CommandRegistry 在 ServiceContainer 中的 token。
 *
 * 作用域 = 'app'：
 *   - 大部分命令（编辑器 / 文件 / 视图 / 应用）跨 workspace 含义相同
 *   - 切 workspace 时不应该清掉命令注册（菜单 / 快捷键依赖它们的存在）
 *   - 未来如果有 workspace-specific command（例如 'workspace.openInVSCode'），
 *     可以在 workspace 子容器里另注册一个独立的 CommandRegistry，UI 层
 *     按需 fallback。本步骤不展开。
 */
export const COMMAND_REGISTRY: ServiceToken<CommandRegistry> = createServiceToken<CommandRegistry>(
  'commands',
  'app',
);
