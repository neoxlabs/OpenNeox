/**
 * E2E Capability Tests — 多协议真实 API 调用
 *
 * 从 test.config.json 读取 provider 配置
 * 每个 enabled: true 的 provider 都会跑一遍完整测试
 * 没有配置或全部 disabled 时自动跳过
 *
 * 配置方式: 编辑项目根目录 test.config.json
 *   → 填入 apiKey
 *   → 设 enabled: true
 *
 * 测试项:
 * 1. 基础对话 — 能回复
 * 2. 指令遵循 — 能按格式回答
 * 3. 工具调用 — Function Calling
 * 4. 多轮记忆 — 上下文引用
 * 5. 中文理解 — 中文指令
 * 6. 流式响应 — SSE
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── 配置加载 ─── //

interface TestProvider {
    protocol: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    enabled: boolean;
}

interface TestConfig {
    providers: Record<string, TestProvider>;
}

function loadTestConfig(): TestConfig {
    const configPath = resolve(process.cwd(), 'test.config.json');

    if (!existsSync(configPath)) {
        return { providers: {} };
    }

    try {
        const raw = readFileSync(configPath, 'utf-8');
        return JSON.parse(raw) as TestConfig;
    } catch {
        return { providers: {} };
    }
}

const config = loadTestConfig();
const enabledProviders = Object.entries(config.providers)
    .filter(([, p]) => p.enabled && p.apiKey)
    .map(([name, p]) => ({ name, ...p }));

const HAS_PROVIDERS = enabledProviders.length > 0;

// ─── HTTP 工具 ─── //

async function chatCompletion(
    provider: TestProvider & { name: string },
    messages: Array<{ role: string; content: string }>,
    options?: {
        tools?: any[];
        stream?: boolean;
    },
): Promise<any> {
    const isAnthropic = provider.protocol === 'anthropic';

    // ─── Anthropic 原生协议 ─── //
    if (isAnthropic) {
        return anthropicRequest(provider, messages, options);
    }

    // ─── OpenAI 兼容协议 (OpenAI/DeepSeek/Kimi/Doubao/GLM/Gemini) ─── //
    return openaiRequest(provider, messages, options);
}

async function openaiRequest(
    provider: TestProvider & { name: string },
    messages: Array<{ role: string; content: string }>,
    options?: { tools?: any[]; stream?: boolean },
): Promise<any> {
    const payload: any = {
        model: provider.model,
        messages,
        temperature: 0,
        max_tokens: 500,
    };
    if (options?.tools) payload.tools = options.tools;

    if (options?.stream) {
        const response = await fetch(`${provider.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({ ...payload, stream: true }),
        });

        if (!response.ok) {
            throw new Error(`[${provider.name}] API error: ${response.status}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let content = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (trimmed.startsWith('data: ')) {
                    try {
                        const chunk = JSON.parse(trimmed.slice(6));
                        const delta = chunk.choices?.[0]?.delta?.content;
                        if (delta) content += delta;
                    } catch { /* skip */ }
                }
            }
        }
        return { content, stream: true };
    }

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`[${provider.name}] API error: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.choices[0].message;
}

async function anthropicRequest(
    provider: TestProvider & { name: string },
    messages: Array<{ role: string; content: string }>,
    options?: { tools?: any[]; stream?: boolean },
): Promise<any> {
    // Anthropic 的 system 要单独提取
    const sysMessages = messages.filter(m => m.role === 'system');
    const nonSys = messages.filter(m => m.role !== 'system');

    const payload: any = {
        model: provider.model,
        max_tokens: 500,
        messages: nonSys,
    };
    if (sysMessages.length > 0) {
        payload.system = sysMessages.map(m => m.content).join('\n');
    }
    if (options?.tools) {
        payload.tools = options.tools.map(t => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
        }));
    }

    const response = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`[${provider.name}] API error: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json();

    // 转换为统一格式
    const textBlocks = data.content?.filter((b: any) => b.type === 'text') || [];
    const toolBlocks = data.content?.filter((b: any) => b.type === 'tool_use') || [];

    return {
        content: textBlocks.map((b: any) => b.text).join(''),
        tool_calls: toolBlocks.length > 0
            ? toolBlocks.map((b: any) => ({
                function: { name: b.name, arguments: JSON.stringify(b.input) },
            }))
            : undefined,
    };
}

// ─── 测试定义 ─── //

describe('E2E Capability Tests', () => {
    beforeAll(() => {
        if (!HAS_PROVIDERS) {
            console.log('\n⏭️  No providers enabled in test.config.json — E2E tests skipped');
            console.log('   Edit test.config.json → set apiKey + enabled: true\n');
        } else {
            console.log(`\n🧪 Testing ${enabledProviders.length} provider(s): ${enabledProviders.map(p => p.name).join(', ')}\n`);
        }
    });

    // 为每个 enabled 的 provider 生成测试
    for (const provider of enabledProviders) {
        describe(`[${provider.name}] ${provider.model}`, () => {

            // ────────────────────────────────────────
            // 1. 基础对话
            // ────────────────────────────────────────
            it('基础对话 — 能回复', async () => {
                const result = await chatCompletion(provider, [
                    { role: 'user', content: 'Reply with exactly: HELLO_NEOX' },
                ]);
                expect(result.content).toBeTruthy();
                expect(result.content).toContain('HELLO_NEOX');
            }, 30000);

            // ────────────────────────────────────────
            // 2. 指令遵循
            // ────────────────────────────────────────
            it('指令遵循 — 按格式回答', async () => {
                const result = await chatCompletion(provider, [
                    { role: 'user', content: 'What is 2+2? Reply with only the number, nothing else.' },
                ]);
                expect(result.content.trim()).toContain('4');
            }, 30000);

            // ────────────────────────────────────────
            // 3. 工具调用
            // ────────────────────────────────────────
            it('工具调用 — Function Calling', async () => {
                const tools = [{
                    type: 'function',
                    function: {
                        name: 'readfile',
                        description: 'Read file contents',
                        parameters: {
                            type: 'object',
                            properties: {
                                file_path: { type: 'string', description: 'Path to file' },
                            },
                            required: ['file_path'],
                        },
                    },
                }];

                const result = await chatCompletion(provider, [
                    { role: 'user', content: 'Read the file /src/main.ts' },
                ], { tools });

                expect(result.tool_calls).toBeTruthy();
                expect(result.tool_calls.length).toBeGreaterThan(0);
                expect(result.tool_calls[0].function.name).toBe('readfile');
            }, 30000);

            // ────────────────────────────────────────
            // 4. 多轮记忆
            // ────────────────────────────────────────
            it('多轮对话 — 上下文记忆', async () => {
                const result = await chatCompletion(provider, [
                    { role: 'user', content: 'My secret code is NEOX42. Remember it.' },
                    { role: 'assistant', content: 'I have noted your secret code: NEOX42.' },
                    { role: 'user', content: 'What is my secret code? Reply with only the code.' },
                ]);
                expect(result.content).toContain('NEOX42');
            }, 30000);

            // ────────────────────────────────────────
            // 5. 中文理解
            // ────────────────────────────────────────
            it('中文理解 — 中文指令处理', async () => {
                const result = await chatCompletion(provider, [
                    { role: 'user', content: '用一句中文回答：TypeScript 是什么？' },
                ]);
                expect(result.content).toBeTruthy();
                // 应包含中文字符
                expect(/[\u4e00-\u9fa5]/.test(result.content)).toBe(true);
            }, 30000);

            // ────────────────────────────────────────
            // 6. 流式响应 (仅 OpenAI 协议)
            // ────────────────────────────────────────
            if (provider.protocol !== 'anthropic') {
                it('流式响应 — SSE 正常', async () => {
                    const result = await chatCompletion(provider, [
                        { role: 'user', content: 'Count from 1 to 5, one number per line.' },
                    ], { stream: true });

                    expect(result.stream).toBe(true);
                    expect(result.content).toBeTruthy();
                    expect(result.content).toContain('1');
                    expect(result.content).toContain('5');
                }, 30000);
            }
        });
    }

    // 无 provider 时生成占位跳过测试
    if (!HAS_PROVIDERS) {
        it.skip('no providers configured (edit test.config.json)', () => { });
    }
});
