import type {
  ProviderProtocol as SharedProviderProtocol,
  ProviderModelConfig as SharedProviderModelConfig,
  ProviderConfigEntry,
  UserLanguage as SharedUserLanguage,
  OrchestratorConfig as SharedOrchestratorConfig,
  TaskType as SharedTaskType,
  TaskRoutingRule as SharedTaskRoutingRule,
  ContextSharingStrategy as SharedContextSharingStrategy,
  OrchestrationMode as SharedOrchestrationMode,
} from '@neoxlabs/kernel/types/configTypes.js';

export type UserLanguage = SharedUserLanguage;
export type OrchestratorConfig = SharedOrchestratorConfig;
export type TaskType = SharedTaskType;
export type TaskRoutingRule = SharedTaskRoutingRule;
export type ContextSharingStrategy = SharedContextSharingStrategy;
export type OrchestrationMode = SharedOrchestrationMode;
export type ProviderProtocol = SharedProviderProtocol;
export type ProviderModelConfig = SharedProviderModelConfig;
export type ProviderConfig = ProviderConfigEntry;
