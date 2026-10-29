/**
 * @openneox/sdk/testing/node · Node-only 测试辅助
 *
 * 主入口 @openneox/sdk/testing 不依赖 fs (兼容浏览器). 需要从文件路径读 JSONL fixture
 * 的能力放在这里独立入口, 浏览器场景不会被打包. 跟 SDK 主入口分开维护.
 */

import { readFileSync } from 'fs';
import { replayFromJsonl, type MockProvider } from './index.js';

export * from './index.js';

/**
 * 从 JSONL fixture 文件构造一个 replay provider (Node-only).
 *
 * @example
 *   import { replay } from '@openneox/sdk/testing/node';
 *   provider: replay('./fixtures/weather-run.jsonl')
 */
export function replay(fixturePath: string): MockProvider {
  const text = readFileSync(fixturePath, 'utf-8');
  return replayFromJsonl(text, fixturePath);
}
