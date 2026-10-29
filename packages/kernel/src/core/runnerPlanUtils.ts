import type { RawResponseStreamEvent } from '../types/index.js';
import { buildPlanAutoContinueEvent } from './runnerEventBuilders.js';

export function shouldAutoContinuePlan(plannerMode: boolean, response: string): boolean {
  if (!plannerMode) {
    return false;
  }
  const text = (response || '').trim();
  if (text.length < 40) {
    return false;
  }
  const normalized = text.toLowerCase();
  const planKeywords = [
    'planned steps',
    'plan:',
    'execution plan',
    '行动计划',
    '计划：',
    '计划如下',
    '方案：',
    '步骤计划',
  ];
  const hasKeyword = planKeywords.some(keyword => normalized.includes(keyword));
  if (!hasKeyword) {
    return false;
  }
  const listMatches =
    (text.match(/(^|\n)\s*[-*•]\s+/g) || []).length +
    (text.match(/(^|\n)\s*\d+\.\s+/g) || []).length;
  return listMatches >= 2;
}

export function buildPlanFollowupPrompt(): string {
  return 'Plan approved. Continue executing the plan step by step and start working immediately.';
}

export function maybeApplyPlannerAutoFollowup(options: {
  plannerMode: boolean;
  fullContent: string;
  planAutoFollowups: number;
  memory: {
    add: (message: { role: 'user'; content: string }) => void;
  };
}): { shouldContinue: boolean; planAutoFollowups: number; event?: RawResponseStreamEvent } {
  const { plannerMode, fullContent, memory } = options;
  if (!shouldAutoContinuePlan(plannerMode, fullContent) || options.planAutoFollowups >= 2) {
    return {
      shouldContinue: false,
      planAutoFollowups: options.planAutoFollowups,
    };
  }

  const nextPlanAutoFollowups = options.planAutoFollowups + 1;
  const followupPrompt = buildPlanFollowupPrompt();
  memory.add({
    role: 'user',
    content: followupPrompt,
  });

  return {
    shouldContinue: true,
    planAutoFollowups: nextPlanAutoFollowups,
    event: buildPlanAutoContinueEvent(fullContent, followupPrompt, nextPlanAutoFollowups),
  };
}
