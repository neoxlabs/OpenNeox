/**
 * readfile System - 智能文件读取系统
 *
 * 提供三种策略:
 * 1. AST 索引模式 - 精准定位，需要构建索引
 * 2. Search + Chunk - 无需索引的备用方案
 * 3. 传统 Chunk - 兜底方案
 */

// 导出类型
export * from './types.js';

// 导出核心类
export { SmartReader, createSmartReader } from './smartReader.js';
export { IndexManager, createIndexManager } from './indexManager.js';

// 导出工具函数
export * from './utils.js';

// 导出解析器
export * from './parsers/index.js';

// 导出工具定义
export { createSmartReadTools } from './tools.js';

// 导出动态提示函数
export {
  getIndexStatus,
  getSmartReadStrategyHint,
  getSmartReadDynamicPrompt,
  type IndexStatusInfo,
} from './tools.js';
