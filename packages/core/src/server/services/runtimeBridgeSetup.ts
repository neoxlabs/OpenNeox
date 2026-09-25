import { getGlobalUserHookRunner } from '../../core/userHooks.js';
import { skipsApproval } from '../../core/hookProtocol.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EventBus } from '../eventBus.js';
import type { PermissionManager, ApprovalResult } from '@neoxlabs/kernel/core/permissions/index.js';
import type { AskUserQuestionInput } from '../../tools/askUserTool.js';
import { setAskUserUICallback, setAskUserTimeoutCallback } from '../../tools/askUserTool.js';
import { setBackgroundTaskCallback, setShellOutputStreamCallback } from '../../tools/runtimeTools.js';
import { startServiceSnapshotTick } from '../../runtime/services/serviceSnapshot.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { ToolRiskAssessment } from '@neoxlabs/kernel/core/toolRiskEvaluator.js';
import { setTeamExecPersistence } from '../../runtime/team/teamExecStore.js';
import { setTeamPlanPersistence } from '../../runtime/team/teamPlanStore.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

export interface PendingPermissionEntry {
  resolve: (result: ApprovalResult) => void;
  tool: string;
  args: any;
  sessionId: string;
  risk?: ToolRiskAssessment;
  createdAt: number;
  settled: boolean;
}

interface SetupRuntimeBridgeCallbacksOptions {
  bus: EventBus;
  /** 本 runtime 绑定的工程根 —— 服务快照按它过滤, 多项目窗口不互相看到对方的服务。 */
  workDir?: string;
  activeSessions: Set<string>;
  approvalSessionStore: AsyncLocalStorage<string>;
  permissionManager: PermissionManager;
  pendingPermissions: Map<string, PendingPermissionEntry>;
  enterWaiting?: (
    sessionId: string,
    kind: 'approval' | 'user',
    requestId: string,
    tool?: { toolName: string; args?: any },
  ) => void;
  /** 退出等待态 — 只有 ask_user 需要外部调 (审批走 main.ts 的 resolvePendingPermission
   *  单一收口, 不经过这里)。 */
  exitWaiting?: (sessionId: string, kind: 'approval' | 'user', requestId: string) => void;
}

function normalizeBackgroundStatus(status?: string): 'running' | 'done' | 'error' | 'killed' | undefined {
  return status === 'running' || status === 'done' || status === 'error' || status === 'killed'
    ? status
    : undefined;
}

function resolveSessionId(
  approvalSessionStore: AsyncLocalStorage<string>,
  activeSessions: Set<string>,
): string | null {
  const scopedSessionId = approvalSessionStore.getStore();
  if (scopedSessionId) {
    return scopedSessionId;
  }

  if (activeSessions.size === 1) {
    return [...activeSessions][0] ?? null;
  }

  return null;
}

/** @returns 取消服务快照订阅的函数 —— 窗口/runtime 销毁时必须调, 否则会一直往
 *  已 dispose 的 bus 上推快照 (每开关一次项目泄漏一个订阅者)。 */
export function setupRuntimeBridgeCallbacks(options: SetupRuntimeBridgeCallbacksOptions): () => void {
  const {
    bus,
    activeSessions,
    approvalSessionStore,
    permissionManager,
    pendingPermissions,
    enterWaiting,
    exitWaiting,
  } = options;

  setTeamPlanPersistence({
    persist: (plan) => {
      try {
        getDatabase().upsertTeamSession({
          teamId: plan.teamId,
          workspacePath: process.cwd(),
          sessionId: plan.sessionId,
          goal: plan.goal,
          status: plan.stage,
          memberIds: plan.roster.map((m) => m.id),
          missionGraph: JSON.stringify(plan),
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        });
      } catch (err: any) {
        cliLogger.warn('TEAM_PLAN', `落盘失败 (不阻塞规划): ${err?.message ?? err}`);
      }
    },
    /* 解散团队 (输入框药丸 ✕) —— 内存清了还得把 team_sessions 里的行删掉,
     * 否则下次启动 hydrate 把队伍捞回来。 */
    purge: (sessionId) => {
      try {
        getDatabase().deleteTeamSessionsBySession(sessionId);
      } catch (err: any) {
        cliLogger.warn('TEAM_PLAN', `解散团队删存档失败: ${err?.message ?? err}`);
      }
    },
    load: (sessionId) => {
      try {
        const row = getDatabase().getLatestTeamSessionBySession(sessionId);
        if (!row?.missionGraph) return null;
        const g = JSON.parse(row.missionGraph) as any;
        /* 同理: 先摊开整包, 再用库里的行覆盖几个权威字段 + 补默认值。
         * 新字段不用改这里 —— 少一个字段就少一次静默丢失。 */
        return {
          ...g,
          teamId: row.teamId,
          sessionId: row.sessionId,
          goal: row.goal ?? g.goal,
          stage: g.stage ?? 'requirements',
          requirements: g.requirements ?? [],
          roster: g.roster ?? [],
          reviews: g.reviews ?? [],
          claims: g.claims ?? [],
          createdAt: g.createdAt ?? row.createdAt ?? Date.now(),
          updatedAt: g.updatedAt ?? row.updatedAt ?? Date.now(),
        };
      } catch {
        return null;
      }
    },
  });

  /* 执行态落盘 —— 复用同一张 team_sessions 行, 塞在 mission_graph.exec 里。
   * 为什么要落: 用户切走会话再回来 (或刷新), 执行台不能变空白 —— 规划态早就是这么做的
   * (纯内存那一版被当场点名过)。整包塞进去, 不列白名单 (那病今晚咬了五次)。 */
  setTeamExecPersistence((st) => {
    try {
      const db = getDatabase();
      const row = db.getLatestTeamSessionBySession(st.sessionId);
      if (!row?.missionGraph) return;   // 规划还没落盘, 执行态无处安放 (正常不会发生)
      const g = JSON.parse(row.missionGraph) as Record<string, unknown>;
      db.upsertTeamSession({
        teamId: row.teamId,
        workspacePath: row.workspacePath ?? process.cwd(),
        sessionId: st.sessionId,
        goal: row.goal,
        status: row.status,
        memberIds: row.memberIds ?? [],
        missionGraph: JSON.stringify({ ...g, exec: st }),
        createdAt: row.createdAt ?? st.startedAt ?? Date.now(),
        updatedAt: Date.now(),
      });
    } catch (err: any) {
      cliLogger.warn('TEAM_EXEC', `落盘失败 (不阻塞执行): ${err?.message ?? err}`);
    }
  });

  const backgroundTaskSessionById = new Map<number, string>();
  const backgroundTaskIdByPid = new Map<number, number>();
  let backgroundTaskIdSeed = 0;

  setAskUserUICallback((requestId: string, questions: AskUserQuestionInput[], options) => {
    const sessionId = resolveSessionId(approvalSessionStore, activeSessions);
    if (!sessionId) {
      cliLogger.warn('SERVER', `ask_user_needed dropped due to ambiguous session context: requestId=${requestId}`);
      return undefined;
    }
    const timeoutSec = options?.timeoutSec ?? 0;
    bus.publish({
      sessionId,
      type: 'ask_user_needed',
      data: {
        type: 'ask_user_needed',
        requestId,
        questions,
        timeoutSec,
      },
      timestamp: Date.now(),
    });
    enterWaiting?.(sessionId, 'user', requestId);
    /* 返 sessionId → askUserTool 把本次调用持久化进 pending_ask_user 表.
     * 服务重启后, 用户的 submit 在 replyAskUser handler 里命中磁盘记录走 resume 路径. */
    return sessionId;
  });

  setAskUserTimeoutCallback((requestId: string, sessionId: string, timeoutSec: number, reason) => {
    cliLogger.info('SERVER', `ask_user_expired: requestId=${requestId} session=${sessionId} reason=${reason} after ${timeoutSec}s`);
    exitWaiting?.(sessionId, 'user', requestId);
    bus.publish({
      sessionId,
      type: 'ask_user_expired',
      data: {
        type: 'ask_user_expired',
        requestId,
        timeoutSec,
        reason,
      },
      timestamp: Date.now(),
    });
  });

  setBackgroundTaskCallback({
    onAdd: (command: string, pid: number): number => {
      const sessionId = resolveSessionId(approvalSessionStore, activeSessions);
      if (!sessionId) {
        cliLogger.warn('SERVER', `background_task(add) dropped due to ambiguous session context: pid=${pid}`);
        return 0;
      }
      const taskId = ++backgroundTaskIdSeed;
      backgroundTaskSessionById.set(taskId, sessionId);
      backgroundTaskIdByPid.set(pid, taskId);
      bus.publish({
        sessionId,
        type: 'background_task',
        data: {
          type: 'background_task',
          action: 'add',
          taskId,
          pid,
          command,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });

      return taskId;
    },
    onUpdate: (taskId: number, updates: { status?: string; exitCode?: number; outputLine?: string }) => {
      const sessionId = backgroundTaskSessionById.get(taskId)
        || resolveSessionId(approvalSessionStore, activeSessions);
      if (!sessionId) {
        cliLogger.warn('SERVER', `background_task(update) dropped due to ambiguous session context: taskId=${taskId}`);
        return;
      }

      bus.publish({
        sessionId,
        type: 'background_task',
        data: {
          type: 'background_task',
          action: 'update',
          taskId,
          updates: {
            ...updates,
            status: normalizeBackgroundStatus(updates.status),
          },
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });

      if (updates.status && updates.status !== 'running') {
        /* 终结事件发出后不要立刻删 pid↔task 映射。renderer/后端可能还会用
         * process:list 或迟到 update_by_pid 做兜底 reconcile；删太早会导致 exit 事件丢 session，
         * BackgroundTasksBar 卡在 running。短暂保留后再清即可避免泄漏。 */
        setTimeout(() => {
          backgroundTaskSessionById.delete(taskId);
          for (const [pid, id] of backgroundTaskIdByPid) {
            if (id === taskId) backgroundTaskIdByPid.delete(pid);
          }
        }, 60_000);
      }
    },
    onUpdateByPid: (pid: number, updates: { status?: string; exitCode?: number }) => {
      const taskId = backgroundTaskIdByPid.get(pid);
      const sessionId = (taskId ? backgroundTaskSessionById.get(taskId) : undefined)
        || resolveSessionId(approvalSessionStore, activeSessions);
      if (!sessionId) {
        cliLogger.warn('SERVER', `background_task(update_by_pid) dropped due to ambiguous session context: pid=${pid}`);
        return;
      }

      bus.publish({
        sessionId,
        type: 'background_task',
        data: {
          type: 'background_task',
          action: 'update_by_pid',
          taskId,
          pid,
          updates: {
            ...updates,
            status: normalizeBackgroundStatus(updates.status),
          },
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });

      if (updates.status && updates.status !== 'running') {
        setTimeout(() => {
          if (taskId) backgroundTaskSessionById.delete(taskId);
          backgroundTaskIdByPid.delete(pid);
        }, 60_000);
      }
    },
  });

  const shellStreamSessionByPid = new Map<number, string>();

  setShellOutputStreamCallback((payload) => {
    /* sessionId 来源优先级:
     *   1. payload.sessionId — caller 显式带过来 (UI 触发的 serviceLauncher 走这条)
     *   2. ALS 内 (agent 执行 execute_shell 时, 唯一精确路径)
     *   3. pid 粘性路由 (turn 已结束的长活服务 — 用 spawn 时记下的 session)
     *   4. 唯一活跃 session (兜底)
     *   5. 全部活跃 session (兜底兜底, fan-out) */
    const events: Array<{ sessionId: string }> = [];
    if (payload.sessionId) {
      events.push({ sessionId: payload.sessionId });
    } else {
      const scoped = approvalSessionStore.getStore();
      const sticky = typeof payload.pid === 'number' ? shellStreamSessionByPid.get(payload.pid) : undefined;
      if (scoped) {
        events.push({ sessionId: scoped });
      } else if (sticky) {
        events.push({ sessionId: sticky });
      } else if (activeSessions.size === 1) {
        events.push({ sessionId: [...activeSessions][0] });
      } else if (activeSessions.size > 1) {
        for (const sid of activeSessions) events.push({ sessionId: sid });
      }
    }
    if (events.length === 0) {
      cliLogger.warn('SERVER', `shell_output_stream dropped (no session): toolId=${payload.toolId ?? 'unknown'} pid=${payload.pid ?? 'unknown'}`);
      return;
    }
    /* 记住 pid 归属 (单 session 归属即可; fan-out 兜底路径不记, 避免记错主人) */
    if (typeof payload.pid === 'number' && payload.pid > 0 && events.length === 1) {
      shellStreamSessionByPid.set(payload.pid, events[0].sessionId);
    }
    if (payload.isComplete && typeof payload.pid === 'number') {
      const donePid = payload.pid;
      setTimeout(() => shellStreamSessionByPid.delete(donePid), 60_000).unref?.();
    }
    for (const ev of events) {
      bus.publish({
        sessionId: ev.sessionId,
        type: 'shell_output_stream',
        data: {
          type: 'shell_output_stream',
          toolId: payload.toolId,
          command: payload.command,
          output: payload.output,
          outputDelta: payload.outputDelta,
          elapsed: payload.elapsed,
          isComplete: payload.isComplete,
          exitCode: payload.exitCode,
          pid: payload.pid,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });
    }
  });

  permissionManager.setApprovalHandler(async (request) => {
    const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    const sessionId = resolveSessionId(approvalSessionStore, activeSessions);
    if (!sessionId) {
      cliLogger.warn('SERVER', `Permission denied due to ambiguous session context: tool=${request.toolName}`);
      return { approved: false, remember: false };
    }

    cliLogger.info(
      'SERVER_AUDIT',
      `permission request created: requestId=${requestId} tool=${request.toolName} risk=${request.risk?.level ?? 'low'} session=${sessionId}`,
    );

    const hooks = getGlobalUserHookRunner();
    if (hooks) {
      try {
        const outcome = await hooks.fire('PermissionRequest', {
          toolName: request.toolName,
          toolArgs: request.args as Record<string, any>,
          payload: {
            risk_level: request.risk?.level ?? 'low',
            reason: request.reason,
            session_id: sessionId,
            request_id: requestId,
          },
        });
        if (!outcome.allow) {
          cliLogger.info('SERVER_AUDIT',
            `permission denied by hook: tool=${request.toolName} reason=${outcome.reason ?? ''}`);
          /* 用户视角也要能看见"是谁拒的" —— 否则只看到工具失败, 找不到原因 */
          await hooks.fire('PermissionDenied', {
            toolName: request.toolName,
            payload: { by: 'hook', reason: outcome.reason, session_id: sessionId },
          }).catch(() => { /* 通知式, 失败不影响主流程 */ });
          return { approved: false, remember: false };
        }
        if (skipsApproval(outcome)) {
          cliLogger.info('SERVER_AUDIT',
            `permission auto-allowed by hook: tool=${request.toolName} source=${outcome.source ?? ''}`);
          return { approved: true, remember: false };
        }
      } catch (err: any) {
        /* hook 自己崩了不该把工具卡死 —— 跟退出码那条 fail-open 是同一个原则 */
        cliLogger.warn('HOOKS', `PermissionRequest hook 出错, 按没有 hook 处理: ${err?.message}`);
      }
    }

    bus.publish({
      sessionId,
      type: 'approval_needed',
      data: {
        type: 'approval_needed',
        requestId,
        toolName: request.toolName,
        args: request.args,
        reason: request.reason,
        allowRemember: request.allowRemember,
        scopeKey: request.scopeKey,
        risk: request.risk,
      },
      timestamp: createdAt,
    });

    enterWaiting?.(sessionId, 'approval', requestId, { toolName: request.toolName, args: request.args });

    /* 永久等待用户审批 — 没有 fail-close 超时.
     *
     * 原则: "用户没点同意 = 没有授权", 凭什么过期 + 静默 DENY? 那是"看起来安全实则危险"的反模式:
     *   · 用户去倒水, 回来 agent 已经悄悄拒了, 然后接下来的 plan 全废 (链条上 N 个 tool call 都因
     *     "前置 DENY" 一并失败), 没人知道发生了什么 — 比直接 hang 更难调试.
     *   · CC / Codex 都不设默认 timeout, 用户离开就让 agent 等着.
     *
     * 退出路径: agent abort (用户点 Stop) / session close → cancelPendingPermissionsForSession
     * 会 resolve 'session_aborted', 干净收场. 无人值守需求由 YOLO (dangerous) 模式表达,
     * 不能用静默 DENY 充数. */
    return await new Promise<ApprovalResult>((resolve) => {
      pendingPermissions.set(requestId, {
        resolve,
        tool: request.toolName,
        args: request.args,
        sessionId,
        risk: request.risk,
        createdAt,
        settled: false,
      });
    });
  });

  return startServiceSnapshotTick((snap) => {
    const targets = activeSessions.size > 0 ? [...activeSessions] : [];
    for (const sessionId of targets) {
      bus.publish({
        sessionId,
        type: 'background_task',
        data: {
          type: 'background_task',
          action: 'snapshot',
          generatedAt: snap.generatedAt,
          processes: snap.processes as unknown as Array<Record<string, unknown>>,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      });
    }
  }, options.workDir);
}
