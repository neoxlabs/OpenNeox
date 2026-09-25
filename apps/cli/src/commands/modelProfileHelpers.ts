import { colors } from '../constants.js';
import { resolveBuiltinModelProfile, type ResolvedModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { loadConfig, saveConfig, type ProviderConfigEntry, type ProviderModelConfig } from '@neoxlabs/platform/utils/config.js';
import type { SelectionChoice } from '../cliTypes.js';

export interface ModelProfileStatusRecord {
  key: string;
  provider: ProviderConfigEntry;
  modelConfig: ProviderModelConfig;
  profile: ResolvedModelProfile;
  active: boolean;
  promptSource: string;
}

export function collectModelProfileStatusRecords(
  providers: ProviderConfigEntry[],
  activeProviderId: string,
  activeModel: string,
): ModelProfileStatusRecord[] {
  const records: ModelProfileStatusRecord[] = [];

  for (const provider of providers) {
    for (const modelConfig of provider.models || []) {
      const profile = resolveBuiltinModelProfile({
        protocol: provider.protocol,
        model: modelConfig.name,
        baseUrl: provider.baseUrl,
      });
      const active = provider.id === activeProviderId && modelConfig.name === activeModel;
      const promptSource = profile.prompt?.fullInstructions
        ? `full-md(${profile.prompt.fullInstructions.length})`
        : (profile.prompt?.style ?? 'layered');

      records.push({
        key: `${provider.id}::${modelConfig.name}`,
        provider,
        modelConfig,
        profile,
        active,
        promptSource,
      });
    }
  }

  records.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.provider.id !== b.provider.id) return a.provider.id.localeCompare(b.provider.id);
    return a.modelConfig.name.localeCompare(b.modelConfig.name);
  });

  return records;
}

export function formatModelProfileOverviewText(records: ModelProfileStatusRecord[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Model Profile 状态'));
  lines.push('');

  let currentProviderId = '';
  for (const record of records) {
    if (record.provider.id !== currentProviderId) {
      currentProviderId = record.provider.id;
      lines.push(colors.primary(`  ${record.provider.name} (${record.provider.id})`) + colors.dim(`  [${record.provider.protocol}]`));
    }

    const forceResponsesAPI = record.profile.transport?.openai?.forceResponsesAPI ?? false;
    const parallelToolCalls = record.profile.transport?.openai?.parallelToolCalls ?? true;
    const strictSSEDone = record.profile.transport?.openai?.strictSSEDone ?? false;
    const disabledTools = record.profile.toolset?.disabledTools ?? [];
    const activeMark = record.active ? '★' : ' ';

    lines.push(
      colors.dim(`    ${activeMark} ${record.modelConfig.name}`) +
      colors.info(` → ${record.profile.id}`) +
      colors.dim(` | prompt:${record.promptSource}`) +
      colors.dim(` | responses:${forceResponsesAPI ? 'on' : 'off'}`) +
      colors.dim(` | parallel:${parallelToolCalls ? 'on' : 'off'}`) +
      colors.dim(` | done:${strictSSEDone ? 'strict' : 'loose'}`) +
      (disabledTools.length > 0 ? colors.dim(` | disabled:${disabledTools.length}`) : '')
    );
  }

  lines.push('');
  lines.push(colors.dim('  Tip: 输入 /model-profile 后可选单个模型查看详细加载信息'));
  return lines.join('\n');
}

export function formatModelProfileDetailText(
  record: ModelProfileStatusRecord,
  totalTools: number,
): string {
  const forceResponsesAPI = record.profile.transport?.openai?.forceResponsesAPI ?? false;
  const parallelToolCalls = record.profile.transport?.openai?.parallelToolCalls ?? true;
  const strictSSEDone = record.profile.transport?.openai?.strictSSEDone ?? false;
  const requestTimeoutMs = record.profile.transport?.openai?.requestTimeoutMs;
  const streamRequestTimeoutMs = record.profile.transport?.openai?.streamRequestTimeoutMs;
  const sources = record.profile.sourceProfileIds.join(' -> ');

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Model Profile 详情（隐藏命令）'));
  lines.push('');
  lines.push(colors.dim('  Provider:      ') + colors.info(`${record.provider.name} (${record.provider.id}) [${record.provider.protocol}]`));
  lines.push(colors.dim('  Model:         ') + colors.info(record.modelConfig.name));
  lines.push(colors.dim('  Active:        ') + colors.info(record.active ? 'yes' : 'no'));
  lines.push(colors.dim('  Profile ID:    ') + colors.info(record.profile.id));
  lines.push(colors.dim('  Profile chain: ') + colors.info(sources));
  lines.push(colors.dim('  Prompt:        ') + colors.info(record.promptSource));
  lines.push(colors.dim('  Responses API: ') + colors.info(forceResponsesAPI ? 'enabled' : 'disabled'));
  lines.push(colors.dim('  Parallel tool: ') + colors.info(parallelToolCalls ? 'enabled' : 'disabled'));
  lines.push(colors.dim('  SSE done mode: ') + colors.info(strictSSEDone ? 'strict' : 'loose'));
  if (requestTimeoutMs !== undefined) lines.push(colors.dim('  Req timeout:   ') + colors.info(`${requestTimeoutMs}ms`));
  if (streamRequestTimeoutMs !== undefined) lines.push(colors.dim('  Stream timeout:') + colors.info(` ${streamRequestTimeoutMs}ms`));

  const profileDisabled = record.profile.toolset?.disabledTools ?? [];
  const cfgOverride = loadConfig().toolsetOverrides?.[record.profile.id];
  const effectiveDisabled = cfgOverride ?? profileDisabled;
  const availableCount = totalTools - effectiveDisabled.length;

  lines.push(colors.dim('  Tools total:   ') + colors.info(`${totalTools}`));
  lines.push(colors.dim('  Tools avail:   ') + colors.info(`${availableCount}`));
  if (effectiveDisabled.length > 0) {
    lines.push(colors.dim('  Disabled tools:') + colors.info(` ${effectiveDisabled.join(', ')}`));
    lines.push(colors.dim('  Disable source:') + colors.info(cfgOverride ? ' config override' : ' profile default'));
  } else {
    lines.push(colors.dim('  Disabled tools:') + colors.info(' none'));
  }

  const reasoning = record.modelConfig.reasoning;
  if (reasoning) {
    lines.push(colors.dim('  Reasoning cfg: ') + colors.info(`effort=${reasoning.effort || 'default'}, summary=${reasoning.summary || 'default'}, verbosity=${reasoning.verbosity || 'default'}`));
  }

  return lines.join('\n');
}

export function formatModelProfileFallbackDetailText(
  label: string,
  profile: ResolvedModelProfile,
  totalTools: number,
): string {
  const profileDis = profile.toolset?.disabledTools ?? [];
  const cfgOvr = loadConfig().toolsetOverrides?.[profile.id];
  const effDis = cfgOvr ?? profileDis;
  const avail = totalTools - effDis.length;
  const lines = [
    '',
    colors.highlight('  Model Profile 详情'),
    '',
    colors.dim('  Model:         ') + colors.info(label),
    colors.dim('  Profile ID:    ') + colors.info(profile.id),
    colors.dim('  Profile chain: ') + colors.info(profile.sourceProfileIds.join(' -> ')),
    colors.dim('  Tools total:   ') + colors.info(`${totalTools}`),
    colors.dim('  Tools avail:   ') + colors.info(`${avail}`),
    colors.dim('  Disabled tools:') + colors.info(effDis.length > 0 ? ` ${effDis.join(', ')}` : ' none'),
    ...(cfgOvr ? [colors.dim('  Disable source:') + colors.info(' config override')] : []),
  ];
  return lines.join('\n');
}

interface HandleToolsetConfigFlowOptions {
  profile: ResolvedModelProfile;
  allToolNames: string[];
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
}

export async function handleToolsetConfigFlow(options: HandleToolsetConfigFlowOptions): Promise<void> {
  const profileId = options.profile.id;
  if (options.allToolNames.length === 0) {
    options.logInfo('Toolset config', 'No tools available.');
    return;
  }

  const config = loadConfig();
  const configOverride = config.toolsetOverrides?.[profileId];
  const initialDisabled = configOverride ?? options.profile.toolset?.disabledTools ?? [];
  const disabledSet = new Set(initialDisabled);

  while (true) {
    const choices: SelectionChoice[] = [
      { label: '✓ 保存并返回', value: '__save__', description: `当前禁用 ${disabledSet.size} 个工具` },
      { label: '✗ 取消', value: '__cancel__', description: '放弃更改' },
      ...options.allToolNames.map(name => ({
        label: `${disabledSet.has(name) ? '✗' : '✓'} ${name}`,
        value: name,
        description: disabledSet.has(name) ? '已禁用 — 选择以启用' : '已启用 — 选择以禁用',
      })),
    ];

    let picked: string;
    try {
      picked = await options.promptSelect(
        `Toolset 配置 — ${profileId}`,
        choices,
        undefined,
        '选择工具以 toggle 启用/禁用状态',
      );
    } catch (error: any) {
      if (error?.message === 'cancelled') return;
      throw error;
    }

    if (picked === '__cancel__') return;
    if (picked === '__save__') {
      const freshConfig = loadConfig();
      const overrides = freshConfig.toolsetOverrides ?? {};
      if (disabledSet.size > 0) {
        overrides[profileId] = [...disabledSet];
      } else {
        delete overrides[profileId];
      }
      if (Object.keys(overrides).length > 0) {
        freshConfig.toolsetOverrides = overrides;
      } else {
        delete freshConfig.toolsetOverrides;
      }
      saveConfig(freshConfig);
      options.logInfo('Toolset config', `已保存 profile "${profileId}" 的 toolset 配置（禁用 ${disabledSet.size} 个工具）`);
      return;
    }

    if (disabledSet.has(picked)) {
      disabledSet.delete(picked);
    } else {
      disabledSet.add(picked);
    }
  }
}
