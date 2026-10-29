
// ─── 模式自动升级 ───

/**
 * 复杂度指标 — 用于判断是否应从 single 升级到 assistant
 */
export interface ComplexitySignals {
  /** 用户消息长度 */
  messageLength: number;
  /** 涉及的文件数（从消息中提取的路径数） */
  mentionedFiles: number;
  /** 是否包含多步骤指令（"先...然后...最后"） */
  hasMultipleSteps: boolean;
  /** 是否涉及多个系统（前端+后端、测试+实现等） */
  multipleSystemsMentioned: boolean;
  /** 当前 session 已用 token 数 */
  sessionTokens: number;
  exploreCallCount: number;
}

/**
 * 评估任务复杂度 — 返回是否建议升级到 assistant 模式
 *
 * 阈值设计（保守，避免误升级）：
 * - 满足 3+ 个信号才建议升级
 * - 单个强信号（如 10+ 文件）也触发
 */
export function shouldSuggestUpgrade(signals: ComplexitySignals): {
  suggest: boolean;
  reason?: string;
  confidence: number;
} {
  let score = 0;
  const reasons: string[] = [];

  // 消息很长（可能包含复杂需求）
  if (signals.messageLength > 500) {
    score += 1;
    reasons.push('long message');
  }

  // 涉及很多文件
  if (signals.mentionedFiles >= 5) {
    score += 2; // 强信号
    reasons.push(`${signals.mentionedFiles} files mentioned`);
  } else if (signals.mentionedFiles >= 3) {
    score += 1;
    reasons.push(`${signals.mentionedFiles} files mentioned`);
  }

  // 多步骤指令
  if (signals.hasMultipleSteps) {
    score += 1;
    reasons.push('multi-step instructions');
  }

  // 跨系统
  if (signals.multipleSystemsMentioned) {
    score += 2; // 强信号
    reasons.push('multiple systems involved');
  }

  // 已经用了很多 explore（说明任务复杂）
  if (signals.exploreCallCount >= 3) {
    score += 1;
    reasons.push(`${signals.exploreCallCount} explore calls used`);
  }

  const suggest = score >= 3;
  const confidence = Math.min(score / 5, 1);

  return {
    suggest,
    reason: suggest ? `Complexity detected: ${reasons.join(', ')}` : undefined,
    confidence,
  };
}

/**
 * 从用户消息中提取复杂度信号
 */
export function extractComplexitySignals(
  message: string,
  sessionContext?: { totalTokens?: number; exploreCount?: number },
): ComplexitySignals {
  // 检测多步骤指令
  const stepPatterns = [
    /先[^。]*然后/,
    /第[一二三四五六七八九十\d]+[步,:：]/,
    /first.*then.*finally/i,
    /step\s*[1-9]/i,
    /1\.\s.*2\.\s/,
  ];
  const hasMultipleSteps = stepPatterns.some(p => p.test(message));

  // 检测跨系统
  const systemPatterns = [
    /前端.*后端|后端.*前端|frontend.*backend/i,
    /测试.*实现|实现.*测试|test.*implement/i,
    /client.*server|server.*client/i,
    /api.*ui|ui.*api/i,
    /数据库.*接口|接口.*数据库|database.*api/i,
  ];
  const multipleSystemsMentioned = systemPatterns.some(p => p.test(message));

  // 提取文件路径
  const filePaths = message.match(/[\w/-]+\.\w{1,10}/g) ?? [];
  const uniqueFiles = new Set(filePaths);

  return {
    messageLength: message.length,
    mentionedFiles: uniqueFiles.size,
    hasMultipleSteps,
    multipleSystemsMentioned,
    sessionTokens: sessionContext?.totalTokens ?? 0,
    exploreCallCount: sessionContext?.exploreCount ?? 0,
  };
}
