/**
 * ConfigurationTypeRegistry —— 运行配置类型的注册表 (IDEA 扩展点等价物)
 *
 * 灵感: IntelliJ 的 `com.intellij.configurationType` extension point.
 * 每个 ConfigurationType (npm / go.build / compound / ...) 通过这里注册,
 * 左侧树和 "+" 添加菜单都从这里读取可用类型列表.
 *
 * 设计参考 `ToolWindowRegistry` —— 同 id 重复注册抛错, 注册/反注册发 topic
 * 事件, 任何消费者都能响应运行时的类型变化 (例如插件热加载).
 *
 * **跟 ToolWindowRegistry 的细微差别**:
 *   - 不按 anchor 过滤, 改成按 typeId lookup + 全量列表.
 *   - 不支持 isAvailable —— 配置类型一旦注册就一直可用, 不存在 "当前工程
 *     没安装 npm 所以隐藏 npm 类型" 这种条件 (那应该在 Settings.checkConfiguration
 *     里发警告, 不是在类型注册层隐藏).
 */

import type { MessageBus } from '../bus/MessageBus.js';
import { CONFIGURATION_TYPES_TOPIC } from './types.js';
import type { ConfigurationType } from './types.js';

export interface ConfigurationTypeRegistryOptions {
  bus: MessageBus;
}

export type ConfigurationTypeUnregister = () => void;

export class ConfigurationTypeRegistry {
  private readonly entries = new Map<string, ConfigurationType>();
  private readonly bus: MessageBus;

  constructor(options: ConfigurationTypeRegistryOptions) {
    this.bus = options.bus;
  }

  /**
   * 注册一个 ConfigurationType. 同 id 重复注册抛错.
   * 返回反注册函数 —— 只删自己注册的那个 (id 被别人覆盖时不误伤).
   */
  register(type: ConfigurationType): ConfigurationTypeUnregister {
    if (this.entries.has(type.id)) {
      throw new Error(`ConfigurationType "${type.id}" already registered`);
    }
    this.entries.set(type.id, type);
    this.bus.publisher(CONFIGURATION_TYPES_TOPIC).onRegistered(type);
    return () => {
      const current = this.entries.get(type.id);
      if (current === type) {
        this.entries.delete(type.id);
        this.bus.publisher(CONFIGURATION_TYPES_TOPIC).onUnregistered(type.id);
      }
    };
  }

  registerAll(types: ConfigurationType[]): ConfigurationTypeUnregister {
    const offs = types.map((t) => this.register(t));
    return () => {
      for (const off of offs) off();
    };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): ConfigurationType | undefined {
    return this.entries.get(id);
  }

  /** 按 displayName 排序的全列表 —— 用于 "+" 添加菜单 */
  list(): ConfigurationType[] {
    return [...this.entries.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }

  /** 用 typeId + factoryId 定位一个 factory —— 反序列化时用 */
  findFactory(typeId: string, factoryId: string) {
    const type = this.entries.get(typeId);
    if (!type) return undefined;
    return type.getFactories().find((f) => f.id === factoryId);
  }
}
