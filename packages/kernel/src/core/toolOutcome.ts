/**
 * Determine tool success from structured self-reported outcomes, not only from
 * whether invocation throws.
 * Object results use their explicit success or error fields, while string
 * results use the fixed failure marker produced by the tool layer. Generic
 * text such as a log line beginning with "Error" is not treated as failure.
 */

/* 判据的实现搬到了 types/toolResult.ts —— 跟它读的那几种"结果形状"住在一起,
 * 也让 neox-core 侧的工具能合法 import 到 (core/toolOutcome.js 不在 kernel 的
 * exports 清单里, 深引会被包边界闸挡下)。这里保留原路径, 老调用方不用改。 */
export { readToolSelfReportedOutcome } from './types/toolResult.js';
export { markToolFailure, TOOL_FAILURE_TAG } from './types/toolResult.js';
