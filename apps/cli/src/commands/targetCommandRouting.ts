/**
 * Target Mission command routing — /target
 *
 * Phase 1: 单 agent 长跑 — 用户声明一个目标, loop 一直跑到目标真正达成。
 *
 * 用法:
 *   /target <自由文本描述>          激活 target mode + 记录目标; 下一条 chat 开始动手.
 *   /target <文本> --for 2h         带 P1.4 time ceiling 激活 (超时自动 expired).
 *   /target status                  查看当前 target 状态.
 *   /target off                     退出 target mode (放弃当前 target).
 *   /target pause                   P1.3 暂停 (保留状态可 continue).
 *   /target continue                P1.3 从 paused 恢复到 active.
 *   /target refine <新目标文本>     P1.5 只改 objective, 保留 plan / elapsed / 历史.
 *
 * 命令本身只做副作用(激活 mode + 打提示), 不发送 chat.
 * 主循环 loop 闸门由 runtimeBuilder.ts 注入的 loopContinuationGate 承接.
 *
 * 参考 内部设计文档
 */

import {
  activateTargetFromCommand,
  getTargetStatus,
  getCurrentTargetPlan,
  getLastDoneCheck,
  getAbandonReason,
  resetTargetMode,
  isTargetActive,
  pauseTargetMission,
  continueTargetMission,
  refineTargetMission,
  isTargetPaused,
} from '@neoxlabs/core/tools/targetModeTools.js';
import { L } from '../i18n/index.js';
import { getTargetSnapshot, isTargetShown } from '../ink/targetIndicatorStore.js';

/** 解析 "--for 2h" / "--for 30m" / "--for 90s" → 毫秒. 找不到 flag 返回 undefined. */
function parseMaxRunTimeFlag(args: string[]): { rest: string[]; maxRunTimeMs?: number } {
  const rest: string[] = [];
  let maxRunTimeMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--for' && i + 1 < args.length) {
      const val = args[i + 1].trim().toLowerCase();
      const m = val.match(/^(\d+(?:\.\d+)?)(h|m|s)?$/);
      if (m) {
        const n = parseFloat(m[1]);
        const unit = m[2] || 'm';
        const factor = unit === 'h' ? 3600_000 : unit === 's' ? 1000 : 60_000;
        maxRunTimeMs = Math.round(n * factor);
        i++; // skip value
        continue;
      }
    }
    rest.push(args[i]);
  }
  return { rest, maxRunTimeMs };
}

/** 跑 agent 那条线程的 bridge 上跟 target 有关的几个方法 (见 core server/main.ts)。 */
export interface TargetRuntimeBridge {
  grantTargetConsent?(sessionId: string): Promise<void>;
  rememberTargetUserText?(sessionId: string, text: string): Promise<void>;
  targetCommand?(
    sessionId: string,
    cmd: 'pause' | 'continue' | 'stop' | 'off' | 'refine',
    arg?: string,
  ): Promise<{ live: boolean; ok: boolean; status?: string; error?: string }>;
}

export interface TargetCommandRoutingDeps {
  /** 打印一条 info 到 CLI (通常是 uiController.addInfo 或类似). */
  logInfo: (title: string, message?: string) => void;
  /** 打印一条 error 到 CLI. */
  logError?: (title: string, message?: string) => void;
  /** 跑 agent 那条线程的 bridge。CLI 默认把 runtime 放在 worker thread, 它有自己的模块注册表:
   *  这里直接 import targetModeTools 改的是主线程那份副本, agent 一眼都看不到。有 bridge 就必须走它。
   *  daemon 模式 (HTTP) 没有 bridge, 回落旧路径。 */
  getRuntimeBridge?: () => TargetRuntimeBridge | null;
  getSessionId?: () => string;
  /** 把一条话当用户消息发出去 (/target <目标> 交给模型调 activate_target, 跟桌面端同一条路) */
  sendAsChat?: (text: string) => Promise<void>;
}

async function handleViaRuntimeBridge(
  bridge: TargetRuntimeBridge,
  sid: string,
  sub: string,
  args: string[],
  deps: TargetCommandRoutingDeps,
): Promise<boolean> {
  const snap = getTargetSnapshot();
  if (sub === 'status') {
    if (!isTargetShown(snap)) {
      const st = snap ? String((snap as { status?: string }).status ?? 'off') : 'off';
      deps.logInfo('Target', L(`当前没有进行中的目标 (状态: ${st}).`, `No target in progress (status: ${st}).`));
      return true;
    }
    const lines = [
      `${L('状态', 'Status')}: ${snap.status}`,
      `${L('目标', 'Target')}: ${snap.target ?? ''}`,
    ];
    if (snap.subMissionCount > 0) lines.push(`${L('进度', 'Progress')}: ${snap.completedSubMissions}/${snap.subMissionCount}`);
    if (snap.createdAt) lines.push(`${L('已运行', 'Elapsed')}: ${Math.round((Date.now() - snap.createdAt) / 60_000)}m`);
    deps.logInfo('Target', lines.join('\n'));
    return true;
  }

  const cmdMap: Record<string, 'pause' | 'continue' | 'off' | 'refine'> = {
    pause: 'pause', continue: 'continue', resume: 'continue', off: 'off', refine: 'refine',
  };
  const mapped = cmdMap[sub];
  if (mapped) {
    const arg = mapped === 'refine' ? args.slice(1).join(' ').trim() : undefined;
    if (mapped === 'refine' && !arg) {
      deps.logInfo('Target', L('用法: /target refine <新的目标文本>', 'Usage: /target refine <new goal>'));
      return true;
    }
    const r = await bridge.targetCommand?.(sid, mapped, arg);
    if (!r?.live) {
      deps.logInfo('Target', L('当前没有进行中的目标.', 'No target in progress.'));
      return true;
    }
    if (!r.ok) {
      if (mapped === 'continue' && r.status === 'active') {
        deps.logInfo('Target', L('目标已经在进行中 —— 发一条消息 (比如「接着做」) 就能推进.', 'Target is already active — send a message (e.g. "carry on") to push it forward.'));
      } else {
        deps.logInfo('Target', L(`/target ${sub} 没生效${r.error ? `: ${r.error}` : ''} (状态: ${r.status ?? '?'})`, `/target ${sub} had no effect${r.error ? `: ${r.error}` : ''} (status: ${r.status ?? '?'})`));
      }
      return true;
    }
    const msg: Record<string, string> = {
      pause: L('目标已暂停, 本轮结束后停下. 恢复用 /target continue.', 'Target paused; it stops after this turn. Resume with /target continue.'),
      continue: L('目标已恢复. 发一条消息继续推进.', 'Target resumed. Send a message to carry on.'),
      off: L('已退出目标模式.', 'Target mode off.'),
      refine: L(`目标已更新: ${arg}`, `Goal updated: ${arg}`),
    };
    deps.logInfo('Target', msg[mapped]);
    return true;
  }

  const { rest, maxRunTimeMs } = parseMaxRunTimeFlag(args);
  const goal = rest.join(' ').trim();
  if (!goal) return false; /* 空 /target 走下面的用法说明 */
  await bridge.grantTargetConsent?.(sid);
  const text = maxRunTimeMs
    ? `/target ${goal} (${L('时间上限', 'time limit')} ${Math.round(maxRunTimeMs / 60_000)}m)`
    : `/target ${goal}`;
  await bridge.rememberTargetUserText?.(sid, text);
  if (!deps.sendAsChat) return false;
  await deps.sendAsChat(text);
  return true;
}

export async function handleTargetCommandRouting(
  cmd: string,
  args: string[],
  deps: TargetCommandRoutingDeps,
): Promise<boolean> {
  if (cmd !== '/target') return false;

  const sub = (args[0] || '').toLowerCase();

  const bridge = deps.getRuntimeBridge?.() ?? null;
  const sid = deps.getSessionId?.();
  if (bridge && sid && typeof bridge.targetCommand === 'function') {
    if (await handleViaRuntimeBridge(bridge, sid, sub, args, deps)) return true;
  }

  // /target status
  if (sub === 'status') {
    const status = getTargetStatus();
    const plan = getCurrentTargetPlan();
    const lastCheck = getLastDoneCheck();
    const abandonReason = getAbandonReason();
    const lines: string[] = [];
    lines.push(`Status: ${status}`);
    if (plan) {
      lines.push(`Target: ${plan.target}`);
      if (plan.maxRunTimeMs) {
        const remainMs = Math.max(0, plan.createdAt + plan.maxRunTimeMs - Date.now());
        lines.push(`Time ceiling: ${Math.round(plan.maxRunTimeMs / 60_000)}m  (remaining ~${Math.round(remainMs / 60_000)}m)`);
      }
      if (plan.sub_missions?.length) {
        lines.push(`Sub-missions (${plan.sub_missions.length}):`);
        for (const sm of plan.sub_missions) {
          lines.push(`  - [${sm.id}] ${sm.description}${sm.success_criteria ? ` · criteria: ${sm.success_criteria}` : ''}`);
        }
      }
    }
    if (lastCheck) {
      lines.push(`Last check_target_done: done=${lastCheck.done} · ${lastCheck.reason}`);
    }
    if (abandonReason) {
      lines.push(`Abandon reason: ${abandonReason}`);
    }
    deps.logInfo('Target', lines.join('\n'));
    return true;
  }

  // /target off
  if (sub === 'off') {
    if (!isTargetActive() && getTargetStatus() === 'off') {
      deps.logInfo('Target', L('当前没有激活的 target, 无需退出.', 'No active target — nothing to turn off.'));
      return true;
    }
    resetTargetMode();
    deps.logInfo('Target', L('Target mode 已退出. 下一条 chat 回到普通模式.', 'Target mode off. Your next message is a normal chat.'));
    return true;
  }

  // /target pause
  if (sub === 'pause') {
    if (!isTargetActive()) {
      deps.logInfo('Target', L(`当前 target 状态是 ${getTargetStatus()}, 不是 active — 无法 pause.`, `The target is ${getTargetStatus()}, not active — can’t pause.`));
      return true;
    }
    pauseTargetMission('User /target pause');
    deps.logInfo('Target', L('Target 已暂停. Loop 将在本轮结束后正常退出. 恢复请用 /target continue.', 'Target paused. The loop stops after this turn. Resume with /target continue.'));
    return true;
  }

  // /target continue
  if (sub === 'continue' || sub === 'resume') {
    if (!isTargetPaused()) {
      deps.logInfo('Target', L(`当前 target 状态是 ${getTargetStatus()}, 不是 paused — 无法 continue.`, `The target is ${getTargetStatus()}, not paused — can’t continue.`));
      return true;
    }
    continueTargetMission();
    deps.logInfo('Target', L('Target 已恢复. 下一条 chat 继续推进 (agent 从上次 pause 点继续).', 'Target resumed. Your next message carries on from where it paused.'));
    return true;
  }

  // /target refine <新目标文本>
  if (sub === 'refine') {
    const newText = args.slice(1).join(' ').trim();
    if (!newText) {
      deps.logInfo('Target', L('用法: /target refine <新的目标文本>. 保留原 plan / elapsed / 历史.', 'Usage: /target refine <new goal>. Keeps the plan, elapsed time and history.'));
      return true;
    }
    if (!isTargetActive() && !isTargetPaused()) {
      deps.logInfo('Target', L(`当前 target 状态是 ${getTargetStatus()} — 只有 active / paused 才能 refine.`, `The target is ${getTargetStatus()} — only active or paused targets can be refined.`));
      return true;
    }
    if (refineTargetMission(newText, 'User /target refine')) {
      deps.logInfo('Target', L(`目标已更新: ${newText}\n\nPlan / 时长 / 历史保留.`, `Goal updated: ${newText}\n\nPlan, elapsed time and history kept.`));
    } else {
      deps.logInfo('Target', L('Refine 失败 — 内部拒绝. 可能没有活的 target.', 'Refine failed — rejected internally. There may be no live target.'));
    }
    return true;
  }

  // 未匹配子命令 → 全部当自由文本
  // 解析 --for 时长 flag (P1.4 time ceiling)
  const { rest: cleanArgs, maxRunTimeMs } = parseMaxRunTimeFlag(args);
  const targetText = cleanArgs.join(' ').trim();
  if (!targetText) {
    deps.logInfo(
      'Target',
      L([
        '用法:',
        '  /target <你的目标描述>          激活 target 模式并记录目标',
        '  /target <文本> --for 2h         带时间上限 (超时自动 expired)',
        '  /target status                  查看当前 target 状态',
        '  /target off                     退出 target 模式',
        '  /target pause                   暂停当前 target',
        '  /target continue                恢复被 pause 的 target',
        '  /target refine <新目标文本>     只改目标, 保留 plan / 时长 / 历史',
        '',
        'Target 模式下, agent 会长跑直到自己确认 target 达成 (通过 check_target_done 工具).',
        '发起一个中等以上规模、有明确成功标准的任务时使用。简单一问一答不需要 target.',
      ].join('\n'), [
        'Usage:',
        '  /target <your goal>             turn on target mode with this goal',
        '  /target <text> --for 2h         with a time limit (expires when it runs out)',
        '  /target status                  show the target',
        '  /target off                     leave target mode',
        '  /target pause                   pause the target',
        '  /target continue                resume a paused target',
        '  /target refine <new goal>       change the goal, keep plan / time / history',
        '',
        'In target mode the agent keeps going until it confirms the goal is met (via check_target_done).',
        'Use it for medium-or-bigger tasks with a clear finish line. Quick Q&A doesn’t need it.',
      ].join('\n')),
    );
    return true;
  }

  activateTargetFromCommand(targetText, maxRunTimeMs);
  const mins = maxRunTimeMs ? Math.round(maxRunTimeMs / 60_000) : 0;
  const ceilingMsg = maxRunTimeMs ? L(`\n时间上限: ${mins} 分钟 (超时自动 expired)`, `\nTime limit: ${mins} min (expires after)`) : '';
  deps.logInfo(
    'Target',
    L([
      `Target 已激活: ${targetText}${ceilingMsg}`,
      '',
      '下一条 chat 输入 (可以直接回车/空消息) 即开始动手.',
      'Agent 会长跑直到自己确认目标达成 (check_target_done).',
      '任意时候: /target status 查看进度 · /target pause 暂停 · /target off 退出.',
    ].join('\n'), [
      `Target on: ${targetText}${ceilingMsg}`,
      '',
      'Your next message (even an empty Enter) starts the work.',
      'The agent keeps going until it confirms the goal is met (check_target_done).',
      'Any time: /target status for progress · /target pause · /target off.',
    ].join('\n')),
  );
  return true;
}
