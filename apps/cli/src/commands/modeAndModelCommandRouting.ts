import { loadConfig, saveConfig, getConcurrencyProfile } from '@neoxlabs/platform/utils/config.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { t, formatMessage } from '../i18n/index.js';

/* 当前项用 isCurrent 标 (菜单统一画 ● + 绿色), 不再在 label 末尾拼 "  ✓" —— 那个 ✓ 会被拆进"值"一栏, 跟其它菜单长得不一样 */
type ModeHubChoice = { label: string; value: string; description?: string; isCurrent?: boolean };

const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

interface ModeAndModelCommandRoutingDeps {
  handleMode: (actionArg?: string) => Promise<void>;
  handleRun: (actionArg?: string) => Promise<void>;
  handleRunConfig: (subCommand?: string) => Promise<void>;
  handleProvider: (args: string[]) => Promise<void>;
  handleModel: (args: string[]) => Promise<void>;
  handleModelProfile: (args: string[]) => Promise<void>;
  promptSelect: (question: string, choices: ModeHubChoice[], def?: string) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  getActiveProvider?: () => ProviderConfigEntry | undefined;
  getActiveModel?: () => string | undefined;
  onProviderChanged?: () => void;
}

async function handleEffortCommand(deps: ModeAndModelCommandRoutingDeps, arg?: string): Promise<void> {
  const provider = deps.getActiveProvider?.();
  const model = deps.getActiveModel?.();
  if (!provider || !model) {
    deps.logInfo('Effort', t().modeCmd.noProviderBound);
    return;
  }
  const modelEntry = provider.models?.find(m => m.name === model);
  const current = (modelEntry?.reasoning?.effort ?? 'high') as EffortLevel;
  let target = (arg || '').toLowerCase() as EffortLevel;
  if (!EFFORT_LEVELS.includes(target)) {
    try {
      const m = t().modeCmd;
      target = (await deps.promptSelect(m.reasoningEffortTitle, [
        { label: m.effortMinimal, value: 'minimal', description: m.effortMinimalDesc },
        { label: m.effortLow,     value: 'low',     description: m.effortLowDesc },
        { label: m.effortMedium,  value: 'medium',  description: m.effortMediumDesc },
        { label: m.effortHigh,    value: 'high',    description: m.effortHighDesc },
        { label: m.effortXhigh,   value: 'xhigh',   description: m.effortXhighDesc },
        { label: m.effortMax,     value: 'max',     description: m.effortMaxDesc },
        { label: m.effortUltra,   value: 'ultra',   description: m.effortUltraDesc },
      ].map(c => ({ ...c, isCurrent: c.value === current })), current)) as EffortLevel;
    } catch (e: any) {
      if (e?.message !== 'cancelled') deps.logInfo('Effort', e?.message || 'cancelled');
      return;
    }
  }
  if (!EFFORT_LEVELS.includes(target)) return;
  if (current === target) {
    deps.logInfo('Effort', formatMessage(t().modeCmd.alreadySet, { v: target }));
    return;
  }
  /* 写到 provider config + 持久化 */
  const config = loadConfig();
  const providerCfg = config.providers?.[provider.id];
  if (!providerCfg) {
    deps.logInfo('Effort', 'Provider 不存在 (配置已变更, 重启 cli)');
    return;
  }
  /* 同上: 订阅模型不在本地 models 里, 这里给它补一条最小记录, 让 effort 存得下来。
   * (BYOK 场景照旧命中已有条目, 行为不变) */
  let mc = providerCfg.models?.find(m => m.name === model);
  if (!mc) {
    providerCfg.models = providerCfg.models ?? [];
    mc = { name: model } as NonNullable<typeof providerCfg.models>[number];
    providerCfg.models.push(mc);
  }
  mc.reasoning = { ...(mc.reasoning ?? {}), effort: target };
  mc.updatedAt = new Date().toISOString();
  saveConfig(config);
  deps.onProviderChanged?.();
  deps.logInfo(`Reasoning effort → ${target}`, `${provider.name} · ${model} (next chat 生效)`);
}

/** 并发档位: auto (组合+中并发) / low (单模型+并发1). 唯一暴露的 subagent/并发开关. */
async function handleConcurrencyProfile(deps: ModeAndModelCommandRoutingDeps, arg?: string): Promise<void> {
  const cur = getConcurrencyProfile();
  let target = (arg || '').toLowerCase();
  if (target !== 'auto' && target !== 'low') {
    try {
      const m = t().modeCmd;
      target = await deps.promptSelect(m.concurrencyTitle, [
        { label: m.concurrencyAuto, value: 'auto', description: m.concurrencyAutoDesc, isCurrent: cur === 'auto' },
        { label: m.concurrencyLow,  value: 'low',  description: m.concurrencyLowDesc,  isCurrent: cur === 'low' },
      ], cur);
    } catch (e: any) {
      if (e?.message !== 'cancelled') deps.logInfo(t().modeCmd.concurrencyTitle, e?.message || 'cancelled');
      return;
    }
  }
  if (target !== 'auto' && target !== 'low') return;
  if (cur === target) {
    deps.logInfo(t().modeCmd.concurrencyTitle, formatMessage(t().modeCmd.alreadySet, { v: target }));
    return;
  }
  const config = loadConfig();
  config.concurrencyProfile = target as 'auto' | 'low';
  saveConfig(config);
  deps.logInfo(`并发档位已设为 ${target}`, target === 'low'
    ? '单模型 + 并发 1 (下次对话生效)'
    : '组合 + 中并发 (下次对话生效)');
}

export async function handleModeAndModelCommandRouting(
  cmd: string,
  args: string[],
  deps: ModeAndModelCommandRoutingDeps,
): Promise<boolean> {
  switch (cmd) {
    case '/mode': {
      // /mode 是运行设置入口: 交互方式 (agent/ask) + 运行架构 (agentic/assistant) + 架构配置
      const a = (args[0] || '').toLowerCase();
      // 快捷直达
      if (a === 'agent' || a === 'ask' || a === 'status') {
        await deps.handleMode(args[0]);
        return true;
      }
      if (a === 'run' || a === 'arch' || a === 'architecture') {
        await deps.handleRun(args[1]);
        return true;
      }
      if (a === 'config' || a === 'runconfig') {
        await deps.handleRunConfig(args[1]);
        return true;
      }
      // 并发档位快捷直达: /mode auto | /mode low | /mode concurrency
      if (a === 'auto' || a === 'low') {
        await handleConcurrencyProfile(deps, a);
        return true;
      }
      if (a === 'concurrency' || a === 'speed') {
        await handleConcurrencyProfile(deps);
        return true;
      }
      // 无参/未知 → hub 菜单 (agent/ask 一步直达, 运行架构/并发档位进阶)
      try {
        const profile = getConcurrencyProfile();
        const m = t().modeCmd;
        const choice = await deps.promptSelect(m.runSettingsTitle, [
          { label: m.agentLabel, value: 'agent', description: m.agentDesc },
          { label: m.askLabel, value: 'ask', description: m.askDesc },
          { label: `${m.concurrencyEntry} — ${profile}`, value: 'concurrency', description: m.concurrencyEntryDesc },
          { label: m.runArchEntry, value: 'run', description: m.runArchEntryDesc },
          { label: m.archConfigEntry, value: 'config', description: m.archConfigEntryDesc },
        ]);
        if (choice === 'agent' || choice === 'ask') await deps.handleMode(choice);
        else if (choice === 'concurrency') await handleConcurrencyProfile(deps);
        else if (choice === 'run') await deps.handleRun(undefined);
        else if (choice === 'config') await deps.handleRunConfig(undefined);
      } catch (e: any) {
        if (e?.message !== 'cancelled') deps.logInfo('Mode', e?.message || 'cancelled');
      }
      return true;
    }
    case '/run':  // 隐藏别名: 等价 /mode run
      await deps.handleRun(args[0]);
      return true;
    case '/runconfig': {  // 隐藏别名: 等价 /mode config
      const subCmd = (args[0] || '').toLowerCase();
      await deps.handleRunConfig(subCmd || undefined);
      return true;
    }
    case '/provider':
      await deps.handleProvider(args);
      return true;
    case '/model':
      await deps.handleModel(args);
      return true;
    case '/model-profile':
      await deps.handleModelProfile(args);
      return true;
    case '/effort':
      await handleEffortCommand(deps, args[0]);
      return true;
    default:
      return false;
  }
}
