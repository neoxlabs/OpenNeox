import { describe, expect, it } from 'vitest';
import {
  analyzeAnthropicCachePayload,
  formatAnthropicCachePayloadAnalysis,
} from '../anthropicCachePayloadAnalysis.js';

describe('anthropicCachePayloadAnalysis', () => {
  it('detects tool prefix risks and ordinary input after the message marker', () => {
    const payload = {
      model: 'claude-test',
      system: [
        {
          type: 'text',
          text: 'static system prompt '.repeat(400),
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: '## Project Memory\nworkspace facts',
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'old user question' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'old tool result',
              cache_reference: 'toolu_1',
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a.ts' } }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: 'cached conversation tail '.repeat(200),
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'fresh ordinary input '.repeat(900) }],
        },
      ],
      tools: [
        { name: 'Bash', description: 'run shell', input_schema: { type: 'object' } },
        { name: 'mcp__alpha__lookup', description: 'mcp lookup', input_schema: { type: 'object' } },
        { name: 'Read', description: 'read file', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
      ],
    };

    const analysis = analyzeAnthropicCachePayload(payload);

    expect(analysis.cacheControls.total).toBe(4);
    expect(analysis.tools.flatAlphabeticalByName).toBe(true);
    expect(analysis.tools.officialBuiltInPrefixCompatible).toBe(false);
    expect(analysis.tools.builtInPrefixLength).toBe(1);
    expect(analysis.tools.builtInCount).toBe(2);
    expect(analysis.tools.firstNonBuiltInIndex).toBe(1);
    expect(analysis.tools.cacheControlIndexes).toEqual([2]);
    expect(analysis.messages.cacheControlCount).toBe(1);
    expect(analysis.messages.cacheReferenceCount).toBe(1);
    expect(analysis.messages.toolResultBeforeOrAtLastMarker).toBe(2);
    expect(analysis.messages.roughTokensAfterLastMarker).toBeGreaterThanOrEqual(4000);
    expect(analysis.system.blocks[1].dynamicMarkers).toContain('## Project Memory');
    expect(analysis.warnings.join('\n')).toContain('flat alphabetically sorted');
    expect(analysis.warnings.join('\n')).toContain('ordinary input');
    expect(analysis.warnings.join('\n')).toContain('global cache_control');
  });

  it('formats a compact log summary', () => {
    const analysis = analyzeAnthropicCachePayload({
      model: 'claude-test',
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
    });

    const lines = formatAnthropicCachePayloadAnalysis(analysis);

    expect(lines.some(line => line.includes('model=claude-test'))).toBe(true);
    expect(lines.some(line => line.includes('cache_controls total=3'))).toBe(true);
    expect(lines.some(line => line.includes('tools count=1'))).toBe(true);
    expect(lines.some(line => line.includes('last_marker=message[0].content[0]:text'))).toBe(true);
  });
});
