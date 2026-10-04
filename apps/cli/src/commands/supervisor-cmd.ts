/**
 * Supervisor Command Handlers
 * 监督 Agent CLI 命令 - 已废弃，仅用于清理旧配置
 */

import { saveConfig, type NeoxConfig } from '@neoxlabs/platform/utils/config.js';

export interface SupervisorCommandContext {
  userConfig: NeoxConfig;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
}

/**
 * 处理 /supervisor 命令
 * 该功能已废弃，此命令仅用于清理旧配置
 */
export async function handleSupervisorCommand(
  ctx: SupervisorCommandContext,
  _actionArg?: string
): Promise<void> {
  // 清理旧的 supervisor 配置
  if (ctx.userConfig.supervisor || ctx.userConfig.assistant?.supervisorAgent) {
    const updated: NeoxConfig = { ...ctx.userConfig };
    if (updated.supervisor) {
      delete updated.supervisor;
    }
    if (updated.assistant?.supervisorAgent) {
      const nextAssistant = { ...updated.assistant };
      delete nextAssistant.supervisorAgent;
      if (Object.keys(nextAssistant).length === 0) {
        delete updated.assistant;
      } else {
        updated.assistant = nextAssistant;
      }
    }
    ctx.updateConfig(updated);
    saveConfig(updated);
  }
  ctx.logInfo('监督 Agent 已移除', '该配置已废弃并会自动清理。');
}
