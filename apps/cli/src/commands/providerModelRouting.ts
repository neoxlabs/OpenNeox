import {
  showProviderOptions,
  applyProviderChange,
  handleProviderAddCommand,
  handleProviderEditCommand,
  handleProviderDeleteCommand,
  handleProviderDefaultCommand,
  handleInteractiveProviderSelection,
  showModelOptionsCommand,
  handleModelAddCommand,
  handleModelSelectionFlow,
  handleModelRemoveCommand,
  handleModelDefaultCommand,
  handleInteractiveModelSelection,
  handleModelConfigCommand,
} from './index.js';
import type { ProviderCommandContextWithOutput } from '../contexts/coreCommandContexts.js';

export async function handleProviderRouting(
  args: string[],
  providerCtx: ProviderCommandContextWithOutput,
): Promise<void> {
  const action = (args[0] || '').toLowerCase();
  switch (action) {
    case '':
      await handleInteractiveProviderSelection(providerCtx); break;
    case 'list':
      showProviderOptions(providerCtx); break;
    case 'add':
      await handleProviderAddCommand(providerCtx); break;
    case 'edit':
    case 'update':
      await handleProviderEditCommand(providerCtx, args[1]); break;
    case 'remove':
    case 'delete':
      await handleProviderDeleteCommand(providerCtx, args[1]); break;
    case 'use':
      await applyProviderChange(providerCtx, args[1]); break;
    case 'default':
      await handleProviderDefaultCommand(providerCtx, args[1]); break;
    default:
      await applyProviderChange(providerCtx, action); break;
  }
}

export async function handleModelRouting(
  args: string[],
  modelCtx: ProviderCommandContextWithOutput,
): Promise<void> {
  const action = (args[0] || '').toLowerCase();
  const rest = args.slice(1);
  switch (action) {
    case '':
      await handleInteractiveModelSelection(modelCtx); break;
    case 'list':
      await showModelOptionsCommand(modelCtx, rest[0]); break;
    case 'add':
      await handleModelAddCommand(modelCtx, rest[0]); break;
    case 'remove':
    case 'delete':
      await handleModelRemoveCommand(modelCtx, rest[0]); break;
    case 'default':
      await handleModelDefaultCommand(modelCtx, rest[0]); break;
    case 'use':
      await handleModelSelectionFlow(modelCtx, rest[0], rest[1]); break;
    case 'config':
    case 'configure':
      await handleModelConfigCommand(modelCtx, rest[0]); break;
    default:
      await handleModelSelectionFlow(modelCtx, undefined, action); break;
  }
}
