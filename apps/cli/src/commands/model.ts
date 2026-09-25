/**
 * Model Command Handlers
 * Handles all model-related CLI commands
 */

import type { ProviderConfigEntry, ProviderModelConfig } from '@neoxlabs/platform/utils/config.js';
import type { ProviderCommandContext } from './providerTypes.js';
import type { ProviderProtocol } from '@neoxlabs/platform/shared/ipc.js';
import { PROTOCOL_LABELS, colors } from '../constants.js';
import { formatBadges } from '../utils/index.js';
import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';
import { getModelSuggestionsByProtocol } from '@neoxlabs/core/models/protocolModels.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { isGPTModel } from '@neoxlabs/platform/utils/modelDetect.js';
import { getCliEdition } from '../edition/index.js';
import type { SelectionChoice } from '../cliTypes.js';
import { t, formatMessage } from '../i18n/index.js';

/**
 * Interactive model selection result
 */
export interface ModelSelectionResult {
  providerId: string;
  modelName: string;
}

/**
 * Output function type for flexible output handling
 */
type OutputFn = (line: string) => void;

/**
 * Extended context with optional output function
 */
export interface ModelCommandContext extends ProviderCommandContext {
  outputFn?: OutputFn;
}

/**
 * Show available models list for all providers
 */
export function showModelOptions(ctx: ModelCommandContext): void {
  const allProviders = ctx.getProviders();

  if (!allProviders || allProviders.length === 0) {
    ctx.logInfo('No provider configured', 'Add a provider before managing models.');
    return;
  }

  // Show models for all providers
  showAllProvidersModels(ctx, allProviders);
}

/**
 * Show models for all providers
 */
export function showAllProvidersModels(
  ctx: ModelCommandContext,
  providers: ProviderConfigEntry[]
): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(colors.highlight('  Available Models'));
  lines.push('');

  for (const provider of providers) {
    const protocolName = PROTOCOL_LABELS[provider.protocol] || 'OpenAI';
    const isCurrentProvider = provider.id === ctx.providerId;
    const providerBadge = isCurrentProvider ? colors.success(' [current]') : '';

    lines.push(colors.primary(`  ▸ ${provider.name} (${provider.id})`) + providerBadge);
    lines.push(colors.dim(`    Protocol: ${protocolName}`));

    if (provider.models.length === 0) {
      lines.push(colors.dim('    No models configured'));
    } else {
      provider.models.forEach((model, index) => {
        const badges: string[] = [];
        if (isCurrentProvider && model.name === ctx.model) {
          badges.push('current');
        }
        if (model.name === provider.defaultModel) {
          badges.push('default');
        }
        lines.push(`    ${colors.dim(`${index + 1}.`)} ${model.name}${formatBadges(badges)}`);
      });
    }
    lines.push('');
  }

  lines.push(colors.dim('  Commands:'));
  lines.push(colors.dim('    /model use [providerId] <name>  switch model'));
  lines.push(colors.dim('    /model add                      add model'));
  lines.push(colors.dim('    /model remove <name>            remove model'));
  lines.push(colors.dim('    /model default <name>           set default model'));
  lines.push(colors.dim('    /model list <providerId>        list provider models'));
  lines.push('');

  // If outputFn is provided, use it for multi-line display
  if (ctx.outputFn) {
    for (const line of lines) {
      ctx.outputFn(line);
    }
    return;
  }

  // Fallback to logInfo for simple display
  const detailLines = lines.slice(1, -1);
  ctx.logInfo('Available models', detailLines.join('\n'));
}

/**
 * Show models for a specific provider
 */
export function showModelOptionsForProvider(
  ctx: ModelCommandContext,
  provider: ProviderConfigEntry
): void {
  if (!provider || provider.models.length === 0) {
    ctx.logInfo(
      `No models for ${provider?.name || 'provider'}`,
      'Use /model add to register a model.'
    );
    return;
  }

  const defaultModel = provider.defaultModel;
  const protocolName = PROTOCOL_LABELS[provider.protocol] || 'OpenAI';

  // Build all lines first
  const lines: string[] = [];

  lines.push('');
  lines.push(colors.highlight(`  Available Models - ${provider.name} (${provider.id})`));
  lines.push(colors.dim(`  Protocol: ${protocolName}`));
  lines.push('');

  provider.models.forEach((model, index) => {
    const badges: string[] = [];
    if (provider.id === ctx.providerId && model.name === ctx.model) {
      badges.push('current');
    }
    if (model.name === defaultModel) {
      badges.push('default');
    }
    lines.push(`  ${colors.primary(`${index + 1}.`)} ${model.name}${formatBadges(badges)}`);
  });

  lines.push('');
  lines.push(colors.dim('  Commands:'));
  lines.push(colors.dim('    /model use [providerId] <name>  switch model'));
  lines.push(colors.dim('    /model add                      add model'));
  lines.push(colors.dim('    /model remove <name>            remove model'));
  lines.push(colors.dim('    /model default <name>           set default model'));
  lines.push(colors.dim('    /model list <providerId>        list other provider models'));
  lines.push('');

  // If outputFn is provided, use it for multi-line display
  if (ctx.outputFn) {
    for (const line of lines) {
      ctx.outputFn(line);
    }
    return;
  }

  // Fallback to logInfo for simple display (join all lines as details)
  const detailLines = lines.slice(1, -1); // Remove first and last empty lines
  ctx.logInfo('Available models', detailLines.join('\n'));
}

/**
 * Handle /model list command
 */
export async function showModelOptionsCommand(
  ctx: ModelCommandContext,
  providerId?: string
): Promise<void> {
  if (providerId) {
    const provider = ctx.getProvider(providerId);
    if (!provider) {
      ctx.logInfo('Provider not found', `Unknown provider "${providerId}".`);
      return;
    }
    showModelOptionsForProvider(ctx, provider);
    return;
  }
  showModelOptions(ctx);
}

/**
 * Apply model change
 */
export async function applyModelChange(
  ctx: ModelCommandContext,
  modelName: string
): Promise<void> {
  if (!ctx.providerSettings) {
    ctx.logInfo('No provider configured', 'Set up a provider before selecting models.');
    return;
  }
  /* sentinel 'neox-cloud' models[] 永远空 (订阅模型由 membership cache 动态拉, 不进 providerStore),
   * 校验 providerSettings.models 永远 fail → "Invalid model / No models configured" 误伤.
   * 跳过 sentinel 校验 — model 合法性由 gateway / membership cache 兜底. */
  const isSentinel = ctx.providerSettings.id === 'neox-cloud';
  if (!isSentinel && !ctx.providerSettings.models.some(model => model.name === modelName)) {
    const available = ctx.providerSettings.models.map(model => model.name).join(', ');
    ctx.logInfo('Invalid model', available ? `Available models: ${available}` : 'No models configured.');
    return;
  }

  if (modelName === ctx.model) {
    const configured = await maybeConfigureReasoningForSelectedModel(ctx, ctx.providerSettings, modelName);
    if (configured) {
      return;
    }
    ctx.logInfo('Model unchanged', `${modelName} is already active.`);
    return;
  }

  try {
    ctx.setLastSelectedModel(ctx.providerId, modelName);

    await ctx.applyProviderState({
      providerId: ctx.providerId,
      provider: ctx.provider,
      model: modelName,
      providerSettings: ctx.providerSettings,
    });

    ctx.updateProviderDisplay(ctx.getProviderDisplayName(), modelName);
    ctx.logInfo('Model updated', `Model set to ${modelName}`);

    // Auto-disable PTC if switching to a GPT model
    if (isGPTModel(modelName)) {
      const cfg = loadConfig();
      if (cfg.experimental?.enablePTC) {
        const updated = { ...cfg, experimental: { ...cfg.experimental, enablePTC: false } };
        saveConfig(updated);
        ctx.logInfo('PTC auto-disabled', t().modelCmd.ptcAutoDisabled);
      }
    }

    const latestProvider = ctx.getProvider(ctx.providerId) || ctx.providerSettings;
    await maybeConfigureReasoningForSelectedModel(ctx, latestProvider, modelName);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logInfo('Failed to change model', msg);
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
 * Get model presets based on provider protocol
 * Dynamically generates model list from registry
 */
function getModelPresetsForProtocol(protocol: ProviderProtocol): Array<{
  name: string;
  description: string;
}> {
  const suggestions = getModelSuggestionsByProtocol(protocol);

  return [
    ...suggestions.slice(0, 15).map(modelId => {
      const model = modelRegistry.getModel(modelId);
      if (!model) {
        return {
          name: modelId,
          description: modelId,
        };
      }

      const contextInfo = formatContextWindow(model.maxInputTokens);
      const badges: string[] = [];
      if (model.supportsVision) badges.push('vision');
      if (model.supportsThinking) badges.push('thinking');

      const badgeStr = badges.length > 0 ? `${badges.join(' ')} ` : '';

      return {
        name: modelId,
        description: `${model.displayName} ${badgeStr}(${contextInfo} ctx)`,
      };
    }),
    {
      name: '__custom__',
      description: 'Enter custom model name',
    },
  ];
}

/**
 * Prompt user for OpenAI Responses API reasoning configuration
 * @param ctx Command context
 * @param provider Target provider
 * @returns Reasoning config or undefined if not applicable/skipped
 */
async function promptReasoningConfig(
  ctx: ModelCommandContext,
  provider: ProviderConfigEntry
): Promise<ProviderModelConfig['reasoning'] | undefined> {
  // Only ask for OpenAI providers using Responses API
  const isOpenAIResponsesAPI = provider.protocol === 'openai-responses' ||
    (provider.protocol === 'openai' && provider.baseUrl?.includes('responses'));

  if (!isOpenAIResponsesAPI) {
    return undefined;
  }

  const configureReasoning = await ctx.promptYesNo(
    '要设置推理强度吗? (OpenAI Responses 模型)',
    false
  );

  if (!configureReasoning) {
    return undefined;
  }

  // Prompt for effort level
  const effort = await ctx.promptSelect(
    '推理强度',
    [
      { label: 'minimal', value: 'minimal', description: '几乎不推理, 最快' },
      { label: 'low', value: 'low', description: '浅推理, 快' },
      { label: 'medium', value: 'medium', description: '平衡' },
      { label: 'high', value: 'high', description: '深推理, 更慢更细' },
      { label: 'xhigh', value: 'xhigh', description: '极深, 最难的任务' },
      { label: 'max', value: 'max', description: '最大推理深度 (GPT-5.6)' },
      { label: 'ultra', value: 'ultra', description: '自动任务委派 (仅 GPT-5.6 Sol/Terra)' },
    ],
    'low'
  ) as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

  // Prompt for summary mode
  const summary = await ctx.promptSelect(
    '推理摘要',
    [
      { label: '自动', value: 'auto', description: '由模型决定' },
      { label: '简短', value: 'concise', description: '一两句' },
      { label: '详细', value: 'detailed', description: '完整摘要' },
    ],
    'auto'
  ) as 'auto' | 'concise' | 'detailed';

  // Prompt for verbosity (optional)
  const configureVerbosity = await ctx.promptYesNo(
    '设置回答详细程度? (进阶, 一般不用)',
    false
  );

  let verbosity: 'low' | 'medium' | 'high' | undefined = undefined;
  if (configureVerbosity) {
    verbosity = await ctx.promptSelect(
      '回答详细程度',
      [
        { label: '简洁', value: 'low', description: '只说要点' },
        { label: '标准', value: 'medium', description: '默认' },
        { label: '详细', value: 'high', description: '尽量展开' },
      ],
      'low'
    ) as 'low' | 'medium' | 'high';
  }

  return {
    effort,
    summary,
    ...(verbosity && { verbosity }),
  };
}

async function maybeConfigureReasoningForSelectedModel(
  ctx: ModelCommandContext,
  provider: ProviderConfigEntry,
  modelName: string
): Promise<boolean> {
  const reasoningConfig = await promptReasoningConfig(ctx, provider);
  if (!reasoningConfig) {
    return false;
  }

  ctx.updateModelConfig(provider.id, modelName, {
    reasoning: reasoningConfig,
  });

  const latestProvider = ctx.getProvider(provider.id) || provider;

  if (provider.id === ctx.providerId && modelName === ctx.model) {
    await ctx.applyProviderState({
      providerId: provider.id,
      provider: latestProvider.protocol,
      model: modelName,
      providerSettings: latestProvider,
    });
    ctx.updateProviderDisplay(ctx.getProviderDisplayName(), modelName);
  } else {
    ctx.refreshProviderSettings();
  }

  ctx.logInfo('Model configuration updated', `Updated reasoning settings for ${modelName}`);
  return true;
}

/**
 * Handle /model add command with interactive preset selection
 * @param ctx Command context
 * @param initialNameOrProviderId Optional model name (for CLI args) or provider ID (for internal calls)
 * @param isProviderId If true, treat second param as provider ID instead of model name
 */
export async function handleModelAddCommand(
  ctx: ModelCommandContext,
  initialNameOrProviderId?: string,
  isProviderId: boolean = false
): Promise<void> {
  const allProviders = ctx.getProviders();
  if (!allProviders || allProviders.length === 0) {
    ctx.logInfo('No provider configured', 'Add a provider before managing models.');
    return;
  }

  try {
    while (true) {
      // Step 1: Select target provider
      let targetProvider: ProviderConfigEntry;
      let initialName: string | undefined;

      if (isProviderId && initialNameOrProviderId) {
        // Internal call with provider ID specified
        const provider = ctx.getProvider(initialNameOrProviderId);
        if (!provider) {
          ctx.logInfo('Provider not found', `Unknown provider "${initialNameOrProviderId}".`);
          return;
        }
        targetProvider = provider;
        initialName = undefined; // Show preset menu
      } else if (initialNameOrProviderId?.trim() && !isProviderId) {
        // CLI call with model name specified
        if (!ctx.providerSettings) {
          ctx.logInfo('No provider configured', 'Add a provider before managing models.');
          return;
        }
        targetProvider = ctx.providerSettings;
        initialName = initialNameOrProviderId.trim();
      } else {
        // Interactive mode - select provider first
        if (allProviders.length === 1) {
          targetProvider = allProviders[0];
        } else {
          const selection = await ctx.selectProviderFromList('给哪个 Provider 添加模型');
          if (!selection) {
            // User selected "Back" on top-level menu → exit
            return;
          }

          if (selection.id === '__add__') {
            // Trigger provider add flow
            const { handleProviderAddCommand } = await import('./provider.js');
            await handleProviderAddCommand(ctx);
            // Refresh provider list after adding
            const updatedProviders = ctx.getProviders();
            if (!updatedProviders || updatedProviders.length === 0) {
              // User cancelled provider creation or it failed
              return;
            }
            // Loop back to provider selection to let user choose the new provider
            continue;
          }

          targetProvider = selection;
        }
        initialName = undefined; // Show preset menu
      }

      // Step 2: Select or input model name
      let modelName: string;

      if (initialName) {
        // Model name provided via CLI argument
        modelName = initialName;
      } else {
        // Show interactive selection with presets
        const presets = getModelPresetsForProtocol(targetProvider.protocol);

        // DEBUG: Log preset information
        cliLogger.debug('MODEL_ADD', 'Getting model presets', {
          protocol: targetProvider.protocol,
          presetCount: presets.length,
          firstThree: presets.slice(0, 3),
        });

        const choices = [
          { label: '← Back', value: '__back__' },
          ...presets.map(preset => ({
            label: preset.name === '__custom__'
              ? '> Custom model name'
              : `${preset.name} — ${preset.description}`,
            value: preset.name,
          })),
        ];

        const selected = await ctx.promptSelect(
          `Select a model to add to ${targetProvider.name}`,
          choices
        );

        if (!selected || selected === '__back__') {
          // User selected "Back" or cancelled
          if (allProviders.length === 1 || isProviderId) {
            // Only one provider or called from model selection → cancel means exit
            return;
          }
          // Multiple providers → cancel means return to provider selection
          continue;
        }

        // If user chose custom, prompt for manual entry
        if (selected === '__custom__') {
          modelName = await ctx.promptText('Enter custom model name', {});
        } else {
          modelName = selected;
        }
      }

      // Step 3: Check if model already exists
      const existingModel = targetProvider.models.find(m => m.name === modelName);
      if (existingModel) {
        ctx.logInfo(
          'Model already exists',
          `Model "${modelName}" is already added to provider ${targetProvider.name}.`
        );
        // Don't exit, let user try again by going back to model selection
        if (initialName || allProviders.length === 1 || isProviderId) {
          // Can't go back, just exit
          return;
        }
        // Loop back to provider selection
        continue;
      }

      // Step 4: Add model with user preferences
      const makeDefault = await ctx.promptYesNo('设为这个 Provider 的默认模型?', false);

      // Step 4.5: Configure reasoning settings for OpenAI Responses API models
      const reasoningConfig = await promptReasoningConfig(ctx, targetProvider);

      // Build model config
      const modelConfig: Partial<ProviderModelConfig> = {};
      if (reasoningConfig) {
        modelConfig.reasoning = reasoningConfig;
      }

      const updated = ctx.addModel(targetProvider.id, modelName, makeDefault, modelConfig);

      // Step 5: Ask if user wants to use it now (only if we modified a different provider or current provider)
      let useNow = false;
      if (targetProvider.id === ctx.providerId) {
        // Same provider - just ask if they want to use it now
        useNow = await ctx.promptYesNo('现在就用这个模型?', true);
      } else {
        // Different provider - ask if they want to switch to this provider and model
        useNow = await ctx.promptYesNo(
          `切换到 ${targetProvider.name} 并用这个模型?`,
          false
        );
      }

      // Refresh provider settings
      ctx.refreshProviderSettings();

      ctx.logInfo('Model added', `Model "${modelName}" added to provider ${updated.name}.`);

      // Step 6: Apply the selection if requested
      if (useNow || makeDefault) {
        if (targetProvider.id !== ctx.providerId) {
          // Switching to different provider
          ctx.setLastSelectedModel(targetProvider.id, modelName);
          ctx.setDefaultProvider(targetProvider.id);
          await ctx.applyProviderState({
            providerId: targetProvider.id,
            provider: targetProvider.protocol,
            model: modelName,
            providerSettings: updated,
          });
          ctx.updateProviderDisplay(ctx.getProviderDisplayName(), modelName);
          ctx.logInfo('Provider and model updated', `${ctx.getProviderDisplayName()} / ${modelName}`);
        } else {
          // Same provider, just change model
          await applyModelChange(ctx, modelName);
        }
      }

      // Successfully added, exit the loop
      break;
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo('Model addition cancelled');
    } else {
      ctx.logInfo('Failed to add model', msg);
    }
  }
}

async function maybePromptClearConversationOnInteractiveSwitch(
  ctx: ModelCommandContext,
  targetProvider: ProviderConfigEntry,
  desiredModelName: string
): Promise<boolean> {
  if (!ctx.hasConversationContext || !ctx.clearConversationContext) {
    return true;
  }

  if (targetProvider.id === ctx.providerId && desiredModelName === ctx.model) {
    return true;
  }

  const hasContext = await ctx.hasConversationContext();
  if (!hasContext) {
    return true;
  }

  const tr = t();
  try {
    const shouldClear = await ctx.promptYesNo(
      formatMessage(tr.modelCmd.clearContextPrompt, { model: desiredModelName }),
      false
    );

    if (shouldClear) {
      await ctx.clearConversationContext();
      ctx.logInfo(tr.modelCmd.contextCleared, tr.modelCmd.contextClearedDetail);
    } else {
      ctx.logInfo(tr.modelCmd.contextKept, tr.modelCmd.contextKeptDetail);
    }

    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo(tr.modelCmd.switchCancelled, tr.modelCmd.switchCancelledDetail);
      return false;
    }
    throw error;
  }
}

/**
 * Handle /model use command with provider selection flow
 */
export async function handleModelSelectionFlow(
  ctx: ModelCommandContext,
  providerArg?: string,
  modelArg?: string
): Promise<void> {
  let targetProvider: ProviderConfigEntry | null = null;
  let desiredModelName: string | undefined = modelArg;

  if (providerArg) {
    const providerMatch = ctx.getProvider(providerArg);
    if (providerMatch) {
      targetProvider = providerMatch;
    } else if (!desiredModelName) {
      desiredModelName = providerArg;
    } else {
      ctx.logInfo('Provider not found', `Unknown provider "${providerArg}".`);
      return;
    }
  }

  if (!targetProvider) {
    if (ctx.getProviderCount() <= 1 && ctx.providerSettings) {
      targetProvider = ctx.providerSettings;
    } else {
      const selection = await ctx.selectProviderFromList('选 Provider (自带 Key)');
      if (!selection) {
        return;
      }

      if (selection.id === '__add__') {
        // Trigger provider add flow
        const { handleProviderAddCommand } = await import('./provider.js');
        await handleProviderAddCommand(ctx);
        return;
      }

      targetProvider = selection;
    }
  }

  if (desiredModelName) {
    const exists = targetProvider.models.some(model => model.name === desiredModelName);
    if (!exists) {
      ctx.logInfo('Model not found', `Model "${desiredModelName}" does not exist for ${targetProvider.name}.`);
      return;
    }
  } else {
    desiredModelName = await ctx.selectModelFromProvider(
      targetProvider,
      `Select model for ${targetProvider.name}`
    ) || undefined;
    if (!desiredModelName) {
      return; // User selected Back
    }
    if (desiredModelName === '__add__') {
      await handleModelAddCommand(ctx, targetProvider.id, true);
      return;
    }
    if (desiredModelName === '__delete__') {
      await handleModelRemoveCommand(ctx, undefined, targetProvider.id);
      return;
    }
  }

  const shouldContinue = await maybePromptClearConversationOnInteractiveSwitch(
    ctx,
    targetProvider,
    desiredModelName
  );
  if (!shouldContinue) {
    return;
  }

  // Switch provider if needed
  if (targetProvider.id !== ctx.providerId) {
    const nextModel = ctx.resolveModel(targetProvider.id);
    if (!nextModel) {
      ctx.logInfo('Provider has no models', `Configure models for ${targetProvider.name} via /model add.`);
      return;
    }
    ctx.setLastSelectedModel(targetProvider.id, desiredModelName);
    ctx.setDefaultProvider(targetProvider.id);
    await ctx.applyProviderState({
      providerId: targetProvider.id,
      provider: targetProvider.protocol,
      model: desiredModelName,
      providerSettings: targetProvider,
    });
    ctx.updateProviderDisplay(ctx.getProviderDisplayName(), desiredModelName);
    ctx.logInfo('Provider and model updated', `Provider: ${ctx.getProviderDisplayName()}\nModel: ${desiredModelName}`);

    const latestProvider = ctx.getProvider(targetProvider.id) || targetProvider;
    await maybeConfigureReasoningForSelectedModel(ctx, latestProvider, desiredModelName);
  } else {
    await applyModelChange(ctx, desiredModelName);
  }

  showModelOptionsForProvider(ctx, targetProvider);
}

/**
 * Handle /model remove command
 * @param ctx Command context
 * @param modelName Optional model name to remove
 * @param providerId Optional provider ID (defaults to current provider)
 */
export async function handleModelRemoveCommand(
  ctx: ModelCommandContext,
  modelName?: string,
  providerId?: string
): Promise<void> {
  // Determine target provider
  const targetProviderId = providerId || ctx.providerId;
  const targetProvider = ctx.getProvider(targetProviderId);

  if (!targetProvider) {
    ctx.logInfo('No provider configured', 'Add a provider before managing models.');
    return;
  }

  let targetName: string | null = modelName ? modelName.trim() : '';
  if (!targetName) {
    // Select model from the target provider
    targetName = await ctx.selectModelFromProvider(
      targetProvider,
      `Select a model to remove from ${targetProvider.name}`
    );
    if (!targetName) {
      return;
    }
    // Handle special actions (Back, Add, Delete again)
    if (targetName === '__back__' || targetName === '__add__' || targetName === '__delete__') {
      return;
    }
  }
  if (!targetProvider.models.some(model => model.name === targetName)) {
    ctx.logInfo('Model not found', `Model "${targetName}" does not exist for ${targetProvider.name}.`);
    return;
  }

  try {
    const confirmed = await ctx.promptConfirmKeyword(
      `Type REMOVE to delete model "${targetName}" from ${targetProvider.name}`,
      'remove'
    );
    if (!confirmed) {
      ctx.logInfo('Model removal cancelled');
      return;
    }

    const updated = ctx.removeModel(targetProviderId, targetName);
    const removedActive = ctx.providerId === targetProviderId && ctx.model === targetName;

    if (removedActive) {
      const fallbackModel = ctx.resolveModel(targetProviderId);
      if (!fallbackModel) {
        ctx.logInfo('Model removed', `Removed ${targetName}. Add another model with /model add.`);
        return;
      }
      ctx.setLastSelectedModel(targetProviderId, fallbackModel);
      await ctx.applyProviderState({
        providerId: targetProviderId,
        provider: ctx.provider,
        model: fallbackModel,
        providerSettings: updated,
      });
      ctx.updateProviderDisplay(ctx.getProviderDisplayName(), fallbackModel);
      ctx.logInfo('Model removed', `Removed ${targetName}. Switched to ${fallbackModel}.`);
    } else {
      ctx.refreshProviderSettings();
      ctx.logInfo('Model removed', `Removed ${targetName} from ${targetProvider.name}.`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo('Model removal cancelled');
    } else {
      ctx.logInfo('Failed to remove model', msg);
    }
  }
}

/**
 * Handle /model default command
 */
export async function handleModelDefaultCommand(
  ctx: ModelCommandContext,
  modelName?: string
): Promise<void> {
  if (!ctx.providerSettings) {
    ctx.logInfo('No provider configured', 'Add a provider before managing models.');
    return;
  }
  let targetName: string | null = modelName ? modelName.trim() : '';
  if (!targetName) {
    targetName = await ctx.selectModelFromCurrentProvider('Select a model to set as default');
    if (!targetName) {
      return;
    }
  }
  if (!ctx.providerSettings.models.some(model => model.name === targetName)) {
    ctx.logInfo('Model not found', `Model "${targetName}" does not exist for ${ctx.providerSettings.name}.`);
    return;
  }

  try {
    const updated = ctx.updateProvider(ctx.providerId, { defaultModel: targetName });
    ctx.setLastSelectedModel(ctx.providerId, targetName);

    await ctx.applyProviderState({
      providerId: ctx.providerId,
      provider: ctx.provider,
      model: targetName,
      providerSettings: updated,
    });

    ctx.updateProviderDisplay(ctx.getProviderDisplayName(), targetName);
    ctx.logInfo('Default model updated', `${targetName} is now default for ${updated.name}.`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.logInfo('Failed to set default model', msg);
  }
}

/**
 * Interactive model selection flow (provider first, then model)
 * This is the main entry point for /model without arguments
 */
/**
 * runByokFlatModelMenu — 把所有 BYOK provider × model 摊成单菜单,
 *   每行 "provider · model (protocol)"; 选了直接 switch provider + model.
 *   sentinel 'neox-cloud' 不进 (走 subscription 菜单).
 *
 *   排序: 优先 current selection → 当前 provider 的其它 model → 其它 provider.
 *   顶部 ← Back + + Add provider/model 入口.
 */
async function runByokFlatModelMenu(
  ctx: ModelCommandContext,
  byokProviders: ProviderConfigEntry[],
): Promise<void> {
  /* 摊平 */
  type Entry = { providerId: string; providerName: string; protocol: string; modelName: string };
  const entries: Entry[] = [];
  for (const p of byokProviders) {
    if (/-(images|tts|stt|embedding)$/.test(p.protocol)) continue;
    for (const m of p.models) {
      entries.push({
        providerId: p.id,
        providerName: p.name,
        protocol: PROTOCOL_LABELS[p.protocol] || p.protocol,
        modelName: m.name,
      });
    }
  }

  if (entries.length === 0) {
    const trEmpty = t();
    ctx.logInfo(trEmpty.modelCmd.noBYOKModels, trEmpty.modelCmd.noBYOKModelsHint);
    return;
  }

  /* 排序: current provider 的 model 在前 (current selection 最前), 然后其余 */
  entries.sort((a, b) => {
    const aIsCurrent = a.providerId === ctx.providerId;
    const bIsCurrent = b.providerId === ctx.providerId;
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    if (aIsCurrent && bIsCurrent) {
      if (a.modelName === ctx.model) return -1;
      if (b.modelName === ctx.model) return 1;
    }
    return a.providerName.localeCompare(b.providerName);
  });

  const choices: SelectionChoice[] = [
    { label: '← Back', value: '__back__' },
    { label: '+ Add provider', value: '__add_provider__' },
    ...entries.map((e, i) => {
      const isCurrent = e.providerId === ctx.providerId && e.modelName === ctx.model;
      const tag = isCurrent ? ' (current)' : '';
      return {
        label: `${e.providerName} · ${e.modelName}  ${colors.dim ? colors.dim(`(${e.protocol})`) : `(${e.protocol})`}${tag}`,
        value: String(i),
        isCurrent,
      };
    }),
  ];

  const initial = entries.findIndex((e) => e.providerId === ctx.providerId && e.modelName === ctx.model);
  const choice = await ctx.promptSelect(
    formatMessage(t().modelCmd.selectBYOK, { models: entries.length, providers: byokProviders.length }),
    choices,
    initial >= 0 ? String(initial) : undefined,
  );

  if (choice === '__back__') return;
  if (choice === '__add_provider__') {
    const { handleProviderAddCommand } = await import('./provider.js');
    await handleProviderAddCommand(ctx);
    return;
  }

  const picked = entries[Number(choice)];
  if (!picked) return;

  const targetProvider = ctx.getProvider(picked.providerId);
  if (!targetProvider) {
    ctx.logInfo('Provider not found', picked.providerId);
    return;
  }

  if (picked.providerId !== ctx.providerId) {
    /* 切 provider + model */
    ctx.setLastSelectedModel(picked.providerId, picked.modelName);
    ctx.setDefaultProvider(picked.providerId);
    await ctx.applyProviderState({
      providerId: picked.providerId,
      provider: targetProvider.protocol,
      model: picked.modelName,
      providerSettings: targetProvider,
    });
    ctx.updateProviderDisplay(ctx.getProviderDisplayName(), picked.modelName);
    ctx.logInfo('Provider and model updated', `${picked.providerName} · ${picked.modelName}`);
    await maybeConfigureReasoningForSelectedModel(ctx, targetProvider, picked.modelName);
  } else {
    /* 同 provider 换 model —— 默认 provider 也要落盘: 配置文件跟桌面端共用, 那边切过订阅以后
     * 这里界面还是 BYOK 但盘上默认已是 neox-cloud, 选了"当前这个"也不写, 下次启动 / -p 就走订阅 */
    ctx.setDefaultProvider(picked.providerId);
    await applyModelChange(ctx, picked.modelName);
  }
}

export async function handleInteractiveModelSelection(
  ctx: ModelCommandContext
): Promise<void> {
  const allProviders = ctx.getProviders();

  if (!allProviders || allProviders.length === 0) {
    ctx.logInfo('No provider configured', 'Add a provider with /provider add first.');
    return;
  }

  /* sentinel 'neox-cloud' 不进 BYOK 视图 — 它走 subscription 菜单 */
  const byokProviders = allProviders.filter((p) => p.id !== 'neox-cloud');

  const account = getCliEdition().account;
  if (account) {
    const result = await account.runModelMenu(ctx);
    if (result === 'handled') return;
  }

  try {
    await runByokFlatModelMenu(ctx, byokProviders);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo('Selection cancelled');
    } else {
      ctx.logInfo('Selection failed', msg);
    }
  }
}

/**
 * Handle /model config command - Configure advanced settings for a model
 * @param ctx Command context
 * @param modelName Optional model name
 * @param providerId Optional provider ID (defaults to current provider)
 */
export async function handleModelConfigCommand(
  ctx: ModelCommandContext,
  modelName?: string,
  providerId?: string
): Promise<void> {
  // Determine target provider
  const targetProviderId = providerId || ctx.providerId;
  const targetProvider = ctx.getProvider(targetProviderId);

  if (!targetProvider) {
    ctx.logInfo('No provider configured', 'Add a provider before configuring models.');
    return;
  }

  // Select model if not specified
  let targetModelName = modelName?.trim() || '';
  if (!targetModelName) {
    targetModelName = await ctx.selectModelFromProvider(
      targetProvider,
      `Select a model to configure (${targetProvider.name})`
    ) || '';
    if (!targetModelName || targetModelName.startsWith('__')) {
      return; // User cancelled or selected special action
    }
  }

  // Verify model exists
  const model = targetProvider.models.find((m) => m.name === targetModelName);
  if (!model) {
    ctx.logInfo('Model not found', `Model "${targetModelName}" does not exist for ${targetProvider.name}.`);
    return;
  }

  try {
    // Show current configuration
    ctx.logInfo(
      `Configuring model: ${targetModelName}`,
      `Provider: ${targetProvider.name} (${targetProvider.protocol})`
    );

    // Configure reasoning settings
    const reasoningConfig = await promptReasoningConfig(ctx, targetProvider);

    if (!reasoningConfig) {
      ctx.logInfo('Configuration cancelled', 'No changes made.');
      return;
    }

    // Update model config
    const updated = ctx.updateModelConfig(targetProviderId, targetModelName, {
      reasoning: reasoningConfig,
    });

    // Refresh provider settings if this is the current provider
    if (targetProviderId === ctx.providerId) {
      ctx.refreshProviderSettings();
    }

    ctx.logInfo(
      'Model configuration updated',
      `Updated reasoning settings for ${targetModelName}`
    );

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'cancelled') {
      ctx.logInfo('Configuration cancelled');
    } else {
      ctx.logInfo('Failed to configure model', msg);
    }
  }
}
