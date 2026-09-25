import type { ChatRequest } from '../index.js';
import type { AgentRunMode } from '../../runtime/modeFactory.js';
import type { RuntimeMetadata } from '../../runtime/runtimeTypes.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface PrepareChatRequestOptions {
  request: ChatRequest;
  currentMode: AgentRunMode;
  defaultProviderId: string;
  defaultModelName: string;
}

interface PreparedChatRequest {
  mode: AgentRunMode;
  metadata?: RuntimeMetadata;
}

export function prepareChatRequest(options: PrepareChatRequestOptions): PreparedChatRequest {
  const { request, currentMode, defaultProviderId, defaultModelName } = options;
  const mode: AgentRunMode = (request.mode as AgentRunMode | undefined) ?? currentMode;

  cliLogger.info(
    'SERVER',
    `🎯 Chat request: mode=${mode}, providerId=${request.providerId || '(default)'}, modelName=${request.modelName || '(default)'}`,
  );

  if (request.modelConfig) {
    const mc = request.modelConfig;
    if (mc.reasoningEffort) {
      process.env.NEOX_REASONING_EFFORT = mc.reasoningEffort;
      cliLogger.info('SERVER', `  Reasoning effort: ${mc.reasoningEffort}`);
    }
    if (mc.reasoningSummary) process.env.NEOX_REASONING_SUMMARY = mc.reasoningSummary;
    if (mc.verbosity) process.env.NEOX_VERBOSITY = mc.verbosity;
    if (mc.serviceTier) process.env.NEOX_SERVICE_TIER = mc.serviceTier;
  }

  const resolvedProviderId = request.providerId || defaultProviderId;
  const providerOverridden = !!request.providerId && request.providerId !== defaultProviderId;
  const resolvedModelName  = request.modelName || (providerOverridden ? '' : defaultModelName);

  if (!resolvedProviderId) {
    cliLogger.error('SERVER', `❌ Chat request missing providerId AND no server default available. Reject.`);
    throw new Error('Chat request rejected: providerId is required and no server default is configured. Caller must pass providerId explicitly.');
  }
  if (!resolvedModelName && providerOverridden) {
    cliLogger.warn('SERVER', `⚠️ Chat request: providerId=${resolvedProviderId} without modelName — not borrowing default provider's model "${defaultModelName}", resolver will pick this provider's own model.`);
  } else if (!resolvedModelName) {
    cliLogger.error('SERVER', `❌ Chat request missing modelName AND no server default available (providerId=${resolvedProviderId}). Reject.`);
    throw new Error('Chat request rejected: modelName is required and no server default is configured. Caller must pass modelName explicitly.');
  }
  if (!request.modelName && !providerOverridden) {
    cliLogger.warn('SERVER', `⚠️ Chat request: modelName fallback to server default "${defaultModelName}" — caller should pass modelName explicitly. Check UI → AgentBridge → SDK chain.`);
  }
  if (!request.providerId) {
    cliLogger.warn('SERVER', `⚠️ Chat request: providerId fallback to server default "${defaultProviderId}" — caller should pass providerId explicitly.`);
  }

  const rawMetadata = (request as { metadata?: any }).metadata;
  const effortLevel = rawMetadata?.effortLevel ?? (request as any).effortLevel;

  return {
    mode,
    metadata: {
      ...(request.attachments ? { attachments: request.attachments } : {}),
      providerId: resolvedProviderId,
      ...(resolvedModelName ? { modelName: resolvedModelName } : {}),
      isAutoRouted: request.isAutoRouted,
      routeConfig: request.routeConfig,
      ...(effortLevel ? { effortLevel } : {}),
      ...(rawMetadata?.entryUserMessagePersisted ? { entryUserMessagePersisted: true } : {}),
    } as RuntimeMetadata,
  };
}
