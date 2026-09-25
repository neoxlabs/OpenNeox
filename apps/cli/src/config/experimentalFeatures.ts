/**
 * Experimental Features Configuration
 * 
 * 实验性功能配置，允许用户启用/禁用新功能
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface ExperimentalFeaturesConfig {
  /** 使用独立输入处理器（避免 Event Loop 阻塞） */
  useInputWorker: boolean;
  
  /** 使用异步流处理器（处理大内容） */
  useStreamProcessor: boolean;
  
  /** Event Loop 监控 */
  eventLoopMonitoring: boolean;
  
  /** 调试模式 */
  debug: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ExperimentalFeaturesConfig = {
  useInputWorker: true,
  useStreamProcessor: true, // 默认启用，已经过测试
  eventLoopMonitoring: true, // 默认启用监控
  debug: false,
};

/**
 * 从环境变量读取配置
 */
export function loadExperimentalConfig(): ExperimentalFeaturesConfig {
  const config: ExperimentalFeaturesConfig = {
    useInputWorker: process.env.NEOX_EXPERIMENTAL_INPUT_WORKER !== '0', // 默认启用，设置=0可关闭
    useStreamProcessor: process.env.NEOX_EXPERIMENTAL_STREAM_PROCESSOR !== '0', // 默认启用
    eventLoopMonitoring: process.env.NEOX_EVENT_LOOP_MONITORING !== '0', // 默认启用
    debug: process.env.CLI_DEBUG === '1', // 调试模式默认关闭
  };

  if (config.debug) {
    cliLogger.info('EXPERIMENTAL', 'Loaded configuration', config);
  }

  return config;
}

/**
 * 全局配置实例
 */
let globalConfig: ExperimentalFeaturesConfig | null = null;

/**
 * 获取全局配置
 */
export function getExperimentalConfig(): ExperimentalFeaturesConfig {
  if (!globalConfig) {
    globalConfig = loadExperimentalConfig();
  }
  return globalConfig;
}

/**
 * 更新配置（运行时）
 */
export function updateExperimentalConfig(updates: Partial<ExperimentalFeaturesConfig>): void {
  if (!globalConfig) {
    globalConfig = loadExperimentalConfig();
  }
  
  Object.assign(globalConfig, updates);
  
  cliLogger.info('EXPERIMENTAL', 'Configuration updated', globalConfig);
}

/**
 * 重置配置为默认值
 */
export function resetExperimentalConfig(): void {
  globalConfig = { ...DEFAULT_CONFIG };
  cliLogger.info('EXPERIMENTAL', 'Configuration reset to defaults');
}

/**
 * 打印配置信息
 */
export function printExperimentalConfig(): void {
  const config = getExperimentalConfig();
  
  console.log('\nExperimental Features (默认全部启用):');
  console.log('━'.repeat(50));
  console.log(`  Input Worker:          ${config.useInputWorker ? '✓ Enabled' : '✗ Disabled'} (Default: ON)`);
  console.log(`  Stream Processor:      ${config.useStreamProcessor ? '✓ Enabled' : '✗ Disabled'} (Default: ON)`);
  console.log(`  Event Loop Monitoring: ${config.eventLoopMonitoring ? '✓ Enabled' : '✗ Disabled'} (Default: ON)`);
  console.log(`  Debug Mode:            ${config.debug ? '✓ Enabled' : '✗ Disabled'} (Default: OFF)`);
  console.log('━'.repeat(50));
  console.log('\n环境变量 (所有功能默认开启，仅需要关闭时设置):');
  console.log('  NEOX_EXPERIMENTAL_INPUT_WORKER=0       # 关闭输入工作线程');
  console.log('  NEOX_EXPERIMENTAL_STREAM_PROCESSOR=0   # 关闭流处理器');
  console.log('  NEOX_EVENT_LOOP_MONITORING=0           # 关闭事件循环监控');
  console.log('  CLI_DEBUG=1                            # 开启调试模式（默认关闭）');
  console.log('  INK_MEM=1                              # 开启内存监控日志（默认关闭）');
  console.log();
}

