import type { NeoxConfig, WebSearchConfig } from '@neoxlabs/platform/utils/config.js';
import { wrapApiKey, unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';

type Choice = { label: string; value: string; description: string };

interface WebSearchCommandDeps {
  userConfig: NeoxConfig;
  promptSelect: (question: string, choices: Choice[], defaultValue?: string, hint?: string) => Promise<string>;
  promptText: (question: string, options?: { allowEmpty?: boolean; defaultValue?: string }) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  persistAndRefresh: (nextConfig: NeoxConfig, title: string, details?: string) => Promise<void>;
}

interface WebSearchMainAdapterDeps {
  userConfig: NeoxConfig;
  promptSelect: WebSearchCommandDeps['promptSelect'];
  promptText: WebSearchCommandDeps['promptText'];
  logInfo: WebSearchCommandDeps['logInfo'];
  updateUserConfig: (config: NeoxConfig) => void;
  persistConfig: (config: NeoxConfig) => void;
  refreshTools: () => Promise<void>;
}

export async function handleWebSearchCommandFlow(
  args: string[],
  deps: WebSearchCommandDeps,
): Promise<void> {
  let action = (args[0] || '').toLowerCase();
  let value = args.slice(1).join(' ').trim();

  if (!action) {
    try {
      action = await deps.promptSelect(
        '联网搜索',
        [
          { label: '查看配置', value: 'status', description: '当前是否开启、用哪个后端' },
          { label: '开启', value: 'on', description: '允许模型调用 web_search' },
          { label: '关闭', value: 'off', description: '禁用 web_search' },
          { label: '搜索后端', value: 'set-engine', description: 'auto / bocha / serper / 自定义' },
          { label: '自定义地址', value: 'set-url', description: '后端选"自定义"时用' },
          { label: 'API Key', value: 'set-key', description: 'bocha / serper 的 Key, 留空清除' },
        ],
        'status',
      );
      if (action === 'set-engine') {
        value = await deps.promptSelect(
          '搜索后端',
          [
            { label: 'Auto (自带)', value: 'auto', description: 'GPT/Claude/Kimi/DeepSeek 用模型原生搜索' },
            { label: '博查 Bocha', value: 'bocha', description: '国内首选, DeepSeek 官方搜索商 (需 API Key)' },
            { label: 'Serper', value: 'serper', description: 'Google 结果, 国际 (需 API Key)' },
            { label: 'Custom', value: 'custom', description: '自定义搜索 endpoint (需 URL)' },
          ],
          deps.userConfig.webSearch?.engine || 'auto',
          '选择搜索后端',
        );
      } else if (action === 'set-url') {
        value = await deps.promptText('输入 WebSearch URL（留空清除）', { allowEmpty: true, defaultValue: deps.userConfig.webSearch?.url || '' });
      } else if (action === 'set-key') {
        /* 盘上是 enc:v1 密文 — 解出明文当默认值回显 (旧明文透传) */
        value = await deps.promptText('输入搜索 API Key（留空清除）', { allowEmpty: true, defaultValue: unwrapApiKey(deps.userConfig.webSearch?.apiKey) });
      }
    } catch (error: any) {
      if (error?.message !== 'cancelled') deps.logInfo('WebSearch 操作失败', error?.message || String(error));
      return;
    }
  }

  const webSearchConfig = {
    enabled: deps.userConfig.webSearch?.enabled === true,
    engine: deps.userConfig.webSearch?.engine || 'auto',
    url: deps.userConfig.webSearch?.url,
    apiKey: deps.userConfig.webSearch?.apiKey,
  };
  const nextConfig: NeoxConfig = { ...deps.userConfig, webSearch: { ...webSearchConfig } };

  switch (action) {
    case 'status': {
      const enabledText = webSearchConfig.enabled ? 'ON' : 'OFF';
      const endpointText = webSearchConfig.url?.trim() || '(默认: 当前 Provider /v1/messages)';
      const keyText = webSearchConfig.apiKey ? '已配置' : '未配置';
      deps.logInfo('WebSearch 配置', `状态: ${enabledText}\n后端: ${webSearchConfig.engine}\nURL: ${endpointText}\nAPI Key: ${keyText}`);
      return;
    }
    case 'set-engine': {
      const webSearch = { ...(nextConfig.webSearch || { enabled: false }) } as WebSearchConfig;
      const eng = (value || 'auto') as WebSearchConfig['engine'];
      webSearch.engine = eng;
      nextConfig.webSearch = webSearch;
      await deps.persistAndRefresh(nextConfig, `WebSearch 后端已设为 ${eng}`, eng === 'bocha' || eng === 'serper' ? '记得用 set-key 配 API Key' : eng === 'custom' ? '记得用 set-url 配 endpoint' : 'GPT/Claude/Kimi 用自带搜索');
      return;
    }
    case 'on':
    case 'enable':
      nextConfig.webSearch = { ...(nextConfig.webSearch || {}), enabled: true };
      await deps.persistAndRefresh(nextConfig, 'WebSearch 已开启', '现在可使用 web_search 工具');
      return;
    case 'off':
    case 'disable':
      nextConfig.webSearch = { ...(nextConfig.webSearch || {}), enabled: false };
      await deps.persistAndRefresh(nextConfig, 'WebSearch 已关闭', 'web_search 工具将不会暴露给模型');
      return;
    case 'set-url': {
      const webSearch = { ...(nextConfig.webSearch || { enabled: false }) } as WebSearchConfig;
      if (!value) {
        delete webSearch.url;
        nextConfig.webSearch = webSearch;
        await deps.persistAndRefresh(nextConfig, 'WebSearch URL 已清空', '将回退到默认 Provider API URL');
        return;
      }
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL 协议必须是 http 或 https');
      } catch (error: any) {
        deps.logInfo('URL 无效', error?.message || `无效 URL: ${value}`);
        return;
      }
      webSearch.url = value;
      nextConfig.webSearch = webSearch;
      await deps.persistAndRefresh(nextConfig, 'WebSearch URL 已更新', value);
      return;
    }
    case 'set-key': {
      const webSearch = { ...(nextConfig.webSearch || { enabled: false }) } as WebSearchConfig;
      if (!value) {
        delete webSearch.apiKey;
        nextConfig.webSearch = webSearch;
        await deps.persistAndRefresh(nextConfig, 'WebSearch API Key 已清空', '将不再使用 Serper 回退');
        return;
      }
      webSearch.apiKey = wrapApiKey(value);
      nextConfig.webSearch = webSearch;
      await deps.persistAndRefresh(nextConfig, 'WebSearch API Key 已更新', `${value.slice(0, 4)}****`);
      return;
    }
    default:
      deps.logInfo('用法', ['/websearch status', '/websearch on|off', '/websearch set-url <url>', '/websearch set-key <api-key>', '提示: set-url / set-key 不带参数可清空该配置'].join('\n'));
  }
}

export async function handleWebSearchCommandFromMain(
  args: string[],
  deps: WebSearchMainAdapterDeps,
): Promise<void> {
  await handleWebSearchCommandFlow(args, {
    userConfig: deps.userConfig,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    logInfo: deps.logInfo,
    persistAndRefresh: async (nextConfig, title, details) => {
      deps.updateUserConfig(nextConfig);
      deps.persistConfig(nextConfig);
      try {
        await deps.refreshTools();
      } catch {
        // ignore tool refresh errors here; config is already persisted
      }
      deps.logInfo(title, details);
    },
  });
}
