import type { Message, MessageContent, MessageContentPart, Tool } from '../types/index.js';
import { getTextFromContent } from './messageUtils.js';

export interface ContextBreakdownDetails {
  systemPromptTokens: number;
  hiddenInstructionsTokens: number;
  agentPrefixTokens: number;
  userTextTokens: number;
  assistantTextTokens: number;
  attachmentTextTokens: number;
  imageDescriptionTokens: number;
  fileDescriptionTokens: number;
  toolDefinitionsTokens: number;
  toolCallTokens: number;
  toolResultTokens: number;
}

export interface ContextTokenBreakdown {
  systemTokens: number;
  messageTokens: number;
  toolTokens: number;
  details?: ContextBreakdownDetails;
}

export interface BuildContextBreakdownOptions {
  messages: Message[];
  tools?: Tool[];
  systemPromptText?: string | null;
  hiddenInstructionTexts?: Array<string | null | undefined>;
  agentPrefixText?: string | null;
}

const DETAIL_KEYS: Array<keyof ContextBreakdownDetails> = [
  'systemPromptTokens',
  'hiddenInstructionsTokens',
  'agentPrefixTokens',
  'userTextTokens',
  'assistantTextTokens',
  'attachmentTextTokens',
  'imageDescriptionTokens',
  'fileDescriptionTokens',
  'toolDefinitionsTokens',
  'toolCallTokens',
  'toolResultTokens',
];

function emptyDetails(): ContextBreakdownDetails {
  return {
    systemPromptTokens: 0,
    hiddenInstructionsTokens: 0,
    agentPrefixTokens: 0,
    userTextTokens: 0,
    assistantTextTokens: 0,
    attachmentTextTokens: 0,
    imageDescriptionTokens: 0,
    fileDescriptionTokens: 0,
    toolDefinitionsTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
  };
}

/* 使用统一的语言感知估算器，避免 CJK 文本被 ASCII 比例低估。 */
import { estimateTokens } from './tokenEstimate.js';
export function roughTokenEstimate(text: string | null | undefined): number {
  if (!text) return 0;
  const normalized = text.trim();
  if (!normalized.length) return 0;
  return estimateTokens(normalized);
}

function estimateImageDescriptionTokens(part: Extract<MessageContentPart, { type: 'image_url' }>): number {
  const detail = part.image_url?.detail || 'auto';
  return roughTokenEstimate(`image ${detail}`);
}

function estimateFileDescriptionTokens(line: string): number {
  return roughTokenEstimate(line.replace(/data:[^\]]+/g, 'file'));
}

function classifyTextContent(text: string, details: ContextBreakdownDetails, role: 'user' | 'assistant' | 'tool'): void {
  const normalized = text.trim();
  if (!normalized) return;

  if (role !== 'user') {
    const key = role === 'assistant' ? 'assistantTextTokens' : 'toolResultTokens';
    details[key] += roughTokenEstimate(normalized);
    return;
  }

  const attachmentStart = normalized.indexOf('Attachments:\n');
  if (attachmentStart < 0) {
    details.userTextTokens += roughTokenEstimate(normalized);
    return;
  }

  const before = normalized.slice(0, attachmentStart).trim();
  const attachmentSection = normalized.slice(attachmentStart);
  const dividerIndex = attachmentSection.indexOf('\n\n');
  const attachmentBlock = dividerIndex >= 0 ? attachmentSection.slice(0, dividerIndex) : attachmentSection;
  const after = dividerIndex >= 0 ? attachmentSection.slice(dividerIndex + 2).trim() : '';

  const attachmentLines = attachmentBlock
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of attachmentLines) {
    if (/\[(File|URL):/i.test(line)) {
      details.fileDescriptionTokens += estimateFileDescriptionTokens(line);
    } else {
      details.attachmentTextTokens += roughTokenEstimate(line);
    }
  }

  if (before) {
    details.userTextTokens += roughTokenEstimate(before);
  }
  if (after) {
    details.userTextTokens += roughTokenEstimate(after);
  }
}

function classifyUserContent(content: MessageContent, details: ContextBreakdownDetails): void {
  if (content === null) return;
  if (typeof content === 'string') {
    classifyTextContent(content, details, 'user');
    return;
  }

  for (const part of content) {
    if (part.type === 'text') {
      classifyTextContent(part.text, details, 'user');
    } else if (part.type === 'image_url') {
      details.imageDescriptionTokens += estimateImageDescriptionTokens(part);
    } else if (part.type === 'tool_result') {
      details.toolResultTokens += roughTokenEstimate(part.content);
    }
  }
}

function estimateToolDefinitionTokens(tools: Tool[]): number {
  return tools.reduce((total, tool) => {
    const payload = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
    return total + roughTokenEstimate(JSON.stringify(payload));
  }, 0);
}

function sumDetails(details: ContextBreakdownDetails, keys: Array<keyof ContextBreakdownDetails>): number {
  return keys.reduce((total, key) => total + (details[key] || 0), 0);
}

function scaleValues(values: Array<{ key: string; value: number }>, total: number): Record<string, number> {
  const rawTotal = values.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const result: Record<string, number> = {};

  for (const item of values) result[item.key] = 0;
  if (total <= 0 || rawTotal <= 0) return result;

  const scaled = values.map(item => {
    const raw = Math.max(0, item.value);
    const exact = (raw / rawTotal) * total;
    const base = Math.floor(exact);
    return { key: item.key, raw, base, fraction: exact - base };
  });

  let assigned = scaled.reduce((sum, item) => sum + item.base, 0);
  let remainder = total - assigned;

  scaled.sort((a, b) => {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    return b.raw - a.raw;
  });

  for (const item of scaled) {
    if (remainder <= 0) break;
    if (item.raw <= 0) continue;
    item.base += 1;
    remainder -= 1;
  }

  for (const item of scaled) result[item.key] = item.base;
  return result;
}

export function buildContextBreakdown(options: BuildContextBreakdownOptions): ContextTokenBreakdown {
  const details = emptyDetails();
  const hasStructuredSystem = !!(
    options.systemPromptText ||
    options.agentPrefixText ||
    options.hiddenInstructionTexts?.some(Boolean)
  );

  if (hasStructuredSystem) {
    details.systemPromptTokens += roughTokenEstimate(options.systemPromptText || '');
    details.agentPrefixTokens += roughTokenEstimate(options.agentPrefixText || '');
    for (const text of options.hiddenInstructionTexts || []) {
      details.hiddenInstructionsTokens += roughTokenEstimate(text || '');
    }
  }

  for (const message of options.messages) {
    if (message.role === 'system') {
      if (!hasStructuredSystem) {
        details.systemPromptTokens += roughTokenEstimate(getTextFromContent(message.content));
      }
      continue;
    }

    if (message.role === 'user') {
      classifyUserContent(message.content, details);
      continue;
    }

    if (message.role === 'assistant') {
      details.assistantTextTokens += roughTokenEstimate(getTextFromContent(message.content));
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        details.toolCallTokens += roughTokenEstimate(JSON.stringify(message.tool_calls));
      }
      continue;
    }

    if (message.role === 'tool') {
      details.toolResultTokens += roughTokenEstimate(getTextFromContent(message.content));
    }
  }

  if (options.tools?.length) {
    details.toolDefinitionsTokens += estimateToolDefinitionTokens(options.tools);
  }

  return {
    systemTokens: sumDetails(details, ['systemPromptTokens', 'hiddenInstructionsTokens', 'agentPrefixTokens']),
    messageTokens: sumDetails(details, ['userTextTokens', 'assistantTextTokens', 'attachmentTextTokens', 'imageDescriptionTokens', 'fileDescriptionTokens']),
    toolTokens: sumDetails(details, ['toolDefinitionsTokens', 'toolCallTokens', 'toolResultTokens']),
    details,
  };
}

export function normalizeContextBreakdown(
  breakdown: ContextTokenBreakdown | undefined,
  authoritativeTotal: number,
): ContextTokenBreakdown | undefined {
  if (!breakdown || authoritativeTotal <= 0) return breakdown;

  const rawSystem = breakdown.systemTokens || 0;
  const rawMessages = breakdown.messageTokens || 0;
  const rawTools = breakdown.toolTokens || 0;
  const rawTotal = rawSystem + rawMessages + rawTools;
  if (rawTotal <= 0) return undefined;

  const groupTotals = scaleValues([
    { key: 'system', value: rawSystem },
    { key: 'messages', value: rawMessages },
    { key: 'tools', value: rawTools },
  ], authoritativeTotal);

  if (!breakdown.details) {
    return {
      systemTokens: groupTotals.system || 0,
      messageTokens: groupTotals.messages || 0,
      toolTokens: groupTotals.tools || 0,
    };
  }

  const rawDetails = breakdown.details;
  const nextDetails = emptyDetails();
  const systemScaled = scaleValues([
    { key: 'systemPromptTokens', value: rawDetails.systemPromptTokens },
    { key: 'hiddenInstructionsTokens', value: rawDetails.hiddenInstructionsTokens },
    { key: 'agentPrefixTokens', value: rawDetails.agentPrefixTokens },
  ], groupTotals.system || 0);
  const messageScaled = scaleValues([
    { key: 'userTextTokens', value: rawDetails.userTextTokens },
    { key: 'assistantTextTokens', value: rawDetails.assistantTextTokens },
    { key: 'attachmentTextTokens', value: rawDetails.attachmentTextTokens },
    { key: 'imageDescriptionTokens', value: rawDetails.imageDescriptionTokens },
    { key: 'fileDescriptionTokens', value: rawDetails.fileDescriptionTokens },
  ], groupTotals.messages || 0);
  const toolScaled = scaleValues([
    { key: 'toolDefinitionsTokens', value: rawDetails.toolDefinitionsTokens },
    { key: 'toolCallTokens', value: rawDetails.toolCallTokens },
    { key: 'toolResultTokens', value: rawDetails.toolResultTokens },
  ], groupTotals.tools || 0);

  for (const key of DETAIL_KEYS) {
    nextDetails[key] = (systemScaled[key] || 0) + (messageScaled[key] || 0) + (toolScaled[key] || 0);
  }

  return {
    systemTokens: sumDetails(nextDetails, ['systemPromptTokens', 'hiddenInstructionsTokens', 'agentPrefixTokens']),
    messageTokens: sumDetails(nextDetails, ['userTextTokens', 'assistantTextTokens', 'attachmentTextTokens', 'imageDescriptionTokens', 'fileDescriptionTokens']),
    toolTokens: sumDetails(nextDetails, ['toolDefinitionsTokens', 'toolCallTokens', 'toolResultTokens']),
    details: nextDetails,
  };
}
