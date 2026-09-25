/**
 * RunConfig Command Handler
 * 运行配置中心 CLI 命令
 */

import type { SelectionChoice } from '../cliTypes.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { type NeoxConfig } from '@neoxlabs/platform/utils/config.js';

export interface RunConfigCommandContext {
  userConfig: NeoxConfig;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  promptText: (
    question: string,
    options?: { defaultValue?: string; allowEmpty?: boolean; hint?: string }
  ) => Promise<string>;
  promptMultiSelect?: (
    question: string,
    choices: SelectionChoice[],
    defaultValues?: string[],
    hint?: string
  ) => Promise<string[]>;
  getProviders: () => ProviderConfigEntry[];
  activeProviderId?: string;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
  workDir?: string;
  llmCall?: (system: string, prompt: string) => Promise<string>;
  readFile?: (path: string) => Promise<string | null>;
  listDir?: (path: string) => Promise<string[]>;
}

/**
 * 运行配置分区
 */
type RunConfigSection = 'agentic' | 'show';

function normalizeRunConfigSection(value?: string): RunConfigSection | undefined {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'agentic' || normalized === 'show') {
    return normalized;
  }
  return undefined;
}

/**
 * Handle /runconfig command
 */
export async function handleRunConfigCommand(
  ctx: RunConfigCommandContext,
  actionArg?: string
): Promise<void> {
  let section = normalizeRunConfigSection(actionArg);

  if (!section) {
    try {
      const selectedSection = await ctx.promptSelect(
        '运行配置中心 (runconfig)',
        [
          { label: '[A] agentic', value: 'agentic' },
          { label: 'Show all', value: 'show' },
          { label: '← Back', value: 'back' },
        ],
        'agentic',
        '↑↓ 选择, Enter 确认, ESC 取消'
      );

      if (selectedSection === 'back') {
        return;
      }
      section = normalizeRunConfigSection(selectedSection);
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('操作取消', error?.message);
      }
      return;
    }
  }

  if (!section) {
    return;
  }

  if (section === 'show') {
    showRunConfigOverview(ctx);
    return;
  }

  if (section === 'agentic') {
    ctx.logInfo('agentic 配置', '当前版本暂无 agentic 专属配置项');
    return;
  }
}

function showRunConfigOverview(ctx: RunConfigCommandContext): void {
  const lines: string[] = [];
  lines.push('agentic: (暂无专属配置项)');

  ctx.logInfo('runconfig 概览', lines.join('\n'));
}
