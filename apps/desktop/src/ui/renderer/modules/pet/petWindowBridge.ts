/**
 * petWindowBridge — pet 窗口 renderer 跟 main 进程的 IPC 封装
 *
 * 由 preload-pet.cjs 通过 contextBridge 暴露 `window.petBridge`. 这个文件给一个
 * 类型化的访问壳, 让组件不用 `(window as any).petBridge?.x?.()` 这种字符串散落.
 */

export interface PetAgentEvent {
  type: 'speech' | 'plan' | 'mood' | 'error' | 'complete' | 'activity';
  /** speech 的文本内容 (max 80 字, 主进程已截断) */
  text?: string;
  /** plan 进度 (type=plan 时有) */
  planProgress?: { done: number; total: number };
  /** mood 切换目标 (type=mood/error/complete 时有) */
  mood?: string;
}

export interface PetWindowConfig {
  /** 渲染模式 — svg=矢量原创, 3d=Three.js+.glb, 2d=canvas 程序生成, sprite=像素 sprite sheet */
  mode: 'svg' | '3d' | '2d' | 'sprite';
  /** mode='svg' 时的色板变体 */
  svgVariant?: string;
  skin: string;
  size: 'sm' | 'md' | 'lg';
  speechBubble: boolean;
  showPlanProgress: boolean;
  reactOnTaskComplete: boolean;
  reactOnError: boolean;
  idleAnimations: boolean;
  /** 用户导入的 .glb 元数据列表 — 解析 'custom-*' skin id 时用到 */
  customSkins?: Array<{ id: string; fileName: string; name: string }>;
  /** mode='2d' 时活跃的 Pet2DSpec 完整对象 — pet window 直接拿这个画 */
  active2DSpec?: unknown;
  /** mode='sprite' 时当前 sprite id ('spr-*' 内置 / 'sprite-*' 用户导入) */
  activeSpriteId?: string | null;
  /** 用户导入的 sprite 列表 */
  customSprites?: Array<{ id: string; fileName: string; name: string; cellWidth?: number; cellHeight?: number }>;
}

export interface PetBridgeApi {
  /** 拉一次当前 config (启动时) */
  getConfig(): Promise<PetWindowConfig>;
  /** 订阅 config 变更 (主窗口里 PetTab 改了之后, main 进程 broadcast 过来) */
  onConfigChange(handler: (cfg: PetWindowConfig) => void): () => void;
  /** 订阅 agent 事件 (主窗口 NeoxRuntime 过滤后转发) */
  onAgentEvent(handler: (evt: PetAgentEvent) => void): () => void;

  /** 拖动: 用户按下宠物本体 → 主进程开始记录起始 mouse 位置 */
  startDrag(): void;
  /** 拖动: 鼠标移动 → 直接调主进程 move window (60fps throttle 自管) */
  drag(dx: number, dy: number): void;
  /** 拖动: 松手 → 主进程做吸附 corner */
  endDrag(): void;

  /** 用户从右键菜单点 "关闭桌宠" — 跟 cfg.enabled=false 等价 */
  dismiss(): void;
  /** debug 用: 显式拉到屏幕中间 */
  recenter(): void;
}

/** 编译时安全壳 — 真实 IPC 通道在 preload-pet.cjs 注入 */
function getBridge(): PetBridgeApi {
  const bridge = (window as unknown as { petBridge?: PetBridgeApi }).petBridge;
  if (!bridge) {
    throw new Error('[petBridge] window.petBridge missing — preload-pet.cjs not loaded?');
  }
  return bridge;
}

export const petBridge = new Proxy({} as PetBridgeApi, {
  get(_target, key: keyof PetBridgeApi) {
    return (getBridge() as any)[key];
  },
});
