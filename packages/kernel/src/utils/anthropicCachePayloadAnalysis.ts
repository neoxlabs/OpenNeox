import { estimateTokens } from './tokenEstimate.js';

type JsonRecord = Record<string, unknown>;

export type AnthropicCacheToolKind = 'built_in' | 'mcp' | 'custom';

export interface AnthropicSystemBlockAnalysis {
  index: number;
  type: string;
  textChars: number;
  roughTokens: number;
  hasCacheControl: boolean;
  cacheScope?: string;
  dynamicMarkers: string[];
  preview: string;
}

export interface AnthropicToolAnalysis {
  index: number;
  name: string;
  kind: AnthropicCacheToolKind;
  roughTokens: number;
  hasCacheControl: boolean;
  eagerInputStreaming: boolean;
}

export interface AnthropicMessageCacheMarker {
  messageIndex: number;
  blockIndex: number | null;
  role: string;
  type: string;
  roughTokensThroughMarker: number;
}

export interface AnthropicCachePayloadAnalysis {
  generatedAt: string;
  model?: string;
  payloadBytes: number;
  roughPayloadTokens: number;
  request: {
    maxTokens?: number;
    stream?: boolean;
    temperature?: number;
    thinkingType?: string;
    thinkingBudgetTokens?: number;
    betaFields: string[];
  };
  cacheControls: {
    total: number;
    system: number;
    tools: number;
    messages: number;
    exceedsAnthropicBreakpointLimit: boolean;
  };
  system: {
    blockCount: number;
    roughTokens: number;
    cachedBlockCount: number;
    cachedRoughTokens: number;
    cacheControlIndexes: number[];
    blocks: AnthropicSystemBlockAnalysis[];
  };
  tools: {
    count: number;
    roughTokens: number;
    builtInCount: number;
    mcpCount: number;
    customCount: number;
    builtInPrefixLength: number;
    firstNonBuiltInIndex: number | null;
    firstMcpIndex: number | null;
    firstCustomIndex: number | null;
    cacheControlIndexes: number[];
    cacheControlToolNames: string[];
    flatAlphabeticalByName: boolean;
    officialBuiltInPrefixCompatible: boolean;
    interleavedBuiltInsAfterDynamic: string[];
    headNames: string[];
    tailNames: string[];
    tools: AnthropicToolAnalysis[];
  };
  messages: {
    count: number;
    roughTokens: number;
    roleCounts: Record<string, number>;
    stringContentMessages: number;
    cacheControlCount: number;
    cacheMarkers: AnthropicMessageCacheMarker[];
    lastCacheMarker: AnthropicMessageCacheMarker | null;
    roughTokensThroughLastMarker: number;
    roughTokensAfterLastMarker: number;
    toolResultCount: number;
    toolResultBeforeOrAtLastMarker: number;
    toolResultAfterLastMarker: number;
    cacheReferenceCount: number;
    cacheEditsBlockCount: number;
    cacheEditsDeleteCount: number;
  };
  warnings: string[];
}

/**
 * Claude Code 官方 built-in 工具名 (PascalCase 已 remap 后).
 *
 * 关键: 这个 set 有两个消费点, 必须**同源**避免 drift:
 *   1) 本文件 analyzeAnthropicCachePayload — 诊断 cache prefix 是否兼容
 *   2) anthropic.ts buildToolsPayload / ensureLastToolCacheControl — tools 分区排序 +
 *      cache_control anchor 定位, 保证 built-in 前缀连续 + cache 打在 built-in 段末尾
 *
 * 若 Anthropic 未来在 Claude Code cache policy 里新增 built-in (例如 SkillTool),
 * 只改这一处即可两边同步命中. 千万别在 anthropic.ts 里再抄一份.
 *
 * 'web_search' (下划线) 保留是因为 buildWebSearchTool 追加的 server tool 用小写命名, 也算 built-in.
 */
export const CLAUDE_CODE_BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
  'Task',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'ExitPlanMode',
  'web_search',
]);
const BUILT_IN_TOOL_NAMES = CLAUDE_CODE_BUILT_IN_TOOL_NAMES;

const DYNAMIC_SYSTEM_MARKERS = [
  '## 项目记忆',
  '## 上次任务摘要',
  '## Project Memory',
  '## Last Run Summary',
  'Project Memory',
  'Last Run Summary',
  'session memory',
  'Working directory',
  'Current date',
  '工作目录',
  '当前日期',
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyForEstimate(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value ?? '');
  } catch {
    return String(value ?? '');
  }
}

function estimateValueTokens(value: unknown): number {
  return estimateTokens(stringifyForEstimate(value));
}

function previewText(text: string, maxChars = 120): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

function hasCacheControl(value: unknown): boolean {
  return isRecord(value) && value.cache_control !== undefined && value.cache_control !== null;
}

function getCacheScope(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const cacheControl = value.cache_control;
  if (!isRecord(cacheControl)) return undefined;
  return typeof cacheControl.scope === 'string' ? cacheControl.scope : undefined;
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  return typeof raw === 'string' ? raw : undefined;
}

function getNumberField(value: unknown, field: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function getBooleanField(value: unknown, field: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  return typeof raw === 'boolean' ? raw : undefined;
}

function withoutCacheControl(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const clone: JsonRecord = { ...value };
  delete clone.cache_control;
  return clone;
}

function getSystemBlocks(payload: JsonRecord): unknown[] {
  if (Array.isArray(payload.system)) return payload.system;
  if (typeof payload.system === 'string') {
    return [{ type: 'text', text: payload.system }];
  }
  return [];
}

function getTools(payload: JsonRecord): unknown[] {
  return Array.isArray(payload.tools) ? payload.tools : [];
}

function getMessages(payload: JsonRecord): unknown[] {
  return Array.isArray(payload.messages) ? payload.messages : [];
}

function classifyToolName(name: string): AnthropicCacheToolKind {
  if (BUILT_IN_TOOL_NAMES.has(name)) return 'built_in';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'custom';
}

function analyzeSystem(payload: JsonRecord): AnthropicCachePayloadAnalysis['system'] {
  const blocks = getSystemBlocks(payload).map((block, index): AnthropicSystemBlockAnalysis => {
    const type = getStringField(block, 'type') ?? 'unknown';
    const text = getStringField(block, 'text') ?? stringifyForEstimate(block);
    const dynamicMarkers = DYNAMIC_SYSTEM_MARKERS.filter(marker => text.includes(marker));
    const hasControl = hasCacheControl(block);

    return {
      index,
      type,
      textChars: text.length,
      roughTokens: estimateTokens(text),
      hasCacheControl: hasControl,
      cacheScope: getCacheScope(block),
      dynamicMarkers,
      preview: previewText(text),
    };
  });

  const cacheControlIndexes = blocks.filter(block => block.hasCacheControl).map(block => block.index);

  return {
    blockCount: blocks.length,
    roughTokens: blocks.reduce((sum, block) => sum + block.roughTokens, 0),
    cachedBlockCount: cacheControlIndexes.length,
    cachedRoughTokens: blocks
      .filter(block => block.hasCacheControl)
      .reduce((sum, block) => sum + block.roughTokens, 0),
    cacheControlIndexes,
    blocks,
  };
}

function analyzeTools(payload: JsonRecord): AnthropicCachePayloadAnalysis['tools'] {
  const tools = getTools(payload).map((tool, index): AnthropicToolAnalysis => {
    const name = getStringField(tool, 'name') ?? `<unnamed:${index}>`;
    return {
      index,
      name,
      kind: classifyToolName(name),
      roughTokens: estimateValueTokens(withoutCacheControl(tool)),
      hasCacheControl: hasCacheControl(tool),
      eagerInputStreaming: getBooleanField(tool, 'eager_input_streaming') ?? false,
    };
  });

  let builtInPrefixLength = 0;
  for (const tool of tools) {
    if (tool.kind !== 'built_in') break;
    builtInPrefixLength += 1;
  }

  const names = tools.map(tool => tool.name);
  const sortedNames = [...names].sort((left, right) => left.localeCompare(right));
  const flatAlphabeticalByName = names.length === sortedNames.length
    && names.every((name, index) => name === sortedNames[index]);
  const builtInCount = tools.filter(tool => tool.kind === 'built_in').length;
  const firstNonBuiltIn = tools.find(tool => tool.kind !== 'built_in');
  const firstMcp = tools.find(tool => tool.kind === 'mcp');
  const firstCustom = tools.find(tool => tool.kind === 'custom');
  const cacheControlTools = tools.filter(tool => tool.hasCacheControl);
  const interleavedBuiltInsAfterDynamic = firstNonBuiltIn
    ? tools
      .filter(tool => tool.index > firstNonBuiltIn.index && tool.kind === 'built_in')
      .map(tool => tool.name)
    : [];

  return {
    count: tools.length,
    roughTokens: tools.reduce((sum, tool) => sum + tool.roughTokens, 0),
    builtInCount,
    mcpCount: tools.filter(tool => tool.kind === 'mcp').length,
    customCount: tools.filter(tool => tool.kind === 'custom').length,
    builtInPrefixLength,
    firstNonBuiltInIndex: firstNonBuiltIn?.index ?? null,
    firstMcpIndex: firstMcp?.index ?? null,
    firstCustomIndex: firstCustom?.index ?? null,
    cacheControlIndexes: cacheControlTools.map(tool => tool.index),
    cacheControlToolNames: cacheControlTools.map(tool => tool.name),
    flatAlphabeticalByName,
    officialBuiltInPrefixCompatible: builtInPrefixLength === builtInCount,
    interleavedBuiltInsAfterDynamic,
    headNames: names.slice(0, 12),
    tailNames: names.slice(Math.max(0, names.length - 8)),
    tools,
  };
}

interface MessageBlockEntry {
  messageIndex: number;
  blockIndex: number | null;
  role: string;
  type: string;
  roughTokens: number;
  hasCacheControl: boolean;
  isToolResult: boolean;
  hasCacheReference: boolean;
  cacheEditsDeleteCount: number;
}

function getCacheEditsDeleteCount(block: unknown): number {
  if (!isRecord(block) || block.type !== 'cache_edits' || !Array.isArray(block.edits)) return 0;
  return block.edits.filter(edit => isRecord(edit) && edit.type === 'delete').length;
}

function analyzeMessages(payload: JsonRecord): AnthropicCachePayloadAnalysis['messages'] {
  const messages = getMessages(payload);
  const entries: MessageBlockEntry[] = [];
  const roleCounts: Record<string, number> = {};
  let stringContentMessages = 0;

  messages.forEach((message, messageIndex) => {
    const role = getStringField(message, 'role') ?? 'unknown';
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;

    if (hasCacheControl(message)) {
      entries.push({
        messageIndex,
        blockIndex: null,
        role,
        type: 'message',
        roughTokens: estimateValueTokens(withoutCacheControl(message)),
        hasCacheControl: true,
        isToolResult: false,
        hasCacheReference: false,
        cacheEditsDeleteCount: 0,
      });
    }

    if (!isRecord(message)) {
      entries.push({
        messageIndex,
        blockIndex: null,
        role,
        type: 'unknown',
        roughTokens: estimateValueTokens(message),
        hasCacheControl: false,
        isToolResult: false,
        hasCacheReference: false,
        cacheEditsDeleteCount: 0,
      });
      return;
    }

    const content = message.content;
    if (typeof content === 'string') {
      stringContentMessages += 1;
      entries.push({
        messageIndex,
        blockIndex: null,
        role,
        type: 'string',
        roughTokens: estimateTokens(content),
        hasCacheControl: false,
        isToolResult: false,
        hasCacheReference: false,
        cacheEditsDeleteCount: 0,
      });
      return;
    }

    if (Array.isArray(content)) {
      content.forEach((block, blockIndex) => {
        const type = getStringField(block, 'type') ?? 'unknown';
        entries.push({
          messageIndex,
          blockIndex,
          role,
          type,
          roughTokens: estimateValueTokens(withoutCacheControl(block)),
          hasCacheControl: hasCacheControl(block),
          isToolResult: type === 'tool_result',
          hasCacheReference: isRecord(block) && block.cache_reference !== undefined && block.cache_reference !== null,
          cacheEditsDeleteCount: getCacheEditsDeleteCount(block),
        });
      });
      return;
    }

    entries.push({
      messageIndex,
      blockIndex: null,
      role,
      type: 'empty',
      roughTokens: 0,
      hasCacheControl: false,
      isToolResult: false,
      hasCacheReference: false,
      cacheEditsDeleteCount: 0,
    });
  });

  let runningTokens = 0;
  const cacheMarkers: AnthropicMessageCacheMarker[] = [];
  entries.forEach(entry => {
    runningTokens += entry.roughTokens;
    if (entry.hasCacheControl) {
      cacheMarkers.push({
        messageIndex: entry.messageIndex,
        blockIndex: entry.blockIndex,
        role: entry.role,
        type: entry.type,
        roughTokensThroughMarker: runningTokens,
      });
    }
  });

  const lastCacheMarker = cacheMarkers.at(-1) ?? null;
  let lastCacheEntryIndex = -1;
  if (lastCacheMarker) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.hasCacheControl
        && entry.messageIndex === lastCacheMarker.messageIndex
        && entry.blockIndex === lastCacheMarker.blockIndex
        && entry.type === lastCacheMarker.type
      ) {
        lastCacheEntryIndex = i;
        break;
      }
    }
  }
  const roughTokensThroughLastMarker = lastCacheMarker?.roughTokensThroughMarker ?? 0;
  const roughTokens = entries.reduce((sum, entry) => sum + entry.roughTokens, 0);

  return {
    count: messages.length,
    roughTokens,
    roleCounts,
    stringContentMessages,
    cacheControlCount: cacheMarkers.length,
    cacheMarkers,
    lastCacheMarker,
    roughTokensThroughLastMarker,
    roughTokensAfterLastMarker: lastCacheEntryIndex >= 0
      ? entries.slice(lastCacheEntryIndex + 1).reduce((sum, entry) => sum + entry.roughTokens, 0)
      : roughTokens,
    toolResultCount: entries.filter(entry => entry.isToolResult).length,
    toolResultBeforeOrAtLastMarker: lastCacheEntryIndex >= 0
      ? entries.slice(0, lastCacheEntryIndex + 1).filter(entry => entry.isToolResult).length
      : 0,
    toolResultAfterLastMarker: lastCacheEntryIndex >= 0
      ? entries.slice(lastCacheEntryIndex + 1).filter(entry => entry.isToolResult).length
      : entries.filter(entry => entry.isToolResult).length,
    cacheReferenceCount: entries.filter(entry => entry.hasCacheReference).length,
    cacheEditsBlockCount: entries.filter(entry => entry.type === 'cache_edits').length,
    cacheEditsDeleteCount: entries.reduce((sum, entry) => sum + entry.cacheEditsDeleteCount, 0),
  };
}

function getRequestSummary(payload: JsonRecord): AnthropicCachePayloadAnalysis['request'] {
  const thinking = isRecord(payload.thinking) ? payload.thinking : undefined;
  const betaFields = Object.keys(payload).filter(key =>
    key === 'anthropic_beta'
    || key === 'beta'
    || key.endsWith('_beta')
    || key.includes('beta'));

  return {
    maxTokens: getNumberField(payload, 'max_tokens'),
    stream: getBooleanField(payload, 'stream'),
    temperature: getNumberField(payload, 'temperature'),
    thinkingType: thinking ? getStringField(thinking, 'type') : undefined,
    thinkingBudgetTokens: thinking ? getNumberField(thinking, 'budget_tokens') : undefined,
    betaFields,
  };
}

function buildWarnings(analysis: Omit<AnthropicCachePayloadAnalysis, 'warnings'>): string[] {
  const warnings: string[] = [];

  if (analysis.cacheControls.total > 4) {
    warnings.push(`cache_control count is ${analysis.cacheControls.total}, above Anthropic's 4-breakpoint limit`);
  }

  for (const block of analysis.system.blocks) {
    if (block.hasCacheControl && block.roughTokens < 1024) {
      warnings.push(`system[${block.index}] cached block is short (~${block.roughTokens} tokens); short breakpoints often do not help`);
    }
    if (block.hasCacheControl && block.cacheScope === 'global' && block.dynamicMarkers.length > 0) {
      warnings.push(`system[${block.index}] uses global cache_control but contains dynamic markers: ${block.dynamicMarkers.join(', ')}`);
    }
  }

  if (analysis.tools.count > 0 && analysis.tools.cacheControlIndexes.length === 0) {
    warnings.push('tools exist but no tool cache_control marker was found');
  }
  if (!analysis.tools.officialBuiltInPrefixCompatible) {
    warnings.push(`tool order is not official-prefix-compatible: built-in prefix=${analysis.tools.builtInPrefixLength}, built-in total=${analysis.tools.builtInCount}`);
  }
  if (analysis.tools.flatAlphabeticalByName && !analysis.tools.officialBuiltInPrefixCompatible) {
    warnings.push('tools look flat alphabetically sorted; MCP/custom tools can split the built-in prefix used by Claude Code cache policy');
  }
  if (analysis.tools.firstNonBuiltInIndex !== null) {
    const cacheAfterDynamic = analysis.tools.cacheControlIndexes
      .some(index => analysis.tools.firstNonBuiltInIndex !== null && index >= analysis.tools.firstNonBuiltInIndex);
    if (cacheAfterDynamic) {
      warnings.push(`tool cache_control is after first MCP/custom tool at index ${analysis.tools.firstNonBuiltInIndex}; cached tool prefix may include dynamic tools`);
    }
  }
  if (analysis.tools.interleavedBuiltInsAfterDynamic.length > 0) {
    warnings.push(`built-in tools appear after MCP/custom tools: ${analysis.tools.interleavedBuiltInsAfterDynamic.slice(0, 8).join(', ')}`);
  }

  if (analysis.messages.cacheControlCount === 0) {
    warnings.push('no message-level cache_control marker found; conversation history cannot be cached past system/tools');
  }
  if (analysis.messages.cacheControlCount > 1) {
    warnings.push(`message-level cache_control count is ${analysis.messages.cacheControlCount}; Claude Code normally writes one message breakpoint`);
  }
  if (analysis.messages.roughTokensAfterLastMarker >= 4000) {
    warnings.push(`~${analysis.messages.roughTokensAfterLastMarker} message tokens remain after the last cache marker; these will be ordinary input`);
  }
  if (
    analysis.messages.toolResultBeforeOrAtLastMarker > 0
    && analysis.messages.cacheReferenceCount < analysis.messages.toolResultBeforeOrAtLastMarker
  ) {
    warnings.push(`only ${analysis.messages.cacheReferenceCount}/${analysis.messages.toolResultBeforeOrAtLastMarker} cached-prefix tool_result blocks have cache_reference`);
  }
  if (analysis.messages.roughTokensThroughLastMarker >= 20000 && analysis.messages.cacheEditsBlockCount === 0) {
    warnings.push('long cached message prefix but no cache_edits blocks found');
  }

  return warnings;
}

export function analyzeAnthropicCachePayload(payload: unknown): AnthropicCachePayloadAnalysis {
  const record = isRecord(payload) ? payload : {};
  const serialized = stringifyForEstimate(payload);
  const system = analyzeSystem(record);
  const tools = analyzeTools(record);
  const messages = analyzeMessages(record);
  const cacheControls = {
    total: system.cachedBlockCount + tools.cacheControlIndexes.length + messages.cacheControlCount,
    system: system.cachedBlockCount,
    tools: tools.cacheControlIndexes.length,
    messages: messages.cacheControlCount,
    exceedsAnthropicBreakpointLimit: false,
  };
  cacheControls.exceedsAnthropicBreakpointLimit = cacheControls.total > 4;

  const withoutWarnings = {
    generatedAt: new Date().toISOString(),
    model: getStringField(record, 'model'),
    payloadBytes: Buffer.byteLength(serialized, 'utf8'),
    roughPayloadTokens: estimateTokens(serialized),
    request: getRequestSummary(record),
    cacheControls,
    system,
    tools,
    messages,
  };

  return {
    ...withoutWarnings,
    warnings: buildWarnings(withoutWarnings),
  };
}

function formatNullableIndex(index: number | null): string {
  return index === null ? 'none' : String(index);
}

function formatMarker(marker: AnthropicMessageCacheMarker | null): string {
  if (!marker) return 'none';
  const block = marker.blockIndex === null ? 'message' : `content[${marker.blockIndex}]`;
  return `message[${marker.messageIndex}].${block}:${marker.type}`;
}

export function formatAnthropicCachePayloadAnalysis(analysis: AnthropicCachePayloadAnalysis): string[] {
  const lines: string[] = [];
  const thinking = analysis.request.thinkingType
    ? `${analysis.request.thinkingType}${analysis.request.thinkingBudgetTokens ? `/${analysis.request.thinkingBudgetTokens}` : ''}`
    : 'none';

  lines.push(`model=${analysis.model ?? 'unknown'} bytes=${analysis.payloadBytes} rough_tokens=${analysis.roughPayloadTokens} max_tokens=${analysis.request.maxTokens ?? 'unset'} thinking=${thinking}`);
  lines.push(`cache_controls total=${analysis.cacheControls.total} system=${analysis.cacheControls.system} tools=${analysis.cacheControls.tools} messages=${analysis.cacheControls.messages} exceeds_4=${analysis.cacheControls.exceedsAnthropicBreakpointLimit}`);
  lines.push(`system blocks=${analysis.system.blockCount} tokens~${analysis.system.roughTokens} cached_blocks=${analysis.system.cachedBlockCount} cached_tokens~${analysis.system.cachedRoughTokens} indexes=[${analysis.system.cacheControlIndexes.join(',')}]`);
  lines.push(`tools count=${analysis.tools.count} tokens~${analysis.tools.roughTokens} built_in=${analysis.tools.builtInCount} mcp=${analysis.tools.mcpCount} custom=${analysis.tools.customCount} built_in_prefix=${analysis.tools.builtInPrefixLength} flat_alpha=${analysis.tools.flatAlphabeticalByName}`);
  lines.push(`tools first_non_builtin=${formatNullableIndex(analysis.tools.firstNonBuiltInIndex)} first_mcp=${formatNullableIndex(analysis.tools.firstMcpIndex)} first_custom=${formatNullableIndex(analysis.tools.firstCustomIndex)} cache_indexes=[${analysis.tools.cacheControlIndexes.join(',')}] cache_tools=[${analysis.tools.cacheControlToolNames.join(',')}]`);
  if (analysis.tools.headNames.length > 0) {
    lines.push(`tools head=[${analysis.tools.headNames.join(',')}] tail=[${analysis.tools.tailNames.join(',')}]`);
  }
  lines.push(`messages count=${analysis.messages.count} tokens~${analysis.messages.roughTokens} markers=${analysis.messages.cacheControlCount} last_marker=${formatMarker(analysis.messages.lastCacheMarker)} tokens_through_marker~${analysis.messages.roughTokensThroughLastMarker} tokens_after_marker~${analysis.messages.roughTokensAfterLastMarker}`);
  lines.push(`messages tool_results=${analysis.messages.toolResultCount} before_or_at_marker=${analysis.messages.toolResultBeforeOrAtLastMarker} after_marker=${analysis.messages.toolResultAfterLastMarker} cache_reference=${analysis.messages.cacheReferenceCount} cache_edits=${analysis.messages.cacheEditsBlockCount}/${analysis.messages.cacheEditsDeleteCount}`);
  lines.push(`messages roles=${JSON.stringify(analysis.messages.roleCounts)} string_content_messages=${analysis.messages.stringContentMessages}`);

  if (analysis.system.blocks.length > 0) {
    const cachedSystem = analysis.system.blocks
      .filter(block => block.hasCacheControl)
      .map(block => `system[${block.index}] scope=${block.cacheScope ?? 'ephemeral'} tokens~${block.roughTokens} markers=${block.dynamicMarkers.length ? block.dynamicMarkers.join('|') : 'none'} preview="${block.preview}"`);
    lines.push(...cachedSystem);
  }

  if (analysis.warnings.length > 0) {
    for (const warning of analysis.warnings) {
      lines.push(`WARN ${warning}`);
    }
  } else {
    lines.push('WARN none');
  }

  return lines;
}
