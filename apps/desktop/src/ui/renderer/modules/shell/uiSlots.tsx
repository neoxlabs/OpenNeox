/**
 * 外壳 UI 插槽。
 *
 * 外壳上有几个位置是给"发行版自带的扩展界面"留的 —— 典型的是侧栏底部那一行:
 * 公开构建里它只放本地入口 (全部项目 / 设置), 而带账号体系的发行版要在同一个位置
 * 放账户行 (头像 + 用户名 + 额度)。
 *
 * 两种实现不应该互相改对方的文件。所以约定:
 *   · **挂载点**留在公开仓库, 它知道自己在页面哪个位置、该拿到哪些 props;
 *   · **实现**由谁需要谁注册, 放在各自的文件里;
 *   · 没有人注册时渲染 children, 也就是公开构建自带的那份本地实现。
 *
 * 结果是这层对公开构建完全透明 (不注册 = 跟没有插槽一模一样), 而带账号的发行版
 * 只需要新增文件 + 一行注册, 不必在共享组件里插条件分支 —— 两边合代码时冲突面
 * 就只剩注册入口那一个文件。
 *
 * 用法:
 *   registerUiSlot('sidebar.footer', AccountRow);   // 启动时注册一次
 *   <UiSlot name="sidebar.footer" props={…}>兜底内容</UiSlot>
 *
 * @see editionSlots.ts —— 发行版唯一的注册入口
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { CloudLocation } from './cloudLocation';

/**
 * 每个插槽位收到的 props。
 *
 * 写成一张表而不是让各挂载点自己定, 是为了让两边实现对着同一份契约: 挂载点改了
 * props, 注册方这边立刻类型报错, 而不是运行时才发现某个回调是 undefined。
 */
export interface UiSlotPropsMap {
  /**
   * 侧栏底缘那一行。
   * 公开构建: 全部项目 + 设置; 带账号的发行版: 账户行 (头像 / 用户名 / 额度 / 更新胶囊)。
   */
  'sidebar.footer': {
    /** 跳账户页。公开构建没有账户概念, 本地兜底会忽略它。 */
    onOpenAccount?: () => void;
    onOpenSettings?: () => void;
    onShowWorkspacePanel?: () => void;
  };
  /** 折叠态图标栏的底部。跟 sidebar.footer 同语义, 只是收窄成一列图标。 */
  'iconrail.footer': {
    onOpenAccount?: () => void;
    onOpenSettings?: () => void;
    onShowWorkspacePanel?: () => void;
    /** 视觉变体 —— 决定按钮尺寸和菜单弹出方向。 */
    variant?: 'topbar' | 'rail';
  };
  /**
   * 设置 → 关于, 版本卡下面。
   * 需要联网取更新日志的发行版把日志区块挂这儿; 公开构建这里是空的, 日志走外链。
   */
  'settings.about.sections': {
    zh: boolean;
    /** 当前平台, 已归一成 'mac' / 'win' / 'linux'; 拿不到时是空串。 */
    platform: string;
    /** 完整日志的外链地址。 */
    allUrl?: string;
  };
  /**
   * 模型选择器里每一行模型名右侧的角标。
   * 带额度体系的发行版在这里放"消耗倍率"条; 公开构建是 BYOK, 没有倍率可言。
   */
  'composer.model.badge': {
    modelId: string;
    size?: 'sm' | 'md';
  };
  /**
   * 登录弹窗。欢迎页 / 引导页 / 外壳 ("对话需要登录" 事件) 三处共用。
   * 公开构建没有账号体系, 不注册; 调用方同时按 editionHooks.hasAccount 藏掉入口。
   */
  'auth.login': {
    onClose?: () => void;
    onSuccess?: () => void;
  };
  /** 首次引导第一步的登录按钮 (浏览器登录 + 等待 / 取消)。没有账号体系的构建不注册, 引导跳过这一步。 */
  'onboarding.login': {
    onSuccess?: () => void;
  };
  /** 外壳顶层的全局浮层 (额度用尽弹窗、额度提示条……)。公开构建为空。 */
  'app.overlays': Record<string, never>;
  /** 输入框正上方的额度横幅 (额度用尽倒计时 + BYOK 出路)。公开构建为空。 */
  'composer.quota.banner': Record<string, never>;
  /** 顶栏右侧的通知入口。公开构建为空。 */
  'topbar.notifications': Record<string, never>;
  /** 侧栏会话行标题右侧的运行位置标记。公开构建为空 (会话都在本机)。 */
  'sidebar.session.badge': {
    location?: CloudLocation;
  };
  /** 设置 → 我的账户 / 订阅与账单 两页的正文。公开构建不注册, 导航里也没有这两项。 */
  'settings.tab.account': Record<string, never>;
  'settings.tab.subscription': Record<string, never>;
  /** 设置 → 用量统计, 订阅数据源下的额度面板。 */
  'settings.usage.subscription': {
    language: string;
  };
  /** 云端数据没能刷新时的"当前是缓存"横幅。 */
  'settings.data-stale': {
    stale: boolean;
    lastError?: string | null;
    lastSuccessAt?: number;
    loading?: boolean;
    onRetry?: () => void;
    scope?: string;
  };
}

export type UiSlotName = keyof UiSlotPropsMap;

type SlotComponent<N extends UiSlotName> = React.ComponentType<UiSlotPropsMap[N]>;

const registry = new Map<UiSlotName, React.ComponentType<never>>();
const listeners = new Set<() => void>();

/** 注册一个插槽实现。重复注册以最后一次为准, 返回取消注册的函数。 */
export function registerUiSlot<N extends UiSlotName>(name: N, component: SlotComponent<N>): () => void {
  const entry = component as unknown as React.ComponentType<never>;
  registry.set(name, entry);
  for (const notify of listeners) notify();
  return () => {
    if (registry.get(name) === entry) registry.delete(name);
    for (const notify of listeners) notify();
  };
}

export function getUiSlot<N extends UiSlotName>(name: N): SlotComponent<N> | undefined {
  return registry.get(name) as SlotComponent<N> | undefined;
}

interface UiSlotProps<N extends UiSlotName> {
  name: N;
  /** 透传给插槽实现的 props; 兜底内容自己从外部拿, 不经过这里。 */
  props: UiSlotPropsMap[N];
  /** 没有人注册时渲染它。 */
  children?: React.ReactNode;
}

/**
 * 渲染插槽: 有注册实现就用它, 否则用兜底内容。
 *
 * 订阅 registry 的变化是必须的 —— 注册通常发生在启动早期, 但发行版完全可以在
 * 登录成功后才注册账户行, 那时挂载点早就渲染过了, 不重渲就永远停在兜底上。
 */
export function UiSlot<N extends UiSlotName>({ name, props, children }: UiSlotProps<N>): React.ReactElement | null {
  const [, bump] = useState(0);
  const onChange = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    listeners.add(onChange);
    return () => { listeners.delete(onChange); };
  }, [onChange]);

  const Impl = registry.get(name) as SlotComponent<N> | undefined;
  if (!Impl) return <>{children}</>;
  return <Impl {...props} />;
}
