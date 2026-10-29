import type { NeoxConfig, WebSearchConfig } from '@neoxlabs/platform/utils/config.js';
import { wrapApiKey, unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { L } from '../i18n/index.js';

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
        L('联网搜索', 'Web search'),
        [
          { label: L('查看配置', 'Show settings'), value: 'status', description: L('当前是否开启、用哪个后端', 'whether it’s on and which backend') },
          { label: L('开启', 'Turn on'), value: 'on', description: L('允许模型调用 web_search', 'let the model call web_search') },
          { label: L('关闭', 'Turn off'), value: 'off', description: L('禁用 web_search', 'disable web_search') },
          { label: L('搜索后端', 'Search backend'), value: 'set-engine', description: L('auto / bocha / serper / 自定义', 'auto / bocha / serper / custom') },
          { label: L('自定义地址', 'Custom URL'), value: 'set-url', description: L('后端选"自定义"时用', 'used with the custom backend') },
          { label: 'API Key', value: 'set-key', description: L('bocha / serper 的 Key, 留空清除', 'key for bocha / serper; empty clears it') },
        ],
        'status',
      );
      if (action === 'set-engine') {
        value = await deps.promptSelect(
          L('搜索后端', 'Search backend'),
          [
            { label: L('Auto (自带)', 'Auto (built-in)'), value: 'auto', description: L('GPT/Claude/Kimi/DeepSeek 用模型原生搜索', 'GPT/Claude/Kimi/DeepSeek use their native search') },
            { label: L('博查 Bocha', 'Bocha'), value: 'bocha', description: L('国内首选, DeepSeek 官方搜索商 (需 API Key)', 'best in mainland China, DeepSeek’s search provider (needs a key)') },
            { label: 'Serper', value: 'serper', description: L('Google 结果, 国际 (需 API Key)', 'Google results (needs a key)') },
            { label: L('自定义', 'Custom'), value: 'custom', description: L('自定义搜索 endpoint (需 URL)', 'your own search endpoint (needs a URL)') },
          ],
          deps.userConfig.webSearch?.engine || 'auto',
          L('选择搜索后端', 'Pick a search backend'),
        );
      } else if (action === 'set-url') {
        value = await deps.promptText(L('输入 WebSearch URL（留空清除）', 'Web search URL (empty clears it)'), { allowEmpty: true, defaultValue: deps.userConfig.webSearch?.url || '' });
      } else if (action === 'set-key') {
        /* 盘上是 enc:v1 密文 — 解出明文当默认值回显 (旧明文透传) */
        value = await deps.promptText(L('输入搜索 API Key（留空清除）', 'Search API key (empty clears it)'), { allowEmpty: true, defaultValue: unwrapApiKey(deps.userConfig.webSearch?.apiKey) });
      }
    } catch (error: any) {
      if (error?.message !== 'cancelled') deps.logInfo(L('联网搜索设置失败', 'Web search settings failed'), error?.message || String(error));
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
      const endpointText = webSearchConfig.url?.trim() || L('(默认: 当前 Provider /v1/messages)', '(default: current provider /v1/messages)');
      const keyText = webSearchConfig.apiKey ? L('已配置', 'set') : L('未配置', 'not set');
      deps.logInfo(L('联网搜索设置', 'Web search settings'), `${L('状态', 'Status')}: ${enabledText}\n${L('后端', 'Backend')}: ${webSearchConfig.engine}\nURL: ${endpointText}\nAPI Key: ${keyText}`);
      return;
    }
    case 'set-engine': {
      const webSearch = { ...(nextConfig.webSearch || { enabled: false }) } as WebSearchConfig;
      const eng = (value || 'auto') as WebSearchConfig['engine'];
      webSearch.engine = eng;
      nextConfig.webSearch = webSearch;
      await deps.persistAndRefresh(nextConfig, L(`搜索后端已设为 ${eng}`, `Search backend set to ${eng}`),
        eng === 'bocha' || eng === 'serper' ? L('记得用 set-key 配 API Key', 'Set the API key with set-key')
          : eng === 'custom' ? L('记得用 set-url 配 endpoint', 'Set the endpoint with set-url')
            : L('GPT/Claude/Kimi 用自带搜索', 'GPT/Claude/Kimi use their built-in search'));
      return;
    }
    case 'on':
    case 'enable':
      nextConfig.webSearch = { ...(nextConfig.webSearch || {}), enabled: true };
      await deps.persistAndRefresh(nextConfig, L('联网搜索已开启', 'Web search on'), L('现在可使用 web_search 工具', 'The web_search tool is available'));
      return;
    case 'off':
    case 'disable':
      nextConfig.webSearch = { ...(nextConfig.webSearch || {}), enabled: false };
      await deps.persistAndRefresh(nextConfig, L('联网搜索已关闭', 'Web search off'), L('web_search 工具将不会暴露给模型', 'The model won’t see the web_search tool'));
      return;
    case 'set-url': {
      const webSearch = { ...(nextConfig.webSearch || { enabled: false }) } as WebSearchConfig;
      if (!value) {
        delete webSearch.url;
        nextConfig.webSearch = webSearch;
        await deps.persistAndRefresh(nextConfig, L('搜索 URL 已清空', 'Search URL cleared'), L('将回退到默认 Provider API URL', 'Falls back to the provider’s API URL'));
        return;
      }
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(L('URL 协议必须是 http 或 https', 'URL must start with http or https'));
      } catch (error: any) {
        deps.logInfo(L('URL 无效', 'Invalid URL'), error?.message || `${L('无效 URL', 'Invalid URL')}: ${value}`);
        return;
      }
      webSearch.url = value;
      nextConfig.webSearch = webSearch;
      await deps.persistAndRefresh(nextConfig, L('搜索 URL 已更新', 'Search URL updated'), value);
      return;
    }
    case 'set-key': {
      const webSearch = { ...(nextConfig.webSearch || { enabled: false }) } as WebSearchConfig;
      if (!value) {
        delete webSearch.apiKey;
        nextConfig.webSearch = webSearch;
        await deps.persistAndRefresh(nextConfig, L('搜索 API Key 已清空', 'Search API key cleared'), L('将不再使用 Serper 回退', 'Serper fallback is off'));
        return;
      }
      webSearch.apiKey = wrapApiKey(value);
      nextConfig.webSearch = webSearch;
      await deps.persistAndRefresh(nextConfig, L('搜索 API Key 已更新', 'Search API key updated'), `${value.slice(0, 4)}****`);
      return;
    }
    default:
      deps.logInfo(L('用法', 'Usage'), ['/websearch status', '/websearch on|off', '/websearch set-url <url>', '/websearch set-key <api-key>',
        L('提示: set-url / set-key 不带参数可清空该配置', 'Tip: set-url / set-key with no value clears it')].join('\n'));
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
