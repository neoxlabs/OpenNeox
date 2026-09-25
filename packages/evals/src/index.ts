/**
 * @openneox/evals — Neox Agent benchmark harness.
 *
 *   公开仓库, 谁都能跑, 数字可复现. (跟 Cursor/Devin 闭源 harness 形成对比.)
 *
 *   能跑哪些 bench (规划):
 *     · SWE-bench Verified / Lite — Phase B 在做
 *     · HumanEval / LiveCodeBench — Phase C
 *     · Neox 自家 Browser-verify bench — Phase D (改完真去 browser 验证, Neox 独有的差异化能力量化)
 *
 *   架构: 包内 src/runners/<bench>.ts 是具体 bench 的编排器,
 *         src/harness/ 是通用能力 (headlessAgent / docker / grader),
 *         src/report/ 出 JSON + HTML scorecard.
 *
 *   依赖: @openneox/core 直接 import (内部包, 完整工具集); 不绕 @openneox/sdk
 *         避免被 SDK 公开 surface 的进度卡住.
 */

export { runHeadlessAgent } from './harness/headlessAgent.js';
export type {
  HeadlessAgentOptions,
  HeadlessAgentResult,
  HeadlessProviderType,
} from './harness/headlessAgent.js';
