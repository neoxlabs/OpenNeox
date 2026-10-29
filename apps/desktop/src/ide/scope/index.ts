/**
 * @neox/ide/scope —— Scope / ProjectScope / ServiceRegistry 平台层
 *
 * 对标 IntelliJ Platform 的 ComponentManager + Project + MessageBus,
 * 用于 Neox 的多项目窗口隔离. 详见 README / types.ts 头注释.
 */

export { Scope } from './Scope.js';
export type { ScopeInitOptions } from './Scope.js';

export { Holder } from './Holder.js';
export { ServiceRegistry } from './ServiceRegistry.js';
export {
  ScopedEventBus,
  createAppTopic,
  createProjectTopic,
} from './ScopedEventBus.js';
export type {
  ScopedTopic,
  TopicListener,
  Unsubscribe,
} from './ScopedEventBus.js';

export { createServiceToken } from './types.js';
export type { ServiceToken, DisposableNode } from './types.js';
