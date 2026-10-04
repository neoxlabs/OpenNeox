/**
 * Provider/Model Command Types
 * Extended context for provider and model command handlers
 */

import type { ProviderConfigEntry, ProviderProtocol, ProviderModelConfig } from '@neoxlabs/platform/utils/config.js';
import type { SelectionChoice, TextPromptOptions } from '../cliTypes.js';

/**
 * Extended context for provider/model commands
 */
export interface ProviderCommandContext {
  // Current state
  providerId: string;
  provider: ProviderProtocol;
  model: string;
  providerSettings: ProviderConfigEntry;

  // Provider store operations
  getProviders: () => ProviderConfigEntry[];
  getProvider: (id: string) => ProviderConfigEntry | undefined;
  getDefaultProvider: () => ProviderConfigEntry | undefined;
  getProviderCount: () => number;
  resolveModel: (providerId: string) => string | undefined;
  addProvider: (options: {
    id?: string;
    name: string;
    protocol: ProviderProtocol;
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
    models: string[];
    setAsDefault: boolean;
  }) => ProviderConfigEntry;
  updateProvider: (id: string, updates: {
    name?: string;
    protocol?: ProviderProtocol;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
  }) => ProviderConfigEntry;
  deleteProvider: (id: string) => void;
  renameProvider: (oldId: string, newId: string) => ProviderConfigEntry;
  setDefaultProvider: (id: string) => void;
  setLastSelectedModel: (providerId: string, model: string) => void;
  addModel: (providerId: string, modelName: string, makeDefault: boolean, modelConfig?: Partial<ProviderModelConfig>) => ProviderConfigEntry;
  removeModel: (providerId: string, modelName: string) => ProviderConfigEntry;
  updateModelConfig: (providerId: string, modelName: string, updates: Partial<Omit<ProviderModelConfig, 'name' | 'createdAt'>>) => ProviderConfigEntry;

  // UI prompt methods
  promptText: (question: string, options?: TextPromptOptions) => Promise<string>;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string, hint?: string) => Promise<string>;
  promptYesNo: (question: string, initialYes?: boolean) => Promise<boolean>;
  promptConfirmKeyword: (message: string, keyword: string) => Promise<boolean>;
  selectProviderFromList: (message: string) => Promise<ProviderConfigEntry | null>;
  selectModelFromProvider: (provider: ProviderConfigEntry, message: string) => Promise<string | null>;
  selectModelFromCurrentProvider: (message: string) => Promise<string | null>;
  getProviderByIdentifier: (providerId?: string) => ProviderConfigEntry | null;

  // State update callbacks
  applyProviderState: (state: {
    providerId: string;
    provider: ProviderProtocol;
    model: string;
    providerSettings: ProviderConfigEntry;
  }) => Promise<void>;
  refreshProviderSettings: () => void;
  getProviderDisplayName: () => string;

  // Conversation context
  hasConversationContext?: () => Promise<boolean>;
  clearConversationContext?: () => Promise<void>;

  // UI and logging
  logInfo: (message: string, details?: string) => void;
  updateProviderDisplay: (providerName: string, model: string) => void;
}
