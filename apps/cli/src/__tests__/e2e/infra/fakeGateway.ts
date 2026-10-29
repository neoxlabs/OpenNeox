import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ScriptedToolCall {
  id?: string;
  name: string;
  /** 固定参数; 传函数则按本次请求 body 现算 (测试要从 <pid> 之类动态字段取值时用) */
  arguments: string | ((body: any) => string);
}

export interface ScriptedResponse {
  /** 只有最后一轮 user 文本包含这个子串才命中; 不传 = 任意请求 */
  match?: string;
  /** 完整回复文本. 不传用 defaultText */
  text?: string;
  /** 按数组分块下发 (覆盖 text 分块方式) */
  chunks?: string[];
  /** 每块之间延迟, 默认 30ms */
  chunkDelayMs?: number;
  /** 直接返回 HTTP 错误 */
  httpStatus?: number;
  /** 错误 body (JSON) */
  errorBody?: unknown;
  /** 永不结束的响应 —— 测超时 / 中断 */
  hang?: boolean;
  /** tool_calls (OpenAI delta 格式) */
  toolCalls?: ScriptedToolCall[];
  /** 命中一次后移除, 默认 true */
  once?: boolean;
}

export interface GatewayRequest {
  method: string;
  url: string;
  body: any;
  rawBody: string;
  aborted: boolean;
  ts: number;
  /** 标题生成 / 摘要等侧路请求 —— 不消费脚本队列, 也不计入 chatRequests() */
  aux: boolean;
}

export interface FakeGateway {
  port: number;
  /** 给 provider baseUrl 用, 带 /v1 后缀 */
  baseUrl: string;
  /** 追加脚本响应 */
  push(response: ScriptedResponse): void;
  /** 收到的所有请求 */
  requests: GatewayRequest[];
  /** 只算 chat completions 请求 */
  chatRequests(): GatewayRequest[];
  requestCount(): number;
  /** 等待第 n 个 chat 请求到达 (从 1 开始) */
  waitForChat(n: number, timeoutMs?: number): Promise<GatewayRequest>;
  stop(): Promise<void>;
}

interface InternalResponse extends ScriptedResponse {
  used?: boolean;
}

const DEFAULT_TEXT = 'mock reply';

function lastUserText(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...messages].reverse().find((m: any) => m?.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

/** 标题生成 / 摘要这类侧路请求: 走同一个 provider, 但不是被测的对话轮. */
function isAuxRequest(body: any): boolean {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((m: any) => {
    if (m?.role !== 'system') return false;
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : '';
    return /title generator|generate a (?:short )?title|summari[sz]e the conversation/i.test(text);
  });
}

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function completionChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown): unknown {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 本地 OpenAI 兼容假网关. 不走外网, 不签 HMAC (只服务 BYOK /v1 provider).
 * 支持 SSE 流式、非流式、HTTP 错误、挂起、tool_calls.
 */
export async function startFakeGateway(opts: { defaultText?: string } = {}): Promise<FakeGateway> {
  const scripted: InternalResponse[] = [];
  const requests: GatewayRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const waiters: Array<{ n: number; resolve: (r: GatewayRequest) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  const defaultText = opts.defaultText ?? DEFAULT_TEXT;

  const notify = (): void => {
    const chatCount = requests.filter((r) => !r.aux && r.url.includes('/chat/completions')).length;
    for (const waiter of [...waiters]) {
      if (chatCount >= waiter.n) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        const req = requests.filter((r) => !r.aux && r.url.includes('/chat/completions'))[waiter.n - 1];
        waiter.resolve(req);
      }
    }
  };

  const pick = (body: any): InternalResponse => {
    const text = lastUserText(body);
    const index = scripted.findIndex((s) => !s.used && (!s.match || text.includes(s.match)));
    if (index >= 0) {
      const picked = scripted[index];
      picked.used = true;
      if (picked.once === false) picked.used = false;
      return picked;
    }
    return {};
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    sockets.add(req.socket);
    req.socket.on('close', () => sockets.delete(req.socket));

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: any = {};
      try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { /* keep {} */ }

      if (req.method === 'GET' && /\/models\b/.test(req.url || '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }));
        return;
      }

      if (!/\/chat\/completions\b/.test(req.url || '')) {
        /* 其它探测端点一律 200, 不制造额外噪音 */
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const aux = isAuxRequest(body);
      const record: GatewayRequest = {
        method: req.method || 'POST',
        url: req.url || '',
        body,
        rawBody,
        aborted: false,
        ts: Date.now(),
        aux,
      };
      requests.push(record);
      notify();

      const response = aux ? {} : pick(body);
      const model = body?.model || 'mock-model';
      const stream = body?.stream !== false;

      res.on('close', () => {
        if (!res.writableEnded) record.aborted = true;
      });

      if (response.hang) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hang\n\n');
        return;
      }

      if (response.httpStatus) {
        res.writeHead(response.httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response.errorBody ?? { error: { message: 'mock upstream failure', type: 'mock_error' } }));
        return;
      }

      const toolCalls = (response.toolCalls || []).map((t) => ({
        id: t.id,
        name: t.name,
        arguments: typeof t.arguments === 'function' ? t.arguments(body) : t.arguments,
      }));
      const text = response.text ?? defaultText;
      const textChunks = response.chunks ?? (text ? [text] : []);
      const delayMs = response.chunkDelayMs ?? 30;

      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: toolCalls.length > 0 ? null : text,
              ...(toolCalls.length > 0
                ? { tool_calls: toolCalls.map((t, i) => ({ id: t.id || `call_${i}`, type: 'function', function: { name: t.name, arguments: t.arguments } })) }
                : {}),
            },
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sse(res, completionChunk(model, { role: 'assistant', content: '' }));

      let delay = 0;
      for (const chunk of textChunks) {
        delay += delayMs;
        const payload = chunk;
        setTimeout(() => {
          if (res.writableEnded || record.aborted) return;
          sse(res, completionChunk(model, { content: payload }));
        }, delay);
      }

      if (toolCalls.length > 0) {
        delay += delayMs;
        setTimeout(() => {
          if (res.writableEnded || record.aborted) return;
          sse(res, completionChunk(model, {
            tool_calls: toolCalls.map((t, i) => ({
              index: i,
              id: t.id || `call_${i}`,
              type: 'function',
              function: { name: t.name, arguments: t.arguments },
            })),
          }));
        }, delay);
      }

      delay += delayMs;
      setTimeout(() => {
        if (res.writableEnded || record.aborted) return;
        sse(res, completionChunk(model, {}, toolCalls.length > 0 ? 'tool_calls' : 'stop', {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      }, delay);
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake gateway: 没有拿到端口');
  const port = address.port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    push(response) { scripted.push({ ...response }); },
    chatRequests() { return requests.filter((r) => !r.aux && r.url.includes('/chat/completions')); },
    requestCount() { return this.chatRequests().length; },
    waitForChat(n, timeoutMs = 20_000) {
      return new Promise<GatewayRequest>((resolve, reject) => {
        const chat = requests.filter((r) => !r.aux && r.url.includes('/chat/completions'));
        if (chat.length >= n) { resolve(chat[n - 1]); return; }
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`fake gateway: 等第 ${n} 个 chat 请求超时 (已收到 ${chat.length})`));
        }, timeoutMs);
        waiters.push({ n, resolve, reject, timer });
      });
    },
    async stop() {
      for (const waiter of waiters.splice(0)) clearTimeout(waiter.timer);
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
