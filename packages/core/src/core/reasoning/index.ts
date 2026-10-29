/**
 * 运行时辅助组件(原 Adaptive Reasoning Engine):
 * - ErrorPatternMemory: 错误模式记忆 + 递进式恢复
 * - ToolUsageAdvisor:   工具使用效率顾问
 * - AutoVerifyPipeline: 写文件后自动编译验证
 * - projectContextDetector: 零成本项目上下文探测
 *
 * 注:原 ReasoningGate / TaskComplexityAnalyzer / PostActionReflector / TaskIntentTracker
 * 已下线 — 它们靠在 turn 之间往 memory 塞 [FOCUS] / [VERIFY] / [TASK PROGRESS] 等 system
 * 消息来"规则化 LLM 涌现行为", 违反"agent 已收手就不能私自继续"红线, 整体删除。
 */

export { ErrorPatternMemory } from '@neoxlabs/kernel/core/reasoning/errorPatternMemory.js';
export type { ErrorCategory as ErrorPatternCategory } from '@neoxlabs/kernel/core/reasoning/errorPatternMemory.js';

export { ToolUsageAdvisor } from '@neoxlabs/kernel/core/reasoning/toolUsageAdvisor.js';

export { AutoVerifyPipeline } from '@neoxlabs/kernel/core/reasoning/autoVerifyPipeline.js';
export type { VerifyResult } from '@neoxlabs/kernel/core/reasoning/autoVerifyPipeline.js';

export { detectProjectContext, formatProjectContextPrompt, clearProjectContextCache } from '@neoxlabs/kernel/core/reasoning/projectContextDetector.js';
export type { ProjectContext } from '@neoxlabs/kernel/core/reasoning/projectContextDetector.js';
