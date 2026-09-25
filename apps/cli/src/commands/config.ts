/**
 * Config Command Handlers
 * Handles configuration-related CLI commands
 */

import * as fs from 'fs';
import { colors } from '../constants.js';
import { CONFIG_FILE, saveConfig, type ApprovalMode, type NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import type { SelectionChoice } from '../cliTypes.js';
import { cliPrintln } from '../utils/output.js';
import { getLanguage } from '../i18n/index.js';

const L = (zh: string, en: string): string => {
  try { return getLanguage() === 'zh' ? zh : en; } catch { return zh; }
};

function outputToUI(ctx: { outputLines?: (lines: string[]) => void }, lines: string[]): void {
  if (ctx.outputLines) {
    ctx.outputLines(lines);
  } else {
    lines.forEach(line => cliPrintln(line));
  }
}

/**
 * Config command context
 */
export interface ConfigCommandContext {
  approvalMode: ApprovalMode;
  userConfig: NeoxConfig;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  cleanup: () => Promise<void>;
  setApprovalMode: (
    mode: ApprovalMode,
    options?: {
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: {
        acknowledgeNoApproval: true;
        acknowledgeHighRiskExecution: true;
      };
    }
  ) => void | Promise<void>;
  getScopedApprovalMode: (scopeKey: string) => ApprovalMode | undefined;
  updateConfig: (config: NeoxConfig) => void;
  outputLines?: (lines: string[]) => void;
}

const DANGEROUS_MODE_CONFIRMATION = {
  acknowledgeNoApproval: true,
  acknowledgeHighRiskExecution: true,
} as const;

const KNOWN_AGENT_APPROVAL_SCOPES = [
  'singleagent',
  'mainagent',
  'main',
  'worker',
  'scout',
  'verifier',
  'compressor',
] as const;

function normalizeScopeKey(value: string): string {
  return value.trim().toLowerCase();
}

function formatScopeLabel(scopeKey: string): string {
  const normalized = normalizeScopeKey(scopeKey);
  const labelMap: Record<string, string> = {
    agenticagent: 'AgenticAgent',
    mainagent: 'MainAgent',
    main: 'Main',
    worker: 'Worker',
    scout: 'Scout',
    verifier: 'Verifier',
    compressor: 'Compressor',
  };
  return labelMap[normalized] || scopeKey;
}

function parseApprovalMode(value: string | undefined): ApprovalMode | null {
  const normalized = (value || '').trim().toLowerCase();
  /* yolo 是桌面端术语, 用户习惯了, 这里当 dangerous 的 alias 接 */
  if (normalized === 'yolo') return 'dangerous';
  return normalized === 'auto' || normalized === 'manual' || normalized === 'dangerous'
    ? normalized
    : null;
}

async function selectApprovalMode(
  ctx: ConfigCommandContext,
  defaultMode: ApprovalMode,
  includeInherit: boolean
): Promise<ApprovalMode | 'inherit'> {
  const choices: SelectionChoice[] = [
    {
      label: L('auto (推荐)', 'auto (recommended)'),
      value: 'auto',
      description: L('读工具自动放行 · 写/执行工具弹审批 · 勾 "Always Allow" 可记忆',
                     'Read tools run freely · write/execute tools ask first · "Always Allow" is remembered'),
    },
    {
      label: 'manual',
      value: 'manual',
      description: L('所有工具运行前手动确认 (适合敏感项目)',
                     'Confirm every tool before it runs (good for sensitive projects)'),
    },
    {
      label: 'yolo',
      value: 'dangerous',
      description: L('所有工具自动执行 · 零审批 · 跟桌面端 yolo 同 (慎用)',
                     'Every tool runs automatically · no approvals at all · same as yolo on desktop (use with care)'),
    },
  ];

  if (includeInherit) {
    choices.push({
      label: 'inherit global',
      value: 'inherit',
      description: L('移除该 Agent 覆盖，跟随全局设置', 'Drop this agent’s override and follow the global setting'),
    });
  }

  return ctx.promptSelect(
    '审批模式',
    choices,
    defaultMode,
  ) as Promise<ApprovalMode | 'inherit'>;
}

function updateScopedApprovalConfig(
  config: NeoxConfig,
  scopeKey: string,
  mode: ApprovalMode | 'inherit'
): NeoxConfig {
  const normalizedScope = normalizeScopeKey(scopeKey);
  const nextScopes = { ...(config.agentApprovalScopes || {}) };

  if (mode === 'inherit') {
    delete nextScopes[normalizedScope];
  } else {
    nextScopes[normalizedScope] = mode;
  }

  if (Object.keys(nextScopes).length === 0) {
    const { agentApprovalScopes: _drop, ...rest } = config;
    return rest;
  }

  return {
    ...config,
    agentApprovalScopes: nextScopes,
  };
}

async function confirmDangerousModeSwitch(
  ctx: ConfigCommandContext,
  target: 'global' | 'agent',
  scopeKey: string,
): Promise<boolean> {
  const scopeLabel = target === 'global'
    ? L('全局', 'global')
    : `Agent ${formatScopeLabel(scopeKey)}`;
  try {
    const choice = await ctx.promptSelect(
      L(`⚠ yolo 模式 (${scopeLabel}) — 所有工具自动执行, 零审批`,
        `⚠ yolo mode (${scopeLabel}) — every tool runs automatically, with no approvals`),
      [
        {
          label: L('取消', 'Cancel'),
          value: 'cancel',
          description: L('保持当前模式 (推荐, 想反悔随时改回)',
                         'Keep the current mode (recommended — you can always change it later)'),
        },
        {
          label: L('我懂, 开 yolo', 'I understand, enable yolo'),
          value: 'confirm',
          description: L('高风险命令 (rm -rf / sudo / curl|sh) 也会自动跑, 出事自担',
                         'High-risk commands (rm -rf / sudo / curl|sh) will run automatically too — this is on you'),
        },
      ],
      'cancel',
      L('按 ↑↓ 选, Enter 确认; ESC 取消', '↑↓ to choose, Enter to confirm, ESC to cancel'),
    );
    return choice === 'confirm';
  } catch {
    /* promptSelect 抛 cancelled — 当作取消 */
    return false;
  }
}

async function confirmConfigClear(ctx: ConfigCommandContext): Promise<boolean> {
  try {
    const choice = await ctx.promptSelect(
      L('⚠ 清除配置 — 删除所有 provider / API key 设置',
        '⚠ Clear config — deletes every provider and API key setting'),
      [
        {
          label: L('取消', 'Cancel'),
          value: 'cancel',
          description: L('保持当前配置不变 (推荐)', 'Leave the current config untouched (recommended)'),
        },
        {
          label: L('确认清除', 'Yes, clear it'),
          value: 'confirm',
          description: L('当前配置会备份后重置, 需重启 CLI 重新配置',
                         'Your config is backed up then reset; you will need to restart the CLI and set it up again'),
        },
      ],
      'cancel',
      L('按 ↑↓ 选, Enter 确认; ESC 取消', '↑↓ to choose, Enter to confirm, ESC to cancel'),
    );
    return choice === 'confirm';
  } catch {
    /* promptSelect 抛 cancelled — 当作取消 */
    return false;
  }
}

/**
 * Handle /config-clear command
 */
export async function handleConfigClearCommand(
  ctx: ConfigCommandContext
): Promise<void> {
  outputToUI(ctx, [
    '',
    colors.warning('  ⚠  This will delete your configuration file and reset all settings.'),
    colors.dim('     You will need to reconfigure providers and API keys.'),
    '',
  ]);

  const confirmed = await confirmConfigClear(ctx);

  if (!confirmed) {
    outputToUI(ctx, ['', colors.info('  Configuration clear cancelled.'), '']);
    return;
  }

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      /* 不直接 unlink — 误点不可逆会擦掉所有 provider/API key. 改 rename 成 .bak (覆盖旧 .bak),
       * 误操作后还能手动恢复. */
      const backupFile = `${CONFIG_FILE}.bak`;
      fs.renameSync(CONFIG_FILE, backupFile);
      outputToUI(ctx, [
        '',
        colors.success('  ✓ Configuration cleared (已备份原配置, 可手动恢复).'),
        '',
        colors.info('  Please restart the CLI to reconfigure.'),
        '',
      ]);

      // Exit the CLI
      await ctx.cleanup();
      process.exit(0);
    } else {
      outputToUI(ctx, ['', colors.info('  No configuration file found.'), '']);
    }
  } catch (error: any) {
    outputToUI(ctx, [
      '',
      colors.error('  ✗ Failed to clear configuration file.'),
      colors.dim(`    ${error.message}`),
      '',
    ]);
  }
}

/**
 * Handle /approval command
 */
export async function handleApprovalCommand(
  ctx: ConfigCommandContext,
  args: string[] = []
): Promise<void> {
  const instructions = [
    'Usage:',
    '/approval auto|manual|yolo',
    '/approval global auto|manual|yolo',
    '/approval agent <scope> auto|manual|yolo|inherit',
  ].join(' ');

  let target: 'global' | 'agent' = 'global';
  let scopeKey = '';
  let selectedMode: ApprovalMode | 'inherit' | null = null;

  const first = (args[0] || '').toLowerCase();

  if (args.length > 0) {
    if (first === 'global') {
      selectedMode = parseApprovalMode(args[1]);
      if (!selectedMode) {
        ctx.logInfo('无效参数', instructions);
        return;
      }
    } else if (first === 'agent') {
      scopeKey = normalizeScopeKey(args[1] || '');
      const rawMode = (args[2] || '').toLowerCase();
      if (!scopeKey || !(rawMode === 'inherit' || parseApprovalMode(rawMode))) {
        ctx.logInfo('无效参数', instructions);
        return;
      }
      target = 'agent';
      selectedMode = rawMode === 'inherit' ? 'inherit' : parseApprovalMode(rawMode);
    } else {
      const directGlobalMode = parseApprovalMode(first);
      if (directGlobalMode) {
        selectedMode = directGlobalMode;
      } else {
        scopeKey = normalizeScopeKey(args[0]);
        const rawMode = (args[1] || '').toLowerCase();
        if (!scopeKey || !(rawMode === 'inherit' || parseApprovalMode(rawMode))) {
          ctx.logInfo('无效参数', instructions);
          return;
        }
        target = 'agent';
        selectedMode = rawMode === 'inherit' ? 'inherit' : parseApprovalMode(rawMode);
      }
    }
  } else {
    try {
      const overriddenAgents = KNOWN_AGENT_APPROVAL_SCOPES.filter((s) => !!ctx.getScopedApprovalMode(s));
      const hasOverrides = overriddenAgents.length > 0;
      /* 没任何 agent override → 直接进模式选择, 跳掉"范围"中间步. */
      if (!hasOverrides) {
        selectedMode = await selectApprovalMode(ctx, ctx.approvalMode, false);
      } else {
        /* 有 override 才显两层: 全局 / 高级 (per-agent), 不再无条件列 7 个 */
        const targetChoice = await ctx.promptSelect(
          L('审批设置', 'Approval settings'),
          [
            {
              label: 'Global (Recommended)',
              value: 'global',
              description: L(`全局模式 (当前: ${ctx.approvalMode}) — 多数场景只需这一项`,
                             `Global mode (currently: ${ctx.approvalMode}) — this is all most people need`),
            },
            {
              label: L(`高级: per-agent 覆盖 (${overriddenAgents.length} 项已覆盖)`,
                       `Advanced: per-agent overrides (${overriddenAgents.length} set)`),
              value: 'advanced',
              description: L('为单个 sub-agent (worker/scout/verifier...) 单独设, 不动全局',
                             'Set one sub-agent (worker/scout/verifier…) on its own, leaving the global setting alone'),
            },
          ],
          'global',
          L('按 ↑↓ 选择, Enter 确认', '↑↓ to choose, Enter to confirm'),
        );
        if (targetChoice === 'advanced') {
          const agentChoice = await ctx.promptSelect(
            L('per-agent 审批模式覆盖', 'Per-agent approval overrides'),
            KNOWN_AGENT_APPROVAL_SCOPES.map((scope) => {
              const current = ctx.getScopedApprovalMode(scope);
              return {
                label: `Agent: ${formatScopeLabel(scope)}`,
                value: `agent:${scope}`,
                description: current
                  ? L(`当前覆盖: ${current}`, `overridden: ${current}`)
                  : L(`inherit (跟全局 ${ctx.approvalMode})`, `inherit (follows global: ${ctx.approvalMode})`),
              };
            }),
            undefined,
            L('按 ↑↓ 选择 agent, Enter 进入模式选择', '↑↓ to pick an agent, Enter to choose its mode'),
          );
          target = 'agent';
          scopeKey = normalizeScopeKey(agentChoice.slice('agent:'.length));
          const currentScoped = ctx.getScopedApprovalMode(scopeKey) || ctx.approvalMode;
          selectedMode = await selectApprovalMode(ctx, currentScoped, true);
        } else {
          selectedMode = await selectApprovalMode(ctx, ctx.approvalMode, false);
        }
      }
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('审批模式切换失败', error?.message);
      }
      return;
    }
  }

  if (!selectedMode) {
    ctx.logInfo('审批模式切换失败', '未选择模式');
    return;
  }

  if (target === 'global') {
    if (ctx.approvalMode === selectedMode) {
      ctx.logInfo('审批模式未变化', `全局仍为 ${selectedMode}`);
      return;
    }

    if (selectedMode === 'dangerous') {
      const confirmed = await confirmDangerousModeSwitch(ctx, 'global', '');
      if (!confirmed) {
        ctx.logInfo('审批模式未变化', '已取消切换 yolo 模式');
        return;
      }
    }

    try {
      await ctx.setApprovalMode(selectedMode as ApprovalMode, {
        scope: 'global',
        dangerousConfirmation: selectedMode === 'dangerous' ? DANGEROUS_MODE_CONFIRMATION : undefined,
      });
    } catch (err: any) {
      /* daemon sync 失败 — config 还没写, CLI in-memory 也已回滚 (applyGlobalApprovalMode 先走了
       * 但 daemon 没接住, 重启 daemon 时会从 config 读旧值). 显错误而不是说"已切换 yolo"骗人. */
      ctx.logInfo('审批模式切换失败', err?.message || String(err));
      return;
    }
    const updatedConfig = {
      ...ctx.userConfig,
      approvalMode: selectedMode as ApprovalMode,
      agentApprovalMode: selectedMode as ApprovalMode,
    };
    ctx.updateConfig(updatedConfig);
    saveConfig(updatedConfig);

    const message =
      selectedMode === 'manual'
        ? '已切换为 manual 模式: 除只读工具外需手动确认.'
        : selectedMode === 'dangerous'
          ? '已切换为 yolo 模式: 所有工具自动执行, 无任何审批.'
          : '已切换为 auto 模式: 白名单只读工具自动, 其它操作需确认.';
    ctx.logInfo('全局审批模式已更新 (已同步 daemon)', message);
    return;
  }

  const currentScoped = ctx.getScopedApprovalMode(scopeKey);
  if (selectedMode !== 'inherit' && currentScoped === selectedMode) {
    ctx.logInfo('审批模式未变化', `${formatScopeLabel(scopeKey)} 仍为 ${selectedMode}`);
    return;
  }
  if (selectedMode === 'inherit' && !currentScoped) {
    ctx.logInfo('审批模式未变化', `${formatScopeLabel(scopeKey)} 已继承全局模式`);
    return;
  }

  if (selectedMode === 'inherit') {
    if (ctx.approvalMode === 'dangerous') {
      const confirmed = await confirmDangerousModeSwitch(ctx, 'agent', scopeKey);
      if (!confirmed) {
        ctx.logInfo('审批模式未变化', `已取消 ${formatScopeLabel(scopeKey)} yolo 继承`);
        return;
      }
    }

    const nextConfig = updateScopedApprovalConfig(ctx.userConfig, scopeKey, selectedMode);
    ctx.updateConfig(nextConfig);
    saveConfig(nextConfig);

    try {
      await ctx.setApprovalMode(ctx.approvalMode, {
        scope: 'agent',
        scopeKey,
        inherit: true,
        dangerousConfirmation: ctx.approvalMode === 'dangerous' ? DANGEROUS_MODE_CONFIRMATION : undefined,
      });
    } catch (err: any) {
      ctx.logInfo('Agent 审批模式切换失败', err?.message || String(err));
      return;
    }
    ctx.logInfo(
      'Agent 审批模式已更新 (已同步 daemon)',
      `${formatScopeLabel(scopeKey)} 已改为继承全局模式 (${ctx.approvalMode})`,
    );
    return;
  }

  if (selectedMode === 'dangerous') {
    const confirmed = await confirmDangerousModeSwitch(ctx, 'agent', scopeKey);
    if (!confirmed) {
      ctx.logInfo('审批模式未变化', `已取消 ${formatScopeLabel(scopeKey)} yolo 切换`);
      return;
    }
  }

  const nextConfig = updateScopedApprovalConfig(ctx.userConfig, scopeKey, selectedMode);
  ctx.updateConfig(nextConfig);
  saveConfig(nextConfig);

  try {
    await ctx.setApprovalMode(selectedMode as ApprovalMode, {
      scope: 'agent',
      scopeKey,
      inherit: false,
      dangerousConfirmation: selectedMode === 'dangerous' ? DANGEROUS_MODE_CONFIRMATION : undefined,
    });
  } catch (err: any) {
    ctx.logInfo('Agent 审批模式切换失败', err?.message || String(err));
    return;
  }
  ctx.logInfo('Agent 审批模式已更新 (已同步 daemon)', `${formatScopeLabel(scopeKey)} → ${selectedMode}`);
}
