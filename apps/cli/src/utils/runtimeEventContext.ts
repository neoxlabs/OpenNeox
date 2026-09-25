import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { RuntimeEventContext } from './runtimeEvents.js';

interface BuildRuntimeEventContextOptions {
  uiController: InkUIAdapter | null;
  getUiController: () => InkUIAdapter | null;
  lastToolCallArgs: Map<string, Record<string, any>>;
  toolIdToName: Map<string, string>;
  toolIdToArgs: Map<string, Record<string, any>>;
  pushTokenStats: RuntimeEventContext['pushTokenStats'];
  getRuntimeTokens: RuntimeEventContext['getRuntimeTokens'];
  setRuntimeTokens: RuntimeEventContext['setRuntimeTokens'];
  getStreamingTokenCount: NonNullable<RuntimeEventContext['getStreamingTokenCount']>;
  setStreamingTokenCount: NonNullable<RuntimeEventContext['setStreamingTokenCount']>;
  provider: string;
  model: string;
  sessionId: string | undefined;
  tokenUsage: RuntimeEventContext['tokenUsage'];
}

export function buildRuntimeEventContext(
  options: BuildRuntimeEventContextOptions,
): RuntimeEventContext {
  return {
    uiController: options.uiController,
    getUiController: options.getUiController,
    lastToolCallArgs: options.lastToolCallArgs,
    toolIdToName: options.toolIdToName,
    toolIdToArgs: options.toolIdToArgs,
    pushTokenStats: options.pushTokenStats,
    getRuntimeTokens: options.getRuntimeTokens,
    setRuntimeTokens: options.setRuntimeTokens,
    getStreamingTokenCount: options.getStreamingTokenCount,
    setStreamingTokenCount: options.setStreamingTokenCount,
    provider: options.provider,
    model: options.model,
    sessionId: options.sessionId,
    tokenUsage: options.tokenUsage,
  };
}

interface BuildRuntimeEventContextFromMainStateOptions {
  uiController: InkUIAdapter | null;
  getUiController?: () => InkUIAdapter | null;
  lastToolCallArgs: Map<string, Record<string, any>>;
  toolIdToName: Map<string, string>;
  toolIdToArgs: Map<string, Record<string, any>>;
  pushTokenStats: RuntimeEventContext['pushTokenStats'];
  getRuntimeTokens: RuntimeEventContext['getRuntimeTokens'];
  setRuntimeTokens: RuntimeEventContext['setRuntimeTokens'];
  getStreamingTokenCount: NonNullable<RuntimeEventContext['getStreamingTokenCount']>;
  setStreamingTokenCount: NonNullable<RuntimeEventContext['setStreamingTokenCount']>;
  provider: string;
  model: string;
  sessionId: string | undefined;
  tokenUsage: RuntimeEventContext['tokenUsage'];
}

export function buildRuntimeEventContextFromMainState(
  options: BuildRuntimeEventContextFromMainStateOptions,
): RuntimeEventContext {
  return buildRuntimeEventContext({
    uiController: options.uiController,
    getUiController: options.getUiController ?? (() => options.uiController),
    lastToolCallArgs: options.lastToolCallArgs,
    toolIdToName: options.toolIdToName,
    toolIdToArgs: options.toolIdToArgs,
    pushTokenStats: options.pushTokenStats,
    getRuntimeTokens: options.getRuntimeTokens,
    setRuntimeTokens: options.setRuntimeTokens,
    getStreamingTokenCount: options.getStreamingTokenCount,
    setStreamingTokenCount: options.setStreamingTokenCount,
    provider: options.provider,
    model: options.model,
    sessionId: options.sessionId,
    tokenUsage: options.tokenUsage,
  });
}
