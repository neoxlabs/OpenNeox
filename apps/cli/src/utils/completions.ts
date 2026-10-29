/**
 * Command Completion Suggestions
 * Provides autocomplete suggestions for CLI commands
 */

import type { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { getCliCommandHints } from '../constants.js';

/**
 * Context for completion suggestions
 */
export interface CompletionContext {
  providerStore: ProviderStore;
  providerSettings: ProviderConfigEntry | null;
}

/**
 * Get autocomplete suggestions for the current input
 */
export function getCompletionSuggestions(
  ctx: CompletionContext,
  inputValue: string
): string[] {
  const trimmed = inputValue.trim();
  if (!trimmed.startsWith('/')) {
    return [];
  }

  const hasTrailingSpace = /\s$/.test(inputValue);
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) {
    return [];
  }

  const command = tokens[0];
  const args = tokens.slice(1);
  const providerIds = ctx.providerStore.getProviders().map(provider => provider.id);
  const modelNames = ctx.providerSettings?.models.map(model => model.name) || [];
  const providerActions = ['list', 'add', 'edit', 'remove', 'default', 'use'];
  const modelActions = ['list', 'add', 'use', 'remove', 'default'];

  const completeAction = (cmd: string, actions: string[]) => {
    return actions.map(action => `${cmd} ${action}`);
  };

  const baseForArgument = (): string => {
    if (hasTrailingSpace) {
      return inputValue;
    }
    const idx = inputValue.lastIndexOf(' ');
    if (idx === -1) {
      return `${inputValue} `;
    }
    return inputValue.slice(0, idx + 1);
  };

  /**
   * 用户正在输入的那个片段 (末尾还没打完的 token)。有尾随空格 = 新起一个参数, 返回空。
   */
  const activeFragment = (): string => (hasTrailingSpace ? '' : (tokens[tokens.length - 1] ?? ''));

  const filterByFragment = (items: string[]): string[] => {
    const frag = activeFragment().toLowerCase();
    if (!frag) return items;
    return items.filter((item) => item.toLowerCase().startsWith(frag));
  };

  // If it's just a partial command (no space yet), suggest matching commands
  if (args.length === 0 && !hasTrailingSpace) {
    const matches = getCliCommandHints().filter(hint =>
      hint.startsWith(trimmed)  // 支持精确匹配，输入完整命令也能继续提示
    );
    if (matches.length > 0) {
      return matches;
    }
  }

  switch (command) {
    case '/provider': {
      if (args.length === 0 || (args.length === 1 && !hasTrailingSpace)) {
        return completeAction('/provider', providerActions);
      }
      const action = args[0];
      if (!providerActions.includes(action)) {
        return completeAction('/provider', providerActions);
      }
      if (['use', 'edit', 'remove', 'default'].includes(action)) {
        if (args.length === 1 && !hasTrailingSpace) {
          return providerIds.map(id => `/provider ${action} ${id}`);
        }
        const base = baseForArgument();
        return filterByFragment(providerIds).map(id => `${base}${id}`);
      }
      return [];
    }
    case '/model': {
      if (args.length === 0 || (args.length === 1 && !hasTrailingSpace)) {
        return completeAction('/model', modelActions);
      }
      const action = args[0];
      const restArgs = args.slice(1);
      if (!modelActions.includes(action)) {
        return completeAction('/model', modelActions);
      }
      switch (action) {
        case 'list': {
          if (providerIds.length === 0) {
            return [];
          }
          const base = restArgs.length === 0 ? `${trimmed} ` : baseForArgument();
          return filterByFragment(providerIds).map(id => `${base}${id}`);
        }
        case 'use': {
          if (restArgs.length === 0) {
            return Array.from(new Set([
              ...providerIds.map(id => `/model use ${id}`),
              ...modelNames.map(name => `/model use ${name}`),
            ]));
          }
          const providerId = restArgs[0];
          const provider = ctx.providerStore.getProvider(providerId);
          if (provider) {
            const base = baseForArgument();
            return filterByFragment((provider.models || []).map(m => m.name)).map(name => `${base}${name}`);
          }
          if (modelNames.length === 0) {
            return [];
          }
          /* restArgs.length===1 且没尾随空格 = 用户正在打的就是这个模型名本身,
           * base 要取到它前面 (baseForArgument), 再按片段过滤 —— 否则会拼成
           * "/model use <已打完的模型> <另一个模型>"。 */
          const base = baseForArgument();
          return filterByFragment(modelNames).map(name => `${base}${name}`);
        }
        case 'remove':
        case 'delete':
        case 'default': {
          if (modelNames.length === 0) {
            return [];
          }
          const base = restArgs.length === 0 ? `${trimmed} ` : baseForArgument();
          return filterByFragment(modelNames).map(name => `${base}${name}`);
        }
        default:
          return [];
      }
    }
    default:
      return [];
  }
}
