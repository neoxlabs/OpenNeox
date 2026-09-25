/**
 * Setup Command — /setup 统一配置入口
 *
 * 纯终端交互，不需要 LLM 模型
 * 
 * /setup              — 显示快速配置菜单
 * /setup provider     — Provider 配置
 * /setup model        — 切换模型
 * /setup websearch    — Web Search 配置
 * /setup language     — 语言设置
 */

import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { t, formatMessage } from '../i18n/index.js';
import { getCliEdition } from '../edition/index.js';

export interface SetupCommandContext {
    logInfo: (title: string, detail?: string) => void;
    logError: (title: string, detail?: string) => void;
    promptSelect: <T extends string>(
        title: string,
        choices: Array<{ label: string; value: T; description?: string }>,
        defaultValue?: string
    ) => Promise<T>;
    promptText: (
        label: string,
        options?: { defaultValue?: string; hint?: string; allowEmpty?: boolean; password?: boolean }
    ) => Promise<string>;
    handleCommand: (cmd: string) => Promise<void>;
    /** 本会话实际在用的服务 / 模型 —— config 里的 defaultModel 对订阅 (Neox Cloud) 永远是空, 只看它会显示"未配置" */
    current?: { provider: string; model: string };
}

export async function handleSetupCommand(
    ctx: SetupCommandContext,
    args: string[]
): Promise<void> {
    const subCommand = (args[0] || '').toLowerCase();

    // 直接跳到子命令
    switch (subCommand) {
        case 'provider':
            await ctx.handleCommand('/provider add');
            return;
        case 'model':
            await ctx.handleCommand('/model');
            return;
        case 'websearch':
            await ctx.handleCommand('/websearch');
            return;
        case 'language':
            await ctx.handleCommand('/language');
            return;
        case 'mcp':
            await ctx.handleCommand('/mcp');
            return;
        case 'tts':
            await ctx.handleCommand('/tts');
            return;
    }

    // 交互式菜单
    const config = loadConfig();
    const store = new ProviderStore(config);
    const defaultProvider = store.getDefaultProvider();
    const tr = t();

    // 构建当前状态摘要
    const providerCount = Object.keys(config.providers || {}).length;
    const currentModel = ctx.current?.model || defaultProvider?.defaultModel || tr.setup.notConfigured;
    const currentProvider = ctx.current?.provider || defaultProvider?.name || tr.setup.notConfigured;
    const webSearchEnabled = config.webSearch?.enabled ? tr.setup.enabled : tr.setup.disabled;
    const language = config.language || 'zh';
    const mcpCount = config.mcp?.servers?.length || 0;
    /* 账号项只在有账号体系的发行版出现 (公开版没有 /login /whoami) */
    const account = getCliEdition().account;
    const loggedIn = account?.isLoggedIn() ?? false;

    try {
        const action = await ctx.promptSelect(
            `${tr.setup.headerTitle} · ${currentProvider}`,
            [
                // 订阅优先: 账号 / 订阅 (Neox Cloud) 放第一位
                ...(account
                    ? [{
                        label: loggedIn ? tr.setup.accountLabel : tr.setup.accountLabelOut,
                        value: 'account' as const,
                        description: tr.setup.accountDesc,
                    }]
                    : []),
                {
                    label: formatMessage(tr.setup.modelLabel, { model: currentModel }),
                    value: 'model' as const,
                    description: tr.setup.modelDesc,
                },
                // BYOK 为次要路径 (自带 API Key, 不走订阅)
                {
                    label: providerCount > 0
                        ? formatMessage(tr.setup.providerLabel, { count: providerCount })
                        : tr.setup.providerLabelEmpty,
                    value: 'provider' as const,
                    description: tr.setup.providerDesc,
                },
                {
                    label: formatMessage(tr.setup.webSearchLabel, { status: webSearchEnabled }),
                    value: 'websearch' as const,
                    description: tr.setup.webSearchDesc,
                },
                {
                    label: mcpCount > 0
                        ? formatMessage(tr.setup.mcpLabel, { count: mcpCount })
                        : tr.setup.mcpLabelEmpty,
                    value: 'mcp' as const,
                    description: tr.setup.mcpDesc,
                },
                {
                    label: formatMessage(tr.setup.languageLabel, { lang: language === 'zh' ? '中文' : 'English' }),
                    value: 'language' as const,
                    description: tr.setup.languageDesc,
                },
                {
                    label: tr.setup.advancedLabel,
                    value: 'advanced' as const,
                    description: tr.setup.advancedDesc,
                },
            ],
            account && !loggedIn ? 'account' : 'model',
        );

        switch (action) {
            case 'account':
                // 未登录 → 去登录用订阅; 已登录 → 账号 / 套餐 / 用量
                await ctx.handleCommand(loggedIn ? '/whoami' : '/login');
                break;

            case 'provider':
                if (providerCount === 0) {
                    // 没有 provider：直接去添加
                    await ctx.handleCommand('/provider add');
                } else {
                    // 有 provider：显示管理菜单
                    await ctx.handleCommand('/provider');
                }
                break;

            case 'model':
                await ctx.handleCommand('/model');
                break;

            case 'websearch':
                await ctx.handleCommand('/websearch');
                break;

            case 'mcp':
                await ctx.handleCommand('/mcp');
                break;

            case 'language':
                await ctx.handleCommand('/language');
                break;

            case 'advanced':
                await handleAdvancedSetup(ctx);
                break;
        }
    } catch (error: any) {
        const tr = t();
        /* 取消 = 用户按了 esc, 什么都不留 (不再打 "已取消" 卡片) */
        if (!(error.message?.includes('cancel') || error.message?.includes('interrupt'))) {
            ctx.logError(tr.setup.errorTitle, error.message);
        }
    }
}

async function handleAdvancedSetup(ctx: SetupCommandContext): Promise<void> {
    const config = loadConfig();
    const tr = t();
    const ttsEnabled = config.tts?.enabled ? tr.setup.enabled : tr.setup.disabled;
    const remoteEnabled = config.remote?.enabled ? tr.setup.enabled : tr.setup.disabled;

    const action = await ctx.promptSelect(
        tr.setup.advancedTitle,
        [
            {
                label: formatMessage(tr.setup.ttsLabel, { status: ttsEnabled }),
                value: 'tts' as const,
                description: tr.setup.ttsDesc,
            },
            {
                label: formatMessage(tr.setup.remoteLabel, { status: remoteEnabled }),
                value: 'remote' as const,
                description: tr.setup.remoteDesc,
            },
            {
                label: tr.setup.experimentalLabel,
                value: 'experimental' as const,
                description: tr.setup.experimentalDesc,
            },
            {
                label: tr.setup.notifyLabel,
                value: 'notify' as const,
                description: tr.setup.notifyDesc,
            },
            {
                label: `← ${tr.common.back}`,
                value: 'back' as const,
            },
        ],
        'tts',
    );

    switch (action) {
        case 'tts':
            await ctx.handleCommand('/tts');
            break;
        case 'remote':
            await ctx.handleCommand('/remote');
            break;
        case 'experimental':
            await ctx.handleCommand('/experimental');
            break;
        case 'notify':
            await ctx.handleCommand('/notify');
            break;
        case 'back':
            // 返回主菜单
            await handleSetupCommand(ctx, []);
            break;
    }
}
