/**
 * 内置的 Executor —— RUN / DEBUG
 *
 * 这两个 executor 在应用启动时由 WorkspacePlatformProvider 注入到
 * ExecutorRegistry. 第三方扩展想加新 executor (Coverage / Profile)
 * 直接 registry.register() 即可, 不动这里.
 */

import type { Executor } from '../../../../../ide/index.js';
import { RUN_EXECUTOR_ID, DEBUG_EXECUTOR_ID } from '../../../../../ide/index.js';

export const RUN_EXECUTOR: Executor = {
  id: RUN_EXECUTOR_ID,
  displayName: '运行',
  icon: 'Play',
  description: '运行当前配置',
};

export const DEBUG_EXECUTOR: Executor = {
  id: DEBUG_EXECUTOR_ID,
  displayName: '调试',
  icon: 'Bug',
  description: '以调试模式运行当前配置',
};

export const BUILT_IN_EXECUTORS: readonly Executor[] = [RUN_EXECUTOR, DEBUG_EXECUTOR];
