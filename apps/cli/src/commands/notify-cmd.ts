/**
 * Notify Command Handlers
 * Completion alerts (sound/notification).
 */

import path from 'path';
import type { SelectionChoice } from '../cliTypes.js';
import { saveConfig, SOUNDS_DIR, type CompletionAlertConfig, type NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import {
  DEFAULT_COMPLETION_SOUND,
  getCompletionAlertConfig,
  listSoundFiles,
  listMacOSSystemSounds,
  getMacOSSystemSoundsDir,
} from '../utils/completionAlerts.js';
import { t, formatMessage } from '../i18n/index.js';

export interface NotifyCommandContext {
  userConfig: NeoxConfig;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
}

export async function handleNotifyCommand(
  ctx: NotifyCommandContext,
  actionArg?: string
): Promise<void> {
  const alertConfig = getCompletionAlertConfig(ctx.userConfig);
  let action = actionArg?.toLowerCase();

  if (!action) {
    const soundLabel = alertConfig.soundFile
      ? alertConfig.soundFile
      : `Default: ${DEFAULT_COMPLETION_SOUND}`;
    const soundStatus = alertConfig.soundEnabled ? t().notify.on : t().notify.off;
    const notifyStatus = alertConfig.notifyEnabled ? t().notify.on : t().notify.off;

    try {
      action = await ctx.promptSelect(
        t().notify.completionAlerts,
        [
          {
            label: `${formatMessage(t().notify.soundLabel, { status: soundStatus })} — ${t().notify.soundDesc}`,
            value: 'sound',
          },
          {
            label: `${formatMessage(t().notify.soundFileLabel, { file: soundLabel })}`,
            value: 'soundfile',
          },
          {
            label: `${formatMessage(t().notify.notificationLabel, { status: notifyStatus })} — ${t().notify.notificationDesc}`,
            value: 'notify',
          },
        ],
        'sound',
        t().notify.selectHint
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo('Selection cancelled', error?.message);
      }
      return;
    }
  }

  switch (action) {
    case 'sound': {
      try {
        const value = await ctx.promptSelect(
          t().notify.enableSound,
          [
            { label: t().notify.on, value: 'on' },
            { label: t().notify.off, value: 'off' },
          ],
          alertConfig.soundEnabled ? 'on' : 'off'
        );
        updateCompletionAlertConfig(ctx, { soundEnabled: value === 'on' });
        ctx.logInfo(t().notify.soundUpdated, value === 'on' ? t().notify.enabled : t().notify.disabled);
      } catch (error: any) {
        if (error?.message !== 'cancelled') {
          ctx.logInfo('Selection cancelled', error?.message);
        }
      }
      break;
    }
    case 'notify': {
      try {
        const value = await ctx.promptSelect(
          t().notify.enableNotification,
          [
            { label: t().notify.on, value: 'on' },
            { label: t().notify.off, value: 'off' },
          ],
          alertConfig.notifyEnabled ? 'on' : 'off'
        );
        updateCompletionAlertConfig(ctx, { notifyEnabled: value === 'on' });
        ctx.logInfo(t().notify.notificationUpdated, value === 'on' ? t().notify.enabled : t().notify.disabled);
      } catch (error: any) {
        if (error?.message !== 'cancelled') {
          ctx.logInfo('Selection cancelled', error?.message);
        }
      }
      break;
    }
    case 'soundfile': {
      const customFiles = listSoundFiles();
      const systemSounds = listMacOSSystemSounds();

      // 如果没有任何声音文件
      if (customFiles.length === 0 && systemSounds.length === 0) {
        ctx.logInfo(t().notify.noSoundFiles, formatMessage(t().notify.placeSoundFiles, { dir: SOUNDS_DIR }));
        return;
      }

      const choices: SelectionChoice[] = [];

      // 添加 macOS 系统声音
      if (systemSounds.length > 0) {
        choices.push({
          label: t().notify.systemSounds,
          value: '__separator_system__',
          description: '',
        });
        for (const file of systemSounds) {
          const systemPath = path.join(getMacOSSystemSoundsDir(), file);
          const isCurrent = alertConfig.soundFile === systemPath;
          choices.push({
            label: `${t().notify.systemSoundPrefix} ${file}`,
            value: systemPath,
            description: isCurrent ? t().notify.current : undefined,
          });
        }
      }

      // 添加自定义声音
      if (customFiles.length > 0) {
        choices.push({
          label: t().notify.customSounds,
          value: '__separator_custom__',
          description: '',
        });
        for (const file of customFiles) {
          const isCurrent = alertConfig.soundFile === file;
          choices.push({
            label: file,
            value: file,
            description: isCurrent ? t().notify.current : undefined,
          });
        }
      }

      // 过滤掉分隔符
      const selectableChoices = choices.filter(c => !c.value.startsWith('__separator'));

      // 确定默认值
      let defaultValue = selectableChoices[0]?.value || '';
      if (alertConfig.soundFile) {
        const found = selectableChoices.find(c => c.value === alertConfig.soundFile);
        if (found) {
          defaultValue = found.value;
        }
      }

      try {
        const selected = await ctx.promptSelect(
          t().notify.selectSound,
          choices,
          defaultValue,
          t().notify.selectHint
        );

        // 跳过分隔符选择
        if (selected.startsWith('__separator')) {
          return;
        }

        updateCompletionAlertConfig(ctx, { soundFile: selected });
        ctx.logInfo(t().notify.soundFileUpdated, path.basename(selected));
      } catch (error: any) {
        if (error?.message !== 'cancelled') {
          ctx.logInfo('Selection cancelled', error?.message);
        }
      }
      break;
    }
    default:
      ctx.logInfo(t().notify.invalidAction, t().notify.useNotifyToView);
  }
}

function updateCompletionAlertConfig(
  ctx: NotifyCommandContext,
  updates: Partial<CompletionAlertConfig>
): void {
  const current = getCompletionAlertConfig(ctx.userConfig);
  const next: CompletionAlertConfig = { ...current, ...updates };
  const updatedConfig: NeoxConfig = {
    ...ctx.userConfig,
    completionAlerts: next,
  };
  ctx.updateConfig(updatedConfig);
  saveConfig(updatedConfig);
}
