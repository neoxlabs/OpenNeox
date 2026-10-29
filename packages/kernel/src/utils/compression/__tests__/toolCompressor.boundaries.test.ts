import { describe, it, expect, vi } from 'vitest';
import { ToolCompressor } from '../toolCompressor.js';
import { ToolType } from '../types.js';

function makeProvider(reply: any) {
  const chat = vi.fn(async () => reply);
  return { chat } as any;
}

function okReply(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('ToolCompressor.getToolType', () => {
  const c = new ToolCompressor();

  it('已知工具名映射到对应类型', () => {
    expect(c.getToolType('Read')).toBe(ToolType.FILE_READ);
    expect(c.getToolType('Write')).toBe(ToolType.FILE_WRITE);
    expect(c.getToolType('Edit')).toBe(ToolType.FILE_EDIT);
    expect(c.getToolType('Glob')).toBe(ToolType.FILE_SEARCH);
    expect(c.getToolType('Grep')).toBe(ToolType.FILE_SEARCH);
    expect(c.getToolType('Bash')).toBe(ToolType.BASH);
    expect(c.getToolType('BashOutput')).toBe(ToolType.BASH);
    expect(c.getToolType('WebFetch')).toBe(ToolType.WEB_FETCH);
    expect(c.getToolType('WebSearch')).toBe(ToolType.WEB_SEARCH);
    expect(c.getToolType('Task')).toBe(ToolType.TASK);
  });

  it('MCP 前缀单独归类', () => {
    expect(c.getToolType('mcp__github__create_issue')).toBe(ToolType.MCP);
  });

  it('未知工具名归 OTHER（大小写敏感）', () => {
    expect(c.getToolType('totally_unknown')).toBe(ToolType.OTHER);
    expect(c.getToolType('read')).toBe(ToolType.OTHER);
    expect(c.getToolType('')).toBe(ToolType.OTHER);
  });

  it('supportedTools 覆盖映射表中的全部名字', () => {
    expect(c.supportedTools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Task']));
  });
});

describe('ToolCompressor.needsLLMCompression 阈值与上下文窗口缩放', () => {
  const c = new ToolCompressor();

  it('WebFetch / WebSearch / Task 不论多短总是走 LLM', () => {
    expect(c.needsLLMCompression('WebFetch', '')).toBe(true);
    expect(c.needsLLMCompression('WebSearch', 'tiny')).toBe(true);
    expect(c.needsLLMCompression('Task', 'done')).toBe(true);
  });

  it('200K 窗口下 Read 阈值是 20000 字符', () => {
    expect(c.needsLLMCompression('Read', 'x'.repeat(20000), 200_000)).toBe(false);
    expect(c.needsLLMCompression('Read', 'x'.repeat(20001), 200_000)).toBe(true);
  });

  it('不传 contextWindow 时按 128K 缩放（阈值 12800）', () => {
    expect(c.needsLLMCompression('Read', 'x'.repeat(12800))).toBe(false);
    expect(c.needsLLMCompression('Read', 'x'.repeat(12801))).toBe(true);
  });

  it('小窗口缩放系数下限 0.3（阈值 6000）', () => {
    expect(c.needsLLMCompression('Read', 'x'.repeat(6000), 1000)).toBe(false);
    expect(c.needsLLMCompression('Read', 'x'.repeat(6001), 1000)).toBe(true);
  });

  it('大窗口缩放系数上限 2.0（阈值 40000）', () => {
    expect(c.needsLLMCompression('Read', 'x'.repeat(40000), 500_000)).toBe(false);
    expect(c.needsLLMCompression('Read', 'x'.repeat(40001), 500_000)).toBe(true);
  });

  it('Bash 阈值 15000、MCP 阈值 10000（200K 窗口）', () => {
    expect(c.needsLLMCompression('Bash', 'x'.repeat(15001), 200_000)).toBe(true);
    expect(c.needsLLMCompression('mcp__a__b', 'x'.repeat(10000), 200_000)).toBe(false);
    expect(c.needsLLMCompression('mcp__a__b', 'x'.repeat(10001), 200_000)).toBe(true);
  });
});

describe('ToolCompressor.compress — 规则压缩与 LLM 回退', () => {
  it('文件读取短内容原样保留，并带上路径头', async () => {
    const c = new ToolCompressor();
    const r = await c.compress('Read', 'file: src/a.ts\nconst a = 1;', { enableLLMCompression: false });
    expect(r.strategy).toBe(ToolType.FILE_READ);
    expect(r.usedLLM).toBe(false);
    expect(r.content).toBe('📄 src/a.ts\nfile: src/a.ts\nconst a = 1;');
    expect(r.originalLength).toBe('file: src/a.ts\nconst a = 1;'.length);
    expect(r.compressedLength).toBe(r.content.length);
  });

  it('文件读取超长内容保留头尾并标注省略行数', async () => {
    const c = new ToolCompressor();
    const content = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')} ${'x'.repeat(50)}`).join('\n');
    const r = await c.compress('Read', content, {});
    /* 头尾按字符预算切 (kernelbugs 修复), 省略的行数随预算变, 只钉格式 */
    expect(r.content).toMatch(/\.\.\. \[省略 \d+ 行\] \.\.\./);
    expect(r.content).toContain('line-000');
    expect(r.content).toContain('line-099');
    expect(r.compressedLength).toBeLessThan(r.originalLength);
  });

  it('编辑结果提取 file/old/new 摘要', async () => {
    const c = new ToolCompressor();
    const r = await c.compress('Edit', 'file: src/a.ts\nold_string: foo\nnew_string: bar', {});
    expect(r.content).toContain('📝 编辑: src/a.ts');
    expect(r.content).toContain('旧内容: foo');
    expect(r.content).toContain('新内容: bar');
  });

  it('Bash 成功输出超长时保留头 10 行 + 尾 20 行', async () => {
    const c = new ToolCompressor();
    const content = 'command: npm run build\n' + Array.from({ length: 60 }, (_, i) => `row-${i} ${'x'.repeat(60)}`).join('\n');
    const r = await c.compress('Bash', content, {});
    expect(r.content.startsWith('$ npm run build\n')).toBe(true);
    expect(r.content).toContain('row-0');
    expect(r.content).toContain('row-59');
    expect(r.content).toContain('[省略');
  });

  it('Bash 错误输出保留更多内容，且元数据带 exitCode', async () => {
    const c = new ToolCompressor();
    const content = 'command: npm test\nerror: boom\n' + 'y'.repeat(3000);
    const r = await c.compress('Bash', content, {});
    expect(r.content.startsWith('$ npm test\n')).toBe(true);
    expect(r.content).toContain('error: boom');
    expect(r.metadata?.command).toBe('npm test');
    expect(r.metadata?.exitCode).toBe(1);
  });

  it('网页内容剥 HTML 标签并附上去重后的链接', async () => {
    const c = new ToolCompressor();
    const content = '<html><body><h1>Title</h1></body></html> https://a.example https://a.example https://b.example ';
    const r = await c.compress('WebFetch', content, {});
    expect(r.content).not.toContain('<html>');
    expect(r.content).toContain('Title');
    expect(r.content).toContain('相关链接');
    expect(r.content).toContain('- https://a.example');
    expect(r.content).toContain('- https://b.example');
    expect(r.metadata?.urls).toEqual(['https://a.example', 'https://b.example']);
  });

  it('搜索结果超过 30 行只保留前 30 行', async () => {
    const c = new ToolCompressor();
    const content = Array.from({ length: 40 }, (_, i) => `hit-${i}`).join('\n');
    const r = await c.compress('Grep', content, {});
    expect(r.content).toContain('hit-29');
    expect(r.content).not.toContain('hit-30');
    expect(r.content).toContain('还有 10 个结果');
  });

  it('搜索结果不超过 30 行原样返回', async () => {
    const c = new ToolCompressor();
    const content = 'a\nb\nc';
    const r = await c.compress('Glob', content, {});
    expect(r.content).toBe(content);
  });

  it('未知工具走通用头 70% / 尾 25% 截断', async () => {
    const c = new ToolCompressor();
    const content = 'H'.repeat(1000) + 'M'.repeat(2000) + 'T'.repeat(1000);
    const r = await c.compress('some_tool', content, {});
    expect(r.strategy).toBe(ToolType.OTHER);
    expect(r.content).toContain('... [省略 2100 字符] ...');
    expect(r.content.startsWith('H'.repeat(100))).toBe(true);
    expect(r.content.endsWith('T'.repeat(100))).toBe(true);
  });

  it('空输入不崩，长度统计正确', async () => {
    const c = new ToolCompressor();
    const r = await c.compress('Read', '', {});
    expect(r.content).toBe('');
    expect(r.originalLength).toBe(0);
    expect(r.compressedLength).toBe(0);
    expect(r.usedLLM).toBe(false);
  });

  it('支持 LLM 压缩时使用 LLM 结果', async () => {
    const provider = makeProvider(okReply('  summarized  '));
    const c = new ToolCompressor({ llmProvider: provider });
    const r = await c.compress('WebFetch', 'page body', {});
    expect(r.usedLLM).toBe(true);
    expect(r.content).toBe('summarized');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('超长输入送 LLM 前先截断到 8000 字符', async () => {
    const provider = makeProvider(okReply('ok'));
    const c = new ToolCompressor();
    await c.compress('WebFetch', 'z'.repeat(9000), { llmProvider: provider });
    const userContent = (provider.chat.mock.calls[0] as any[])[0][1].content as string;
    expect(userContent).toContain('z'.repeat(100));
    expect(userContent).toContain('[内容过长，已截断]');
    expect(userContent.length).toBeLessThan(8500);
  });

  it('LLM 抛错时回退到规则压缩', async () => {
    const provider = { chat: vi.fn(async () => { throw new Error('upstream 500'); }) } as any;
    const c = new ToolCompressor({ llmProvider: provider });
    const r = await c.compress('WebFetch', '<b>body</b>', {});
    expect(r.usedLLM).toBe(false);
    expect(r.content).toContain('body');
    expect(r.content).not.toContain('<b>');
  });

  it('LLM 返回空串时回退到规则压缩', async () => {
    const provider = makeProvider(okReply('   '));
    const c = new ToolCompressor({ llmProvider: provider });
    const r = await c.compress('WebFetch', 'plain body', {});
    expect(r.usedLLM).toBe(false);
    expect(r.content).toBe('plain body');
  });

  it('enableLLMCompression=false 时不调用 provider', async () => {
    const provider = makeProvider(okReply('summary'));
    const c = new ToolCompressor({ llmProvider: provider });
    const r = await c.compress('WebFetch', 'body', { enableLLMCompression: false });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(r.usedLLM).toBe(false);
  });

  it('没有 LLM provider 时走规则压缩', async () => {
    const c = new ToolCompressor();
    const r = await c.compress('Task', 'task result', {});
    expect(r.usedLLM).toBe(false);
    expect(r.content).toBe('task result');
  });
});
