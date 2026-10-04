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

interface TargetCommandRoutingDeps {
  /** 打印一条 info 到 CLI (通常是 uiController.addInfo 或类似). */
  logInfo: (title: string, message?: string) => void;
  /** 打印一条 error 到 CLI. */
  logError?: (title: string, message?: string) => void;
}

export async function handleTargetCommandRouting(
  cmd: string,
  args: string[],
  deps: TargetCommandRoutingDeps,
): Promise<boolean> {
  if (cmd !== '/target') return false;

  const sub = (args[0] || '').toLowerCase();

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
      deps.logInfo('Target', '当前没有激活的 target, 无需退出.');
      return true;
    }
    resetTargetMode();
    deps.logInfo('Target', 'Target mode 已退出. 下一条 chat 回到普通模式.');
    return true;
  }

  // /target pause
  if (sub === 'pause') {
    if (!isTargetActive()) {
      deps.logInfo('Target', `当前 target 状态是 ${getTargetStatus()}, 不是 active — 无法 pause.`);
      return true;
    }
    pauseTargetMission('User /target pause');
    deps.logInfo('Target', 'Target 已暂停. Loop 将在本轮结束后正常退出. 恢复请用 /target continue.');
    return true;
  }

  // /target continue
  if (sub === 'continue' || sub === 'resume') {
    if (!isTargetPaused()) {
      deps.logInfo('Target', `当前 target 状态是 ${getTargetStatus()}, 不是 paused — 无法 continue.`);
      return true;
    }
    continueTargetMission();
    deps.logInfo('Target', 'Target 已恢复. 下一条 chat 继续推进 (agent 从上次 pause 点继续).');
    return true;
  }

  // /target refine <新目标文本>
  if (sub === 'refine') {
    const newText = args.slice(1).join(' ').trim();
    if (!newText) {
      deps.logInfo('Target', '用法: /target refine <新的目标文本>. 保留原 plan / elapsed / 历史.');
      return true;
    }
    if (!isTargetActive() && !isTargetPaused()) {
      deps.logInfo('Target', `当前 target 状态是 ${getTargetStatus()} — 只有 active / paused 才能 refine.`);
      return true;
    }
    if (refineTargetMission(newText, 'User /target refine')) {
      deps.logInfo('Target', `目标已更新: ${newText}\n\nPlan / 时长 / 历史保留.`);
    } else {
      deps.logInfo('Target', 'Refine 失败 — 内部拒绝. 可能没有活的 target.');
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
      [
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
      ].join('\n'),
    );
    return true;
  }

  activateTargetFromCommand(targetText, maxRunTimeMs);
  const ceilingMsg = maxRunTimeMs ? `\n时间上限: ${Math.round(maxRunTimeMs / 60_000)} 分钟 (超时自动 expired)` : '';
  deps.logInfo(
    'Target',
    [
      `Target 已激活: ${targetText}${ceilingMsg}`,
      '',
      '下一条 chat 输入 (可以直接回车/空消息) 即开始动手.',
      'Agent 会长跑直到自己确认目标达成 (check_target_done).',
      '任意时候: /target status 查看进度 · /target pause 暂停 · /target off 退出.',
    ].join('\n'),
  );
  return true;
}
