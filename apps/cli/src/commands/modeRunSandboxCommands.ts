import { ModeFactory, type AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';
import {
  SandboxMode,
  getCurrentSandboxMode,
  setCurrentSandboxMode,
} from '@neoxlabs/core/runtime/sandboxModeApi.js';
import { persistOsSandboxSelection } from '@neoxlabs/core/tools/shell/osSandbox.js';
import type { InteractionMode } from '../cliTypes.js';
import { L } from '../i18n/index.js';

type Choice = { label: string; value: string; description: string };
type PromptSelect = (question: string, choices: Choice[], defaultValue?: string) => Promise<string>;
type LogInfo = (message: string, details?: string) => void;

interface ModeDeps {
  getInteractionMode: () => InteractionMode;
  setInteractionMode: (mode: InteractionMode) => void;
  promptSelect: PromptSelect;
  logInfo: LogInfo;
}

const modeUpdatedText = (mode: string) => (mode === 'ask'
  ? L('将以更对话的方式回答，并减少工具调用。', 'Answers conversationally and avoids tool calls.')
  : L('恢复默认的 Agent 模式，可自动调用工具。', 'Back to Agent mode — tools are used automatically.'));

export async function handleModeCommand(actionArg: string | undefined, deps: ModeDeps): Promise<void> {
  const desired = (actionArg || '').toLowerCase();
  if (desired && desired !== 'status') {
    if (desired !== 'agent' && desired !== 'ask') {
      deps.logInfo(L('无效的模式', 'Unknown mode'), L('可用模式: agent, ask', 'Available: agent, ask'));
      return;
    }
    if (deps.getInteractionMode() === desired) {
      deps.logInfo(L('模式未变化', 'Mode unchanged'), L(`仍为 ${desired}`, `Still ${desired}`));
      return;
    }
    deps.setInteractionMode(desired as InteractionMode);
    deps.logInfo(L('交互模式已更新', 'Mode updated'), modeUpdatedText(desired));
    return;
  }
  try {
    const selected = await deps.promptSelect(L('交互模式', 'Mode'), [
      { label: 'Agent', value: 'agent', description: L('智能体自动使用工具，适合代码任务', 'Uses tools on its own; best for coding tasks') },
      { label: 'Ask', value: 'ask', description: L('仅回答问题，尽量避免工具调用', 'Just answers; avoids tool calls') },
    ], deps.getInteractionMode());
    if (deps.getInteractionMode() !== selected) {
      deps.setInteractionMode(selected as InteractionMode);
      deps.logInfo(L('交互模式已更新', 'Mode updated'), modeUpdatedText(selected));
    } else {
      deps.logInfo(L('模式', 'Mode'), `${L('当前模式', 'Current')}: ${selected}`);
    }
  } catch (error: any) {
    if (error.message !== 'cancelled') deps.logInfo(L('切换模式失败', 'Mode selection failed'), error.message);
  }
}

interface RunModeDeps {
  getCurrentRunMode: () => AgentRunMode;
  setRunMode: (mode: AgentRunMode) => void;
  promptSelect: PromptSelect;
  logInfo: LogInfo;
}

/**
 * assistant 模式已移除 —— 现在只剩 agentic 一种运行模式, /run 退化为信息提示, 不再做切换。
 */
export async function handleRunModeCommand(_actionArg: string | undefined, deps: RunModeDeps): Promise<void> {
  deps.logInfo(L('运行模式: [A] Agentic', 'Run mode: [A] Agentic'), ModeFactory.getModeDescription('agentic'));
}

interface SandboxDeps {
  isSandboxEnabled: () => boolean;
  setSandboxEnabled: (enabled: boolean) => void;
  syncSandboxMode: (enabled: boolean) => Promise<void>;
  promptSelect: PromptSelect;
  logInfo: LogInfo;
}

/**
 * 把 CLI 输入的 action 字符串规范化到 SandboxMode 三档.
 * 支持新三档名 + 旧 'on'/'off' 别名 (向后兼容).
 * 返 null = 无效输入.
 */
function parseSandboxAction(action: string): SandboxMode | null {
  switch (action) {
    /* 旧别名: on=restricted ≈ READ_ONLY; off=full ≈ DANGER_FULL_ACCESS */
    case 'on':
    case 'enable':
    case 'restricted':
    case 'read-only':
    case 'readonly':
    case 'ro':
      return SandboxMode.READ_ONLY;

    case 'off':
    case 'disable':
    case 'full':
    case 'full-mode':
    case 'danger-full-access':
    case 'danger':
    case 'unsafe':
    case 'yolo':
      return SandboxMode.DANGER_FULL_ACCESS;

    case 'workspace-write':
    case 'workspace':
    case 'default':
    case 'ww':
    case 'normal':
      return SandboxMode.WORKSPACE_WRITE;

    default:
      return null;
  }
}

/** 三档的显示名 —— 菜单、回执、/stats 用同一份 */
export function sandboxModeName(mode: SandboxMode): string {
  switch (mode) {
    case SandboxMode.READ_ONLY: return L('只读', 'read-only');
    case SandboxMode.WORKSPACE_WRITE: return L('工作区可写', 'workspace-write');
    case SandboxMode.DANGER_FULL_ACCESS: return L('完全放开', 'full access');
    default: return String(mode);
  }
}

function describeMode(mode: SandboxMode): { label: string; detail: string } {
  const label = `${L('沙箱', 'Sandbox')}: ${sandboxModeName(mode)}`;
  switch (mode) {
    case SandboxMode.READ_ONLY:
      return { label, detail: L('只允许读 (readfile/grep/search 等). 任何 write/edit/shell 写命令直接拒.', 'Read only (readfile/grep/search…). Any write/edit/shell write is refused.') };
    case SandboxMode.WORKSPACE_WRITE:
      return { label, detail: L('可读可改 workspace 内文件, 出工作区路径需审批.', 'Read and edit inside the workspace; paths outside it need approval.') };
    case SandboxMode.DANGER_FULL_ACCESS:
      return { label, detail: L('全开, 不审批 (critical 命令 rm -rf / 仍拦).', 'Everything allowed, no approvals (critical commands like rm -rf / are still blocked).') };
  }
}

/* 旧 boolean 二档 → 新三档映射 (向 setSandboxEnabled 同步, 兼容 desktop UI 现有逻辑) */
function modeToLegacyEnabled(mode: SandboxMode): boolean {
  return mode === SandboxMode.READ_ONLY;
}

export async function handleSandboxCommand(actionArg: string | undefined, deps: SandboxDeps): Promise<void> {
  const action = (actionArg || '').toLowerCase();
  const currentMode = getCurrentSandboxMode();
  const alreadyText = (detail: string) => `${L('当前已是该模式', 'Already in this mode')} — ${detail}`;

  if (action) {
    if (action === 'status') {
      const desc = describeMode(currentMode);
      deps.logInfo(desc.label, desc.detail);
      return;
    }
    const next = parseSandboxAction(action);
    if (next === null) {
      deps.logInfo(L('沙箱', 'Sandbox'), L(`无效模式: "${actionArg}". 可用: read-only | workspace-write | danger-full-access | status (兼容旧别名 on/off)`,
        `Unknown mode "${actionArg}". Available: read-only | workspace-write | danger-full-access | status (old aliases on/off work too)`));
      return;
    }
    if (next === currentMode) {
      const desc = describeMode(next);
      deps.logInfo(desc.label, alreadyText(desc.detail));
      return;
    }
    setCurrentSandboxMode(next);
    // 持久化到 config (存盘 + OS 强制生效): read-only/workspace-write 开 OS 沙盒, danger 关。
    persistOsSandboxSelection(next as 'read-only' | 'workspace-write' | 'danger-full-access');
    /* 同步旧 boolean 二档 + desktop UI */
    const legacyEnabled = modeToLegacyEnabled(next);
    deps.setSandboxEnabled(legacyEnabled);
    await deps.syncSandboxMode(legacyEnabled);
    const desc = describeMode(next);
    deps.logInfo(desc.label, desc.detail);
    return;
  }

  /* 无参数 → 弹三选一 menu */
  try {
    const selected = await deps.promptSelect(L('沙箱模式', 'Sandbox mode'), [
      { label: sandboxModeName(SandboxMode.READ_ONLY), value: SandboxMode.READ_ONLY, description: L('只能读; 任何写文件 / 改文件 / 写命令直接拒绝', 'Read only; any write, edit or writing command is refused') },
      { label: sandboxModeName(SandboxMode.WORKSPACE_WRITE), value: SandboxMode.WORKSPACE_WRITE, description: L('默认 · 工作区内可读可改, 出工作区要审批', 'Default · read and edit inside the workspace; outside needs approval') },
      { label: sandboxModeName(SandboxMode.DANGER_FULL_ACCESS), value: SandboxMode.DANGER_FULL_ACCESS, description: L('不审批 (高危命令仍会拦) · 慎用', 'No approvals (high-risk commands still blocked) · use with care') },
    ], currentMode);

    const next = selected as SandboxMode;
    if (next === currentMode) {
      const desc = describeMode(next);
      deps.logInfo(desc.label, alreadyText(desc.detail));
      return;
    }
    setCurrentSandboxMode(next);
    // 持久化到 config (存盘 + OS 强制生效): read-only/workspace-write 开 OS 沙盒, danger 关。
    persistOsSandboxSelection(next as 'read-only' | 'workspace-write' | 'danger-full-access');
    const legacyEnabled = modeToLegacyEnabled(next);
    deps.setSandboxEnabled(legacyEnabled);
    await deps.syncSandboxMode(legacyEnabled);
    const desc = describeMode(next);
    deps.logInfo(desc.label, desc.detail);
  } catch (error: any) {
    if (error.message !== 'cancelled') deps.logInfo(L('切换沙箱失败', 'Sandbox selection failed'), error.message);
  }
}
