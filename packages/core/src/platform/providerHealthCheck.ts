import https from 'https';
import { randomBytes } from 'crypto';
import type { HealthCheckRequest, HealthCheckResult } from '@neoxlabs/platform/shared/ipc.js';
import { tokenUsageService } from '@neoxlabs/platform/platform/tokenUsageService.js';
import { buildClaudeCodeHeaders, buildClaudePromptCacheControl, buildAnthropicAuthHeaders, shouldUseClaudeCodeIdentity } from '@neoxlabs/kernel/models/anthropicClaudeCode.js';

function generateRandomHex(length: number): string {
  const bytes = randomBytes(Math.ceil(length / 2));
  return bytes.toString('hex').slice(0, length);
}

function generateUUID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generateClaudeCodeUserId(): string {
  return `user_${generateRandomHex(64)}_account__session_${generateUUID()}`;
}

export function sanitizeUpstreamMessage(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const msg = raw.trim();
  if (!msg) return '';
  if (msg.length > 300) return '';                       // 太长基本是页面/堆栈, 不是给人看的
  if (/<\s*(html|head|body|!doctype|div|script)\b/i.test(msg)) return '';  // HTML 报错页
  if (/^\s*[[{]/.test(msg)) return '';                   // 还是一坨 JSON
  return msg;
}

/** 图片 / 非 chat 模型名 — 不能拿去打 chat/completions, 否则 Test Connection 误报红. */
export function isImageLikeModelName(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    /image|dall-?e|imagen|gpt-image|stable-diffusion|sdxl|flux|midjourney|firefly/.test(m) ||
    m.includes('imagine')
  );
}

function isImageProtocol(protocol: string | undefined): boolean {
  return protocol === 'openai-images';
}

/**
 * 图片协议 / 图片默认模型: 用 GET /models (或根路径) 做鉴权探测,
 * 不走 chat/completions, 避免"Key 明明对却显示模型不支持 chat"的误导.
 */
async function runImageProviderAuthProbe(options: {
  axios: any;
  providerId: string;
  cleanBaseUrl: string;
  joinUrl: (base: string, suffix: string) => string;
  apiKey: string;
  model: string;
  startTime: number;
}): Promise<HealthCheckResult> {
  const { axios, providerId, cleanBaseUrl, joinUrl, apiKey, model, startTime } = options;
  const candidates = [
    joinUrl(cleanBaseUrl, '/models'),
    joinUrl(cleanBaseUrl, '/v1/models'),
    cleanBaseUrl,
  ];
  let lastStatus: number | undefined;
  let lastError = '';
  for (const url of candidates) {
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
        validateStatus: () => true,
        httpsAgent: new https.Agent({ rejectUnauthorized: true, keepAlive: false }),
      });
      const latency = Date.now() - startTime;
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        const status: HealthCheckResult['status'] =
          latency < 1000 ? 'excellent' : latency < 3000 ? 'good' : 'poor';
        return { providerId, status, latency, timestamp: Date.now() };
      }
      if (response.status === 401 || response.status === 403) {
        lastError = sanitizeUpstreamMessage(response.data?.error?.message || response.data?.message)
          || 'API Key 无效或无权限';
        return {
          providerId,
          status: 'error',
          latency,
          timestamp: Date.now(),
          errorMessage: lastError,
          httpStatus: response.status,
        };
      }
      lastError = sanitizeUpstreamMessage(response.data?.error?.message || response.data?.message) || '';
    } catch (err: any) {
      lastError = err?.message || 'Network error';
    }
  }
  return {
    providerId,
    status: 'error',
    latency: Date.now() - startTime,
    timestamp: Date.now(),
    errorMessage: lastError
      || `图片模型 (${model}) 无法用聊天接口探测；鉴权探测也失败。请确认 Base URL / API Key。`,
    httpStatus: lastStatus,
  };
}

/**
 * 托管 provider 探活 —— 打 NeoxCloud 控制面 GET /api/health.
 *
 *   无鉴权、零额度成本, 所以可以让自动健康检查周期性跑。
 *   档位跟通用路径同口径 (<1s excellent / <3s good / 否则 poor), 用户在同一张表里
 *   看到的"快慢"含义一致。网络层失败归 offline 而不是 error —— error 在这张表里
 *   代表"配置/鉴权有问题需要你动手", 网络不通不是。
 */
async function probeNeoxCloud(providerId: string, cloudBase: string): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${cloudBase}/api/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    const latency = Date.now() - startTime;
    if (res.status >= 200 && res.status < 300) {
      const status: HealthCheckResult['status'] =
        latency < 1000 ? 'excellent' : latency < 3000 ? 'good' : 'poor';
      return { providerId, status, latency, timestamp: Date.now() };
    }
    return {
      providerId,
      status: 'error',
      latency,
      timestamp: Date.now(),
      errorMessage: `NeoxCloud 控制面返回 HTTP ${res.status}`,
      httpStatus: res.status,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string } | null;
    const timedOut = e?.name === 'AbortError';
    return {
      providerId,
      status: 'offline',
      latency: Date.now() - startTime,
      timestamp: Date.now(),
      errorMessage: timedOut ? 'NeoxCloud 控制面探测超时' : '无法连接 NeoxCloud 控制面',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runProviderHealthCheck(request: HealthCheckRequest): Promise<HealthCheckResult> {
  if (!request || typeof request !== 'object' || !request.providerId) {
    return {
      providerId: (request as HealthCheckRequest | undefined)?.providerId || '',
      status: 'error',
      latency: 0,
      timestamp: Date.now(),
      errorMessage: 'Health check request missing providerId',
    };
  }

  const { providerId, protocol, baseUrl, urlSuffix, apiKey, model } = request;
  const startTime = Date.now();

  let status: HealthCheckResult['status'] = 'offline';
  let latency = 0;
  let errorMessage = '';
  let httpStatus: number | undefined;

  const keyTrim = (apiKey || '').trim();
  if (providerId === 'neox-cloud' || keyTrim === 'neox-managed') {
    const cloudBase = (request.cloudApiBase || '').trim().replace(/\/+$/, '');
    const resolved = keyTrim && keyTrim !== 'neox-managed';
    if (!resolved || !cloudBase) {
      return {
        providerId,
        status: 'error',
        latency: 0,
        timestamp: Date.now(),
        errorMessage: '请先登录 Neox Cloud',
      };
    }
    return await probeNeoxCloud(providerId, cloudBase);
  }
  if (!keyTrim) {
    return {
      providerId,
      status: 'error',
      latency: 0,
      timestamp: Date.now(),
      errorMessage: 'API Key 未配置',
    };
  }
  const baseTrim = (baseUrl || '').trim();
  if (!baseTrim) {
    return {
      providerId,
      status: 'error',
      latency: 0,
      timestamp: Date.now(),
      errorMessage: 'Base URL 未配置',
    };
  }

  try {
    const axios = (await import('axios')).default;

    let cleanBaseUrl = baseTrim.replace(/\/+$/, '');
    if (!cleanBaseUrl.startsWith('http://') && !cleanBaseUrl.startsWith('https://')) {
      cleanBaseUrl = 'https://' + cleanBaseUrl;
    }

    const joinUrl = (base: string, suffix: string): string => {
      const b = base.replace(/\/+$/, '');
      const s = '/' + suffix.replace(/^\/+/, '');
      const combined = b + s;
      /* 去掉 /v1/v1, /v1/messages 接在 /v1 base 上等情况 */
      return combined.replace(/\/v1\/v1\b/g, '/v1');
    };

    if (isImageProtocol(protocol) || isImageLikeModelName(model)) {
      return await runImageProviderAuthProbe({
        axios,
        providerId,
        cleanBaseUrl,
        joinUrl,
        apiKey: keyTrim,
        model: model || '',
        startTime,
      });
    }

    const isAnthropicOfficial = cleanBaseUrl.includes('api.anthropic.com');

    /* Claude Code 身份策略必须跟 AnthropicProvider 保持一致, 否则 Test Connection 走 A 身份、
     *   真 chat 走 B 身份, 用户看到"测试通过但 chat 报 400". 三态:
     *     'auto' (未配, 默认) = 按 baseUrl 判
     *     'on'  = 强制伪装 Claude Code
     *     'off' = 强制 Neox 原生 (不伪装, 直发标准 Anthropic 请求) */
    const useClaudeCodeIdentity = shouldUseClaudeCodeIdentity(cleanBaseUrl, request.claudeCodeMode ?? 'auto');

    // Detect proxies that do not support cache_control order.
    const shouldDisableCaching = request.disableCaching ||
      cleanBaseUrl.includes('openclaudecode.cn') ||
      cleanBaseUrl.includes('openclaudecode.com');

    let healthUrl: string;
    let headers: Record<string, string>;
    let payload: any;

    if (protocol === 'anthropic') {
      healthUrl = joinUrl(cleanBaseUrl, '/v1/messages');

      const claudeUserId = generateClaudeCodeUserId();
      const systemBlock: any = {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      };
      if (!shouldDisableCaching) {
        systemBlock.cache_control = buildClaudePromptCacheControl();
      }

      const toolBlock: any = {
        name: 'Read',
        description: 'Read file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      };
      if (!shouldDisableCaching) {
        toolBlock.cache_control = buildClaudePromptCacheControl();
      }

      payload = {
        model,
        system: [systemBlock],
        metadata: {
          user_id: claudeUserId,
        },
        max_tokens: 1,
        temperature: 1,
        stream: true,
        messages: [{
          role: 'user',
          content: '1',
        }],
        tools: [toolBlock],
      };

      if (!useClaudeCodeIdentity) {
        headers = {
          'Content-Type': 'application/json',
          ...buildAnthropicAuthHeaders(keyTrim),
          'anthropic-version': '2023-06-01',
        };
        /* 不伪装时 payload 里的假 system 声明也不该发 */
        payload.system = [];
      } else {
        headers = buildClaudeCodeHeaders({
          authToken: keyTrim,
          helperMethod: 'stream',
        });
        healthUrl = healthUrl.replace('/v1/messages', '/v1/messages?beta=true');
      }
    } else if (protocol === 'openai-responses') {
      healthUrl = joinUrl(cleanBaseUrl, '/responses');
      const sessionId = randomBytes(16).toString('hex');
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyTrim}`,
        'Accept': 'text/event-stream',
        'conversation_id': sessionId,
        'session_id': sessionId,
      };
      payload = {
        model,
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        }],
        stream: true,
        temperature: 0.7,
        store: false,
        prompt_cache_key: sessionId,
        instructions: 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. You are expected to be precise, safe, and helpful.',
        tools: [{
          type: 'function',
          name: 'shell',
          description: 'Execute shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
          strict: true,
        }],
      };
    } else if (protocol === 'doubao') {
      healthUrl = joinUrl(cleanBaseUrl, '/responses');
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyTrim}`,
        'Accept': 'text/event-stream',
      };
      payload = {
        model,
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        }],
        stream: true,
        temperature: 0.7,
        store: false,
        max_output_tokens: 1,
      };
    } else if (protocol === 'kimi') {
      const suffix = urlSuffix || '/chat/completions';
      healthUrl = joinUrl(cleanBaseUrl, suffix);
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyTrim}`,
      };
      payload = {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: '1' }],
      };
    } else {
      /* 与 protocolModels.openai 对齐: base 通常已含 /v1 或 /v4, 默认只拼 /chat/completions.
       * 旧默认 /v1/chat/completions 会把智谱 …/paas/v4 拼成 …/v4/v1/chat/completions → 404. */
      const suffix = urlSuffix || '/chat/completions';
      healthUrl = joinUrl(cleanBaseUrl, suffix);
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyTrim}`,
      };
      payload = {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: '1' }],
      };
    }

    if (!headers.session_id) headers.session_id = `neox-probe-${randomBytes(8).toString('hex')}`;

    console.log('[HealthCheck] Request:', { url: healthUrl, model, protocol });
    console.log('[HealthCheck] Header names:', Object.keys(headers));
    console.log('[HealthCheck] Payload keys:', Object.keys(payload));

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 30000);

    const httpsAgent = new https.Agent({
      rejectUnauthorized: true,
      keepAlive: false,
    });

    const response = await axios.post(healthUrl, payload, {
      headers,
      timeout: 30000,
      responseType: protocol === 'anthropic' && !isAnthropicOfficial ? 'stream' : 'json',
      validateStatus: () => true,
      signal: abortController.signal,
      httpsAgent,
    });

    clearTimeout(timeoutId);
    latency = Date.now() - startTime;

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let anthropicCacheReadTokens = 0;
    let anthropicCacheCreationTokens = 0;

    if (response.status >= 200 && response.status < 300) {
      if (protocol === 'anthropic' && !isAnthropicOfficial && response.data) {
        const stream = response.data;
        try {
          let fullData = '';
          for await (const data of stream) {
            fullData += data.toString();
          }

          const events = fullData.split(/\n\n+/);
          for (const eventBlock of events) {
            const lines = eventBlock.split('\n');
            let dataContent = '';
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (trimmedLine.startsWith('data:')) {
                let data = trimmedLine.slice(5);
                if (data.startsWith(' ')) data = data.slice(1);
                dataContent += data;
              } else if (!trimmedLine.startsWith('event:') && trimmedLine) {
                dataContent += trimmedLine;
              }
            }
            if (!dataContent) continue;

            try {
              const event = JSON.parse(dataContent.trim());
              if (event.type === 'message_start' && event.message?.usage) {
                const usage = event.message.usage;
                inputTokens = usage.input_tokens || 0;
                outputTokens = usage.output_tokens || 0;
                anthropicCacheReadTokens = usage.cache_read_input_tokens || 0;
                anthropicCacheCreationTokens = usage.cache_creation_input_tokens || 0;
                cachedTokens = anthropicCacheReadTokens;
              }
              if (event.type === 'message_delta' && event.usage) {
                outputTokens = event.usage.output_tokens || outputTokens;
              }
            } catch {}
          }
          console.log('[HealthCheck]', healthUrl, 'Usage:', { inputTokens, outputTokens, cachedTokens });
        } catch (streamErr: any) {
          if (!streamErr.message?.includes('aborted') && !streamErr.message?.includes('destroyed')) {
            console.log('[HealthCheck] Stream read warning:', streamErr.message);
          }
        } finally {
          try {
            if (stream && typeof stream.destroy === 'function') {
              stream.destroy();
            }
          } catch (destroyErr) {
            console.log('[HealthCheck] Stream destroy warning:', destroyErr);
          }
        }
      } else if (response.data?.usage) {
        const usage = response.data.usage;
        inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
        outputTokens = usage.completion_tokens || usage.output_tokens || 0;
        cachedTokens = usage.cached_tokens || 0;
      }

      if (latency < 1000) status = 'excellent';
      else if (latency < 3000) status = 'good';
      else status = 'poor';

      const totalTokens = inputTokens + outputTokens;
      if (totalTokens > 0) {
        await tokenUsageService.recordUsage({
          timestamp: Date.now(),
          provider: providerId,
          model,
          inputTokens,
          outputTokens,
          totalTokens,
          cachedTokens,
          anthropicCacheReadTokens,
          anthropicCacheCreationTokens,
          duration: latency,
          success: true,
          requestType: 'health-check',
        });
        console.log('[HealthCheck]', healthUrl, 'Token usage recorded:', totalTokens);
      }
    } else {
      status = 'error';
      httpStatus = response.status;
      const errorStream = response.data;
      try {
        if (errorStream && typeof errorStream.on === 'function') {
          let streamData = '';
          try {
            for await (const chunk of errorStream) {
              streamData += chunk.toString();
              if (streamData.length > 500) break;
            }
          } finally {
            if (errorStream && typeof errorStream.destroy === 'function') {
              errorStream.destroy();
            }
          }
          console.log('[HealthCheck] Error stream data:', streamData.substring(0, 300));
          try {
            const parsed = JSON.parse(streamData);
            errorMessage = sanitizeUpstreamMessage(parsed?.error?.message || parsed?.message);
          } catch {
            /* 解析不出结构化消息就**不给** —— 原始响应体(JSON 片段 / Cloudflare HTML)
             * 直接显示给用户是纯噪音, UI 侧会用 httpStatus 翻成一句人话。 */
            errorMessage = '';
          }
        } else if (typeof response.data === 'string') {
          errorMessage = '';                                     // 同上: 不甩原始 body
        } else if (response.data?.error?.message) {
          errorMessage = sanitizeUpstreamMessage(response.data.error.message);
        } else if (response.data?.message) {
          errorMessage = sanitizeUpstreamMessage(response.data.message);
        } else {
          errorMessage = '';                                     // 不 JSON.stringify 整个响应
        }
      } catch (readErr: any) {
        console.log('[HealthCheck] Error reading response:', readErr.message);
        if (errorStream && typeof errorStream.destroy === 'function') {
          try {
            errorStream.destroy();
          } catch {}
        }
      }
      console.log('[HealthCheck]', healthUrl, 'Error:', response.status, errorMessage);
    }
  } catch (err: any) {
    latency = Date.now() - startTime;
    errorMessage = err.message || 'Unknown error';
    httpStatus = err?.response?.status ?? httpStatus;

    if (errorMessage.includes('SSLV3_ALERT_HANDSHAKE_FAILURE') ||
        errorMessage.includes('SSL') ||
        errorMessage.includes('EPROTO')) {
      errorMessage = 'SSL/TLS 握手失败 - 请检查代理服务是否正常，或尝试使用 http:// 替代 https://';
      status = 'error';
      console.log('[HealthCheck] SSL Error for URL:', request.baseUrl);
    } else {
      status = err.code === 'ECONNABORTED' ? 'poor' : 'offline';
      /* 网络层错误码是纯黑话 —— 用户看到 "connect ECONNREFUSED 127.0.0.1:8080" 只会懵。
       * 翻成一句能照着做的话, 口径跟上面 SSL 分支一致。原始码留在 console 供排查。 */
      const netHints: Record<string, string> = {
        ECONNREFUSED: '连接被拒绝 — 地址或端口不对, 若走代理请确认代理已启动',
        ENOTFOUND:    '域名解析失败 — 检查接口地址是否写错, 或网络/DNS 是否正常',
        ETIMEDOUT:    '连接超时 — 检查网络, 或该地址在当前网络下是否可达',
        ECONNABORTED: '请求超时 — 上游响应太慢, 可稍后重试或换个接口地址',
        ECONNRESET:   '连接被重置 — 通常是代理或上游中断了连接, 可重试',
        EHOSTUNREACH: '主机不可达 — 检查网络或 VPN/代理设置',
      };
      const hint = netHints[err.code as string];
      if (hint) errorMessage = hint;
    }
    console.log('[HealthCheck] Exception:', err?.code, err?.message);
  }

  /* 404/5xx 常故意不塞原始 body; 至少给一句可行动的 httpStatus 人话, 避免设置页空白失败. */
  if (!errorMessage && httpStatus) {
    errorMessage = httpStatus === 404
      ? `HTTP 404 — 检查接口地址或模型路径 (baseUrl / urlSuffix)`
      : `HTTP ${httpStatus}`;
  }

  return {
    providerId,
    status,
    latency,
    timestamp: Date.now(),
    errorMessage: errorMessage || undefined,
    httpStatus,
  };
}
