import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { ResolvedModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { resolveBuiltinModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import type { SelectionChoice } from '../cliTypes.js';
import {
  collectModelProfileStatusRecords,
  formatModelProfileOverviewText,
  formatModelProfileDetailText,
  formatModelProfileFallbackDetailText,
  handleToolsetConfigFlow,
  type ModelProfileStatusRecord,
} from './modelProfileHelpers.js';

interface HandleModelProfileCommandFlowOptions {
  args: string[];
  providerId: string;
  model: string;
  providerSettings: ProviderConfigEntry;
  providers: ProviderConfigEntry[];
  toolsLength: number;
  toolNames: string[];
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
}

export async function handleModelProfileCommandFlow(
  options: HandleModelProfileCommandFlowOptions,
): Promise<void> {
  const records = collectModelProfileStatusRecords(options.providers, options.providerId, options.model);

  const action = (options.args[0] || '').toLowerCase();
  if (action === 'all') {
    if (records.length === 0) {
      options.logInfo('Model profile status', 'No providers/models configured yet.');
      return;
    }
    options.logInfo('Model profile status', formatModelProfileOverviewText(records));
    return;
  }
  if (action === 'current') {
    const current = records.find(r => r.active) || records[0];
    if (current) options.logInfo('Model profile detail', formatModelProfileDetailText(current, options.toolsLength));
    return;
  }

  const currentProfile = resolveBuiltinModelProfile({
    protocol: options.providerSettings.protocol,
    model: options.model,
    baseUrl: options.providerSettings.baseUrl,
  });
  const currentLabel = `${options.providerId} / ${options.model}`;
  const currentDisabledCount = (() => {
    const cfg = loadConfig();
    const override = cfg.toolsetOverrides?.[currentProfile.id];
    const disabled = override ?? currentProfile.toolset?.disabledTools ?? [];
    return disabled.length;
  })();

  const topChoices: SelectionChoice[] = [
    {
      label: `★ 当前模型 (${currentLabel})`,
      value: 'current',
      description: `Profile: ${currentProfile.id} | 禁用工具: ${currentDisabledCount}`,
    },
    {
      label: '全部模型列表',
      value: 'all',
      description: `共 ${records.length} 个模型，按 Provider 分组`,
    },
  ];

  let topSelected: string;
  try {
    topSelected = await options.promptSelect('Model Profile', topChoices, 'current');
  } catch (error: any) {
    if (error?.message === 'cancelled') return;
    throw error;
  }

  if (topSelected === 'current') {
    const currentRecord = records.find(r => r.active);
    await handleProfileActionFlow({
      label: currentLabel,
      profile: currentProfile,
      record: currentRecord,
      toolsLength: options.toolsLength,
      toolNames: options.toolNames,
      promptSelect: options.promptSelect,
      logInfo: options.logInfo,
    });
    return;
  }

  if (records.length === 0) {
    options.logInfo('Model profile status', 'No providers/models configured yet. Use /provider and /model add first.');
    return;
  }

  const modelChoices: SelectionChoice[] = records.map(record => {
    const disabledTools = record.profile.toolset?.disabledTools ?? [];
    return {
      label: `${record.active ? '★ ' : ''}${record.provider.id} / ${record.modelConfig.name}`,
      value: record.key,
      description: `${record.profile.id} | disabled:${disabledTools.length}`,
    };
  });

  let selectedKey: string;
  try {
    selectedKey = await options.promptSelect('选择模型', modelChoices, records.find(r => r.active)?.key);
  } catch (error: any) {
    if (error?.message === 'cancelled') return;
    throw error;
  }

  const target = records.find(r => r.key === selectedKey);
  if (!target) return;

  await handleProfileActionFlow({
    label: `${target.provider.id} / ${target.modelConfig.name}`,
    profile: target.profile,
    record: target,
    toolsLength: options.toolsLength,
    toolNames: options.toolNames,
    promptSelect: options.promptSelect,
    logInfo: options.logInfo,
  });
}

interface HandleProfileActionFlowOptions {
  label: string;
  profile: ResolvedModelProfile;
  record?: ModelProfileStatusRecord;
  toolsLength: number;
  toolNames: string[];
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
}

export async function handleProfileActionFlow(
  options: HandleProfileActionFlowOptions,
): Promise<void> {
  const actionChoices: SelectionChoice[] = [
    { label: '查看详情', value: 'detail', description: '显示 profile 详细加载信息' },
    { label: '配置 Toolset', value: 'toolset', description: '启用/禁用工具，保存到 config' },
  ];

  let actionSelected: string;
  try {
    actionSelected = await options.promptSelect(`${options.label} — 操作`, actionChoices, 'detail');
  } catch (error: any) {
    if (error?.message === 'cancelled') return;
    throw error;
  }

  if (actionSelected === 'detail') {
    if (options.record) {
      options.logInfo('Model profile detail', formatModelProfileDetailText(options.record, options.toolsLength));
    } else {
      options.logInfo(
        'Model profile detail',
        formatModelProfileFallbackDetailText(options.label, options.profile, options.toolsLength),
      );
    }
    return;
  }

  if (actionSelected === 'toolset') {
    await handleToolsetConfigFlow({
      profile: options.profile,
      allToolNames: options.toolNames,
      promptSelect: options.promptSelect,
      logInfo: options.logInfo,
    });
  }
}
