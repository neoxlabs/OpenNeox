export type ToolOutcomeSnapshotLike = {
  name: string;
  status: 'success' | 'error' | 'already_done';
};

export function buildLowProgressReplanPrompt(streak: number, recentOutcomes: ToolOutcomeSnapshotLike[]): string {
  const recentFails = recentOutcomes.filter(o => o.status === 'error');
  const failedTools = [...new Set(recentFails.map(o => o.name))];
  const lines = [
    '[PROGRESS GATE]',
    `连续 ${streak} 轮迭代没有实质进展（工具调用大多失败）。`,
    '',
    '停下来重新思考：',
  ];

  if (failedTools.includes('edit') || failedTools.includes('edit_file')) {
    lines.push('- edit 失败：用 readfile(path) 看清当前原文，把要改的那段逐字符照抄进 old_string，再用 edit(file_path, old_string, new_string) 修改（old_string 要唯一命中一处）。');
  }
  if (failedTools.includes('search') || failedTools.includes('search_files') || failedTools.includes('grep')) {
    lines.push('- 搜索失败：换关键词、换目录范围、或用 show_tree 先看目录结构再定位。');
  }
  if (failedTools.includes('readfile') || failedTools.includes('read')) {
    lines.push('- 读文件失败：确认路径是否正确，用 search_files 查找实际文件名。');
  }
  if (failedTools.includes('execute_shell')) {
    lines.push('- Shell 命令失败：检查命令语法和路径，确认依赖是否安装。');
  }

  if (
    failedTools.length === 0 ||
    !failedTools.some(t => ['edit', 'edit_file', 'search', 'search_files', 'grep', 'readfile', 'read', 'execute_shell'].includes(t))
  ) {
    lines.push('- 分析前几次失败的具体错误信息，找出共同原因。');
    lines.push('- 考虑完全不同的方法来达成目标。');
  }

  lines.push('');
  lines.push('必须：先说明之前为什么失败，再用不同的策略继续。不要重复同样的操作。');
  return lines.join('\n');
}

export function buildEvidenceRequiredPrompt(reason: string): string {
  const reasonHint: Record<string, string> = {
    no_tool_execution: '当前任务是执行型任务，必须先实际调用工具再收尾。',
    no_successful_tool_result: '最近工具都没成功，先修复失败路径再继续。',
    missing_mutation_evidence: '修复/实现类任务必须有真实改动证据（不是只读或只说）。',
    missing_validation_after_mutation: '有改动但缺少验证，请补 read/test/build/check 等验证证据。',
    missing_verification_evidence: '当前任务需要验证证据（read/search/test/build/check 之一）。',
    empty_final_output: '你已经完成了工具调用，但上一轮没有输出最终结果。现在必须基于已有信息直接给出最终答案，不要再调用工具，也不要留空。',
    intermediate_progress_text: '当前回复是阶段性进展，不应作为最终完成。',
    tool_call_text_leak: '检测到工具调用封包文本（如 assistant to=...）。请直接发起真实 tool call，不要输出封包文本。',
    insufficient_tool_calls: '成功的工具调用次数不足，请继续调用工具完成任务。',
    continuation_intent_detected: '你的回复表达了后续计划但没有执行。不要只说打算做什么——直接调用工具去做。',
  };
  const hint = reasonHint[reason] || '请补齐可验证的执行证据后再结束。';
  return [
    '[COMPLETION GATE]',
    `Cannot conclude task yet: ${reason}.`,
    `Hint: ${hint}`,
    'Before final answer, provide concrete execution evidence:',
    '- If code/files changed, verify via read/test/build/lint/check command.',
    '- If command already ran, quote key output signals.',
    'Then continue and finish only after evidence is present.',
  ].join('\n');
}

export function enrichToolResult(result: string, toolName: string, duration: number): string {
  if (duration < 1000) {
    return result;
  }
  const timeStr = duration >= 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`;
  const header = `⏱️ [${toolName} took ${timeStr}]\n\n`;
  return header + result;
}

export function buildPerformanceHint(
  toolMetricsHistory: Array<{ name: string; duration: number; success: boolean }>,
): string | null {
  const recentMetrics = toolMetricsHistory.slice(-15);
  if (recentMetrics.length < 5) {
    return null;
  }

  const slowToolCounts = new Map<string, { count: number; totalTime: number }>();
  for (const metric of recentMetrics) {
    if (metric.duration > 2000) {
      const existing = slowToolCounts.get(metric.name) || { count: 0, totalTime: 0 };
      slowToolCounts.set(metric.name, {
        count: existing.count + 1,
        totalTime: existing.totalTime + metric.duration,
      });
    }
  }

  const failureCounts = new Map<string, { total: number; failed: number }>();
  for (const metric of recentMetrics) {
    const existing = failureCounts.get(metric.name) || { total: 0, failed: 0 };
    failureCounts.set(metric.name, {
      total: existing.total + 1,
      failed: existing.failed + (metric.success ? 0 : 1),
    });
  }

  const hints: string[] = [];
  for (const [toolName, stats] of slowToolCounts.entries()) {
    if (stats.count >= 3) {
      hints.push(`⚠️ Tool "${toolName}" is slow (>2s), called ${stats.count} times, total ${(stats.totalTime / 1000).toFixed(1)}s. Consider caching results or using alternatives.`);
    }
  }
  for (const [toolName, stats] of failureCounts.entries()) {
    const failRate = stats.failed / stats.total;
    if (stats.total >= 3 && failRate >= 0.5) {
      hints.push(`⚠️ Tool "${toolName}" has ${Math.round(failRate * 100)}% failure rate (${stats.failed}/${stats.total}). Check arguments or try different approach.`);
    }
  }
  if (hints.length === 0) {
    return null;
  }
  return `\n[Performance Notice]\n${hints.join('\n')}\n`;
}

export function buildToolUsageNudge(toolNames: string, template?: string): string {
  const effectiveTemplate = template
    ?? '[COMPLETION GATE]\n'
    + '你刚才回复了纯文本但没有调用任何工具。\n'
    + '当前任务需要你使用工具来完成实际操作。\n'
    + '请不要只描述计划，直接调用合适的工具开始执行。\n'
    + '可用工具: {toolNames}';
  return effectiveTemplate.replace('{toolNames}', toolNames);
}
