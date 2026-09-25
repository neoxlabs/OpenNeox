/**
 * 测试用 stdio MCP server —— 用 SDK 的低层 Server, 这样工具名可以是任意字符串
 * (高层 McpServer 会校验名字, 造不出"带点/空格/超长"这种真实世界里存在的名字)。
 *
 * 行为由 FIXTURE_MODE 控制:
 *   (默认)  正常服务, 工具见下方 TOOLS
 *   exit    启动就往 stderr 写一句然后 exit(3) —— "命令对了但进程立刻挂"
 *   nolist  不声明 tools 能力 (只有 resources/prompts 的 server 是合法的)
 *   listfail 声明了 tools, 但 tools/list 抛错
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { writeFileSync } from 'node:fs';

const mode = process.env.FIXTURE_MODE || 'normal';
/* 让测试拿到真子进程 pid, 好判断它有没有被收掉 */
if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));

if (mode === 'crash') {
  /* 未捕获异常: node 把一整段栈打到 stderr, 真正那句在栈帧前面 */
  const deep = (n) => { if (n === 0) throw new Error('GITHUB_TOKEN is not set'); deep(n - 1); };
  deep(12);
}

if (mode === 'exit') {
  process.stderr.write('fixture: missing API_KEY, bailing out\n');
  process.exit(3);
}

/* 1x1 PNG */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TOOLS = [
  { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'get.screenshot', description: 'returns an image', inputSchema: { type: 'object', properties: {} } },
  { name: 'read resource', description: 'returns embedded resource', inputSchema: { type: 'object', properties: {} } },
  { name: 'x'.repeat(80), description: 'very long name', inputSchema: { type: 'object', properties: {} } },
  { name: 'always_fails', description: 'isError result', inputSchema: { type: 'object', properties: {} } },
  { name: 'fails_with_image_only', description: 'isError with non-text content', inputSchema: { type: 'object', properties: {} } },
  { name: 'structured', description: 'structuredContent only', inputSchema: { type: 'object', properties: {} } },
];

const capabilities = mode === 'nolist' ? {} : { tools: {} };
const server = new Server({ name: 'fixture', version: '0.0.1' }, { capabilities });

if (mode !== 'nolist') {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (mode === 'listfail') throw new Error('tool registry not ready');
    return { tools: TOOLS };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    switch (name) {
      case 'echo':
        return { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] };
      case 'get.screenshot':
        return {
          content: [
            { type: 'text', text: 'here is the screenshot' },
            { type: 'image', data: PNG_1PX, mimeType: 'image/png' },
          ],
        };
      case 'read resource':
        return {
          content: [
            { type: 'resource', resource: { uri: 'file:///notes.md', mimeType: 'text/markdown', text: '# Notes\nresource body' } },
          ],
        };
      case 'always_fails':
        return { isError: true, content: [{ type: 'text', text: 'rate limited by upstream: 429 Too Many Requests' }] };
      case 'fails_with_image_only':
        return { isError: true, content: [{ type: 'image', data: PNG_1PX, mimeType: 'image/png' }] };
      case 'structured':
        return { content: [], structuredContent: { temperature: 21.5, unit: 'C' } };
      default:
        if (name === 'x'.repeat(80)) return { content: [{ type: 'text', text: 'long-name-ok' }] };
        throw new Error(`unknown tool ${name}`);
    }
  });
}

await server.connect(new StdioServerTransport());
