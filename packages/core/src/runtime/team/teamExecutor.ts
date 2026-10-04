
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { TeamPlan } from './teamPlanStore.js';
import { leafRequirements } from './teamPlanStore.js';
import {
  type ExecTask, type TeamExecState,
  getTeamExec, updateTask, postExecMessage, advanceWave, runnableTasks,
  setTeamExecStatus, execProgress, registerExecAgent,
} from './teamExecStore.js';

export interface TeamExecutorDeps {
  sessionId: string;
  plan: TeamPlan;
  /** agent 工具 —— 派一条活就是起一个子会话 (前台 await 到结束) */
  agentTool: Tool;
  /** 还有多少并发额度 —— 先查再派, 不靠 catch 错误文案 */
  activeAgentCount: () => number;
  maxConcurrent: number;
  emit: (event: Record<string, unknown>) => void;
  /** 每条活的墙钟上限 (ms) */
  taskTimeoutMs?: number;
  /** 开工那一刻的工作目录 —— 派兵时钉给每个子 agent, 用户中途切项目也不漂 */
  workDir?: string;
}

const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
/** 并发额度轮询间隔 —— 满了就等位, 不判失败 */
const SLOT_POLL_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 派给单个 agent 的指令 —— 隔离与配合的规则全写在这里 */
function buildTaskPrompt(deps: TeamExecutorDeps, task: ExecTask): string {
  const { plan } = deps;
  const req = plan.requirements.find((r) => r.id === task.id);
  const member = plan.roster.find((m) => m.id === task.memberId);
  const claim = plan.claims.find((c) => c.memberId === task.memberId);
  const scopes = claim?.ownedScope ?? [];
  const deps0 = (req?.dependsOn ?? []).map((d) => {
    const dr = plan.requirements.find((r) => r.id === d);
    const owner = plan.claims.find((c) => c.requirementIds.includes(d))?.memberId;
    return `${d}${dr ? ` (${dr.title})` : ''}${owner && owner !== task.memberId ? ` —— ${owner} 交付的` : ''}`;
  });
  /* 同批的兄弟活 —— 告诉他"谁在跟你同时干", 免得两个人各自猜对方的接口 */
  const siblings = (getTeamExec(deps.sessionId)?.tasks ?? [])
    .filter((t) => t.wave === task.wave && t.id !== task.id)
    .map((t) => `${t.id} (${t.memberId}: ${t.title})`);

  return [
    `你是团队成员 **${task.memberId}${member?.title ? ` · ${member.title}` : ''}**${member?.level ? ` (${member.level})` : ''}。`,
    `团队目标: ${plan.goal}`,
    '',
    `## 你这一条活: ${task.id} —— ${task.title}`,
    req?.detail ? `\n${req.detail}` : '',
    req?.acceptance ? `\n**验收判据 (做完必须自己验一遍)**: ${req.acceptance}` : '',
    req?.estimateDays ? `\n工期预估: ${req.estimateDays} 人天 —— 超出很多说明你理解的范围不对, 先说清再动手。` : '',
    '',
    '## 你的领地 (只能写这些路径)',
    scopes.length ? scopes.map((s) => `· ${s}`).join('\n') : '· (未声明领地 —— 只改跟这条活直接相关的文件)',
    '',
    '**越界就是打架**: 别人的领地你不许改, 哪怕只差一行。需要别人的东西有两条正路:',
    '  ① 他已经交付了 → 直接用他给的接口/表结构 (下面列了)',
    '  ② 还没有 / 不够用 → 用 send_message 找他要契约, 说清你要什么、为什么;',
    '     等不到就在收尾时说明"卡在谁的什么东西上", **不要自己伸手改他的文件**。',
    '',
    ...(deps0.length ? ['## 前置 (已经交付, 直接消费)', deps0.map((d) => `· ${d}`).join('\n'), ''] : []),
    ...(siblings.length ? ['## 同批并行 (跟你同时在干的人 —— 需要对齐就发消息)', siblings.map((s) => `· ${s}`).join('\n'), ''] : []),
    '## 收尾要求',
    '· 改完自己跑一遍测试 (项目怎么跑测试你自己探)。红了修完再收。',
    '· 最后一段话说清三件事: 改了哪些文件 / 验收判据过没过 / 有没有留给别人的契约或坑。',
    '· 你只做这一条活。别顺手改别人的域, 也别扩大范围。',
  ].filter(Boolean).join('\n');
}

/** 一条活跑完 → 给依赖它的下游成员发契约通知 (配合机制的落点) */
function notifyDownstream(deps: TeamExecutorDeps, task: ExecTask): void {
  const { plan, sessionId } = deps;
  const downstream = leafRequirements(plan).filter((r) => (r.dependsOn ?? []).includes(task.id));
  const seen = new Set<string>();
  for (const d of downstream) {
    const owner = plan.claims.find((c) => c.requirementIds.includes(d.id))?.memberId;
    if (!owner || owner === task.memberId || seen.has(owner)) continue;
    seen.add(owner);
    postExecMessage(sessionId, {
      from: task.memberId,
      to: owner,
      kind: 'contract_ready',
      taskId: task.id,
      text: `${task.id}（${task.title}）已交付，你的 ${d.id} 可以开工了。`
        + (task.result ? `\n交付摘要: ${task.result.slice(0, 300)}` : ''),
    });
  }
}

/**
 * 跑完整个执行流 —— 一批一批推进, 直到全部收口或被中止。
 *
 * 返回时 exec 状态已经是终态 (done/failed/aborted)。
 */
export async function runTeamExecution(deps: TeamExecutorDeps): Promise<TeamExecState | null> {
  const { sessionId } = deps;
  const timeout = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  const emitState = (reason: string) => {
    const st = getTeamExec(sessionId);
    if (!st) return;
    deps.emit({
      type: 'team_exec_update',
      teamId: st.teamId,
      sessionId,
      reason,
      status: st.status,
      currentWave: st.currentWave,
      totalWaves: st.totalWaves,
      tasks: st.tasks,
      messages: st.messages,
      progress: execProgress(st),
      timestamp: Date.now(),
    });
  };

  /** 派一条活 —— 等到有并发额度再真派 (排队不算失败) */
  const runTask = async (task: ExecTask): Promise<void> => {
    while (deps.activeAgentCount() >= deps.maxConcurrent) {
      const st = getTeamExec(sessionId);
      if (!st || st.status !== 'running') return;
      if (task.state !== 'blocked') {
        updateTask(sessionId, task.id, { state: 'blocked', note: '排队等并发额度' });
        emitState('queued');
      }
      await sleep(SLOT_POLL_MS);
    }
    const st0 = getTeamExec(sessionId);
    if (!st0 || st0.status !== 'running') return;

    const agentId = `${task.memberId}#${task.id}`;
    /* 领地闸要靠这条映射反查方案 (它跑在子会话里, 方案挂在父会话上) */
    registerExecAgent(agentId, sessionId, task.memberId);
    updateTask(sessionId, task.id, { state: 'running', agentId, startedAt: Date.now(), note: undefined });
    emitState('task_started');

    try {
      const out = await Promise.race([
        Promise.resolve(deps.agentTool.function({
          type: 'code',
          description: `${task.memberId} · ${task.title}`.slice(0, 60),
          prompt: buildTaskPrompt(deps, task),
          name: agentId,
          run_in_background: false,
          ...(deps.workDir ? { workDir: deps.workDir } : {}),
        })),
        sleep(timeout).then(() => { throw new Error(`任务超时 (${Math.round(timeout / 60000)} 分钟)`); }),
      ]);
      const text = String(out ?? '').trim();
      const looksFailed = /^\[ERROR\]|^\[error\]|^Error:/.test(text) || text.length === 0;
      if (looksFailed) {
        throw new Error(text ? text.slice(0, 300) : '子 agent 没有任何产出 (空返回)');
      }
      /* 兜底: 收到"已派到后台"的信封说明上面那个 run_in_background 没生效 (被转发层吞了 /
       * 参数改名了)。**这种时候必须失败**, 不能标 done —— 它是活着的假绿, 不是产出。
       * 逐字段抄的转发层吞掉新参数是这个仓库反复出现的失效方式, 所以这道兜底要留着。 */
      if (/"?status"?\s*:\s*"background_launched"/.test(text)) {
        throw new Error('子 agent 被派到后台了, 没等到产出 —— run_in_background:false 没生效, 这一条不能算完成');
      }
      updateTask(sessionId, task.id, {
        state: 'done', finishedAt: Date.now(), result: text.slice(0, 1200),
      });
      const t = getTeamExec(sessionId)?.tasks.find((x) => x.id === task.id);
      if (t) notifyDownstream(deps, t);
      emitState('task_done');
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      updateTask(sessionId, task.id, { state: 'failed', finishedAt: Date.now(), note: msg });
      postExecMessage(sessionId, {
        from: task.memberId, to: 'all', kind: 'blocker', taskId: task.id,
        text: `${task.id} 失败: ${msg}`,
      });
      cliLogger.warn('TEAM_EXEC', `${task.id} failed: ${msg}`);
      emitState('task_failed');
    }
  };

  emitState('start');
  let guard = 0;
  for (;;) {
    const st = getTeamExec(sessionId);
    if (!st || st.status !== 'running') break;
    if (guard++ > st.tasks.length * 3 + 20) {
      cliLogger.warn('TEAM_EXEC', 'scheduler guard tripped — 强制收尾');
      setTeamExecStatus(sessionId, 'failed');
      break;
    }
    const batch = runnableTasks(sessionId);
    if (batch.length > 0) {
      /* 批内并行 —— 领地互斥保证它们不会写到同一个文件 */
      await Promise.all(batch.map((t) => runTask(t)));
      continue;
    }
    /* 这一批收口了 → 放行下一批 */
    const next = advanceWave(sessionId);
    emitState(next === 0 ? 'finished' : 'wave_advanced');
    if (next === 0) break;
  }
  return getTeamExec(sessionId);
}
