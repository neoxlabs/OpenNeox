/**
 * Provider Command Handlers
 * Handles all provider-related CLI commands
 */

import type { ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import type { ProviderCommandContext } from './providerTypes.js';
import { PROVIDER_BASE_URLS, PROTOCOL_LABELS } from '../constants.js';
import { formatBadges } from '../utils/index.js';
import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';
import { getModelSuggestionsByProtocol } from '@neoxlabs/core/models/protocolModels.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { t, formatMessage } from '../i18n/index.js';
import { setWizardHeader } from '../ink/wizardHeader.js';
import { getCliEdition } from '../edition/index.js';

/**
 * Show available providers list
 */
export function showProviderOptions(ctx: ProviderCommandContext): void {
  const providers = ctx.getProviders();
  if (providers.length === 0) {
    const account = getCliEdition().account;
    if (!account) {
      ctx.logInfo('还没有配置任何 provider', '用 /provider add 添加。');
    } else if (account.isLoggedIn()) {
      ctx.logInfo(
        '当前用的是 NeoxCloud 订阅通道',
        '这里列的是自带 API key (BYOK) 的 provider —— 你还没添加过。要加用 /provider add。',
      );
    } else {
      ctx.logInfo('还没有配置任何 provider', '用 /provider add 添加, 或用 /login 登录 NeoxCloud。');
    }
    return;
  }
  const defaultProvider = ctx.getDefaultProvider();
  const defaultId = defaultProvider?.id;
  const lines = providers.map((provider, index) => {
    const badges: string[] = [];
    if (provider.id === ctx.providerId) {
      badges.push('current');
    }
    if (provider.id === defaultId) {
      badges.push('default');
    }
    const protocolName = PROTOCOL_LABELS[provider.protocol] || 'OpenAI';
    const models = provider.models.length > 0
      ? provider.models.map(model => model.name).join(', ')
      : 'none';
    const baseUrl = provider.baseUrl || PROVIDER_BASE_URLS[provider.protocol];
    return [
      `${index + 1}. ${provider.name}${formatBadges(badges)}`,
      `     id: ${provider.id}`,
      `     protocol: ${protocolName}`,
      `     base url: ${baseUrl}`,
      `     models: ${models}`,
    ].join('\n');
  });
  const details = `${lines.join('\n\n')}\n\nCommands:\n` +
    '  /provider use <id>      switch provider\n' +
    '  /provider add           add provider\n' +
    '  /provider edit <id>     edit provider\n' +
    '  /provider remove <id>   remove provider\n' +
    '  /provider default <id>  set default provider';
  ctx.logInfo('Available providers', details);
}

/**
 * Apply provider change
 */
export async function applyProviderChange(
  ctx: ProviderCommandContext,
  providerId: string
): Promise<void> {
  if (!providerId) {
    showProviderOptions(ctx);
    return;
  }
  const target =
    ctx.getProvider(providerId) ||
    ctx.getProviders().find((entry) => entry.protocol === (providerId as ProviderProtocol));

  if (!target) {
    ctx.logInfo('Provider not found', `Unknown provider "${providerId}".`);
    return;
  }

  if (target.id === ctx.providerId) {
    ctx.logInfo('Provider unchanged', `${target.name} is already active.`);
    return;
  }

  try {
    const nextModel = ctx.resolveModel(target.id);
    if (!nextModel) {
      throw new Error(`Provider "${target.name}" does not have any models configured.`);
    }

    ctx.setLastSelectedModel(target.id, nextModel);
    ctx.setDefaultProvider(target.id);

    await ctx.applyProviderState({
      providerId: target.id,
      provider: target.protocol,
      model: nextModel,
      providerSettings: target,
    });

    ctx.updateProviderDisplay(ctx.getProviderDisplayName(), nextModel);
    ctx.logInfo(
      'Provider updated',
      `Provider: ${ctx.getProviderDisplayName()}\nModel: ${nextModel}`
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logInfo('Failed to switch provider', msg);
  }
}

/**
 * Format context window for display
 */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}K`;
  }
  return `${tokens}`;
}

/**
 * Get common model choices for a protocol
 * Dynamically generates model list from registry
 */
function getCommonModelsForProtocol(protocol: ProviderProtocol): Array<{
  label: string;
  value: string;
  description?: string;
}> {
  const suggestions = getModelSuggestionsByProtocol(protocol);

  cliLogger.debug('PROVIDER_ADD', 'Getting model suggestions', {
    protocol,
    count: suggestions.length,
  });

  return suggestions.slice(0, 20).map(modelId => {
    const model = modelRegistry.getModel(modelId);
    if (!model) {
      return {
        label: modelId,
        value: modelId,
        description: undefined,
      };
    }

    const contextInfo = formatContextWindow(model.maxInputTokens);
    const badges: string[] = [];
    if (model.supportsVision) badges.push('vision');
    if (model.supportsThinking) badges.push('thinking');

    const badgeStr = badges.length > 0 ? `${badges.join(' ')} ` : '';

    return {
      label: model.id,
      value: model.id,
      description: `${model.displayName} ${badgeStr}(${contextInfo} ctx)`,
    };
  });
}

/**
 * Handle /provider add command - Interactive 4-step flow
 * Step 1: Provider name and URL
 * Step 2: Select models
 * Step 3: API Key
 * Step 4: Save and confirm
 */
export async function handleProviderAddCommand(ctx: ProviderCommandContext): Promise<void> {
  const tr = t();
  /* 步骤进度画在底部向导页眉里 (见 ink/wizardHeader), 不进时间线; 时间线只留结果 */
  const stepHeader = (n: number, what: string, lines?: string[]) =>
    setWizardHeader({ title: tr.providerCmd.addTitle, step: `${n}/4 · ${what}`, lines });
  try {
    // ===== Step 1: Provider name and URL =====
    stepHeader(1, tr.providerCmd.step1Hint);

    const name = await ctx.promptText(tr.providerCmd.displayName, {
      allowEmpty: false,
      hint: tr.providerCmd.displayNameHint,
    });

    const protocol = await ctx.promptSelect(
      tr.providerCmd.protocolFormat,
      [
        { label: tr.providerCmd.protoOpenAIChat, value: 'openai' },
        { label: tr.providerCmd.protoOpenAIResponses, value: 'openai-responses' },
        { label: tr.providerCmd.protoKimi, value: 'kimi' },
        { label: 'DeepSeek — OpenAI 兼容', value: 'deepseek' },
        { label: 'Qwen (阿里云百炼) — OpenAI 兼容', value: 'qwen' },
        { label: 'MiniMax — OpenAI 兼容', value: 'minimax' },
        { label: tr.providerCmd.protoAnthropic, value: 'anthropic' },
        { label: tr.providerCmd.protoAnthropicOpenAI, value: 'anthropic-openai' },
        { label: tr.providerCmd.protoDoubao, value: 'doubao' },
        { label: tr.providerCmd.protoGemini, value: 'gemini' },
        { label: tr.providerCmd.protoGlm, value: 'glm' },
        { label: tr.providerCmd.protoGlmClaude, value: 'glm-claude' },
        { label: tr.providerCmd.protoKimiClaude, value: 'kimi-claude' },
      ],
      'anthropic'
    ) as ProviderProtocol;

    const defaultBase = PROVIDER_BASE_URLS[protocol];
    const baseUrl = await ctx.promptText('Base URL', {
      defaultValue: defaultBase,
      hint: tr.providerCmd.baseUrlHint,
    });

    // ===== Step 2: Select models =====
    stepHeader(2, tr.ui.selectDefaultModel);

    const allRegistryModels = modelRegistry.getAllModels().filter(model => !model.deprecated);
    const providerBrands = [...new Set(allRegistryModels.map(m => m.provider))];

    const BRAND_LABELS: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Claude (Anthropic)',
      gemini: 'Google Gemini',
      kimi: 'Kimi (Moonshot)',
      qwen: 'Qwen (阿里云百炼)',
      glm: 'GLM (智谱 AI)',
      deepseek: 'DeepSeek',
      minimax: 'MiniMax',
      doubao: '豆包 (Doubao)',
    };

    const categoryChoices = [
      { label: tr.providerCmd.categoryRecommended, value: '__recommended__' },
      { label: formatMessage(tr.providerCmd.categoryAll, { count: allRegistryModels.length }), value: '__all__' },
      ...providerBrands.map(brand => {
        const count = allRegistryModels.filter(m => m.provider === brand).length;
        return {
          label: `${BRAND_LABELS[brand] || brand} (${count})`,
          value: brand,
        };
      }),
      { label: tr.providerCmd.categoryCustom, value: '__custom__' },
    ];

    const selectedCategory = await ctx.promptSelect(
      tr.providerCmd.selectModelCategory,
      categoryChoices,
      '__recommended__'
    );

    const selectedModels: string[] = [];
    let defaultModelName = '';

    if (selectedCategory === '__custom__') {
      defaultModelName = await ctx.promptText(tr.providerCmd.enterModelName, { allowEmpty: false });
      selectedModels.push(defaultModelName);
    } else {
      // 根据分类获取模型列表
      let filteredModels: Array<{ label: string; value: string; description?: string }>;

      if (selectedCategory === '__recommended__') {
        filteredModels = getCommonModelsForProtocol(protocol);
      } else if (selectedCategory === '__all__') {
        filteredModels = allRegistryModels.map(m => {
          const contextInfo = formatContextWindow(m.maxInputTokens);
          const badges: string[] = [];
          if (m.supportsVision) badges.push('vision');
          if (m.supportsThinking) badges.push('thinking');
          const badgeStr = badges.length > 0 ? `${badges.join(' ')} ` : '';
          return {
            label: m.id,
            value: m.id,
            description: `${m.displayName} ${badgeStr}(${contextInfo} ctx) [${BRAND_LABELS[m.provider] || m.provider}]`,
          };
        });
      } else {
        // 特定品牌
        filteredModels = allRegistryModels
          .filter(m => m.provider === selectedCategory)
          .map(m => {
            const contextInfo = formatContextWindow(m.maxInputTokens);
            const badges: string[] = [];
            if (m.supportsVision) badges.push('vision');
            if (m.supportsThinking) badges.push('thinking');
            const badgeStr = badges.length > 0 ? `${badges.join(' ')} ` : '';
            return {
              label: `${m.id} — ${badgeStr}${contextInfo} ctx`,
              value: m.id,
            };
          });
      }

      if (filteredModels.length === 0) {
        defaultModelName = await ctx.promptText(tr.providerCmd.noRegistryModels, { allowEmpty: false });
      } else {
        const modelChoices = [
          ...filteredModels,
          { label: tr.providerCmd.customModelName, value: '__custom__' },
        ];

        const firstModel = await ctx.promptSelect(
          tr.providerCmd.selectDefaultModel,
          modelChoices,
          filteredModels[0]?.value
        );

        if (firstModel === '__custom__') {
          defaultModelName = await ctx.promptText(tr.providerCmd.enterModelName, { allowEmpty: false });
        } else {
          defaultModelName = firstModel;
        }
      }
      selectedModels.push(defaultModelName);
    }

    // Ask if want to add more models
    const addMore = await ctx.promptYesNo(tr.providerCmd.addMoreModels, false);
    if (addMore) {
      const moreModelsInput = await ctx.promptText(tr.providerCmd.enterMoreModels, {
        allowEmpty: true,
        hint: tr.providerCmd.enterMoreModelsHint,
      });
      if (moreModelsInput.trim()) {
        const additionalModels = moreModelsInput.split(',').map(m => m.trim()).filter(m => m);
        for (const m of additionalModels) {
          if (!selectedModels.includes(m)) {
            selectedModels.push(m);
          }
        }
      }
    }

    // ===== Step 3: API Key =====
    stepHeader(3, tr.providerCmd.apiKey);

    const apiKey = await ctx.promptText(tr.providerCmd.apiKey, {
      allowEmpty: false,
      hint: tr.providerCmd.apiKeyHint,
      password: true,
    });

    // ===== Step 4: Confirm and save =====

    const maskedKey = apiKey.length <= 4
      ? '*'.repeat(apiKey.length)
      : `${'*'.repeat(4)}${apiKey.slice(-4)}`;

    const summaryLines = [
      `${tr.providerCmd.summaryName}: ${name}`,
      `${tr.providerCmd.summaryProtocol}: ${PROTOCOL_LABELS[protocol]}`,
      `${tr.providerCmd.summaryBaseUrl}: ${baseUrl}`,
      `${tr.providerCmd.summaryApiKey}: ${maskedKey}  (${apiKey.length} 位)`,
      `${tr.providerCmd.summaryModels}: ${selectedModels.join(', ')}`,
    ];
    /* 默认模型跟"模型"清单同值时不再重复占一行 */
    if (!(selectedModels.length === 1 && selectedModels[0] === defaultModelName)) {
      summaryLines.push(`${tr.providerCmd.summaryDefault}: ${defaultModelName}`);
    }
    stepHeader(4, tr.providerCmd.confirmConfig, summaryLines);

    const setDefault = await ctx.promptYesNo(tr.providerCmd.setAsDefault, ctx.getProviderCount() === 0);

    // Generate ID from name
    const autoId = name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);

    const provider = ctx.addProvider({
      id: autoId || undefined,
      name,
      protocol,
      apiKey,
      baseUrl,
      defaultModel: defaultModelName,
      models: selectedModels,
      setAsDefault: setDefault,
    });

    ctx.setLastSelectedModel(provider.id, provider.defaultModel || defaultModelName);

    if (setDefault) {
      await ctx.applyProviderState({
        providerId: provider.id,
        provider: provider.protocol,
        model: provider.defaultModel || defaultModelName,
        providerSettings: provider,
      });
      ctx.updateProviderDisplay(ctx.getProviderDisplayName(), provider.defaultModel || defaultModelName);
    }

    ctx.logInfo(tr.providerCmd.createdTitle, [
      `Provider: ${provider.name}`,
      `Model: ${provider.defaultModel || defaultModelName}`,
      `ID: ${provider.id}`,
      setDefault
        ? '已切换到这个 provider。'
        : `未设为默认 —— 当前仍在用 ${ctx.getProviderDisplayName()}。要切过去: /provider use ${provider.id}`,
    ].join('\n'));

    showProviderOptions(ctx);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    /* 用户自己按 esc 取消: 什么都不留 (向导页眉随之消失) —— 不需要一张"已取消"的卡 */
    if (msg !== 'cancelled') {
      ctx.logInfo(tr.providerCmd.createFailed, msg);
    }
  } finally {
    setWizardHeader(null);
  }
}

export async function handleProviderEditCommand(
  ctx: ProviderCommandContext,
  providerId?: string
): Promise<void> {
  let target = ctx.getProviderByIdentifier(providerId);
  if (!target) {
    target = await ctx.selectProviderFromList('Provider · 选一个查看或修改');
    if (!target) {
      return;
    }
  }
  if (!target) {
    return;
  }
  let editingTarget = target;
  const originalId = editingTarget.id;
  const tr = t();

  try {
    let continueEditing = true;
    while (continueEditing) {
      const isCurrentProvider = editingTarget.id === ctx.providerId;
      const currentConfig = [
        `Provider: ${editingTarget.name}${isCurrentProvider ? ' (current)' : ''}`,
        `ID: ${editingTarget.id}`,
        `Protocol: ${PROTOCOL_LABELS[editingTarget.protocol] || editingTarget.protocol}`,
        `Base URL: ${editingTarget.baseUrl || PROVIDER_BASE_URLS[editingTarget.protocol]}`,
        `API Key: ${editingTarget.apiKey ? '***' + editingTarget.apiKey.slice(-4) : '(not set)'}`,
        `Default Model: ${editingTarget.defaultModel || '(none)'}`,
        `Models: ${editingTarget.models.map(m => m.name).join(', ') || '(none)'}`,
      ].join('\n');
      void currentConfig; // 配置就是下面菜单每一行的值, 不再先往时间线里打一张 "Provider Configuration" 卡

      /* 一行一个字段, "名称 — 当前值" 由 SelectMenu 拆成两栏对齐; 回车改那一项 */
      const actionChoices: Array<{ label: string; value: string; description?: string }> = [
        { label: '← 返回', value: 'done' },
        { label: `名称 — ${editingTarget.name}`, value: 'edit_name' },
        { label: `协议 — ${PROTOCOL_LABELS[editingTarget.protocol]}`, value: 'edit_protocol' },
        { label: `地址 — ${editingTarget.baseUrl || PROVIDER_BASE_URLS[editingTarget.protocol]}`, value: 'edit_base_url' },
        { label: `API Key — ${editingTarget.apiKey ? '••••' + editingTarget.apiKey.slice(-4) : '未设置'}`, value: 'edit_api_key' },
        { label: `默认模型 — ${editingTarget.defaultModel || '未设置'}`, value: 'edit_model' },
        { label: `ID — ${editingTarget.id}`, value: 'edit_id' },
      ];

      if (!isCurrentProvider) {
        actionChoices.push({ label: '切换到这个 Provider', value: 'switch' });
      }
      actionChoices.push({ label: '删除这个 Provider', value: 'delete', description: '不可撤销' });

      const action = await ctx.promptSelect(`Provider · ${editingTarget.name}${isCurrentProvider ? ' (当前)' : ''}`, actionChoices, 'done');

      switch (action) {
        case 'done':
          continueEditing = false;
          break;

        case 'edit_id': {
          const newId = await ctx.promptText(`Edit Provider ID (current: ${editingTarget.id})`, {
            defaultValue: editingTarget.id,
            hint: tr.providerCmd.editIdHint,
          });
          if (newId.trim() && newId.trim() !== editingTarget.id) {
            const renamed = ctx.renameProvider(editingTarget.id, newId.trim());
            editingTarget = renamed;
            if (originalId === ctx.providerId) {
              await ctx.applyProviderState({
                providerId: renamed.id,
                provider: renamed.protocol,
                model: ctx.model,
                providerSettings: renamed,
              });
              ctx.updateProviderDisplay(ctx.getProviderDisplayName(), ctx.model);
            }
            ctx.logInfo('✓ Provider ID updated', `New ID: ${editingTarget.id}`);
          }
          break;
        }

        case 'edit_name': {
          const newName = await ctx.promptText(`Edit Provider Name (current: ${editingTarget.name})`, {
            defaultValue: editingTarget.name,
          });
          if (newName.trim() && newName.trim() !== editingTarget.name) {
            editingTarget = ctx.updateProvider(editingTarget.id, { name: newName.trim() });
            ctx.logInfo('✓ Provider name updated', `New name: ${editingTarget.name}`);
          }
          break;
        }

        case 'edit_protocol': {
          const protocolChoices = [
            { label: tr.providerCmd.protoOpenAIChatEdit, value: 'openai' },
            { label: tr.providerCmd.protoOpenAIResponsesEdit, value: 'openai-responses' },
            { label: tr.providerCmd.protoKimi, value: 'kimi' },
            { label: 'DeepSeek — OpenAI 兼容', value: 'deepseek' },
            { label: 'Qwen (阿里云百炼) — OpenAI 兼容', value: 'qwen' },
            { label: 'MiniMax — OpenAI 兼容', value: 'minimax' },
            { label: tr.providerCmd.protoAnthropic, value: 'anthropic' },
            { label: tr.providerCmd.protoAnthropicOpenAIEdit, value: 'anthropic-openai' },
            { label: tr.providerCmd.protoDoubao, value: 'doubao' },
            { label: tr.providerCmd.protoGemini, value: 'gemini' },
            { label: tr.providerCmd.protoGlm, value: 'glm' },
            { label: tr.providerCmd.protoGlmClaude, value: 'glm-claude' },
            { label: tr.providerCmd.protoKimiClaude, value: 'kimi-claude' },
          ];
          const newProtocol = await ctx.promptSelect(
            `Edit Protocol (current: ${PROTOCOL_LABELS[editingTarget.protocol]})`,
            protocolChoices,
            editingTarget.protocol
          ) as ProviderProtocol;
          if (newProtocol !== editingTarget.protocol) {
            editingTarget = ctx.updateProvider(editingTarget.id, { protocol: newProtocol });
            ctx.logInfo('✓ Protocol updated', `New protocol: ${PROTOCOL_LABELS[newProtocol]}`);
          }
          break;
        }

        case 'edit_base_url': {
          const currentBase = editingTarget.baseUrl || PROVIDER_BASE_URLS[editingTarget.protocol];
          const newBaseUrl = await ctx.promptText(`Edit Base URL (current: ${currentBase})`, {
            defaultValue: currentBase,
          });
          if (newBaseUrl.trim() && newBaseUrl.trim() !== currentBase) {
            editingTarget = ctx.updateProvider(editingTarget.id, { baseUrl: newBaseUrl.trim() });
            ctx.logInfo('✓ Base URL updated', `New URL: ${editingTarget.baseUrl}`);
          }
          break;
        }

        case 'edit_api_key': {
          //    the entry, and treat empty input as "keep existing".
          const maskedCurrent = editingTarget.apiKey
            ? '***' + editingTarget.apiKey.slice(-4)
            : '(not set)';
          const newApiKey = await ctx.promptText(
            `Edit API Key (current: ${maskedCurrent})`,
            {
              allowEmpty: true, // 空输入 = 保留现有 key, 不覆盖
              hint: tr.providerCmd.editApiKeyHint,
              password: true,
            }
          );
          if (newApiKey.trim() && newApiKey.trim() !== editingTarget.apiKey) {
            editingTarget = ctx.updateProvider(editingTarget.id, { apiKey: newApiKey.trim() });
            ctx.logInfo('✓ API Key updated', 'New key has been saved');
          }
          break;
        }

        case 'edit_model': {
          if (editingTarget.models.length === 0) {
            ctx.logInfo('No models configured', 'Use /model add to add models first');
            break;
          }
          const modelChoices = editingTarget.models.map(model => ({
            label: model.name,
            value: model.name,
          }));
          const newModel = await ctx.promptSelect(
            `Edit Default Model (current: ${editingTarget.defaultModel || '(none)'})`,
            modelChoices,
            editingTarget.defaultModel || editingTarget.models[0].name
          );
          if (newModel !== editingTarget.defaultModel) {
            editingTarget = ctx.updateProvider(editingTarget.id, { defaultModel: newModel });
            ctx.logInfo('✓ Default model updated', `New model: ${newModel}`);

            // Update current session if this is the active provider
            if (editingTarget.id === ctx.providerId) {
              ctx.setLastSelectedModel(ctx.providerId, newModel);
              await ctx.applyProviderState({
                providerId: editingTarget.id,
                provider: editingTarget.protocol,
                model: newModel,
                providerSettings: editingTarget,
              });
              ctx.updateProviderDisplay(ctx.getProviderDisplayName(), newModel);
            }
          }
          break;
        }

        case 'switch': {
          // Switch to this provider
          const nextModel = ctx.resolveModel(editingTarget.id);
          if (!nextModel) {
            ctx.logInfo('Cannot switch', 'This provider has no models configured');
            break;
          }
          ctx.setLastSelectedModel(editingTarget.id, nextModel);
          ctx.setDefaultProvider(editingTarget.id);
          await ctx.applyProviderState({
            providerId: editingTarget.id,
            provider: editingTarget.protocol,
            model: nextModel,
            providerSettings: editingTarget,
          });
          ctx.updateProviderDisplay(ctx.getProviderDisplayName(), nextModel);
          ctx.logInfo('✓ Provider switched', `Now using: ${editingTarget.name} / ${nextModel}`);
          break;
        }

        case 'delete': {
          // Delete this provider
          if (ctx.getProviderCount() <= 1) {
            ctx.logInfo('Cannot delete', 'At least one provider is required');
            break;
          }

          const confirmed = await ctx.promptConfirmKeyword(
            `Type DELETE to remove provider "${editingTarget.name}"`,
            'delete'
          );
          if (!confirmed) {
            ctx.logInfo('Deletion cancelled');
            break;
          }

          const wasCurrentProvider = editingTarget.id === ctx.providerId;
          ctx.deleteProvider(editingTarget.id);
          ctx.refreshProviderSettings();

          if (wasCurrentProvider) {
            const fallback = ctx.getDefaultProvider();
            if (fallback) {
              const nextModel = ctx.resolveModel(fallback.id);
              if (nextModel) {
                ctx.setLastSelectedModel(fallback.id, nextModel);
                await ctx.applyProviderState({
                  providerId: fallback.id,
                  provider: fallback.protocol,
                  model: nextModel,
                  providerSettings: fallback,
                });
                ctx.updateProviderDisplay(ctx.getProviderDisplayName(), nextModel);
                ctx.logInfo('✓ Provider deleted', `Removed ${editingTarget.name}. Switched to ${fallback.name}.`);
              }
            }
          } else {
            ctx.logInfo('✓ Provider deleted', `Removed ${editingTarget.name}.`);
          }

          // Exit the editing loop after deletion
          continueEditing = false;
          break;
        }
      }
    }

    ctx.logInfo('✓ Done', `Provider: ${editingTarget.name}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo('Cancelled', 'Provider not modified');
    } else {
      ctx.logInfo('Failed to update provider', msg);
    }
  }
}

/**
 * Handle /provider remove command
 */
export async function handleProviderDeleteCommand(
  ctx: ProviderCommandContext,
  providerId?: string
): Promise<void> {
  let target = ctx.getProviderByIdentifier(providerId);
  if (!target) {
    target = await ctx.selectProviderFromList('删除 Provider · 选一个');
    if (!target) {
      return;
    }
  }
  if (ctx.getProviderCount() <= 1) {
    ctx.logInfo('Cannot delete provider', 'At least one provider is required.');
    return;
  }

  try {
    const confirmed = await ctx.promptConfirmKeyword(
      `Type DELETE to remove provider "${target.name}"`,
      'delete'
    );
    if (!confirmed) {
      ctx.logInfo('Deletion cancelled', 'Provider was not removed.');
      return;
    }

    const removedActive = target.id === ctx.providerId;
    ctx.deleteProvider(target.id);
    ctx.refreshProviderSettings();

    if (removedActive) {
      const fallback = ctx.getDefaultProvider();
      if (!fallback) {
        ctx.logInfo('Provider deleted', `Removed ${target.name}. Add a new provider with /provider add.`);
        return;
      }
      const nextModel = ctx.resolveModel(fallback.id);
      if (!nextModel) {
        ctx.logInfo('Provider deleted', `Removed ${target.name}. Configure models for ${fallback.name} via /model add.`);
        return;
      }
      ctx.setLastSelectedModel(fallback.id, nextModel);
      await ctx.applyProviderState({
        providerId: fallback.id,
        provider: fallback.protocol,
        model: nextModel,
        providerSettings: fallback,
      });
      ctx.updateProviderDisplay(ctx.getProviderDisplayName(), nextModel);
    }

    ctx.logInfo('Provider deleted', `Removed ${target.name}.`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo('Deletion cancelled');
    } else {
      ctx.logInfo('Failed to delete provider', msg);
    }
  }
}

/**
 * Handle /provider default command
 */
export async function handleProviderDefaultCommand(
  ctx: ProviderCommandContext,
  providerId?: string
): Promise<void> {
  let target = ctx.getProviderByIdentifier(providerId);
  if (!target) {
    target = await ctx.selectProviderFromList('设为默认 Provider · 选一个');
    if (!target) {
      return;
    }
  }

  try {
    ctx.setDefaultProvider(target.id);
    ctx.logInfo('Default provider updated', `${target.name} is now the default provider.`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logInfo('Failed to set default provider', msg);
  }
}

export async function handleInteractiveProviderSelection(
  ctx: ProviderCommandContext
): Promise<void> {
  const providers = ctx.getProviders();

  if (!providers || providers.length === 0) {
    ctx.logInfo('No providers configured', 'Use /provider add to create one.');
    return;
  }

  try {
    // Select provider interactively (includes Back and Add options)
    const target = await ctx.selectProviderFromList('Provider · 选一个查看或修改');
    if (!target) {
      return; // User selected Back
    }

    if (target.id === '__add__') {
      await handleProviderAddCommand(ctx);
      return;
    }

    // User can view and modify any field or just keep everything unchanged
    await handleProviderEditCommand(ctx, target.id);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo('Selection cancelled');
    } else {
      ctx.logInfo('Selection failed', msg);
    }
  }
}
