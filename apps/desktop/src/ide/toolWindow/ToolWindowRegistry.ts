/**
 * ToolWindowRegistry —— 注册 / 查询 sidebar 面板（Tool Window）的中央表。
 *
 * 设计目标
 * --------
 * 1. **唯一注册入口**：内置面板（Project / Find / Terminal / Debug）和插件面板
 *    通过同一个 register API 进入 IDE。
 * 2. **按 anchor 分组查询**：渲染 sidebar 时调 `byAnchor('left')` 拿到该侧
 *    所有面板，按 order 排序。
 * 3. **事件可观察**：注册 / 反注册时通过 MessageBus 发 TOOL_WINDOWS_TOPIC，
 *    让消费 sidebar 的 React 组件能在运行时响应（插件热加载场景）。
 * 4. **零 React / DOM 依赖**：跟 IDE 平台层其他 service 保持一致，可在
 *    vitest 跑无障碍。
 *
 * 不变式
 * ------
 * - id 唯一 —— 重复 register 同 id 抛错（避免插件互相覆盖）
 * - register 返回 unregister 函数，cleanup 安全
 * - byAnchor 返回的列表按 order 升序，order 缺省为 100
 *
 * 跟 IntelliJ Tool Window 模型的对照
 * ----------------------------------
 * - IDEA: ToolWindowManager + ToolWindowFactory + ToolWindowEP + Stripe button
 * - Neox: ToolWindowRegistry + ToolWindowDescriptor（已集成 component）
 *
 * IDEA 把"工厂"和"实例"分开是为了 lazy init + 多 content tab。我们当前
 * 阶段不需要这层复杂度，descriptor 直接持有 React 组件类型，由消费的
 * `<ToolWindowSlot>` 组件 lazy 渲染。
 */

import type { MessageBus } from '../bus/MessageBus.js';
import { TOOL_WINDOWS_TOPIC } from './types.js';
import type {
  ToolWindowAnchor,
  ToolWindowDescriptor,
} from './types.js';

export interface ToolWindowRegistryOptions {
  bus: MessageBus;
}

export type ToolWindowUnregister = () => void;

export class ToolWindowRegistry {
  private readonly entries = new Map<string, ToolWindowDescriptor>();
  private readonly bus: MessageBus;

  constructor(options: ToolWindowRegistryOptions) {
    this.bus = options.bus;
  }

  /**
   * 注册一个 tool window。
   * 同 id 重复注册抛错。返回反注册函数（只删自己注册的那一个）。
   */
  register(descriptor: ToolWindowDescriptor): ToolWindowUnregister {
    if (this.entries.has(descriptor.id)) {
      throw new Error(`ToolWindow "${descriptor.id}" already registered`);
    }
    this.entries.set(descriptor.id, descriptor);
    this.bus.publisher(TOOL_WINDOWS_TOPIC).onRegistered(descriptor);
    return () => {
      const current = this.entries.get(descriptor.id);
      if (current === descriptor) {
        this.entries.delete(descriptor.id);
        this.bus.publisher(TOOL_WINDOWS_TOPIC).onUnregistered(descriptor.id);
      }
    };
  }

  /** 批量注册 — 返回统一的反注册函数 */
  registerAll(descriptors: ToolWindowDescriptor[]): ToolWindowUnregister {
    const offs = descriptors.map((d) => this.register(d));
    return () => {
      for (const off of offs) off();
    };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): ToolWindowDescriptor | undefined {
    return this.entries.get(id);
  }

  /**
   * 拿某个 anchor 上所有 tool window，按 order 升序排序。
   *
   * - order 缺省为 100
   * - isAvailable 返回 false 的会被过滤掉（让 Debug 这种条件性面板可以暂时
   *   不出现在 sidebar 上）
   */
  byAnchor(anchor: ToolWindowAnchor): ToolWindowDescriptor[] {
    const list: ToolWindowDescriptor[] = [];
    for (const desc of this.entries.values()) {
      if (desc.anchor !== anchor) continue;
      if (desc.isAvailable && !desc.isAvailable()) continue;
      list.push(desc);
    }
    list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return list;
  }

  /** 列出所有已注册的 tool window（不按 anchor 过滤），用于命令面板 / 调试 */
  list(): ToolWindowDescriptor[] {
    return [...this.entries.values()];
  }
}
