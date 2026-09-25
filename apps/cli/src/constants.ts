/**
 * CLI Constants
 * Centralized constants for the Neox CLI
 */

import chalk from 'chalk';
import type { ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import { VERSION } from '@neoxlabs/kernel/version.js';
import { getCliEdition } from './edition/index.js';

export const CLI_VERSION = VERSION;

/** Tab 补全提示。账号类 (/login /whoami /device ...) 由发行版插槽提供, 插在 /quit 之后。
 *  调用时取 —— 不能在模块顶层拼, 那时商业入口可能还没注册插槽 (见 edition/index.ts)。 */
export function getCliCommandHints(): string[] {
  const at = CLI_COMMAND_HINTS.indexOf('/quit') + 1;
  return [...CLI_COMMAND_HINTS.slice(0, at), ...getCliEdition().commandHints, ...CLI_COMMAND_HINTS.slice(at)];
}

/** 共享的补全提示 (不含账号类) —— 要完整列表用 getCliCommandHints() */
export const CLI_COMMAND_HINTS = [
  // Basic commands
  '/help',
  '/exit',
  '/quit',

  // Mode and settings
  '/mode',
  '/mode agent',
  '/mode ask',
  '/mode auto',
  '/mode low',
  '/mode run',
  '/mode config',
  '/run',
  '/runconfig',
  '/approval',
  '/approval auto',
  '/approval manual',
  '/approval yolo',
  '/approval global auto',
  '/approval agent worker manual',
  '/notify',
  '/sandbox',
  '/sandbox on',
  '/sandbox off',
  '/sandbox status',

  // Provider and model
  '/provider',
  '/provider list',
  '/provider add',
  '/provider edit',
  '/provider remove',
  '/provider default',
  '/provider use',
  '/model',
  '/model list',
  '/model add',
  '/model use',
  '/model remove',
  '/model default',
  '/model config',
  '/effort',
  '/effort minimal',
  '/effort low',
  '/effort medium',
  '/effort high',
  '/effort xhigh',
  '/effort max',
  '/effort ultra',

  // Attachments
  '/attach',
  '/attachments',
  '/attachments list',
  '/attachments clear',

  // Project memory
  '/init',
  '/init project',
  '/init deep',

  // Debugging and thinking
  '/thinking',
  '/thinking on',
  '/thinking off',
  '/thinking status',
  '/websearch',
  '/websearch status',
  '/websearch on',
  '/websearch off',
  '/websearch set-url',
  '/websearch set-key',

  // Session management (子动作统一进 /session)
  '/resume',
  '/session',
  '/session ls',
  '/session new',
  '/session info',
  '/session export',
  '/session clear',
  '/undo',
  '/checkpoint',
  '/rollback',
  '/compact',
  '/cleanup',
  '/cleanup status',

  // Workspace management
  '/workspace',
  '/workspace list',
  '/workspace add',
  '/workspace switch',

  // Process management
  '/processes',
  '/ps',
  '/kill',

  // Configuration and utilities
  '/clear',
  '/config-clear',
  '/stats',
  '/statistic',
  '/pricing',
  '/context',
  '/memory',
  '/memory show',
  '/memory paths',
  '/remote',
  '/index',
  '/mcp',
  '/mcp list',
  '/mcp add',
  '/mcp remove',
  '/mcp connect',
  '/mcp test',

  // Setup / advanced controls (补齐 audit 发现的 autocomplete 漏项)
  '/setup',
  '/theme',
  '/theme slate',
  '/theme warm',
  '/theme mono',
  '/theme nord',
  '/theme neon',
  '/theme light',
  '/theme dark',
  '/update',
  '/skills',
  '/language',
  '/tts',
  '/experimental',
  '/model-profile',
];

/** 每个协议的默认上游根地址. 覆盖 ProviderProtocol 全集 (含 image/tts/stt/embedding 等非 chat 协议),
 *  值对齐 packages/kernel/src/models/providerPresets.ts 的 preset baseUrl. */
export const PROVIDER_BASE_URLS: Record<ProviderProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'openai-images': 'https://api.openai.com/v1',
  'openai-tts': 'https://api.openai.com/v1',
  'openai-stt': 'https://api.openai.com/v1',
  'openai-embedding': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'anthropic-openai': 'https://api.anthropic.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  'doubao-images': 'https://ark.cn-beijing.volces.com/api/v3',
  'doubao-tts': 'https://ark.cn-beijing.volces.com/api/v3',
  gemini: 'https://generativelanguage.googleapis.com',
  'gemini-images': 'https://generativelanguage.googleapis.com',
  grok: 'https://api.x.ai/v1',
  'grok-images': 'https://api.x.ai/v1',
  kimi: 'https://api.moonshot.cn/v1',
  deepseek: 'https://api.deepseek.com',
  minimax: 'https://api.minimax.chat/v1',
  'minimax-tts': 'https://api.minimax.chat/v1',
  'minimax-video': 'https://api.minimax.chat/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'qwen-images': 'https://dashscope.aliyuncs.com/api/v1',
  'dashscope-tts': 'https://dashscope.aliyuncs.com/api/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  'glm-claude': 'https://open.bigmodel.cn/api/paas/v4',
  'glm-images': 'https://open.bigmodel.cn/api/paas/v4',
  'kimi-claude': 'https://api.moonshot.cn/anthropic',
  openrouter: 'https://openrouter.ai/api/v1',
  'openrouter-images': 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
};

/** 协议显示名. 覆盖 ProviderProtocol 全集 —— 只读展示 (列出已存在的 provider),
 *  可选协议清单另在 commands/provider.ts 里显式收窄到运行时支持的 chat 协议.
 *  文案对齐 ProviderFactory.getProtocolDisplayName. */
export const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  openai: 'OpenAI (Chat)',
  'openai-responses': 'OpenAI (Responses)',
  'openai-images': 'OpenAI Images (图像)',
  'openai-tts': 'OpenAI TTS (语音)',
  'openai-stt': 'OpenAI STT (转写)',
  'openai-embedding': 'OpenAI Embeddings (向量)',
  anthropic: 'Anthropic',
  'anthropic-openai': 'Anthropic (OpenAI Format)',
  doubao: '豆包 (Doubao)',
  'doubao-images': '豆包 Seedream (图像)',
  'doubao-tts': '豆包 CosyVoice (语音)',
  gemini: 'Google Gemini',
  'gemini-images': 'Gemini Image (图像)',
  grok: 'xAI Grok',
  'grok-images': 'Grok Image (图像)',
  kimi: 'Kimi (Moonshot)',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  'minimax-tts': 'MiniMax TTS (语音)',
  'minimax-video': 'MiniMax (视频生成)',
  qwen: 'Qwen (阿里云百炼)',
  'qwen-images': '通义万相 (图像)',
  'dashscope-tts': 'Dashscope CosyVoice v2 (语音)',
  glm: 'GLM (智谱 AI)',
  'glm-claude': 'GLM (Claude 协议)',
  'glm-images': '智谱 CogView (图像)',
  'kimi-claude': 'Kimi (Claude 协议)',
  openrouter: 'OpenRouter',
  'openrouter-images': 'OpenRouter (图像)',
  mistral: 'Mistral',
  groq: 'Groq',
  together: 'Together AI',
};

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Detect terminal background and set appropriate colors
 */
export const isDarkBackground = (): boolean => {
  // Check COLORFGBG environment variable (common in many terminals)
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg) {
    const parts = colorFgBg.split(';');
    if (parts.length > 1) {
      const bg = parseInt(parts[1]);
      return bg < 8 || isNaN(bg);
    }
  }

  // Check TERM_PROGRAM for some known terminals
  const termProgram = process.env.TERM_PROGRAM;
  if (termProgram === 'Apple_Terminal' || termProgram === 'iTerm.app') {
    return true;
  }

  // Default to dark background (most common for developers)
  return true;
};

export const isDark = isDarkBackground();

/**
 * Terminal color scheme based on background detection
 */
export const colors = {
  // Primary brand color
  primary: (text: string) => (isDark ? chalk.cyan(text) : chalk.blue(text)),
  // Success color
  success: (text: string) => (isDark ? chalk.green(text) : chalk.green(text)),
  // Error color
  error: (text: string) => (isDark ? chalk.red(text) : chalk.red(text)),
  // Warning color
  warning: (text: string) => (isDark ? chalk.yellow(text) : chalk.yellow(text)),
  // Info/secondary color
  info: (text: string) => (isDark ? chalk.blueBright(text) : chalk.blue(text)),
  // Dimmed/muted text
  dim: (text: string) => (isDark ? chalk.gray(text) : chalk.gray(text)),
  // Highlighted text
  highlight: (text: string) => (isDark ? chalk.white.bold(text) : chalk.black.bold(text)),
  // Code/technical text
  code: (text: string) => (isDark ? chalk.magenta(text) : chalk.magenta(text)),
  // Regular text
  text: (text: string) => (isDark ? chalk.white(text) : chalk.black(text)),
};
