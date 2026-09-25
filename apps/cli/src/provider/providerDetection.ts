import * as fs from 'fs';
import * as path from 'path';
import type { ProviderProtocol } from '@neoxlabs/platform/utils/config.js';

/**
 * Detect providers from environment variables
 * Supports:
 * - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
 * - OPENAI_API_KEY + OPENAI_BASE_URL
 * - GEMINI_API_KEY + GEMINI_BASE_URL
 * - DOUBAO_API_KEY + DOUBAO_BASE_URL
 * - MOONSHOT_API_KEY + MOONSHOT_BASE_URL
 * - Codex config.toml (~/.codex/config.toml)
 */
export interface DetectedProvider {
  name: string;
  protocol: ProviderProtocol;
  apiKey: string;
  baseUrl?: string;
  models: string[];
  envKeyHint?: string;
}

interface CodexModelProvider {
  name: string;
  base_url?: string;
  wire_api?: 'responses' | 'chat' | 'openai';
  env_key?: string;
  temp_env_key?: string;
  requires_openai_auth?: boolean;
  model?: string;
}

function getCodexConfigPath(): string | null {
  const platform = process.platform;

  if (platform === 'win32') {
    const userProfile = process.env.USERPROFILE;
    const appData = process.env.APPDATA;

    if (userProfile) {
      const configPath = path.join(userProfile, '.codex', 'config.toml');
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }

    if (appData) {
      const configPath = path.join(appData, 'codex', 'config.toml');
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }

    return null;
  }

  const home = process.env.HOME;
  if (!home) return null;

  const configPath = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(configPath)) {
    return configPath;
  }

  return null;
}

function parseCodexConfig(content: string): {
  defaultProvider?: string;
  defaultModel?: string;
  providers: Record<string, CodexModelProvider>;
} {
  const result: {
    defaultProvider?: string;
    defaultModel?: string;
    providers: Record<string, CodexModelProvider>;
  } = { providers: {} };

  const lines = content.split('\n');
  let currentSection = '';
  let currentProviderName = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[model_providers\.([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = 'model_providers';
      currentProviderName = sectionMatch[1];
      result.providers[currentProviderName] = { name: currentProviderName };
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = '';
      currentProviderName = '';
      continue;
    }

    const topLevelMatch = line.match(/^(\w+)\s*=\s*"?([^"]*)"?$/);
    if (topLevelMatch && !currentSection) {
      const [, key, value] = topLevelMatch;
      if (key === 'model_provider') {
        result.defaultProvider = value;
      } else if (key === 'model') {
        result.defaultModel = value;
      }
      continue;
    }

    if (currentSection === 'model_providers' && currentProviderName) {
      const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const [, key, rawValue] = kvMatch;
        let value: string | boolean = rawValue.trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        } else if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        }

        const provider = result.providers[currentProviderName];
        switch (key) {
          case 'name':
            provider.name = value as string;
            break;
          case 'base_url':
            provider.base_url = value as string;
            break;
          case 'wire_api':
            provider.wire_api = value as 'responses' | 'chat' | 'openai';
            break;
          case 'env_key':
            provider.env_key = value as string;
            break;
          case 'temp_env_key':
            provider.temp_env_key = value as string;
            break;
          case 'requires_openai_auth':
            provider.requires_openai_auth = value as boolean;
            break;
          case 'model':
            provider.model = value as string;
            break;
        }
      }
    }
  }

  return result;
}

function detectProvidersFromCodexConfig(): DetectedProvider[] {
  const detected: DetectedProvider[] = [];

  const configPath = getCodexConfigPath();
  if (!configPath) {
    return detected;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = parseCodexConfig(content);

    const authJsonPath = path.join(path.dirname(configPath), 'auth.json');
    let authKeys: Record<string, string> = {};
    if (fs.existsSync(authJsonPath)) {
      try {
        authKeys = JSON.parse(fs.readFileSync(authJsonPath, 'utf-8'));
      } catch {
        // ignore parse error
      }
    }

    const dotenvPath = path.join(path.dirname(configPath), '.env');
    const dotenvKeys: Record<string, string> = {};
    if (fs.existsSync(dotenvPath)) {
      try {
        const dotenvContent = fs.readFileSync(dotenvPath, 'utf-8');
        for (const rawLine of dotenvContent.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const k = line.slice(0, eq).trim();
          let v = line.slice(eq + 1).trim();
          /* 去除可能的引号 */
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (k && v) dotenvKeys[k] = v;
        }
      } catch {
        // ignore parse error
      }
    }

    /* 统一查找函数: process.env → auth.json → ~/.codex/.env */
    const lookupKey = (name: string | undefined): string | undefined => {
      if (!name) return undefined;
      return process.env[name] || authKeys[name] || dotenvKeys[name];
    };

    for (const [providerKey, provider] of Object.entries(config.providers)) {
      let apiKey: string | undefined;

      apiKey = lookupKey(provider.env_key);
      if (!apiKey) apiKey = lookupKey(provider.temp_env_key);
      if (!apiKey && provider.requires_openai_auth) {
        apiKey = lookupKey('OPENAI_API_KEY');
      }

      if (!apiKey) {
        apiKey = process.env.CODEX_API_KEY || process.env[`${providerKey.toUpperCase()}_API_KEY`];
      }

      let protocol: ProviderProtocol = 'openai';
      if (provider.wire_api === 'responses') {
        protocol = 'openai-responses';
      }

      const models: string[] = [];
      if (provider.model) {
        models.push(provider.model);
      } else if (config.defaultModel) {
        models.push(config.defaultModel);
      } else {
        models.push('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini');
      }

      detected.push({
        name: `Codex (${providerKey})`,
        protocol,
        apiKey: (apiKey ?? '').trim(),
        baseUrl: provider.base_url,
        models,
        /* 没 key 时给 UI hint: 该去 set 哪个 env var */
        envKeyHint: !apiKey?.trim()
          ? (provider.env_key || provider.temp_env_key || (provider.requires_openai_auth ? 'OPENAI_API_KEY' : undefined))
          : undefined,
      });
    }
  } catch (error) {
    if (process.env.CLI_DEBUG === '1') {
      console.error(`Failed to read Codex config: ${error}`);
    }
  }

  return detected;
}

export function detectProvidersFromEnv(): DetectedProvider[] {
  const detected: DetectedProvider[] = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (anthropicKey && anthropicKey.trim()) {
    detected.push({
      name: 'Anthropic',
      protocol: 'anthropic',
      apiKey: anthropicKey.trim(),
      baseUrl: process.env.ANTHROPIC_BASE_URL?.trim(),
      models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6'],
    });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  if (openaiKey && openaiKey.trim()) {
    const protocol: ProviderProtocol =
      process.env.OPENAI_PROTOCOL === 'responses' || process.env.OPENAI_PROTOCOL === 'openai-responses' ? 'openai-responses' :
        process.env.OPENAI_PROTOCOL === 'anthropic' || process.env.OPENAI_PROTOCOL === 'anthropic-openai' ? 'anthropic-openai' :
          'openai';

    const models = protocol === 'openai-responses'
      ? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']
      : ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

    detected.push({
      name: openaiBaseUrl ? 'OpenAI Proxy' : 'OpenAI',
      protocol,
      apiKey: openaiKey.trim(),
      baseUrl: openaiBaseUrl,
      models,
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey && geminiKey.trim()) {
    detected.push({
      name: 'Gemini',
      protocol: 'gemini',
      apiKey: geminiKey.trim(),
      baseUrl: process.env.GEMINI_BASE_URL?.trim(),
      models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
    });
  }

  const moonshotKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
  if (moonshotKey && moonshotKey.trim()) {
    detected.push({
      name: 'Kimi (Moonshot)',
      protocol: 'kimi',
      apiKey: moonshotKey.trim(),
      baseUrl: process.env.MOONSHOT_BASE_URL?.trim() || process.env.KIMI_BASE_URL?.trim(),
      models: ['kimi-k2.7-code', 'kimi-k2.6'],
    });
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey && deepseekKey.trim()) {
    detected.push({
      name: 'DeepSeek',
      protocol: 'deepseek',
      apiKey: deepseekKey.trim(),
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim(),
      models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    });
  }

  const qwenKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (qwenKey && qwenKey.trim()) {
    detected.push({
      name: 'Qwen (阿里云百炼)',
      protocol: 'qwen',
      apiKey: qwenKey.trim(),
      baseUrl: process.env.QWEN_BASE_URL?.trim() || process.env.DASHSCOPE_BASE_URL?.trim(),
      models: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
    });
  }

  const minimaxKey = process.env.MINIMAX_API_KEY;
  if (minimaxKey && minimaxKey.trim()) {
    detected.push({
      name: 'MiniMax',
      protocol: 'minimax',
      apiKey: minimaxKey.trim(),
      baseUrl: process.env.MINIMAX_BASE_URL?.trim(),
      models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    });
  }

  const doubaoKey = process.env.DOUBAO_API_KEY || process.env.VOLCENGINE_API_KEY;
  if (doubaoKey && doubaoKey.trim()) {
    detected.push({
      name: 'Doubao',
      protocol: 'doubao',
      apiKey: doubaoKey.trim(),
      baseUrl: process.env.DOUBAO_BASE_URL?.trim(),
      models: ['doubao-seed-1-6-251015'],
    });
  }

  const glmKey = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;
  if (glmKey && glmKey.trim()) {
    detected.push({
      name: 'GLM (智谱 AI)',
      protocol: 'glm',
      apiKey: glmKey.trim(),
      baseUrl: process.env.GLM_BASE_URL?.trim() || process.env.ZHIPU_BASE_URL?.trim(),
      models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo'],
    });
  }

  const codexProviders = detectProvidersFromCodexConfig();
  for (const codexProvider of codexProviders) {
    detected.push(codexProvider);
  }

  if (codexProviders.length === 0) {
    const codexKey = process.env.CODEX_API_KEY;
    const codexBaseUrl = process.env.CODEX_BASE_URL?.trim();
    if (codexKey && codexKey.trim()) {
      detected.push({
        name: 'Codex',
        protocol: 'openai-responses',
        apiKey: codexKey.trim(),
        baseUrl: codexBaseUrl,
        models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
      });
    }
  }

  return detected;
}
