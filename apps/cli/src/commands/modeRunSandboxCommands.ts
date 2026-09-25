import { ModeFactory, type AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';
import {
  SandboxMode,
  getCurrentSandboxMode,
  setCurrentSandboxMode,
} from '@neoxlabs/core/runtime/sandboxModeApi.js';
import { persistOsSandboxSelection } from '@neoxlabs/core/tools/shell/osSandbox.js';
import type { InteractionMode } from '../cliTypes.js';

type Choice = { label: string; value: string; description: string };
type PromptSelect = (question: string, choices: Choice[], defaultValue?: string) => Promise<string>;
type LogInfo = (message: string, details?: string) => void;

interface ModeDeps {
  getInteractionMode: () => InteractionMode;
  setInteractionMode: (mode: InteractionMode) => void;
  promptSelect: PromptSelect;
  logInfo: LogInfo;
}

export async function handleModeCommand(actionArg: string | undefined, deps: ModeDeps): Promise<void> {
  const desired = (actionArg || '').toLowerCase();
  if (desired && desired !== 'status') {
    if (desired !== 'agent' && desired !== 'ask') {
      deps.logInfo('无效的模式', '可用模式: agent, ask');
      return;
    }
    if (deps.getInteractionMode() === desired) {
      deps.logInfo('模式未变化', `仍为 ${desired}`);
      return;
    }
    deps.setInteractionMode(desired as InteractionMode);
    deps.logInfo('交互模式已更新', desired === 'ask'
      ? '将以更对话的方式回答，并减少工具调用。'
      : '恢复默认的 Agent 模式，可自动调用工具。');
    return;
  }
  try {
    const selected = await deps.promptSelect('交互模式', [
      { label: 'Agent', value: 'agent', description: '智能体自动使用工具，适合代码任务' },
      { label: 'Ask', value: 'ask', description: '仅回答问题，尽量避免工具调用' },
    ], deps.getInteractionMode());
    if (deps.getInteractionMode() !== selected) {
      deps.setInteractionMode(selected as InteractionMode);
      deps.logInfo('交互模式已更新', selected === 'ask'
        ? '将以更对话的方式回答，并减少工具调用。'
        : '恢复默认的 Agent 模式，可自动调用工具。');
    } else {
      deps.logInfo('模式', `当前模式: ${selected}`);
    }
  } catch (error: any) {
    if (error.message !== 'cancelled') deps.logInfo('Mode selection failed', error.message);
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
  deps.logInfo('运行模式: [A] Agentic', ModeFactory.getModeDescription('agentic'));
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

function describeMode(mode: SandboxMode): { label: string; detail: string } {
  switch (mode) {
    case SandboxMode.READ_ONLY:
      return { label: 'Sandbox: read-only', detail: '只允许读 (readfile/grep/search 等). 任何 write/edit/shell 写命令直接拒.' };
    case SandboxMode.WORKSPACE_WRITE:
      return { label: 'Sandbox: workspace-write (default)', detail: '可读可改 workspace 内文件, 出工作区路径需审批.' };
    case SandboxMode.DANGER_FULL_ACCESS:
      return { label: 'Sandbox: danger-full-access', detail: '全开, 不审批 (critical 命令 rm -rf / 仍拦).' };
  }
}

/* 旧 boolean 二档 → 新三档映射 (向 setSandboxEnabled 同步, 兼容 desktop UI 现有逻辑) */
function modeToLegacyEnabled(mode: SandboxMode): boolean {
  return mode === SandboxMode.READ_ONLY;
}

export async function handleSandboxCommand(actionArg: string | undefined, deps: SandboxDeps): Promise<void> {
  const action = (actionArg || '').toLowerCase();
  const currentMode = getCurrentSandboxMode();

  if (action) {
    if (action === 'status') {
      const desc = describeMode(currentMode);
      deps.logInfo(desc.label, desc.detail);
      return;
    }
    const next = parseSandboxAction(action);
    if (next === null) {
      deps.logInfo('Sandbox', `无效模式: "${actionArg}". 可用: read-only | workspace-write | danger-full-access | status (兼容旧别名 on/off)`);
      return;
    }
    if (next === currentMode) {
      const desc = describeMode(next);
      deps.logInfo(desc.label, `当前已是该模式 — ${desc.detail}`);
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
    const selected = await deps.promptSelect('沙箱模式', [
      { label: '只读',       value: SandboxMode.READ_ONLY,          description: '只能读; 任何写文件 / 改文件 / 写命令直接拒绝' },
      { label: '工作区可写', value: SandboxMode.WORKSPACE_WRITE,    description: '默认 · 工作区内可读可改, 出工作区要审批' },
      { label: '完全放开',   value: SandboxMode.DANGER_FULL_ACCESS, description: '不审批 (高危命令仍会拦) · 慎用' },
    ], currentMode);

    const next = selected as SandboxMode;
    if (next === currentMode) {
      const desc = describeMode(next);
      deps.logInfo(desc.label, `当前已是该模式 — ${desc.detail}`);
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
    if (error.message !== 'cancelled') deps.logInfo('Sandbox selection failed', error.message);
  }
}
