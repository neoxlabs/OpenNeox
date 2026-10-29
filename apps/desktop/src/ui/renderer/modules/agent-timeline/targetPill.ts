
import type { DockTone } from './dock/dockTypes';

export type TargetStatus = 'off' | 'active' | 'paused' | 'satisfied' | 'abandoned' | 'expired';

/** active 但这么久没有任何推进 → 改口说「待继续」。
 *  给足余量: 两轮之间和工具执行间隙都会短暂 idle, 一 idle 就变脸会闪。 */
export const TARGET_STALLED_AFTER_MS = 60_000;
export const TARGET_TERMINAL_AUTO_FADE_MS = 5 * 60_000;

export function isTerminalTargetStatus(s: TargetStatus): s is 'satisfied' | 'abandoned' | 'expired' {
  return s === 'satisfied' || s === 'abandoned' || s === 'expired';
}

export interface TargetPillInput {
  status: TargetStatus;
  target: string | null;
  abandonReason: string | null;
  phase: 'research' | 'execute';
  subMissionCount: number;
  completedSubMissions: number;
  /** 这条会话此刻是否真的在跑 —— 状态位说 paused/active 不等于实际在动 */
  busy: boolean;
  /** 距上一次「确实在跑」过去了多久 */
  idleMs: number;
  isZh: boolean;
}

export interface TargetPillModel {
  tone: DockTone;
  /** 药丸主文案 (中文 ≤ 8 字) */
  label: string;
  /** 右侧小字: 分块进度, 没有战略块时留给调用方填时长 */
  progress: string | null;
  /** 补充说明 —— 展开态和 ⋯ 菜单里显示 */
  hint: string | null;
  /** 排序权重: 12 要处理 · 18 运行中 · 40 已收尾 */
  weight: number;
  attention: boolean;
  /** 暂停按下了但这一轮还没收尾 */
  stillWorking: boolean;
  stalled: boolean;
  terminal: boolean;
  /** detail 里跟在 label 后面的正文 (放弃时是原因, 其余是目标本身) */
  primaryText: string;
}

export function buildTargetPillModel(input: TargetPillInput): TargetPillModel {
  const { status, isZh, busy, idleMs } = input;
  const isPaused = status === 'paused';
  const terminal = isTerminalTargetStatus(status);
  const stillWorking = isPaused && busy;
  /* active 但**没有任何东西在推进** —— 必须如实说, 不能一直挂着「目标进行中」。
   * target 续跑只发生在同一轮 agent loop 内部 (loopContinuationGate 拦住「没调工具就想
   * 结束」的退出点)。这一轮真结束之后没有任何东西会自动开下一轮, 它就停那儿等你说话。 */
  const stalled = status === 'active' && !busy && idleMs >= TARGET_STALLED_AFTER_MS;

  const label = isPaused
    ? (stillWorking
      ? (isZh ? '本轮结束后暂停' : 'Pausing after this step')
      : (isZh ? '已暂停' : 'Paused'))
    : status === 'satisfied'
      ? (isZh ? '目标达成' : 'Target reached')
      : status === 'abandoned'
        ? (isZh ? '已放弃' : 'Abandoned')
        : status === 'expired'
          ? (isZh ? '已超时' : 'Expired')
          : stalled
            ? (isZh ? '目标待继续' : 'Target waiting')
            : input.phase === 'research'
              ? (isZh ? '调研对标中' : 'Researching')
              : (isZh ? '目标进行中' : 'Target Running');

  const labelFinal = label;

  const hint = isPaused
    ? (stillWorking
      ? (isZh ? '正在收尾当前这一步' : 'finishing the current step')
      : (isZh ? '发消息说「继续」即可恢复' : 'send "continue" to resume'))
    : stalled
      ? (isZh ? '这一轮已结束, 发一条消息接着推进' : 'this round ended — send a message to continue')
      : status === 'expired'
        ? (isZh ? '达 max_run_time' : 'reached max_run_time')
        : null;

  const hintFinal = hint;

  const tone: DockTone = status === 'satisfied'
    ? 'ok'
    : status === 'abandoned' || status === 'expired'
      ? 'err'
      : stalled
        ? 'attention'
        : isPaused
          ? 'warn'
          : 'running';

  /* 双层规划宏观进度: 有战略块才显示。中小目标只用 update_plan, 没块可数。 */
  const blockUnit = isZh ? '块' : (input.subMissionCount === 1 ? 'block' : 'blocks');
  const progress = input.subMissionCount > 0
    ? `${input.completedSubMissions}/${input.subMissionCount} ${blockUnit}`
    : null;

  const primaryText = status === 'abandoned'
    ? (input.abandonReason || (isZh ? '(无理由)' : '(no reason)'))
    : (input.target ?? '');

  return {
    tone,
    label: labelFinal,
    progress,
    hint: hintFinal,
    weight: stalled ? 12 : terminal ? 40 : 18,
    attention: stalled,
    stillWorking,
    stalled,
    terminal,
    primaryText,
  };
}

/** 该不该露面 —— 横幅和药丸同一套判据。 */
export function shouldShowTarget(args: {
  status: TargetStatus;
  target: string | null;
  terminalReachedAtMs: number | null;
  dismissed: boolean;
  now: number;
}): boolean {
  const { status, target, terminalReachedAtMs, dismissed, now } = args;
  if (status === 'active' || status === 'paused') return !!target;
  if (isTerminalTargetStatus(status)) {
    if (dismissed) return false;
    if (terminalReachedAtMs == null) return true; /* 记录还没写入, 先显示, 下一 tick 就 OK */
    return now - terminalReachedAtMs <= TARGET_TERMINAL_AUTO_FADE_MS;
  }
  return false;
}
