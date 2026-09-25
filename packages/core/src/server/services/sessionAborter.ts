import type { AgentRunMode } from '../../runtime/modeFactory.js';
import type { AgenticRuntime } from '../../runtime/agenticRuntime.js';
import { getBackgroundTaskNotifier } from '../../runtime/shell/backgroundTaskNotifier.js';
import { clearSessionPause } from '../../runtime/pauseController.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface AbortSessionOptions {
  sessionId: string;
  abortControllers: Map<string, AbortController>;
  activeSessionModes: Map<string, AgentRunMode>;
  singleRuntime: AgenticRuntime | null;
  assistantRuntime?: null;
}

export interface AbortSessionResult {
  /** 中断后仍在运行的后台进程 —— 不杀, 但必须让人和 agent 都知道 */
  survivingProcesses: Array<{ pid: number; command: string }>;
}

export function abortSession(options: AbortSessionOptions): AbortSessionResult {
  const {
    sessionId,
    abortControllers,
    singleRuntime,
  } = options;

  const ac = abortControllers.get(sessionId);
  if (ac) {
    ac.abort();
    abortControllers.delete(sessionId);
  }

  /* assistant 模式已移除 —— 只 abort agentic single runtime。 */
  singleRuntime?.abort(sessionId);

  /* 暂停着按停止: runner 挂在 waitForResume 上只听 resume。runner 侧已经跟 abort 竞速,
   * 这里再清一次暂停, 保证 worker / 没传 signal 的路径也醒得过来, 且下一轮不会一开头就挂住。 */
  try {
    clearSessionPause(sessionId);
  } catch (err: any) {
    cliLogger.warn('SERVER', `abort ${sessionId.slice(0, 16)}: 清暂停状态失败: ${err?.message ?? err}`);
  }

  let survivingProcesses: Array<{ pid: number; command: string }> = [];
  try {
    const notifier = getBackgroundTaskNotifier();
    survivingProcesses = notifier.listLiveForSession(sessionId);
    if (survivingProcesses.length > 0) {
      const lines = survivingProcesses
        .map(p => `  - pid ${p.pid}: ${p.command}`)
        .join('\n');
      notifier.enqueueMessageForSession(
        sessionId,
        `<background-processes-survived-interrupt>\n` +
        `用户中断了上一轮。以下后台进程是上一轮启动的, 中断不会杀它们, 现在仍在运行:\n` +
        `${lines}\n` +
        `如果接下来要用同一个端口/服务, 请直接复用它们 (或先 bash_kill 掉对应 pid), ` +
        `不要假设环境是干净的。\n` +
        `</background-processes-survived-interrupt>`,
        { terminatedBy: 'user', noAutoResume: true },
      );
      cliLogger.info(
        'SERVER',
        `abort ${sessionId.slice(0, 16)}: ${survivingProcesses.length} background process(es) survived — ` +
        survivingProcesses.map(p => `${p.pid}(${p.command.slice(0, 40)})`).join(', '),
      );
    }
  } catch (err: any) {
    /* 报告失败绝不能反过来搞挂中断本身 —— 中断是用户按下去的最高优先级动作 */
    cliLogger.warn('SERVER', `abort ${sessionId.slice(0, 16)}: 收集后台幸存进程失败: ${err?.message ?? err}`);
  }

  return { survivingProcesses };
}
