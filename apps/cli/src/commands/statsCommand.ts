import { isNeoxManagedApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { InteractionMode } from '../cliTypes.js';
import { getCliEdition } from '../edition/index.js';
import { getLanguage } from '../i18n/index.js';
import { LABEL_COLS, panelRow, panelTitle } from '../utils/panelRows.js';
import chalk from 'chalk';
import { NeoxTheme } from '../ink/theme.js';
import { getCurrentSandboxMode } from '@neoxlabs/core/runtime/sandboxModeApi.js';
import { sandboxModeName } from './modeRunSandboxCommands.js';
import { formatPrefixStabilityLine, readPrefixStabilityStats } from '@neoxlabs/core';

interface StatsDeps {
  workDir: string;
  providerDisplayName: string;
  model: string;
  providerSettings?: ProviderConfigEntry;
  memoryLength: number;
  toolsLength: number;
  sessionRequests: number;
  interactionMode: InteractionMode;
  sandboxEnabled: boolean;
  approvalMode: string;
  thinkingMode?: string;
  fetchSessionInfo: () => Promise<{ sessionId?: string; turnCount?: number; messageCount?: number } | null>;
  uiController: { setCommandOutputLines?: (lines: string[]) => void; printCommandOutput?: (line: string) => void } | null;
}

interface StatsMainAdapterDeps {
  workDir: string;
  providerDisplayName: string;
  model: string;
  providerSettings?: ProviderConfigEntry;
  memoryLength: number;
  toolsLength: number;
  sessionRequests: number;
  interactionMode: InteractionMode;
  sandboxEnabled: boolean;
  approvalMode: string;
  thinkingMode?: string;
  sdkClient: { getSessionInfo: (sessionId: string) => Promise<any> } | null;
  getSdkSessionId: () => string;
  uiController: StatsDeps['uiController'];
}

export async function handleStatsCommand(deps: StatsDeps): Promise<void> {
  const workDirShort = deps.workDir.replace(process.env.HOME || '', '~');
  const sessionInfo = await deps.fetchSessionInfo();
  const maskApiKey = (key: string): string => (!key || key.length < 8) ? '***' : `${key.slice(0, 4)}...${key.slice(-4)}`;

  const zh = getLanguage() === 'zh';
  const L = (z: string, e: string) => (zh ? z : e);
  const dot = colors.dim(' · ');

  const messageCount = typeof sessionInfo?.messageCount === 'number'
    ? sessionInfo.messageCount
    : deps.memoryLength;

  /* 目录太长时砍中间留两头 —— 整行折到下一行会把标签列冲散 */
  const dirMax = Math.max(20, (process.stdout.columns || 80) - LABEL_COLS - 4);
  const dirShown = workDirShort.length > dirMax
    ? workDirShort.slice(0, 8) + '…' + workDirShort.slice(-(dirMax - 9))
    : workDirShort;
  const approvalName: Record<string, string> = {
    auto: L('自动 (写和执行前问)', 'auto (asks before writes)'),
    manual: L('每次都问', 'always ask'),
    /* 跟 /approval 菜单、底栏同一个名字: yolo (原来三处 dangerous / yolo / never ask 各叫各的) */
    dangerous: L('yolo (全部放行)', 'yolo (never asks)'),
  };

  const providerShort = deps.providerDisplayName.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '');
  const lines = [
    '',
    panelTitle(L('当前会话', 'Session'), sessionInfo?.sessionId),
    panelRow(L('模型', 'Model'), deps.model + colors.dim(` · ${providerShort}`)),
    panelRow(L('目录', 'Directory'), dirShown),
  ];

  if (deps.providerSettings && !isNeoxManagedApiKey(deps.providerSettings.apiKey)) {
    if (deps.providerSettings.baseUrl) lines.push(panelRow(L('地址', 'Endpoint'), colors.dim(deps.providerSettings.baseUrl)));
    if (deps.providerSettings.apiKey) lines.push(panelRow('API Key', colors.dim(maskApiKey(deps.providerSettings.apiKey))));
  }

  /* 账号 / 订阅段 — 商业版由账号插槽出 (email + plan + 订阅模型数量); 公开版只有本地 BYOK */
  try {
    const account = getCliEdition().account;
    lines.push(...(account ? account.statsLines() : [panelRow(L('账号', 'Account'), colors.dim(L('本地 · BYOK', 'Local · BYOK')))]));
  } catch (err: any) {
    lines.push(panelRow(L('账号', 'Account'), colors.dim(`${L('读取失败', 'unavailable')}: ${err?.message?.slice(0, 60) || err}`)));
  }

  const counts = [
    `${messageCount} ${L('条消息', 'messages')}`,
    ...(typeof sessionInfo?.turnCount === 'number' ? [`${sessionInfo.turnCount} ${L('轮', 'turns')}`] : []),
    `${deps.sessionRequests} ${L('次请求', 'requests')}`,
  ];
  lines.push(panelRow(L('本次', 'So far'), counts.join(dot)));

  /* PROMPT-07 前缀稳定看板 —— runtime worker 落盘的度量, 这里只读; 没有记录就不占一行 */
  const prefixStats = sessionInfo?.sessionId ? readPrefixStabilityStats(sessionInfo.sessionId) : null;
  const prefixLine = prefixStats ? formatPrefixStabilityLine(prefixStats, zh) : '';
  if (prefixLine) lines.push(panelRow(L('前缀', 'Prefix'), prefixLine));

  const approvalText = `${L('审批', 'approval')} ${approvalName[deps.approvalMode] ?? deps.approvalMode}`;
  const modes = [
    deps.interactionMode === 'agent' ? 'Agent' : L('Ask 纯对话', 'Ask'),
    deps.approvalMode === 'dangerous' ? chalk.hex(NeoxTheme.functional.error.startsWith('#') ? NeoxTheme.functional.error : '#E2706B')(approvalText) : approvalText,
    `${L('思考', 'thinking')} ${deps.thinkingMode !== 'disabled' ? L('开', 'on') : L('关', 'off')}`,
    /* 沙箱是三档 (只读 / 工作区可写 / 完全放开); sandboxEnabled 是旧二档布尔, 只有只读才算 true ——
     * 默认的「工作区可写」原来显示成「沙箱 关」, 跟 /sandbox 菜单对不上 */
    `${L('沙箱', 'sandbox')} ${(() => { try { return sandboxModeName(getCurrentSandboxMode()); } catch { return deps.sandboxEnabled ? L('开', 'on') : L('关', 'off'); } })()}`,
  ];
  lines.push(panelRow(L('模式', 'Mode'), modes.join(dot)));
  lines.push('');

  if (deps.uiController?.setCommandOutputLines) {
    deps.uiController.setCommandOutputLines(lines);
    return;
  }
  if (deps.uiController?.printCommandOutput) {
    for (const line of lines) deps.uiController.printCommandOutput(line);
    return;
  }
  for (const line of lines) cliPrintln(line);
}

export async function handleStatsCommandFromMain(
  deps: StatsMainAdapterDeps,
): Promise<void> {
  await handleStatsCommand({
    workDir: deps.workDir,
    providerDisplayName: deps.providerDisplayName,
    model: deps.model,
    providerSettings: deps.providerSettings,
    memoryLength: deps.memoryLength,
    toolsLength: deps.toolsLength,
    sessionRequests: deps.sessionRequests,
    interactionMode: deps.interactionMode,
    sandboxEnabled: deps.sandboxEnabled,
    approvalMode: deps.approvalMode,
    thinkingMode: deps.thinkingMode,
    fetchSessionInfo: async () =>
      deps.sdkClient ? await deps.sdkClient.getSessionInfo(deps.getSdkSessionId()).catch(() => null) : null,
    uiController: deps.uiController,
  });
}
