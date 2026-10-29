/**
 * useTopicSubscription —— React 接入 MessageBus topic 的标准钩子。
 *
 * 把 MessageBus 的 subscribe/unsubscribe 模式包成 React 友好的 hook：
 *   - mount 时订阅，unmount 时反订阅（StrictMode 双调用安全）
 *   - listener 通过 ref 桥接，每次渲染都拿最新闭包，避免捕获过时 state
 *   - effect deps 仅含 [bus, topic.name]，listener 函数变化不会重订
 *
 * 用法
 * ----
 *
 * ```tsx
 * import { useTopicSubscription } from '@ui/renderer/platform'
 * import { FILES_TOPIC } from '@neox/ide'
 *
 * function MyComponent() {
 *   useTopicSubscription(FILES_TOPIC, {
 *     onChanged: (event) => refresh(event.path),
 *     onDeleted: (event) => removeFromList(event.path),
 *   })
 * }
 * ```
 *
 * 跟 useEditorService.subscribe 等"业务订阅"的关系
 * ----------------------------------------------
 * - 业务级订阅（EditorService.subscribe）→ useSyncExternalStore（state 渲染）
 * - 跨组件语义事件订阅（MessageBus.subscribe）→ useTopicSubscription
 *
 * 后者的事件不应该直接驱动渲染 —— 应该触发 service 状态变化，由
 * useSyncExternalStore 那边走渲染。topic 是"动作通知"，store 是"状态来源"。
 */

import { useEffect, useRef } from 'react';
import { MESSAGE_BUS, type Topic, type TopicListener } from '../../../ide/index.js';
import { useService } from './useService.js';

export function useTopicSubscription<L extends TopicListener>(
  topic: Topic<L>,
  listener: Partial<L>,
): void {
  const bus = useService(MESSAGE_BUS);

  // ref 桥接：每次渲染都把最新 listener 写到 ref。effect 注册的 wrapper
  // 内部每次都从 ref 拿 —— 这样 effect 不需要 listener 进 deps，订阅
  // 不会因为闭包变化而抖动。
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => {
    // wrapper：把每个事件方法 forward 到 ref.current 上的最新版本
    // 用 Proxy 一次性代理所有方法，省去显式列表
    const wrapper = new Proxy({} as L, {
      get(_target, method) {
        if (typeof method !== 'string') return undefined;
        return (...args: unknown[]): void => {
          const current = listenerRef.current as Record<string, unknown>;
          const fn = current[method];
          if (typeof fn === 'function') {
            (fn as (...a: unknown[]) => void).apply(current, args);
          }
        };
      },
    });

    return bus.subscribe(topic, wrapper);
    // 仅依赖 bus 和 topic.name —— listener 通过 ref 始终最新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, topic.name]);
}
