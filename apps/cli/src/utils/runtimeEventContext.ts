import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { RuntimeEventContext } from './runtimeEvents.js';

/**
 * The event handler is built once, when the server connection comes up, but the provider,
 * model and session change afterwards (/model, /session new, resume). They are therefore
 * read through getters on every event. Capturing them as values filed every request under
 * the model active at startup: a session run on deepseek-v4.1-flash reported 56 of its 57
 * requests as deepseek-v4-flash in the exit summary.
 */
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
  getProvider: () => string;
  getModel: () => string;
  getSessionId: () => string | undefined;
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
    get provider() { return options.getProvider(); },
    get model() { return options.getModel(); },
    get sessionId() { return options.getSessionId(); },
    tokenUsage: options.tokenUsage,
  };
}

interface BuildRuntimeEventContextFromMainStateOptions
  extends Omit<BuildRuntimeEventContextOptions, 'getUiController'> {
  getUiController?: () => InkUIAdapter | null;
}

export function buildRuntimeEventContextFromMainState(
  options: BuildRuntimeEventContextFromMainStateOptions,
): RuntimeEventContext {
  return buildRuntimeEventContext({
    ...options,
    getUiController: options.getUiController ?? (() => options.uiController),
  });
}
