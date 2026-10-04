/**
 * Neox Config Tool — AI 辅助配置工具
 *
 * 让 AI 读取、修改 Neox 的 config.json 配置。
 * 放在 select_tools 的 neox_config 类别下，按需激活。
 *
 * 支持操作：
 * - neox_config: 统一配置查询/变更提案工具 (Team P1 能力 1, 读写分离; 见文件下半部)
 * - read_config: 读取当前配置（全部或指定 key）
 * - write_config: 写入/更新配置项
 * - list_providers: 列出所有 Provider
 * - add_provider: 添加新 Provider
 * - set_default_provider: 设置默认 Provider
 * - remove_provider: 删除 Provider
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { loadConfig, saveConfig, CONFIG_FILE, type NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import { markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';
import { wrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import type { ProviderProtocol } from '@neoxlabs/kernel/types/configTypes.js';
import { ToolCategory, ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { askUserTool } from './askUserTool.js';
import {
  getBashDefaultTimeoutMs,
  getBashMaxTimeoutMs,
  getMaxThreadDepth,
  getModelOrchestrationMode,
  getOsSandboxMode,
  isOsSandboxEnabled,
  isOsSandboxNetworkAllowed,
  refreshAgentRuntimeConfig,
} from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';
import { getGlobalHealthTracker } from '@neoxlabs/platform/platform/providerHealthState.js';
import { listMcpServers } from '../mcp/configStore.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ==================== Typed Args Interfaces ====================

interface ReadConfigArgs {
    key?: string;
}

interface WriteConfigArgs {
    key: string;
    value: unknown;
}

interface AddProviderArgs {
    name: string;
    protocol: string;
    apiKey: string;
    model: string;
    baseUrl?: string;
    setAsDefault?: boolean;
}

interface ProviderIdArgs {
    providerId: string;
}

interface SwitchModelArgs {
    model: string;
    providerId?: string;
}

interface ListModelsArgs {
    provider?: string;
}

interface McpManageArgs {
    action: 'list' | 'add' | 'remove' | 'toggle';
    id?: string;
    command?: string;
    args?: string[];
    transport?: 'stdio' | 'sse' | 'http';
    url?: string;
}

interface HealthCheckArgs {
    providerId?: string;
}

interface ExportConfigArgs {
    includeKeys?: boolean;
    sections?: string[];
}

const HOT_RELOAD_HINT = '更改已写入配置，运行时会自动重新加载新的 Provider / 模型设置。';

const SECRET_FIELD_RE = /(api[_-]?key|apikey|secret|token|password|authorization|credential|bearer|refresh[_-]?token|access[_-]?token)/i;

const READ_PERMISSION = { category: ToolCategory.READ, allowInAskMode: true };
const CONFIG_WRITE_PERMISSION = {
    category: ToolCategory.SYSTEM,
    defaultPermission: ToolPermission.ASK,
    permissionReason: 'This can change local Neox configuration',
    allowInAskMode: false,
};
const CONFIG_EXPORT_PERMISSION = {
    category: ToolCategory.SYSTEM,
    defaultPermission: ToolPermission.ASK,
    permissionReason: 'This can expose local Neox configuration metadata',
    allowInAskMode: false,
};
const NETWORK_CHECK_PERMISSION = {
    category: ToolCategory.NETWORK,
    defaultPermission: ToolPermission.ASK,
    permissionReason: 'This will make a network request to the provider endpoint',
    allowInAskMode: false,
};

function maskSecret(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '(empty)';
    if (trimmed.length <= 8) return '***';
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(item => redactSecrets(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_FIELD_RE.test(key)) {
            out[key] = typeof nestedValue === 'string' ? maskSecret(nestedValue) : '[redacted]';
        } else {
            out[key] = redactSecrets(nestedValue);
        }
    }
    return out;
}

function stringifyRedacted(value: unknown): string {
    return JSON.stringify(redactSecrets(value), null, 2);
}

function debugIgnoredConfigError(scope: string, error: unknown): void {
    if (process.env.CLI_DEBUG !== '1') return;
    cliLogger.debug('NEOX_CONFIG', `${scope} ignored`, {
        error: error instanceof Error ? error.message : String(error),
    });
}

/**
 * 创建 neox_config 系列工具（13 个）
 */
export function createNeoxConfigTools(): Tool[] {
    return [
        // 统一配置面 (Team P1 能力 1: get/list 直读 + propose_set 提案确认)
        createUnifiedNeoxConfigTool(),
        // Provider 管理
        createReadConfigTool(),
        createWriteConfigTool(),
        createListProvidersTool(),
        createAddProviderTool(),
        createSetDefaultProviderTool(),
        createRemoveProviderTool(),
        // 扩展能力
        createSwitchModelTool(),
        createListModelsTool(),
        createMcpManageTool(),
        createHealthCheckTool(),
        createExportConfigTool(),
        createDiagnoseTool(),
    ];
}

/**
 * read_neox_config — 读取 Neox 配置
 */
function createReadConfigTool(): Tool {
    return {
        name: 'read_neox_config',
        description: 'Read Neox configuration. Without key, returns an overview of everything; with key, returns one section (e.g. "providers", "tts", "webSearch").',
        permission: READ_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                key: {
                    type: 'string',
                    description: 'Section name (optional), e.g. "providers", "tts", "webSearch", "mcp", "language", "runMode". Omit for the full overview.',
                },
            },
        },
        async function(args: ReadConfigArgs) {
            const config = loadConfig();
            const { key } = args;
            const configMap = config as Record<string, unknown>;

            if (key) {
                const value = configMap[key];
                if (value === undefined) {
                    return `配置项 "${key}" 不存在。可用的配置项: ${Object.keys(config).join(', ')}`;
                }
                return stringifyRedacted(value);
            }

            // 全部概览（不展开所有细节，太长）
            const store = new ProviderStore(config);
            const defaultProvider = store.getDefaultProvider();
            const providerCount = Object.keys(config.providers || {}).length;

            const overview = {
                configFile: CONFIG_FILE,
                defaultProvider: defaultProvider ? {
                    id: config.defaultProviderId,
                    name: defaultProvider.name,
                    model: defaultProvider.defaultModel,
                    protocol: defaultProvider.protocol,
                    baseUrl: defaultProvider.baseUrl?.replace(/\/+$/, ''),
                } : null,
                providerCount,
                providers: Object.entries(config.providers || {}).map(([id, p]) => ({
                    id,
                    name: p.name,
                    model: p.defaultModel,
                    protocol: p.protocol,
                })),
                language: config.language || 'zh',
                runMode: config.runMode || 'agentic',
                webSearch: config.webSearch?.enabled ? 'enabled' : 'disabled',
                tts: config.tts?.enabled ? 'enabled' : 'disabled',
                mcp: {
                    serverCount: config.mcp?.servers?.length || 0,
                    servers: config.mcp?.servers?.map(s => ({ id: s.id, name: s.name, enabled: s.enabled })) || [],
                },
                experimental: config.experimental || {},
            };

            return JSON.stringify(overview, null, 2);
        },
    };
}

/**
 * write_neox_config — 写入/更新配置项
 */
function createWriteConfigTool(): Tool {
    return {
        name: 'write_neox_config',
        description: 'Write or update a Neox config entry (language, runMode, webSearch, tts, ...). For provider operations use the dedicated add_neox_provider tool.',
        permission: CONFIG_WRITE_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                key: {
                    type: 'string',
                    description: 'Config key, e.g. "language", "runMode", "webSearch", "tts", "experimental"',
                },
                value: {
                    description: 'Config value (string, number, object or boolean)',
                },
            },
            required: ['key', 'value'],
        },
        async function(args: WriteConfigArgs) {
            const { key, value } = args;

            // 安全检查：禁止直接修改 providers（应该用专用工具）
            if (key === 'providers') {
                return fail('❌ 不能直接修改 providers。请使用 add_neox_provider / remove_neox_provider 工具。');
            }

            // 白名单检查
            const ALLOWED_KEYS = [
                'language', 'runMode', 'webSearch', 'tts', 'experimental',
                'approvalMode', 'completionAlerts', 'context', 'memory',
                'agentSandboxEnabled', 'cliDebug',
            ];

            if (!ALLOWED_KEYS.includes(key)) {
                return fail(`❌ 不支持直接修改 "${key}"。允许的配置项: ${ALLOWED_KEYS.join(', ')}`);
            }

            const config = loadConfig();
            if ((key === 'tts' || key === 'webSearch') && value && typeof value === 'object') {
                const node = value as { apiKey?: unknown };
                if (typeof node.apiKey === 'string' && node.apiKey) node.apiKey = wrapApiKey(node.apiKey);
            }
            (config as Record<string, unknown>)[key] = value;
            saveConfig(config);

            cliLogger.info('NEOX_CONFIG', `Config updated: ${key} = ${stringifyRedacted(value)}`);
            return `✅ 配置已更新: ${key} = ${stringifyRedacted(value)}\n配置文件: ${CONFIG_FILE}\n${HOT_RELOAD_HINT}`;
        },
    };
}

/**
 * list_neox_providers — 列出所有 Provider
 */
function createListProvidersTool(): Tool {
    return {
        name: 'list_neox_providers',
        description: 'List every configured Neox provider, including name, protocol, model and whether it is the default.',
        permission: READ_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {},
        },
        async function() {
            const config = loadConfig();
            const providers = config.providers || {};
            const defaultId = config.defaultProviderId;

            if (Object.keys(providers).length === 0) {
                return '当前没有配置任何 Provider。请使用 add_neox_provider 添加。';
            }

            const lines = Object.entries(providers).map(([id, p]) => {
                const isDefault = id === defaultId ? ' ⭐(默认)' : '';
                const apiKeyPreview = p.apiKey ? maskSecret(p.apiKey) : '(未设置)';
                return [
                    `${p.name}${isDefault}`,
                    `  ID: ${id}`,
                    `  协议: ${p.protocol}`,
                    `  URL: ${p.baseUrl || '(默认)'}`,
                    `  API Key: ${apiKeyPreview}`,
                    `  默认模型: ${p.defaultModel || '(未设置)'}`,
                    `  模型列表: ${(p.models || []).join(', ') || '(空)'}`,
                ].join('\n');
            });

            return lines.join('\n\n');
        },
    };
}

/**
 * add_neox_provider — 添加新 Provider
 */
function createAddProviderTool(): Tool {
    return {
        name: 'add_neox_provider',
        description: 'Add a new AI provider to the Neox config. name, protocol, apiKey and model are required; baseUrl is optional (needed when using a proxy).',
        permission: CONFIG_WRITE_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                name: {
                    type: 'string',
                    description: 'Provider display name, supplied by the user',
                },
                protocol: {
                    type: 'string',
                    description: 'Protocol format (from the enum)',
                    enum: ['openai', 'anthropic', 'anthropic-openai', 'gemini', 'kimi', 'kimi-claude', 'glm', 'glm-claude', 'doubao', 'deepseek', 'minimax', 'qwen', 'openai-responses'],
                },
                apiKey: {
                    type: 'string',
                    description: 'API Key',
                },
                model: {
                    type: 'string',
                    description: "Default model name, supplied by the user; it just has to match the provider's real model id",
                },
                baseUrl: {
                    type: 'string',
                    description: 'Custom API base URL (optional; needed when using a proxy)',
                },
                setAsDefault: {
                    type: 'boolean',
                    description: 'Whether to make this the default provider (default true)',
                },
            },
            required: ['name', 'protocol', 'apiKey', 'model'],
        },
        async function(args: AddProviderArgs) {
            const { name, protocol, apiKey, model, baseUrl, setAsDefault = true } = args;

            const config = loadConfig();
            const store = new ProviderStore(config);

            store.addProvider({
                name,
                protocol: protocol as ProviderProtocol,
                apiKey,
                baseUrl: baseUrl || undefined,
                defaultModel: model,
                models: [model],
                setAsDefault,
            });

            cliLogger.info('NEOX_CONFIG', `Provider added: ${name} (${protocol}), model=${model}`);

            return [
                `✅ Provider "${name}" 已添加${setAsDefault ? '（设为默认）' : ''}`,
                `  协议: ${protocol}`,
                `  模型: ${model}`,
                baseUrl ? `  URL: ${baseUrl}` : '',
                `  配置文件: ${CONFIG_FILE}`,
                '',
                HOT_RELOAD_HINT,
            ].filter(Boolean).join('\n');
        },
    };
}

/**
 * set_default_neox_provider — 设置默认 Provider
 */
function createSetDefaultProviderTool(): Tool {
    return {
        name: 'set_default_neox_provider',
        description: 'Set the default AI provider. Pass a provider ID or name.',
        permission: CONFIG_WRITE_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                providerId: {
                    type: 'string',
                    description: 'Provider ID or name',
                },
            },
            required: ['providerId'],
        },
        async function(args: ProviderIdArgs) {
            const { providerId } = args;
            const config = loadConfig();
            const providers = config.providers || {};

            // 尝试匹配 ID 或名称
            let targetId = providerId;
            if (!providers[providerId]) {
                const entry = Object.entries(providers).find(
                    ([, p]) => p.name.toLowerCase() === providerId.toLowerCase()
                );
                if (entry) {
                    targetId = entry[0];
                } else {
                    return fail(`❌ Provider "${providerId}" 不存在。可用的 Provider: ${Object.entries(providers).map(([id, p]) => `${p.name} (${id})`).join(', ')}`);
                }
            }

            config.defaultProviderId = targetId;
            saveConfig(config);

            const provider = providers[targetId];
            return `✅ 默认 Provider 已切换为: ${provider.name} (${targetId})\n模型: ${provider.defaultModel || '(未设置)'}\n${HOT_RELOAD_HINT}`;
        },
    };
}

/**
 * remove_neox_provider — 删除 Provider
 */
function createRemoveProviderTool(): Tool {
    return {
        name: 'remove_neox_provider',
        description: 'Delete a configured provider. Pass a provider ID or name.',
        permission: CONFIG_WRITE_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                providerId: {
                    type: 'string',
                    description: 'Provider ID or name',
                },
            },
            required: ['providerId'],
        },
        async function(args: ProviderIdArgs) {
            const { providerId } = args;
            const config = loadConfig();
            const providers = config.providers || {};

            // 尝试匹配 ID 或名称
            let targetId = providerId;
            if (!providers[providerId]) {
                const entry = Object.entries(providers).find(
                    ([, p]) => p.name.toLowerCase() === providerId.toLowerCase()
                );
                if (entry) {
                    targetId = entry[0];
                } else {
                    return fail(`❌ Provider "${providerId}" 不存在。`);
                }
            }

            const provider = providers[targetId];
            const providerName = provider.name;
            delete providers[targetId];

            // 如果删除的是默认 Provider，清除默认
            if (config.defaultProviderId === targetId) {
                const remaining = Object.keys(providers);
                config.defaultProviderId = remaining.length > 0 ? remaining[0] : undefined;
            }

            saveConfig(config);

            return `✅ Provider "${providerName}" (${targetId}) 已删除。\n${HOT_RELOAD_HINT}`;
        },
    };
}

// ==================== 扩展工具 ====================

/**
 * neox_switch_model — 切换当前 Provider 的默认模型
 */
function createSwitchModelTool(): Tool {
    return {
        name: 'neox_switch_model',
        description: "Switch the current provider's default model. Just pass the model name.",
        permission: CONFIG_WRITE_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                model: {
                    type: 'string',
                    description: "Model name (just has to match the provider's real model id)",
                },
                providerId: {
                    type: 'string',
                    description: 'Provider ID (optional; defaults to the current default provider)',
                },
            },
            required: ['model'],
        },
        async function(args: SwitchModelArgs) {
            const { model, providerId } = args;
            const config = loadConfig();
            const targetId = providerId || config.defaultProviderId;

            if (!targetId || !config.providers?.[targetId]) {
                return fail('❌ 没有找到目标 Provider。请先用 list_neox_providers 查看可用的 Provider。');
            }

            const provider = config.providers[targetId];
            const oldModel = provider.defaultModel;
            provider.defaultModel = model;

            // 自动添加到模型列表
            if (!provider.models) provider.models = [];
            if (!provider.models.some(m => m.name === model)) {
                provider.models.push({ name: model });
            }

            saveConfig(config);
            return `✅ 模型已切换: ${oldModel} → ${model}\nProvider: ${provider.name} (${targetId})\n${HOT_RELOAD_HINT}`;
        },
    };
}

/**
 * neox_list_models — 列出可用模型
 */
function createListModelsTool(): Tool {
    return {
        name: 'neox_list_models',
        description: 'List every model Neox supports. Can be filtered by provider (openai/anthropic/gemini/minimax/deepseek/qwen, ...).',
        permission: READ_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                provider: {
                    type: 'string',
                    description: 'Filter by provider: "openai", "anthropic", "gemini", "minimax", "deepseek", "qwen", "kimi", "glm", "doubao". Omit to list them all.',
                },
            },
        },
        async function(args: ListModelsArgs) {
            const { provider: filterProvider } = args;

            // 动态导入模型注册表
            const { modelRegistry } = await import('@neoxlabs/platform/models/registry/index.js');
            const allModels = modelRegistry.getAllModels();

            const filtered = filterProvider
                ? allModels.filter(m => m.provider.toLowerCase() === filterProvider.toLowerCase())
                : allModels;

            if (filtered.length === 0) {
                return filterProvider
                    ? `没有找到 "${filterProvider}" 的模型。可用的提供商: ${[...new Set(allModels.map(m => m.provider))].join(', ')}`
                    : '模型注册表为空。';
            }

            // 按 provider 分组
            const grouped = new Map<string, typeof filtered>();
            for (const m of filtered) {
                const list = grouped.get(m.provider) || [];
                list.push(m);
                grouped.set(m.provider, list);
            }

            const lines: string[] = [`共 ${filtered.length} 个模型：`, ''];
            for (const [provider, models] of grouped) {
                lines.push(`📦 ${provider.toUpperCase()} (${models.length})`);
                for (const m of models) {
                    const badges: string[] = [];
                    if (m.supportsVision) badges.push('👁️');
                    if (m.supportsThinking) badges.push('💭');
                    const ctx = m.maxInputTokens
                        ? `${Math.round(m.maxInputTokens / 1000)}K ctx`
                        : '';
                    lines.push(`  ${m.id} — ${badges.join('')} ${ctx}`);
                }
                lines.push('');
            }

            return lines.join('\n');
        },
    };
}

/**
 * neox_mcp_manage — MCP Server 管理
 */
function createMcpManageTool(): Tool {
    return {
        name: 'neox_mcp_manage',
        description: 'MCP server management: list, add, remove, enable/disable MCP tool servers.',
        permission: CONFIG_WRITE_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                action: {
                    type: 'string',
                    description: 'Action: "list" | "add" | "remove" | "toggle"',
                    enum: ['list', 'add', 'remove', 'toggle'],
                },
                id: {
                    type: 'string',
                    description: 'Server ID (required for add/remove/toggle)',
                },
                command: {
                    type: 'string',
                    description: 'For add: the launch command, e.g. "npx -y @modelcontextprotocol/server-filesystem"',
                },
                args: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'For add: command arguments',
                },
                transport: {
                    type: 'string',
                    description: 'For add: transport "stdio" (local command) | "http" (remote Streamable HTTP URL) | "sse" (legacy remote SSE URL). Default stdio',
                    enum: ['stdio', 'http', 'sse'],
                },
                url: {
                    type: 'string',
                    description: 'For add with transport http/sse: the server URL',
                },
            },
            required: ['action'],
        },
        async function(args: McpManageArgs) {
            const { action, id, command, args: cmdArgs, transport = 'stdio', url } = args;
            const config = loadConfig();

            if (!config.mcp) config.mcp = {};
            if (!config.mcp.servers) config.mcp.servers = [];

            const workDir = getWorkspaceRootFromContext();
            const allServers = workDir ? listMcpServers(workDir) : config.mcp.servers.map(s => ({ ...s, scope: 'user' as const }));

            switch (action) {
                case 'list': {
                    if (allServers.length === 0) {
                        return '当前没有配置 MCP Server。\n\n用 neox_mcp_manage(action="add", ...) 添加。';
                    }
                    const lines = allServers.map(s => {
                        const status = s.enabled !== false ? '✅' : '❌';
                        const scope = (s as any).scope === 'workspace' ? ' [工作区]' : '';
                        return `${status} ${s.id}${scope} — ${s.name || s.command || s.url || '?'} (${s.transport})`;
                    });
                    /* 总开关是独立的一层: server 配好了、连得上, 但开关关着时工具**不会注册**,
                     * 模型再怎么试都调不到。不说清楚它只会以为是自己名字写错了。 */
                    const gateOff = config.mcp.enabled === false
                        ? '\n\n⚠️ MCP 总开关当前是**关闭**状态 —— 上面这些 server 的工具不会注册到本次会话, '
                          + '调用一定失败。请让用户在设置里打开 MCP, 或用 neox_config(action="set", key="mcp.enabled", value=true)。'
                        : '';
                    return `MCP Servers (${allServers.length}):\n\n${lines.join('\n')}${gateOff}`;
                }

                case 'add': {
                    if (!id) return fail('❌ 请提供 id（Server 标识符）');
                    if (!command && transport === 'stdio') return fail('❌ stdio 模式需要 command');
                    if (!url && transport !== 'stdio') return fail(`❌ ${transport} 模式需要 url`);

                    /* 查重要查合并后的全集 —— 只查用户级会让"工作区已有同 id"被漏掉,
                     * 加进去也是白加 (listMcpServers 里 workspace 覆盖 user)。 */
                    if (allServers.some(s => s.id === id)) {
                        const scope = (allServers.find(s => s.id === id) as any)?.scope === 'workspace' ? '工作区级' : '用户级';
                        return fail(`❌ Server "${id}" 已存在 (${scope})。`);
                    }

                    config.mcp.servers.push({
                        id,
                        name: id,
                        transport,
                        command: transport === 'stdio' ? (command || undefined) : undefined,
                        args: transport === 'stdio' ? (cmdArgs || undefined) : undefined,
                        url: transport !== 'stdio' ? url : undefined,
                        enabled: true,
                        autoConnect: true,
                    });
                    saveConfig(config);
                    return `✅ MCP Server "${id}" 已添加。\n配置已保存；MCP 连接层若已运行，建议重新连接对应 server。`;
                }

                case 'remove': {
                    if (!id) return fail('❌ 请提供要删除的 Server ID');
                    const idx = config.mcp.servers.findIndex(s => s.id === id);
                    if (idx < 0) {
                        /* 工作区级的条目这个工具改不了 —— 但必须说清楚是"在别的 scope 里",
                         * 而不是含糊地说"不存在"(那会让模型以为已经删干净了)。 */
                        const inWorkspace = allServers.find(s => s.id === id && (s as any).scope === 'workspace');
                        return inWorkspace
                            ? `❌ Server "${id}" 是**工作区级**配置 (<工作区>/.neox/mcp.json), 这个工具只改用户级配置。请直接改那个文件或用设置页。`
                            : `❌ Server "${id}" 不存在。`;
                    }
                    config.mcp.servers.splice(idx, 1);
                    saveConfig(config);
                    return `✅ MCP Server "${id}" 已删除。`;
                }

                case 'toggle': {
                    if (!id) return fail('❌ 请提供 Server ID');
                    const server = config.mcp.servers.find(s => s.id === id);
                    if (!server) {
                        const inWorkspace = allServers.find(s => s.id === id && (s as any).scope === 'workspace');
                        return inWorkspace
                            ? `❌ Server "${id}" 是**工作区级**配置 (<工作区>/.neox/mcp.json), 这个工具只改用户级配置。`
                            : `❌ Server "${id}" 不存在。`;
                    }
                    server.enabled = !(server.enabled !== false);
                    saveConfig(config);
                    return `✅ MCP Server "${id}" 已${server.enabled ? '启用' : '禁用'}。`;
                }

                default:
                    return fail(`❌ 未知操作 "${action}"。支持: list, add, remove, toggle`);
            }
        },
    };
}

/**
 * neox_health_check — Provider 健康检查
 */
function createHealthCheckTool(): Tool {
    return {
        name: 'neox_health_check',
        description: "Check the current provider's connectivity and API key. Sends one simple request to verify the configuration.",
        permission: NETWORK_CHECK_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                providerId: {
                    type: 'string',
                    description: 'Provider ID to check (optional; defaults to the current default provider)',
                },
            },
        },
        async function(args: HealthCheckArgs) {
            const config = loadConfig();
            const targetId = args.providerId || config.defaultProviderId;

            if (!targetId || !config.providers?.[targetId]) {
                return fail('❌ 没有找到 Provider。请先配置一个 Provider。');
            }

            const provider = config.providers[targetId];
            const results: string[] = [
                `🏥 Provider 健康检查: ${provider.name}`,
                `  协议: ${provider.protocol}`,
                `  URL: ${provider.baseUrl || '(默认)'}`,
                `  模型: ${provider.defaultModel || '(未设置)'}`,
                '',
            ];

            // API Key 检查
            if (!provider.apiKey || provider.apiKey.trim().length === 0) {
                results.push('❌ API Key: 未设置');
                return results.join('\n');
            }
            results.push(`✅ API Key: ${maskSecret(provider.apiKey)} (已设置)`);

            // URL 可达性检查
            const baseUrl = provider.baseUrl || '';
            if (baseUrl) {
                try {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 5000);
                    const response = await fetch(baseUrl, {
                        method: 'HEAD',
                        signal: controller.signal,
                    }).catch(() => null);
                    clearTimeout(timeout);

                    if (response) {
                        results.push(`✅ URL 可达: ${baseUrl} (HTTP ${response.status})`);
                    } else {
                        results.push(`⚠️ URL 可达性未知: ${baseUrl} (连接超时或被拒绝)`);
                    }
                } catch {
                    results.push(`⚠️ URL 检查失败: ${baseUrl}`);
                }
            }

            results.push('');
            results.push('💡 如需测试完整 API 调用，请直接向 AI 发送一条消息。');

            return results.join('\n');
        },
    };
}

/**
 * neox_export_config — 导出配置
 */
function createExportConfigTool(): Tool {
    return {
        name: 'neox_export_config',
        description: 'Export the current Neox config as JSON (for backup, migration or sharing). API keys and other sensitive fields are always redacted.',
        permission: CONFIG_EXPORT_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {
                includeKeys: {
                    type: 'boolean',
                    description: 'Legacy parameter; for security reasons AI tools never return a full API key.',
                },
                sections: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Sections to export (optional), e.g. ["providers", "mcp", "tts"]. Omit to export everything.',
                },
            },
        },
        async function(args: ExportConfigArgs) {
            const { includeKeys = false, sections } = args;
            const config = loadConfig();

            let exportData: Record<string, unknown>;
            if (sections && sections.length > 0) {
                exportData = {};
                const configMap = config as Record<string, unknown>;
                for (const section of sections) {
                    if (configMap[section] !== undefined) {
                        exportData[section] = configMap[section];
                    }
                }
            } else {
                exportData = { ...config };
            }

            const json = stringifyRedacted(exportData);
            const includeKeysNotice = includeKeys
                ? '\n\n注意：includeKeys=true 已被安全策略忽略，完整密钥不会通过 AI 工具导出。'
                : '';
            return `📋 Neox 配置导出 (${sections?.join(', ') || '全部'}):\n\n\`\`\`json\n${json}\n\`\`\`\n\n配置文件位置: ${CONFIG_FILE}${includeKeysNotice}`;
        },
    };
}

/**
 * neox_diagnose — 系统诊断
 */
function createDiagnoseTool(): Tool {
    return {
        name: 'neox_diagnose',
        description: 'Run Neox system diagnostics: Node version, config file state, provider count, MCP state, tool-pack state, disk usage and more.',
        permission: READ_PERMISSION,
        parameters: {
            type: 'object' as const,
            properties: {},
        },
        async function() {
            const config = loadConfig();
            const os = await import('os');
            const fs = await import('fs');
            const path = await import('path');

            const configDir = path.join(os.homedir(), NEOX_HOME_DIRNAME);
            let configSize = 0;
            let sessionCount = 0;

            try {
                const configStat = fs.statSync(CONFIG_FILE);
                configSize = configStat.size;
            } catch (error) {
                debugIgnoredConfigError('diagnose.configStat', error);
            }

            try {
                const sessionsDir = path.join(configDir, 'sessions');
                if (fs.existsSync(sessionsDir)) {
                    sessionCount = fs.readdirSync(sessionsDir).length;
                }
            } catch (error) {
                debugIgnoredConfigError('diagnose.sessionsDir', error);
            }

            const providerCount = Object.keys(config.providers || {}).length;
            const mcpCount = config.mcp?.servers?.length || 0;
            const memoryDir = path.join(configDir, 'memory');
            let memoryCount = 0;
            try {
                if (fs.existsSync(memoryDir)) {
                    memoryCount = fs.readdirSync(memoryDir).length;
                }
            } catch (error) {
                debugIgnoredConfigError('diagnose.memoryDir', error);
            }

            const lines = [
                '🔬 Neox 系统诊断',
                '─'.repeat(40),
                '',
                '📌 环境:',
                `  Node.js: ${process.version}`,
                `  平台: ${os.platform()} ${os.arch()}`,
                `  内存: ${Math.round(os.freemem() / 1024 / 1024)}MB 可用 / ${Math.round(os.totalmem() / 1024 / 1024)}MB 总计`,
                `  进程内存: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap`,
                '',
                '📂 配置:',
                `  配置文件: ${CONFIG_FILE} (${(configSize / 1024).toFixed(1)}KB)`,
                `  配置目录: ${configDir}`,
                `  Provider 数: ${providerCount}`,
                `  默认 Provider: ${config.defaultProviderId || '(未设置)'}`,
                '',
                '📊 状态:',
                `  语言: ${config.language || 'zh'}`,
                `  运行模式: ${config.runMode || 'agentic'}`,
                `  Session 数: ${sessionCount}`,
                `  记忆文件数: ${memoryCount}`,
                `  MCP Server 数: ${mcpCount}`,
                `  Web Search: ${config.webSearch?.enabled ? '✅' : '❌'}`,
                `  TTS: ${config.tts?.enabled ? '✅' : '❌'}`,
                `  沙箱模式: ${config.agentSandboxEnabled ? '✅' : '❌'}`,
                '',
                '🧪 实验功能:',
                `  FGTS: ${config.experimental?.enableFGTS ? '✅' : '❌'}`,
                `  PTC: ${config.experimental?.enablePTC ? '✅' : '❌'}`,
                `  Checkpoint: ${config.experimental?.enableCheckpoint ? '✅' : '❌'}`,
            ];

            return lines.join('\n');
        },
    };
}

// ============================================================================
// 设计: 内部设计文档 §0.1① — 读写分离落到 schema:
//   · get/list      直接读 config/registry 返回 (只读零风险)
//   · propose_set   不直接写: 先返回结构化提案, 经 ask_user 通道弹"确认卡"
//                   (timeline 交互卡, 桌面/CLI/cloud 三端现货), 用户点"应用变更"
//                   才由本工具落盘。答案只能来自真实 UI 点击 (IPC resolveUserQuestion),
//                   模型伪造不了 — 写路径是代码硬保证, 不靠 prompt 恳求。
//   · 危险面        schema 级排除: domain 枚举只有 5 个常规域; 可写键白名单只有 4 个
//                   低危键。审批模式/沙箱开关/API key/危险命令白名单不在枚举里, 调不到。
// ============================================================================

type NeoxConfigDomain = 'models' | 'routing' | 'team' | 'runtime' | 'appearance';

const NEOX_CONFIG_DOMAINS: NeoxConfigDomain[] = ['models', 'routing', 'team', 'runtime', 'appearance'];

interface NeoxConfigArgs {
    action: 'get' | 'list' | 'propose_set';
    domain?: string;
    key?: string;
    value?: unknown;
}

/** propose_set 可写键 — 全部低危、可逆、不含密钥/审批/沙箱面。 */
interface WritableKeySpec {
    domain: NeoxConfigDomain;
    key: string;
    /** 人话说明 (提案卡与 list 输出用) */
    describe: string;
    /** 校验并归一化 value; 返回 {error} 或 {value} */
    normalize: (value: unknown) => { error: string } | { value: unknown };
    read: (config: NeoxConfig) => unknown;
    apply: (config: NeoxConfig, value: unknown) => void;
    /** 写的是 agentRuntime 节 → 落盘后热刷 accessor 缓存 */
    touchesAgentRuntime?: boolean;
    /** 确认卡被取消/超时/无 UI 通道时, 引导用户去哪改 (最保守 fallback) */
    manualPath: string;
}

const WRITABLE_KEYS: WritableKeySpec[] = [
    {
        domain: 'routing',
        key: 'orchestration',
        describe: '智能模型编排开关 (on = 向 agent 注入编排知识, 允许按任务特征选池内模型)',
        normalize: (v) => (v === 'on' || v === 'off') ? { value: v } : { error: '取值只能是 "on" 或 "off"' },
        read: (c) => c.agentRuntime?.modelOrchestration ?? 'off',
        apply: (c, v) => { c.agentRuntime = { ...c.agentRuntime, modelOrchestration: v as 'on' | 'off' }; },
        touchesAgentRuntime: true,
        manualPath: '设置页 → Agent → 智能模型编排',
    },
    {
        domain: 'routing',
        key: 'preferences',
        describe: '模型偏好提示列表 (自然语言, 如 "审查都用 GPT"; 非硬绑定, 编排时参考)',
        normalize: (v) => {
            const arr = typeof v === 'string' ? [v] : v;
            if (!Array.isArray(arr)) return { error: '需要字符串数组 (或单个字符串)' };
            const cleaned = arr.map((s) => String(s).trim()).filter(Boolean);
            if (cleaned.length > 10) return { error: '偏好提示最多 10 条' };
            if (cleaned.some((s) => s.length > 200)) return { error: '单条偏好提示不超过 200 字符' };
            return { value: cleaned };
        },
        read: (c) => c.agentRuntime?.modelOrchestrationHints ?? [],
        apply: (c, v) => { c.agentRuntime = { ...c.agentRuntime, modelOrchestrationHints: v as string[] }; },
        touchesAgentRuntime: true,
        manualPath: '暂无设置页入口, 可让 agent 再次提议或手工编辑 config.json',
    },
    {
        domain: 'runtime',
        key: 'concurrencyProfile',
        describe: '子 Agent 并发策略 (auto = 正常并发; low = 单模型串行, 给限流用户)',
        normalize: (v) => (v === 'auto' || v === 'low') ? { value: v } : { error: '取值只能是 "auto" 或 "low"' },
        read: (c) => c.concurrencyProfile ?? 'auto',
        apply: (c, v) => { c.concurrencyProfile = v as 'auto' | 'low'; },
        manualPath: '手工编辑 config.json 的 concurrencyProfile 字段',
    },
    {
        domain: 'appearance',
        key: 'language',
        describe: '界面/回复语言 (zh 中文 / en English)',
        normalize: (v) => (v === 'zh' || v === 'en') ? { value: v } : { error: '取值只能是 "zh" 或 "en"' },
        read: (c) => c.language ?? 'zh',
        apply: (c, v) => { c.language = v as 'zh' | 'en'; },
        manualPath: '设置页 → 通用 → 语言',
    },
];

function isZh(config: NeoxConfig): boolean {
    return (config.language ?? 'zh') !== 'en';
}

/** provider 运行时健康 — 进程内 ProviderHealthTracker (LLM 请求成败驱动), 无记录即 unknown。
 *  tracker 的 key 由事件转发层决定 (provider 名), 这里按 id/name/protocol 三个候选都查一遍。 */
function lookupProviderHealth(candidates: Array<string | undefined>): string {
    const tracker = getGlobalHealthTracker();
    for (const key of candidates) {
        if (!key) continue;
        const info = tracker.getInfo(key);
        if (info) return info.health;
    }
    return 'unknown';
}

async function buildModelsDomain(config: NeoxConfig): Promise<Record<string, unknown>> {
    const { modelRegistry } = await import('@neoxlabs/platform/models/registry/index.js');
    const providers = config.providers ?? {};

    const pools = Object.entries(providers).map(([id, p]) => {
        const isSubscription = id === 'neox-cloud' || p.apiKey === 'neox-managed';
        const models = (p.models ?? []).map((m) => {
            const meta = modelRegistry.getModel(m.name);
            return {
                name: m.name,
                ...(meta ? {
                    displayName: meta.displayName,
                    contextK: Math.round(meta.maxInputTokens / 1000),
                    scores: meta.scores ?? null,
                    supportsVision: meta.supportsVision ?? false,
                    supportsThinking: meta.supportsThinking ?? false,
                } : { registry: 'no_metadata' }),
            };
        });
        return {
            providerId: id,
            name: p.name,
            protocol: p.protocol,
            kind: isSubscription ? 'subscription' : 'byok',
            isDefault: id === config.defaultProviderId,
            /* 命名避开 SECRET_FIELD_RE (含 "apiKey" 会被 stringifyRedacted 抹成 [redacted]) */
            keyConfigured: !!(p.apiKey && p.apiKey.trim()),
            defaultModel: p.defaultModel ?? null,
            runtimeHealth: lookupProviderHealth([id, p.name, p.protocol]),
            models,
            ...(isSubscription ? { note: '订阅池模型由 membership 动态提供, 本地 config 不枚举' } : {}),
        };
    });

    return {
        defaultProviderId: config.defaultProviderId ?? null,
        pools,
        scoreLegend: 'scores 0-100: coding/reasoning/vision/creativity/speed/cost(越省越高); runtimeHealth: healthy|degraded|down|unknown(本进程近期无请求记录)',
    };
}

function buildRoutingDomain(config: NeoxConfig): Record<string, unknown> {
    return {
        orchestration: getModelOrchestrationMode(),
        preferences: config.agentRuntime?.modelOrchestrationHints ?? [],
        multiProviderFailover: {
            enabled: config.modelRouting?.enabled === true,
            routeCount: Object.keys(config.modelRouting?.routes ?? {}).length,
            note: '同一模型多 Provider 故障转移 (设置页 Routing tab), 与智能编排是两回事',
        },
        writable: ['orchestration', 'preferences'],
    };
}

function buildTeamDomain(): Record<string, unknown> {
    /* RoleRegistry 未落地 (Team P2) — 返回内置四角色静态描述, 对应 agent 工具现有 type。 */
    return {
        status: 'builtin_static',
        note: 'RoleRegistry 尚未落地; 以下为内置角色静态描述。派发子任务用 agent 工具的 type 参数, 模型用 model 参数。',
        roles: [
            { id: 'planner', agentToolType: 'plan', readOnly: true, routingProfile: 'reasoning 优先', description: 'Architecture planning / task breakdown (read-only)' },
            { id: 'implementer', agentToolType: 'code | shell', readOnly: false, routingProfile: 'coding 优先', description: 'Implementation (code = editing only; shell = can run commands to verify)' },
            { id: 'reviewer', agentToolType: 'verify', readOnly: true, routingProfile: '跨 provider + reasoning 优先', description: 'Review / acceptance (read-only; prefer a different provider from the implementer for cross-checking)' },
            { id: 'researcher', agentToolType: 'research', readOnly: true, routingProfile: 'speed / 长上下文优先', description: 'Research and benchmarking, producing REQUIREMENTS.md (document write access only)' },
        ],
    };
}

function buildRuntimeDomain(config: NeoxConfig): Record<string, unknown> {
    const profile = config.concurrencyProfile ?? 'auto';
    return {
        concurrency: {
            profile,
            /* 上限常量在 backgroundAgent/agenticModeTools 内为模块私有 —
             * 此处按同一 env + 默认值复算, 仅作只读展示 (改上限走 env var)。 */
            backgroundAgentLimit: Math.max(1, Number(process.env.NEOX_MAX_CONCURRENT_AGENTS || 3)),
            exploreParallelLimit: profile === 'low' ? 1 : Number(process.env.NEOX_MAX_PARALLEL_EXPLORES || 2),
            maxAgentThreadDepth: getMaxThreadDepth(),
        },
        timeouts: {
            backgroundAgentHardMs: Math.max(0, Number(process.env.NEOX_AGENT_HARD_TIMEOUT_MS ?? 0)),
            noProgressAbortMs: Math.max(0, Number(process.env.NEOX_AGENT_NO_PROGRESS_MS ?? 5 * 60_000)),
            bashDefaultMs: getBashDefaultTimeoutMs(),
            bashMaxMs: getBashMaxTimeoutMs(),
        },
        sandbox: {
            osEnforced: isOsSandboxEnabled(),
            mode: getOsSandboxMode(),
            networkAllowed: isOsSandboxNetworkAllowed(),
            note: '只读展示 — 沙箱/审批面不接受 propose_set',
        },
        writable: ['concurrencyProfile'],
    };
}

function buildAppearanceDomain(config: NeoxConfig): Record<string, unknown> {
    return {
        language: config.language ?? 'zh',
        defaultAgentMode: config.defaultAgentMode ?? 'code',
        theme: { note: '主题为设备本地偏好 (设置页 Theme tab), 不在 config.json, 本工具不可读写' },
        writable: ['language'],
    };
}

async function buildDomainData(domain: NeoxConfigDomain, config: NeoxConfig): Promise<Record<string, unknown>> {
    switch (domain) {
        case 'models': return buildModelsDomain(config);
        case 'routing': return buildRoutingDomain(config);
        case 'team': return buildTeamDomain();
        case 'runtime': return buildRuntimeDomain(config);
        case 'appearance': return buildAppearanceDomain(config);
    }
}

/** propose_set 确认卡 — 走 ask_user 通道 (交互卡 + IPC 回答), 返回是否确认。 */
async function confirmProposalViaAskUser(
    summary: string,
    zh: boolean,
    context?: { signal?: AbortSignal },
): Promise<{ confirmed: boolean; channel: 'card' | 'unavailable'; detail?: string }> {
    const question = zh
        ? `是否应用 Neox 配置变更：${summary}`
        : `Apply this Neox config change: ${summary}?`;
    const confirmLabel = zh ? '应用变更' : 'Apply change';
    const cancelLabel = zh ? '取消' : 'Cancel';

    const raw = await askUserTool.function(
        { questions: [{ question, options: [confirmLabel, cancelLabel] }] },
        context,
    );
    const answer = typeof raw === 'string' ? raw : String(raw ?? '');

    /* askUserTool 的非答案路径都是 JSON (no_interactive_ui / expired / dismissed / ui_callback_failed) */
    try {
        const parsed = JSON.parse(answer);
        if (parsed && typeof parsed === 'object') {
            const reason = parsed.reason || parsed.status || 'unavailable';
            const channel = parsed.reason === 'no_interactive_ui' || parsed.reason === 'ui_callback_failed'
                ? 'unavailable' as const
                : 'card' as const;
            return { confirmed: false, channel, detail: String(reason) };
        }
    } catch { /* 不是 JSON → 正常 "Q:...\nA:..." 答案 */ }

    if (answer.includes(confirmLabel)) return { confirmed: true, channel: 'card' };
    return { confirmed: false, channel: 'card', detail: answer.includes(cancelLabel) ? 'cancelled' : 'not_confirmed' };
}

/**
 * neox_config — "你问 AI, AI 帮你配置 NeoX" 的统一入口。
 *
 * 权限说明: 元数据登记为 READ (get/list 是 90% 用途, manual 审批模式下不弹重复卡)。
 * propose_set 的写动作不依赖该元数据 — 由确认卡的**用户真实点击**硬性把关
 * (resolveUserQuestion 只有 UI/IPC 能触发), 且 OS 沙箱 read-only 档直接拒绝提案。
 */
function createUnifiedNeoxConfigTool(): Tool {
    return {
        name: 'neox_config',
        description: [
            'Neox 配置统一查询/变更提案工具 (读写分离)。',
            'get/list 直接读取: models=模型池+能力分数+provider 可用性; routing=智能编排开关+用户模型偏好;',
            'team=Team 角色; runtime=并发/超时/沙箱只读展示; appearance=语言/外观。',
            'propose_set 不直接写 — 生成变更提案并弹确认卡, 用户点"应用变更"后才落盘。',
            '可写键仅 4 个低危项 (routing.orchestration / routing.preferences / runtime.concurrencyProfile / appearance.language);',
            '审批模式、沙箱、API key 等危险面不在 domain 枚举里, 无法经本工具触达。',
        ].join('\n'),
        permission: { category: ToolCategory.READ, allowInAskMode: true },
        /* get/list 可并行; propose_set 阻塞等用户确认, 必须串行 */
        isConcurrencySafe: (args: Record<string, any>) => args?.action !== 'propose_set',
        parameters: {
            type: 'object' as const,
            properties: {
                action: {
                    type: 'string',
                    enum: ['get', 'list', 'propose_set'],
                    description: "get = read a domain's data; list = list available domains and writable keys; propose_set = propose a change (shows a confirmation card and writes only after the user confirms)",
                },
                domain: {
                    type: 'string',
                    enum: NEOX_CONFIG_DOMAINS,
                    description: 'Config domain. Required for get/propose_set; optional for list (lists all domains).',
                },
                key: {
                    type: 'string',
                    description: 'For get: optional, fetch a single key within the domain. For propose_set: required, the key to change (see writable in the list output).',
                },
                value: {
                    description: 'Required for propose_set: the proposed new value.',
                },
            },
            required: ['action'],
        },
        async function(args: NeoxConfigArgs, context?: { signal?: AbortSignal }) {
            const action = args.action;
            const config = loadConfig();
            const zh = isZh(config);

            // ---------- list ----------
            if (action === 'list') {
                const domains = NEOX_CONFIG_DOMAINS
                    .filter((d) => !args.domain || d === args.domain)
                    .map((d) => ({
                        domain: d,
                        readable: true,
                        writable: WRITABLE_KEYS.filter((w) => w.domain === d).map((w) => ({ key: w.key, describe: w.describe })),
                    }));
                return JSON.stringify({
                    domains,
                    usage: 'get 读取域数据; propose_set(domain, key, value) 发起变更提案 (用户确认后生效)',
                    excluded: '审批模式/沙箱/API key/危险命令白名单 — 不在本工具能力面内',
                }, null, 2);
            }

            // ---------- 域校验 (get / propose_set 必填) ----------
            const domain = args.domain as NeoxConfigDomain | undefined;
            if (!domain || !NEOX_CONFIG_DOMAINS.includes(domain)) {
                return fail(`❌ ${action} 需要合法的 domain。可用: ${NEOX_CONFIG_DOMAINS.join(', ')}`);
            }

            // ---------- get ----------
            if (action === 'get') {
                const data = await buildDomainData(domain, config);
                if (args.key) {
                    const slice = (data as Record<string, unknown>)[args.key];
                    if (slice === undefined) {
                        return fail(`❌ 域 "${domain}" 没有键 "${args.key}"。可用: ${Object.keys(data).join(', ')}`);
                    }
                    return stringifyRedacted({ domain, key: args.key, value: slice });
                }
                return stringifyRedacted({ domain, ...data });
            }

            // ---------- propose_set ----------
            /* OS 沙箱 read-only 档 = 用户声明了只读会话, 配置提案也不发起 */
            if (isOsSandboxEnabled() && getOsSandboxMode() === 'read-only') {
                return zh
                    ? '❌ 当前处于只读沙箱会话, 不发起配置变更提案。'
                    : '❌ Read-only sandbox session: config change proposals are disabled.';
            }

            const spec = WRITABLE_KEYS.find((w) => w.domain === domain && w.key === args.key);
            if (!spec) {
                const writableInDomain = WRITABLE_KEYS.filter((w) => w.domain === domain).map((w) => w.key);
                return writableInDomain.length > 0
                    ? `❌ 域 "${domain}" 可提议修改的键: ${writableInDomain.join(', ')}。其余为只读展示。`
                    : `❌ 域 "${domain}" 当前全部只读 (无可提议修改的键)。`;
            }
            const normalized = spec.normalize(args.value);
            if ('error' in normalized) {
                return fail(`❌ ${domain}.${spec.key}: ${normalized.error}`);
            }

            const current = spec.read(config);
            const proposal = {
                domain,
                key: spec.key,
                current,
                proposed: normalized.value,
                describe: spec.describe,
            };
            if (JSON.stringify(current) === JSON.stringify(normalized.value)) {
                return `ℹ️ ${domain}.${spec.key} 当前已是该值, 无需变更。\n${JSON.stringify(proposal, null, 2)}`;
            }

            const summary = `${spec.describe} | ${domain}.${spec.key}: ${JSON.stringify(current)} → ${JSON.stringify(normalized.value)}`;
            cliLogger.info('NEOX_CONFIG', `propose_set: ${summary}`);

            const verdict = await confirmProposalViaAskUser(summary, zh, context);

            if (!verdict.confirmed) {
                const fallback = verdict.channel === 'unavailable'
                    ? (zh
                        ? `当前环境没有交互确认通道 (${verdict.detail})。提案未应用 — 请引导用户手动修改: ${spec.manualPath}`
                        : `No interactive confirmation channel available (${verdict.detail}). Not applied — guide the user to change it manually: ${spec.manualPath}`)
                    : (zh
                        ? `用户未确认 (${verdict.detail})。提案未应用, 不要重复弹卡; 如用户想改, 可走: ${spec.manualPath}`
                        : `Not confirmed by the user (${verdict.detail}). Proposal not applied; do not re-prompt. Manual path: ${spec.manualPath}`);
                return `📋 配置变更提案 (未应用)\n${JSON.stringify(proposal, null, 2)}\n\n${fallback}`;
            }

            /* 用户点了"应用变更" — 重新 loadConfig 取最新快照再写, 避免确认等待期间的
             * 其他改动被本次快照覆盖 (config 写有跨进程锁, 这里再缩小窗口)。 */
            const fresh = loadConfig();
            spec.apply(fresh, normalized.value);
            saveConfig(fresh);
            if (spec.touchesAgentRuntime) refreshAgentRuntimeConfig();
            cliLogger.info('NEOX_CONFIG', `propose_set applied: ${domain}.${spec.key} = ${JSON.stringify(normalized.value)}`);

            return [
                `✅ 用户已确认, 配置已写入: ${domain}.${spec.key} = ${JSON.stringify(normalized.value)}`,
                `变更: ${JSON.stringify(current)} → ${JSON.stringify(normalized.value)}`,
                `配置文件: ${CONFIG_FILE}`,
                HOT_RELOAD_HINT,
            ].join('\n');
        },
    };
}
