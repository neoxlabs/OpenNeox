/**
 * 指针事件总线 —— 桥在动作发生的那一刻把"指针落在哪"发出来，谁想画给人看就订阅它。
 *
 * ─── 为什么单独一条总线，不塞进 agent 的事件流 ──────────────────────────────
 * 它不是 agent 语义的事件（不是工具调用、不是文本增量），频率和生命周期都不同
 * （动作之间几十毫秒一次）。更重要的是：**它丢了也无所谓** —— 它只驱动一层动画。
 * 混进 agent 事件流的话，一个卡住的动画订阅方会拖慢真正的操作，那就本末倒置了。
 *
 * ─── 为什么放在 platform/shared 而不是 core ─────────────────────────────────
 * 生产者在 core（`runtime/computer/osBridgeClient`），消费者在 desktop 的主进程。
 * 放在 core 里就得让桌面去深引 core 的内部路径（`@openneox/core/runtime/...`），
 * 那条边界是有闸的（`check:boundaries` 会报"新增深引"）。放到共享层两个包都只依赖
 * 它，谁也不用碰对方的内部路径。
 *
 * ─── 已知边界（写在这免得当成 bug 排查）────────────────────────────────────
 * 这是一个**进程内**的单例：订阅只在"生产者和消费者同进程"时收得到。
 * 默认形态下 agent runtime 跑在 worker 线程（工具和桥都在那条线程里），主进程
 * 订阅这份总线是收不到东西的 —— 那种情况需要 worker → main 再转发一次。
 * 判断依据：`NEOX_DESKTOP_INPROCESS_RUNTIME=1` 时工具回主进程，这条总线是通的。
 */

/** 一次指针动作。字段名跟桥的事件行一一对应。 */
export interface ComputerPointerEvent {
  phase: 'act' | 'move' | 'done';
  /** 动作名，跟协议里的 op 对齐：click / click_at / type / key / set_value … */
  action: string;
  /** 给人看的短标签（元素名 / 按键 / 比例） */
  label?: string;
  app?: string;
  /** 物理屏幕像素。key 这类不动指针的动作没有坐标 */
  x?: number;
  y?: number;
  /** 高风险动作换暖色。目前还没人标 —— 被守卫拦掉的动作根本走不到这里 */
  risk?: 'safe' | 'high';
}

type Listener = (e: ComputerPointerEvent) => void;
const listeners = new Set<Listener>();

/** 订阅。返回退订函数（订阅方必须配对调用，否则窗口销毁后还在被回调）。 */
export function onComputerPointer(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 发一条指针事件。
 *
 * 订阅方抛错**只吞掉、不影响别人**：这条总线是为了"让人看见 agent 在做什么"，
 * 它绝不能成为让操作失败的原因。
 */
export function publishComputerPointer(e: ComputerPointerEvent): void {
  for (const cb of listeners) {
    try {
      cb(e);
    } catch { /* 看动画的那一侧不该影响操作本身 */ }
  }
}

/** 有没有人在听 —— 生产者用它决定要不要为此多做一点事（比如多算一次元素位置）。 */
export function hasComputerPointerListener(): boolean {
  return listeners.size > 0;
}
