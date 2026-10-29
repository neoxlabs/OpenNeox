
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  ToolCategory,
  ToolPermission,
} from '@neoxlabs/kernel/types/permissions.js';
import {
  EXTERNAL_AGENT_DEFAULT_TIMEOUT_MS,
  type PluginExternalAgentDefinition,
} from '@neoxlabs/platform/shared/plugin-external-agent.js';
import { localized } from '@neoxlabs/platform/shared/plugin-connector.js';
import { delegateToExternalAgent, detectExternalAgent } from './runner.js';

export type RegisteredExternalAgent = {
  pluginName: string;
  agent: PluginExternalAgentDefinition;
  tool: Tool;
};

/**
 * 宿主注入的运行时钩子。
 *
 *   registry 本身不 import core —— 桌面端和 CLI 拿到的 workspaceRoot /
 *   流式通道 / worktree 实现不一定是同一个, 让调用方给。
 */
const FOREGROUND_WAIT_MS = 90_000;

export type ExternalAgentHostHooks = {
  getWorkspaceRoot: () => string;
  /**
   * 调用时所在的对话 —— 必须在工具被调的那一刻取 (之后在子进程回调里 ALS 未必还在)。
   * 转后台的结果要投回这个对话, 主 agent 才会被唤醒去汇报。
   */
  getSessionId?: () => string | undefined;
  /** 后台完成时把结果送到用户面前 (通知 + timeline) 和主 agent 的收件箱 */
  onBackgroundFinished?: (info: {
    agentId: string;
    displayName: string;
    toolCallId?: string;
    sessionId?: string;
    prompt: string;
    ok: boolean;
    elapsedMs: number;
    toolUseCount: number;
    summary: string;
  }) => void;
  onProgress?: (payload: {
    toolId: string;
    command: string;
    output: string;
    outputDelta?: string;
    elapsed: number;
    isComplete?: boolean;
    exitCode?: number;
  }) => void;
  /** 进程管理器 —— 让外部 agent 跟别的后台进程一样出现在服务面板 */
  processTracker?: {
    register: (info: { pid: number; command: string; cwd: string; workspaceRoot: string; processRef?: unknown }) => void;
    appendOutput: (pid: number, text: string) => void;
    markCompleted: (pid: number, exitCode: number | null) => void;
  };
  worktree?: {
    create: (workDir: string, agentId: string) => { path: string; branch: string } | null;
    cleanup: (info: any, workDir: string) => {
      hasChanges: boolean;
      changedFiles: string[];
      branch?: string;
      worktreePath?: string;
    };
  };
};

class ExternalAgentRegistry {
  private readonly byPlugin = new Map<string, RegisteredExternalAgent[]>();
  private readonly toolOwner = new Map<string, string>();
  private hooks: ExternalAgentHostHooks | null = null;

  /** 宿主启动时装一次。没装的话工具照样注册, 但调用时会说清缺什么。 */
  setHostHooks(hooks: ExternalAgentHostHooks | null): void {
    this.hooks = hooks;
  }

  register(pluginName: string, agents: PluginExternalAgentDefinition[]): Tool[] {
    this.unregister(pluginName);

    const registered: RegisteredExternalAgent[] = [];
    for (const agent of agents) {
      const toolName = `${agent.id}_delegate`;
      const owner = this.toolOwner.get(toolName);
      if (owner && owner !== pluginName) {
        throw new Error(`external agent tool name collision: ${toolName} (already provided by ${owner})`);
      }
      const tool = this.buildTool(pluginName, agent, toolName);
      registered.push({ pluginName, agent, tool });
      this.toolOwner.set(toolName, pluginName);
    }

    this.byPlugin.set(pluginName, registered);
    /* 探测提前在后台做掉: 第一次派活就不用再等 `--version` (dsh 还要找够新的 node, 要跑好几次)。
     * 延后几秒, 不跟启动抢 CPU; 结果进 runner 的 5 分钟缓存。 */
    const prewarm = setTimeout(() => {
      for (const r of registered) void detectExternalAgent(r.agent).catch(() => {});
    }, 3000);
    prewarm.unref?.();
    return registered.map(r => r.tool);
  }

  unregister(pluginName: string): number {
    const entries = this.byPlugin.get(pluginName);
    if (!entries) return 0;
    for (const e of entries) this.toolOwner.delete(e.tool.name);
    this.byPlugin.delete(pluginName);
    return entries.length;
  }

  list(): RegisteredExternalAgent[] {
    return [...this.byPlugin.values()].flat();
  }

  get(agentId: string): RegisteredExternalAgent | undefined {
    return this.list().find(e => e.agent.id === agentId);
  }

  /** 设置页要显示「装没装」 */
  async status(): Promise<Array<{
    pluginName: string;
    id: string;
    displayName: string;
    command: string;
    installed: boolean;
    version?: string;
    installHint: string;
    isolation: string;
    examplePrompts: string[];
  }>> {
    const out = [];
    for (const { pluginName, agent } of this.list()) {
      const detected = await detectExternalAgent(agent);
      out.push({
        pluginName,
        id: agent.id,
        displayName: localized(agent.displayName),
        command: agent.command,
        installed: detected.ok,
        version: detected.version,
        /* 装了但跑不起来 (如 node 太旧) 时给具体原因, 不是泛泛的安装提示 */
        installHint: detected.reason ?? localized(agent.detect.installHint),
        isolation: agent.isolation ?? 'worktree',
        examplePrompts: agent.examplePrompts ?? [],
      });
    }
    return out;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private buildTool(
    pluginName: string,
    agent: PluginExternalAgentDefinition,
    toolName: string,
  ): Tool {
    const isolation = agent.isolation ?? 'worktree';
    const timeoutMs = agent.timeoutMs ?? EXTERNAL_AGENT_DEFAULT_TIMEOUT_MS;
    const name = localized(agent.displayName);

    const description =
      `${localized(agent.description)} ` +
      `把一份完整的任务书交给独立运行的 ${name}。` +
      (isolation === 'worktree'
        ? '它在独立的 git worktree 副本里跑，用户当前的工作区一个字都不会改；它的改动留在副本分支，由你复核后再决定要不要合。只读的审查 / 分析也适合交给它（任务书里写明只读）。'
        : '⚠️ 直接在当前工作区执行、会真的改文件，会与你自己的编辑冲突。') +
      `用户点名要 ${name} 做的事就交给它，不要换成别的 agent。` +
      ` 上限 ${Math.round(timeoutMs / 60000)} 分钟。`;

    return {
      name: toolName,
      description,
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              '交给它的任务书。要自包含：目标、涉及的文件、验收标准。' +
              '对面看不到本次会话的上下文，只有这段文字和工作区里的代码。',
          },
          model: {
            type: 'string',
            description: `可选，指定 ${name} 使用的模型。不传则用它自己的默认值。`,
          },
          run_in_background: {
            type: 'boolean',
            description:
              '设为 true 立即返回、不阻塞你 —— 适合独立任务。它跑完会通知你，'
              + '你可以先干别的。不传则先前台等一会儿，超时自动转后台。',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      isReadOnly: false,
      group: 'agent',
      /* worktree 隔离下各改各的目录, 可以并行 (codex 写 / claude review 同时跑);
       * 不隔离时它们会抢同一批文件, 必须串行 */
      parallelSafety: isolation === 'worktree' ? 'safe' : 'unsafe',
      resultType: 'summarized',
      timeoutMs,
      permission: {
        category: ToolCategory.EXECUTE,
        /* 在用户机器上跑另一个 agent —— 永远要问 */
        defaultPermission: ToolPermission.ASK,
        permissionReason: `在本机运行 ${agent.command} 并让它读写${isolation === 'worktree' ? '隔离副本中的' : '工作区的'}文件`,
        allowInAskMode: false,
      },
      function: async (
        args: { prompt?: string; model?: string; run_in_background?: boolean },
        context,
      ) => {
        const prompt = (args?.prompt ?? '').trim();
        if (!prompt) return `${toolName} 需要 prompt：交给 ${name} 的任务书不能为空。`;

        if (!this.hooks) {
          return `外部 Agent 运行时未初始化（宿主未注入 workspace/worktree 钩子），无法委派给 ${name}。`;
        }
        if (!this.byPlugin.has(pluginName)) {
          return `插件「${pluginName}」已被卸载或禁用，${name} 委派不可用。`;
        }

        /* 前台先等一会儿: 短任务 (跑个测试 / 改一个文件) 内联返回最舒服, 让用户为了
         * 20 秒的活多绕一次「去后台看看」是坏体验; 长任务再转后台, 别冻住主对话。
         * 显式 run_in_background=true 则一秒都不等。 */
        const autoBackgroundMs = args?.run_in_background ? 1 : FOREGROUND_WAIT_MS;
        const sessionId = this.hooks.getSessionId?.();

        const result = await delegateToExternalAgent({
          agent,
          pluginName,
          prompt,
          model: args?.model,
          workspaceRoot: this.hooks.getWorkspaceRoot(),
          toolCallId: context?.toolCallId,
          signal: context?.signal,
          onProgress: this.hooks.onProgress,
          processTracker: this.hooks.processTracker,
          worktree: this.hooks.worktree,
          autoBackgroundMs,
          onFinished: (final) => {
            /* 转后台之后才会走到这里 —— 结果必须主动送到用户面前, 否则一个跑了
             * 二十分钟的任务就这么无声无息地结束了。 */
            this.hooks?.onBackgroundFinished?.({
              agentId: agent.id,
              displayName: name,
              toolCallId: context?.toolCallId,
              sessionId,
              prompt,
              ok: final.ok,
              elapsedMs: final.elapsedMs,
              toolUseCount: Object.values(final.toolCounts).reduce((a, b) => a + b, 0),
              summary: formatResult(name, final),
            });
          },
        });

        if (result.detached) {
          return [
            args?.run_in_background
              ? `${name} 已在后台开始跑。`
              : `${name} 已转入后台继续跑（前台等了 ${Math.round(FOREGROUND_WAIT_MS / 1000)} 秒还没完）。`,
            '它一结束 (成功或失败) 结果会自动送回这个对话、唤醒你汇报 —— 不需要 schedule_wakeup 轮询, 先结束本轮或做别的事即可。',
            '⚠️ 不要重复派同一个任务 —— 它还在跑。',
          ].join('\n');
        }

        return formatResult(name, result);
      },
    };
  }
}

function formatResult(
  name: string,
  r: Awaited<ReturnType<typeof delegateToExternalAgent>>,
): string {
  const mins = (r.elapsedMs / 60000).toFixed(1);
  const lines: string[] = [];

  lines.push(r.ok ? `${name} 完成（${mins} 分钟）` : `${name} 未完成（${mins} 分钟）`);
  if (r.error) lines.push(`原因：${r.error}`);

  const tools = Object.entries(r.toolCounts);
  if (tools.length > 0) {
    lines.push(`它执行了：${tools.map(([k, v]) => `${k}×${v}`).join('、')}`);
  }

  if (r.worktree) {
    /* 改动落在分支上而不是当前工作区 —— 必须说清楚, 否则主 agent 会去当前
     * 目录找这些文件然后发现没变, 进而重做一遍 */
    lines.push('');
    lines.push(`改动在独立分支 \`${r.worktree.branch}\`（目录 ${r.worktree.path}），**不在当前工作区**。`);
    lines.push(`涉及 ${r.worktree.changedFiles.length} 个文件：${r.worktree.changedFiles.slice(0, 20).join(', ')}`);
    lines.push('复核后可以 `git merge` 或 `git cherry-pick` 合进来。');
  } else if (r.ok) {
    lines.push('（没有产生文件改动）');
  }

  if (r.text.trim()) {
    lines.push('');
    lines.push(`--- ${name} 的输出 ---`);
    lines.push(r.text.trim());
  }

  return lines.join('\n');
}

/** 全局单例 */
export const externalAgentRegistry = new ExternalAgentRegistry();
