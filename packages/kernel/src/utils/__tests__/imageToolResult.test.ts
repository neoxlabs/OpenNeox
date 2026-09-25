
import { describe, it, expect } from 'vitest';
import {
  IMAGE_RESULT_PREFIX,
  parseImageToolResult,
  extractToolImages,
  buildImageToolSummaryText,
  buildImageAttachmentMessage,
  MAX_IMAGE_BASE64_BYTES,
} from '../imageToolResult.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import type { Message, MessageContentPart } from '../../types/index.js';

const IMG_RESULT = IMAGE_RESULT_PREFIX + JSON.stringify({
  type: 'image',
  images: [
    { data: 'AAAA', media_type: 'image/jpeg', label: '教育.pdf — Page 1/4' },
    { data: 'BBBB', media_type: 'image/jpeg', label: '教育.pdf — Page 2/4' },
  ],
});

describe('parseImageToolResult', () => {
  it('解析合法图片结果', () => {
    const images = parseImageToolResult(IMG_RESULT)!;
    expect(images).toHaveLength(2);
    expect(images[0].data).toBe('AAAA');
    expect(images[0].label).toContain('Page 1/4');
  });

  it('非前缀 / 坏 JSON / 空图片列表 → null (按普通文本处理)', () => {
    expect(parseImageToolResult('普通工具输出')).toBeNull();
    expect(parseImageToolResult(IMAGE_RESULT_PREFIX + '{broken')).toBeNull();
    expect(parseImageToolResult(IMAGE_RESULT_PREFIX + '{"images":[]}')).toBeNull();
    expect(parseImageToolResult(IMAGE_RESULT_PREFIX + '{"images":[{"data":""}]}')).toBeNull();
  });
});

describe('addToolResult 图片协议注入', () => {
  it('tool 消息为纯文本摘要, 紧随合成 user 图片消息', () => {
    const memory = new ShortTermMemory();
    memory.addToolResult('call_1', 'readfile', IMG_RESULT);

    const messages = memory.getAll();
    expect(messages).toHaveLength(2);

    const toolMsg = messages[0];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(typeof toolMsg.content).toBe('string');
    expect(toolMsg.content as string).toContain('2 张图片');
    expect(toolMsg.content as string).not.toContain('AAAA'); /* base64 绝不进 tool 文本 */

    const attachMsg = messages[1];
    expect(attachMsg.role).toBe('user');
    const parts = attachMsg.content as MessageContentPart[];
    expect(Array.isArray(parts)).toBe(true);
    const imageParts = parts.filter((p) => p.type === 'image_url');
    expect(imageParts).toHaveLength(2);
    expect((imageParts[0] as any).image_url.url).toBe('data:image/jpeg;base64,AAAA');
    /* label 文本 part 与图片交错 */
    expect(parts.some((p) => p.type === 'text' && (p as any).text.includes('Page 1/4'))).toBe(true);
    expect(parts.some((p) => p.type === 'text' && (p as any).text.includes('系统注入'))).toBe(true);
  });

  it('普通文本结果不受影响', () => {
    const memory = new ShortTermMemory();
    memory.addToolResult('call_2', 'search', 'grep found 3 matches');
    const messages = memory.getAll();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('grep found 3 matches');
  });

  it('Contextual 外壳前面被加上耗时头时仍能抽出图', () => {
    const wrapped = JSON.stringify({
      type: 'contextual',
      status: 'success',
      tool: 'computer_snapshot',
      summary: '看了一眼 qq',
      content: IMG_RESULT,
    });
    const headed = `⏱️ [computer_snapshot took 8.5s]\n\n${wrapped}`;
    expect(extractToolImages(headed)?.[0]?.data).toBe('AAAA');
  });

  it('Contextual ToolResult.content 里的图片协议同样注入 (computer_snapshot axBlind)', () => {
    const wrapped = JSON.stringify({
      type: 'contextual',
      status: 'success',
      tool: 'computer_snapshot',
      summary: '看了一眼 idea64',
      content: IMG_RESULT,
      metadata: { computer: { screenshot: '/tmp/shot.jpg', axBlind: true } },
    });
    expect(extractToolImages(wrapped)?.[0]?.data).toBe('AAAA');
    const memory = new ShortTermMemory();
    memory.addToolResult('call_3', 'computer_snapshot', wrapped);
    const messages = memory.getAll();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('tool');
    expect(messages[0].content as string).not.toContain('AAAA');
    const parts = messages[1].content as MessageContentPart[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });
});

describe('builders', () => {
  it('摘要含工具名与 label; 附件消息首 part 声明来源', () => {
    const images = parseImageToolResult(IMG_RESULT)!;
    const summary = buildImageToolSummaryText('readfile', images);
    expect(summary).toContain('readfile');
    expect(summary).toContain('教育.pdf — Page 1/4');
    const msg = buildImageAttachmentMessage('readfile', images);
    expect(msg.role).toBe('user');
    expect((msg.content as MessageContentPart[])[0]).toMatchObject({ type: 'text' });
  });
});

describe('兜底闸门: 单图 base64 硬上限 (2MB)', () => {
  it('超限巨图被替换为占位文本, 不注入 image_url', () => {
    const huge = 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1);
    const msg = buildImageAttachmentMessage('readfile', [
      { data: huge, mediaType: 'image/png', label: 'huge.png' },
      { data: 'small', mediaType: 'image/png', label: 'ok.png' },
    ]);
    const parts = msg.content as MessageContentPart[];
    const imageParts = parts.filter((p) => p.type === 'image_url');
    expect(imageParts).toHaveLength(1); // 只有小图进历史
    expect((imageParts[0] as any).image_url.url).toContain('small');
    const texts = parts.filter((p) => p.type === 'text').map((p) => (p as any).text).join('\n');
    expect(texts).toContain('过大');
    expect(texts).toContain('huge.png');
  });
});

describe('图片结果顺带文本 (readfile 一次读图 + 代码)', () => {
  it('text 字段进 tool 消息, 图片仍走附件, base64 不进 tool 消息', () => {
    const raw = IMAGE_RESULT_PREFIX + JSON.stringify({
      type: 'image',
      images: [{ data: 'iVBORw0KGgoAAAA', media_type: 'image/png', label: 'shot.png' }],
      text: '══════ shot.png ══════\n(1 image(s), attached)\n\n══════ calc.py ══════\ndef add(a, b):',
    });
    const mem = new ShortTermMemory();
    mem.add({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readfile', arguments: '{}' } }] } as any);
    mem.addToolResult('c1', 'readfile', raw);
    const all = mem.getAll();
    const tool = all.find((m) => m.role === 'tool')!;
    expect(String(tool.content)).toContain('def add(a, b):');
    expect(String(tool.content)).not.toContain('iVBORw0KGgo');
    expect(all[all.length - 1].role).toBe('user');
  });

  it('wrapped in a Contextual ToolResult (browser_run with a screenshot): the text still reaches the tool message', () => {
    const content = IMAGE_RESULT_PREFIX + JSON.stringify({
      type: 'image',
      images: [{ data: 'iVBORw0KGgoAAAA', media_type: 'image/png', label: '第 1 步截图' }],
      text: '{"ok":true,"steps":[{"action":"screenshot","output":"[截图 → 附图 1]"}]}',
    });
    const raw = JSON.stringify({ type: 'contextual', status: 'success', tool: 'browser_run', summary: 's', content });
    const mem = new ShortTermMemory();
    mem.add({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_run', arguments: '{}' } }] } as any);
    mem.addToolResult('c1', 'browser_run', raw);
    const all = mem.getAll();
    const tool = all.find((m) => m.role === 'tool')!;
    expect(String(tool.content)).toContain('[截图 → 附图 1]');
    expect(String(tool.content)).not.toContain('iVBORw0KGgo');
    const attach = all[all.length - 1];
    expect(attach.role).toBe('user');
    expect(JSON.stringify(attach.content)).toContain('data:image/png;base64,iVBORw0KGgoAAAA');
  });
});
