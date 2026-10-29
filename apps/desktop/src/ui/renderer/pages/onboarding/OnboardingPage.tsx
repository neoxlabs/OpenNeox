import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAppStore, COLOR_THEMES, type ColorTheme, type DarkModePreference, type ThemePreset } from '../../../state/appStore';
import { THEME_PACKS, type ThemePack } from '../../../state/themePacks';
import { useI18n, setGlobalLanguage, type Language } from '../../hooks/useI18n';
import Icons from '../../components/Icons';
import { brandLogoUrl, onBrandImgError } from '../../utils/brandAssets';
import { setByokPinned } from '../../state/byokPickerPrefs';
import { ProviderScanImport } from '../settings/tabs/ProviderScanImport';
import { MobileAppStep } from './MobileAppStep';
import { ScanLede, ScanProbe, ScanStyles, scanPacing, type ScanSource } from '../settings/tabs/scanShell';
import { UiSlot } from '../../modules/shell/uiSlots';
import { getEditionHook } from '../../modules/shell/editionHooks';
import { syncWinTitleBar } from '../../utils/winTitleBarSync';
import { canSkipWelcome } from '../../app/welcomeGate';
import { httpStatusHint } from '../settings/utils/httpStatusHint';
import { ProviderBrandLogo } from '../settings/tabs/ProviderBrandLogo';
import { NeoxIllus } from '../../media/illus';

interface OnboardingPageProps {
  onComplete: () => void;
  /** 打开设置浮层 —— 引导页(未登录冷启动)原来完全够不着设置, 见 header 里那个齿轮 */
  onOpenSettings?: () => void;
  /** 从哪一步开始 —— 只有离线渲染台 (__harness__/onboarding) 用, 应用里恒从 theme 开始 */
  initialStep?: OnboardingStep;
  /** 只接模型: 整个流程只剩 connect 一步, 接上就 onComplete, 「稍后再说」/返回就 onCancel。
   *  欢迎页「使用 BYOK 继续」和输入框「去配置」走这里 —— 跟引导里同一套选服务商/填 Key,
   *  不再把人甩进设置页那张密表单。'byok' 直接落服务商列表, 'choose' 先问订阅还是自带 Key。 */
  connectOnly?: 'choose' | 'byok';
  onCancel?: () => void;
}

type OnboardingStep = 'theme' | 'mode' | 'migrate' | 'connect' | 'mobile';

/** migrate:scan 的返回形状 (electron/ipc/migrateHandlers.ts) */
interface MigrateSessionShape {
  source: string; sessionId: string; filePath: string;
  cwd: string | null; title: string | null; bytes: number; updatedAt: string; alreadyImported: boolean;
}
interface MigrateScanShape {
  skills: Array<{ id: string; name: string; source: string; path: string; alreadyImported: boolean }>;
  mcp: Array<{ id: string; source: string; transport: string; summary: string; envKeys: string[]; disabledAtSource: boolean; alreadyImported: boolean }>;
  sessions: {
    count: number; projects: number; totalBytes: number;
    bySource: Record<string, number>;
    recent: MigrateSessionShape[];
  };
  freshCount: number;
}

/* 会话这一组在引导页上最多铺几行。用户在这一屏要的是"把我最近在干的事带过来",
 * 不是逐条勾一千个 —— 其余的进设置页再导。 */
const SESSION_ROWS = 200;

/* 行高 —— 虚拟化按它算可视区间, 必须跟 CSS 里 .migrate-row 的实际高度一致。
 * 对不上的话滚动条长度会错, 滚到底还剩一截空白。 */
const MIGRATE_ROW_H = 42;
/* 列表露出几行 (跟 CSS 的 max-height 对齐) */
const MIGRATE_VISIBLE_ROWS = 5;

/* 扫描时逐条报出来的源 —— 跟 migrate:scan 实际读的地方一一对应, 不许编 */
const MIGRATE_SOURCES: ScanSource[] = [
  { zh: '~/.claude/skills 与 ~/.codex/skills', en: '~/.claude/skills · ~/.codex/skills' },
  { zh: '~/.claude.json 与 ~/.codex/config.toml 的 MCP', en: 'MCP servers' },
  { zh: '~/.claude/projects 的历史会话', en: '~/.claude/projects sessions' },
  { zh: '~/.codex/sessions 的历史会话', en: '~/.codex/sessions' },
];

const STREAM_PARTICLES = 7;

const MigrateIllustration: React.FC<{ themePreset: ThemePreset }> = ({ themePreset }) => (
  <div className="migrate-illu" aria-hidden="true">
    <div className="migrate-illu__side">
      <span className="migrate-illu__node">
        <ProviderBrandLogo presetId="anthropic" fallbackLabel="Claude" size={34} />
        <span className="migrate-illu__label">Claude Code</span>
      </span>
      <span className="migrate-illu__node">
        <ProviderBrandLogo presetId="openai" fallbackLabel="Codex" size={34} />
        <span className="migrate-illu__label">Codex</span>
      </span>
    </div>

    {/* 数据流: 一条通道 + 若干错开出发的粒子 */}
    <span className="migrate-illu__stream">
      {Array.from({ length: STREAM_PARTICLES }, (_, i) => (
        <i
          key={i}
          className="migrate-illu__dot"
          style={{
            animationDelay: `${(i * 1.8) / STREAM_PARTICLES}s`,
            top: `${26 + (i % 3) * 22}%`,
          }}
        />
      ))}
    </span>

    <span className="migrate-illu__node migrate-illu__node--to">
      <img src={brandLogoUrl(themePreset)} onError={onBrandImgError('logo')} alt="" width={44} height={44} draggable={false} />
      <span className="migrate-illu__label">Neox</span>
    </span>
  </div>
);

const IconSkill: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M12 3l2.1 4.6 5 .6-3.7 3.4 1 4.9L12 14.1 7.6 16.5l1-4.9L4.9 8.2l5-.6z" />
  </svg>
);
const IconMcp: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M10 13a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 1 0-5.7-5.7L11.2 6.5" />
    <path d="M14 11a4 4 0 0 0-5.7-.4l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.4-1.4" />
  </svg>
);
const IconSession: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.9L3 20.5l1.6-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
  </svg>
);

/* connect 步内部子态: 先让用户选「订阅 vs BYOK」, 再进入对应分支 */
type ConnectMode = 'choose' | 'byok' | 'sub' | 'scan';

/* 出海双 channel: 订阅功能闸 — Vite build 时 define 注入 (见 vite.config.ui.ts).
 * 默认 'off' (NeoxCloud 订阅未就绪), 此时订阅卡片只显示「即将开放」+ 登录入口 (占位).
 * 后端 NeoxCloud 订阅链路 ready 后构建时设 VITE_NEOX_SUBSCRIPTION=on 即可亮全功能. */
declare const __NEOX_SUBSCRIPTION__: string | undefined;
const SUBSCRIPTION_BUILD_ON =
  typeof __NEOX_SUBSCRIPTION__ !== 'undefined'
    ? String(__NEOX_SUBSCRIPTION__).toLowerCase() === 'on'
    : false;

/* ── BYOK 三步走目录 (出海零账号 onboarding 核心) ───────────────────────────────
 * 用户路径: 品牌 → 协议(单协议品牌自动跳过) → API Key 表单.
 * 把 NeoxBYOK 支持的所有协议变体都铺出来:
 *   · OpenAI:    Chat Completions / Responses API
 *   · Anthropic: Messages 原生 / OpenAI 兼容层
 *   · Kimi:      Moonshot 原生 / Claude 风格 (kimi-claude)
 *   · GLM:       Zhipu 原生 / Claude 风格 (glm-claude)
 *   · 其它 (Gemini/DeepSeek/Qwen/Doubao/MiniMax/OpenRouter): 单协议直接进表单
 *   · OpenAI-compatible: 自填 baseUrl + model 透传 OpenAI 协议 (Azure/自建/三方代理) */
interface BrandProtocol {
  id: string;           // ProviderProtocol 枚举值 (openai / openai-responses / anthropic / ...)
  label: string;        // 用户可读名 (Chat Completions / Responses API / Messages (native) / ...)
  desc?: string;        // 一句话说明 (端点 / 适用场景)
  baseUrl: string;
  urlSuffix: string;
  defaultModel: string;
  recommended?: boolean;
  /* 模型下拉候选 — 配 <input list> + <datalist> 给用户既能选又能自定. defaultModel 应出现在首位. */
  models?: string[];
  /* 自定义服务商专用: 协议选择后,baseUrl 输入框的占位提示. */
  basePlaceholder?: string;
}

const BRAND_LOGO_ID: Record<string, string> = {
  qwen: 'dashscope',
  xai: 'grok',
};
const brandLogoId = (brandId: string): string => BRAND_LOGO_ID[brandId] ?? brandId;

/* 品牌分组 —— 海外档:聚合平台 / 官方厂商 / 自定义服务商, 国内档:官方厂商 / 自定义.
 *   hub      = 聚合平台 (OpenRouter), URL 固定, 一把 Key 通多家
 *   official = 厂商官方端点, URL 固定, Key only
 *   custom   = 自定义 Base URL + 模型, 用户全自填 (Azure / vLLM / AWS Bedrock 代理 / 三方) */
type BrandGroup = 'hub' | 'official' | 'custom';

type I18nText = { zh: string; en: string };
const tx = (s: I18nText | string | undefined, lang: 'zh' | 'en'): string => {
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s[lang] || s.en || s.zh || '';
};

interface Brand {
  id: string;           // 'openai' | 'anthropic' | 'openrouter' | ...
  /** 需要选区域的平台 (目前只有 Amazon Bedrock): baseUrl 里的 {region} 会被替换。
   *  第一个是默认区域。 */
  regions?: string[];
  /** 模型 ID 由用户自己填/拉 (平台的模型目录跟账号开通情况有关, 我们不内置猜)。 */
  modelRequired?: boolean;
  label: I18nText;      // 品牌显示名 (国际厂商通常 zh=en; cn 厂商如 "DeepSeek 深度求索" 才区分)
  tagline?: I18nText;   // 副标 (e.g. "GPT-5.5 · 5.4 · Codex" / 翻译版)
  keyUrl: string;       // 「获取 Key」跳转
  protocols: BrandProtocol[];
  group: BrandGroup;
  custom?: boolean;     // 自定义服务商 — 表单需多 baseUrl + model (== group === 'custom')
  recommended?: boolean;
}

/* 模型 tagline / 默认探活模型对齐 neox-core/src/models/registry 2026-06 版本.
 * onboarding 始终用 recommended 协议(不暴露协议选择), 高级用户去设置改.
 * models[] 用于表单的模型下拉候选 — 首项 = 默认/推荐. */
const GLOBAL_BRANDS: Brand[] = [
  // ── 聚合平台 (一把 Key 通多家) ─────────────────────────────────────────
  {
    id: 'openrouter',
    label: { zh: 'OpenRouter', en: 'OpenRouter' },
    tagline: { zh: '聚合 100+ 模型 · 一把 Key 通用', en: '100+ models · one key' },
    group: 'hub', keyUrl: 'https://openrouter.ai/keys', recommended: true,
    protocols: [{
      id: 'openai', label: 'Chat Completions',
      baseUrl: 'https://openrouter.ai/api/v1', urlSuffix: '/chat/completions',
      defaultModel: 'openai/gpt-5.4-mini', recommended: true,
      models: ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna',
               'openai/gpt-5.4-mini', 'openai/gpt-5.5', 'openai/gpt-5.4',
               'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.8', 'anthropic/claude-haiku-4.5',
               'google/gemini-3.5-flash', 'google/gemini-3.0-pro',
               'deepseek/deepseek-chat', 'x-ai/grok-2-1212', 'meta-llama/llama-3.3-70b-instruct'],
    }],
  },
  {
    id: 'together',
    label: { zh: 'Together AI', en: 'Together AI' },
    tagline: { zh: 'Llama · Mixtral · DeepSeek 开源托管', en: 'Llama · Mixtral · DeepSeek hosted' },
    group: 'hub', keyUrl: 'https://api.together.xyz/settings/api-keys',
    protocols: [{
      id: 'openai', label: 'Chat Completions',
      baseUrl: 'https://api.together.xyz/v1', urlSuffix: '/chat/completions',
      defaultModel: 'meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo', recommended: true,
      models: ['meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo',
               'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct-Turbo',
               'mistralai/Mistral-Large-2411', 'mistralai/Mixtral-8x22B-Instruct-v0.1'],
    }],
  },
  // ── 官方厂商 (原生协议, URL 固定, 只填 Key) ─────────────────────────────
  {
    /* Amazon Bedrock —— 走它的 **OpenAI 兼容端点**:
     *   https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions
     *   鉴权就是 Bedrock API key 当 bearer (AWS 官方文档 inference-chat-completions)。
     * 所以对我们来说它跟别的 OpenAI 兼容平台一样, 只多一个"选区域"。
     * 模型 ID 不内置: Bedrock 的可用模型跟账号开通的那些走, 让用户拉或手填。 */
    id: 'bedrock',
    label: { zh: 'Amazon Bedrock', en: 'Amazon Bedrock' },
    tagline: { zh: 'AWS · OpenAI 兼容端点 · 选区域', en: 'AWS · OpenAI-compatible · pick a region' },
    group: 'official', keyUrl: 'https://console.aws.amazon.com/bedrock/',
    regions: ['us-east-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'ap-northeast-1', 'ap-southeast-2'],
    modelRequired: true,
    protocols: [{
      id: 'openai', label: 'Chat Completions',
      baseUrl: 'https://bedrock-runtime.{region}.amazonaws.com/openai/v1',
      urlSuffix: '/chat/completions',
      defaultModel: '', recommended: true,
      models: [],
    }],
  },
  {
    id: 'openai',
    label: { zh: 'OpenAI', en: 'OpenAI' },
    tagline: { zh: 'GPT-5.6 · 5.5 · Codex', en: 'GPT-5.6 · 5.5 · Codex' },
    group: 'official', keyUrl: 'https://platform.openai.com/api-keys',
    protocols: [{
      id: 'openai', label: 'Chat Completions',
      baseUrl: 'https://api.openai.com/v1', urlSuffix: '/chat/completions',
      defaultModel: 'gpt-5.4-mini', recommended: true,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
               'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-nano',
               'gpt-5', 'gpt-5.1-codex', 'gpt-5.2-codex', 'gpt-5.3-codex'],
    }],
  },
  {
    id: 'anthropic',
    label: { zh: 'Anthropic', en: 'Anthropic' },
    tagline: { zh: 'Claude Opus 4.8 · Sonnet 4.6 · Haiku 4.5', en: 'Claude Opus 4.8 · Sonnet 4.6 · Haiku 4.5' },
    group: 'official', keyUrl: 'https://console.anthropic.com/settings/keys',
    protocols: [{
      id: 'anthropic', label: 'Messages (原生)',
      baseUrl: 'https://api.anthropic.com', urlSuffix: '/v1/messages',
      defaultModel: 'claude-sonnet-4-6', recommended: true,
      models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001',
               'claude-fable-5', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929'],
    }],
  },
  {
    id: 'gemini',
    label: { zh: 'Google Gemini', en: 'Google Gemini' },
    tagline: { zh: 'Gemini 3.5 Flash · 3.0 Pro', en: 'Gemini 3.5 Flash · 3.0 Pro' },
    group: 'official', keyUrl: 'https://aistudio.google.com/apikey',
    protocols: [{
      id: 'gemini', label: 'Generative Language',
      baseUrl: 'https://generativelanguage.googleapis.com', urlSuffix: '/v1beta/models',
      defaultModel: 'gemini-3.5-flash', recommended: true,
      models: ['gemini-3.5-flash', 'gemini-3.0-pro', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
    }],
  },
  {
    id: 'deepseek',
    label: { zh: 'DeepSeek', en: 'DeepSeek' },
    tagline: { zh: 'V4 Pro · V4 Flash · 性价比', en: 'V4 Pro · V4 Flash · cost-effective' },
    group: 'official', keyUrl: 'https://platform.deepseek.com/api_keys',
    protocols: [{
      id: 'deepseek', label: 'Chat',
      baseUrl: 'https://api.deepseek.com', urlSuffix: '/chat/completions',
      defaultModel: 'deepseek-flash', recommended: true,
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    }],
  },
  {
    id: 'xai',
    label: { zh: 'xAI · Grok', en: 'xAI · Grok' },
    tagline: { zh: 'Grok 2 · Vision', en: 'Grok 2 · Vision' },
    group: 'official', keyUrl: 'https://console.x.ai',
    protocols: [{
      id: 'openai', label: 'OpenAI 兼容',
      baseUrl: 'https://api.x.ai/v1', urlSuffix: '/chat/completions',
      defaultModel: 'grok-2-1212', recommended: true,
      models: ['grok-2-1212', 'grok-2-vision-1212', 'grok-beta'],
    }],
  },
  {
    id: 'mistral',
    label: { zh: 'Mistral', en: 'Mistral' },
    tagline: { zh: 'Large · Medium · Codestral', en: 'Large · Medium · Codestral' },
    group: 'official', keyUrl: 'https://console.mistral.ai/api-keys/',
    protocols: [{
      id: 'openai', label: 'OpenAI 兼容',
      baseUrl: 'https://api.mistral.ai/v1', urlSuffix: '/chat/completions',
      defaultModel: 'mistral-medium-latest', recommended: true,
      models: ['mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest',
               'codestral-latest', 'pixtral-large-latest'],
    }],
  },
  {
    id: 'groq',
    label: { zh: 'Groq', en: 'Groq' },
    tagline: { zh: 'Llama · 极速推理', en: 'Llama · ultra-fast inference' },
    group: 'official', keyUrl: 'https://console.groq.com/keys',
    protocols: [{
      id: 'openai', label: 'OpenAI 兼容',
      baseUrl: 'https://api.groq.com/openai/v1', urlSuffix: '/chat/completions',
      defaultModel: 'llama-3.3-70b-versatile', recommended: true,
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
               'mixtral-8x7b-32768', 'gemma2-9b-it'],
    }],
  },
  {
    id: 'perplexity',
    label: { zh: 'Perplexity', en: 'Perplexity' },
    tagline: { zh: 'Sonar · 联网搜索', en: 'Sonar · web search' },
    group: 'official', keyUrl: 'https://www.perplexity.ai/settings/api',
    protocols: [{
      id: 'openai', label: 'OpenAI 兼容',
      baseUrl: 'https://api.perplexity.ai', urlSuffix: '/chat/completions',
      defaultModel: 'sonar-medium-online', recommended: true,
      models: ['sonar-medium-online', 'sonar-large-online', 'sonar-small-online', 'sonar-pro'],
    }],
  },
  // ── 自定义服务商 (Base URL + 协议 + 模型 + Key 全自填) ──────────────────
  {
    id: 'custom',
    label: { zh: '自定义服务商', en: 'Custom provider' },
    tagline: { zh: 'Azure · vLLM · AWS Bedrock(经代理) · 三方端点', en: 'Azure · vLLM · AWS Bedrock (via proxy) · third-party' },
    group: 'custom', keyUrl: '', custom: true,
    protocols: [
      { id: 'openai',           label: 'OpenAI Chat Completions', desc: '/chat/completions — 最通用',
        baseUrl: '', urlSuffix: '/chat/completions', defaultModel: '', recommended: true,
        basePlaceholder: 'https://api.example.com/v1',
        models: ['gpt-5.4-mini', 'gpt-5.5', 'claude-sonnet-4-6', 'deepseek-chat', 'gemini-3.5-flash'] },
      { id: 'openai-responses', label: 'OpenAI Responses API', desc: '/responses — 新接口, 上游需支持',
        baseUrl: '', urlSuffix: '/responses', defaultModel: '',
        basePlaceholder: 'https://api.example.com/v1',
        models: ['gpt-5.4-mini', 'gpt-5.5'] },
      { id: 'anthropic',        label: 'Anthropic Messages', desc: '/v1/messages — Claude 原生',
        baseUrl: '', urlSuffix: '/v1/messages', defaultModel: '',
        basePlaceholder: 'https://api.example.com',
        models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'] },
    ],
  },
];

const CN_BRANDS: Brand[] = [
  // ── 官方厂商 ─────────────────────────────────────────────────────────────
  {
    id: 'deepseek',
    label: { zh: 'DeepSeek 深度求索', en: 'DeepSeek' },
    tagline: { zh: 'V4 Pro · Flash · 性价比', en: 'V4 Pro · Flash · cost-effective' },
    group: 'official', keyUrl: 'https://platform.deepseek.com/api_keys', recommended: true,
    protocols: [{
      id: 'deepseek', label: 'Chat',
      baseUrl: 'https://api.deepseek.com', urlSuffix: '/chat/completions',
      defaultModel: 'deepseek-flash', recommended: true,
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    }],
  },
  {
    id: 'kimi',
    label: { zh: 'Kimi 月之暗面', en: 'Kimi (Moonshot)' },
    tagline: { zh: 'K2.7 · K2.6 长上下文', en: 'K2.7 · K2.6 long context' },
    group: 'official', keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    protocols: [{
      id: 'kimi', label: 'Moonshot 原生',
      baseUrl: 'https://api.moonshot.cn/v1', urlSuffix: '/chat/completions',
      defaultModel: 'kimi-k2.6', recommended: true,
      models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2.7-code', 'kimi-k2-0905-preview'],
    }],
  },
  {
    id: 'glm',
    label: { zh: '智谱 GLM', en: 'Zhipu GLM' },
    tagline: { zh: 'GLM-5.2 · 5.1 · 多模态', en: 'GLM-5.2 · 5.1 · multimodal' },
    group: 'official', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    protocols: [{
      id: 'glm', label: 'Zhipu 原生',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', urlSuffix: '/chat/completions',
      defaultModel: 'glm-5.1', recommended: true,
      models: ['glm-5.1', 'glm-5.2', 'glm-5', 'glm-4.7', 'glm-4-flash'],
    }],
  },
  {
    id: 'qwen',
    label: { zh: '通义千问 Qwen', en: 'Qwen (Alibaba)' },
    tagline: { zh: 'Qwen 3.7 Max · Plus', en: 'Qwen 3.7 Max · Plus' },
    group: 'official', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    protocols: [{
      id: 'qwen', label: 'DashScope OpenAI 兼容',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', urlSuffix: '/chat/completions',
      defaultModel: 'qwen3.7-plus', recommended: true,
      models: ['qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-flash'],
    }],
  },
  {
    id: 'doubao',
    label: { zh: '豆包 Doubao', en: 'Doubao (ByteDance)' },
    tagline: { zh: '字节 · Seed 1.6', en: 'Seed 1.6 family' },
    group: 'official', keyUrl: 'https://console.volcengine.com/ark',
    protocols: [{
      id: 'doubao', label: 'Volc Ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', urlSuffix: '/chat/completions',
      defaultModel: 'doubao-seed-1-6-251015', recommended: true,
      models: ['doubao-seed-1-6-251015', 'doubao-seed-1-6-flash-250828'],
    }],
  },
  {
    id: 'minimax',
    label: { zh: 'MiniMax', en: 'MiniMax' },
    tagline: { zh: 'M3 · M2.7', en: 'M3 · M2.7' },
    group: 'official', keyUrl: 'https://platform.minimaxi.com/',
    protocols: [{
      id: 'minimax', label: 'Chat',
      baseUrl: 'https://api.minimax.chat/v1', urlSuffix: '/chat/completions',
      defaultModel: 'MiniMax-M3', recommended: true,
      models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
    }],
  },
  // ── 自定义 (含协议选择) ────────────────────────────────────────────────
  {
    id: 'custom',
    label: { zh: '自定义服务商', en: 'Custom provider' },
    tagline: { zh: '自建 · 代理 · 三方端点', en: 'Self-hosted · proxy · third-party' },
    group: 'custom', keyUrl: '', custom: true,
    protocols: [
      { id: 'openai', label: 'OpenAI Chat Completions', desc: '/chat/completions — 最通用',
        baseUrl: '', urlSuffix: '/chat/completions', defaultModel: '', recommended: true,
        basePlaceholder: 'https://api.example.com/v1',
        models: ['deepseek-chat', 'gpt-5.4-mini', 'kimi-k2.6', 'glm-5.1', 'claude-sonnet-4-6'] },
      { id: 'anthropic', label: 'Anthropic Messages', desc: '/v1/messages — Claude 原生',
        baseUrl: '', urlSuffix: '/v1/messages', defaultModel: '',
        basePlaceholder: 'https://api.example.com',
        models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'] },
    ],
  },
];

/* ── 定制图标 (出海 P1 — 替换 AI 通用 Sparkles/Key) ──
 * 设计原则: 单色 currentColor 跟随主题, 细描边几何感, 不靠装饰. */

const IconModelCatalog: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <rect x="4" y="5" width="16" height="4.2" rx="1.6" />
    <rect x="4" y="11" width="16" height="4.2" rx="1.6" />
    <rect x="4" y="17" width="10.5" height="2.8" rx="1.4" />
    <path d="M16.6 18.4h3.4" />
  </svg>
);

const IconDeviceSync: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <rect x="3.8" y="6.4" width="10.8" height="8.2" rx="1.8" />
    <path d="M6.8 17h7.8" />
    <rect x="16.6" y="9.2" width="3.6" height="8.4" rx="1.2" />
    <path d="M16.2 5.5c1.9.3 3.4 1.3 4.2 2.7" />
    <path d="M7.8 18.9c-1.9-.3-3.4-1.3-4.2-2.7" />
  </svg>
);

const IconUsageControl: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <path d="M5 18V8" />
    <path d="M12 18V5" />
    <path d="M19 18v-7" />
    <rect x="3.5" y="10.2" width="3" height="3" rx="1" />
    <rect x="10.5" y="13.2" width="3" height="3" rx="1" />
    <rect x="17.5" y="7.2" width="3" height="3" rx="1" />
  </svg>
);

/* ── 定制下拉 combobox (模型选择用; 替换浏览器原生 <datalist>, 跨平台样式不一致难看) ──
 * 行为: 输入即过滤、↑↓ 选项、Enter 确认、ESC 关闭、外点关闭、ChevronDown 按钮显式打开. */
interface ModelComboboxProps {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}
const ModelCombobox: React.FC<ModelComboboxProps> = ({ value, onChange, options, placeholder }) => {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 外点关闭
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  /* 过滤: 只有在"用户正在打字"时才过滤。当前值刚好等于某个候选 (比如刚拉完列表
   * 自动选中了第一个) 时不过滤 —— 否则点开下拉只看得到跟它同前缀的那几条,
   * 用户会以为"只拉到了 2 个模型"。 */
  const v = value.trim().toLowerCase();
  const exact = options.some(o => o.toLowerCase() === v);
  const filtered = (!v || exact) ? options : options.filter(o => o.toLowerCase().includes(v));

  // 高亮项滚到可视区
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-i="${highlighted}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, open]);

  return (
    <div className="connect-combo" ref={wrapRef}>
      <input
        className="connect-input connect-combo-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlighted(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) { setOpen(true); return; }
            setHighlighted(h => Math.min(h + 1, Math.max(0, filtered.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlighted(h => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            if (open && filtered[highlighted]) {
              e.preventDefault();
              onChange(filtered[highlighted]);
              setOpen(false);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className={`connect-combo-toggle ${open ? 'open' : ''}`}
        onClick={() => setOpen(o => !o)}
        tabIndex={-1}
        aria-label="toggle options"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && filtered.length > 0 && (
        <div className="connect-combo-list" ref={listRef} role="listbox">
          {filtered.map((opt, i) => (
            <div
              key={opt}
              data-i={i}
              role="option"
              aria-selected={i === highlighted}
              className={`connect-combo-opt ${i === highlighted ? 'highlight' : ''} ${opt === value ? 'selected' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onChange(opt); setOpen(false); }}
              onMouseEnter={() => setHighlighted(i)}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const IconBYOK: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
    <path d="M8 4.8 L12 2.6 L16 4.8 L16 9.2 L12 11.4 L8 9.2 Z" />
    <circle cx="12" cy="7" r="1.4" fill="currentColor" stroke="none" />
    <path d="M12 11.4 L12 21.4" />
    <path d="M12 17.6 L15 17.6" />
    <path d="M12 20 L14 20" />
  </svg>
);

/* 从本机导入: 取景框 —— 跟设置页那张卡用的是同一个图形 */
const IconScan: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 12h10" />
  </svg>
);

const OnboardingPage: React.FC<OnboardingPageProps> = ({ onComplete, onOpenSettings, initialStep, connectOnly, onCancel }) => {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(connectOnly ? 'connect' : (initialStep ?? 'theme'));
  /* ── 迁移这一屏 ──────────────────────────────────────────────
   * 只在**真扫到东西**时才插进流程。新用户机器上什么都没有, 不该看到一屏空的
   * (同理: 已经全导过一遍的老用户也不该再被问一次)。 */
  const [migrateScan, setMigrateScan] = useState<MigrateScanShape | null>(null);
  const [migratePicked, setMigratePicked] = useState<Set<string>>(new Set());
  const [migrateWithEnv, setMigrateWithEnv] = useState(false);
  const [migrateBusy, setMigrateBusy] = useState(false);
  /* 扫过没有 (不是"扫到了什么") —— 空态和未扫态要分得开 */
  const [migrateScanned, setMigrateScanned] = useState(false);
  const [migrateProbe, setMigrateProbe] = useState(0);
  const [migrateFilter, setMigrateFilter] = useState<Record<string, string | null>>({});
  /* 哪一列的筛选菜单开着 (null = 都没开) + 每列的搜索词 */
  const [migrateMenu, setMigrateMenu] = useState<string | null>(null);
  const [migrateQuery, setMigrateQuery] = useState<Record<string, string>>({});
  const [migrateScrollTop, setMigrateScrollTop] = useState<Record<string, number>>({});
  /* 点菜单外面就关 —— 不然它会一直挂在那儿挡住下面的行 */
  useEffect(() => {
    if (!migrateMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.migrate-col__filterwrap')) return;
      setMigrateMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [migrateMenu]);

  const [migrateDone, setMigrateDone] = useState<{ imported: number; failed: number; envStripped: string[]; sessions: number } | null>(null);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);
  const {
    darkMode,
    darkModePreference,
    colorTheme,
    accentExplicit,
    resetColorTheme,
    themePreset,
    themePackId,
    setDarkModePreference,
    setColorTheme,
    setThemePack,
  } = useAppStore();
  const { language, changeLanguage, t } = useI18n();
  const zh = language === 'zh';

  /* 给上面那个只跑一次的 effect 读"此刻在第几屏" —— 不能进 deps, 否则扫描会重跑 */
  const currentStepRef = useRef<OnboardingStep>(currentStep);
  currentStepRef.current = currentStep;

  const [selectedAgentMode, setSelectedAgentMode] = useState<'work' | 'code'>('code');
  const [readyAtStart, setReadyAtStart] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void canSkipWelcome()
      .then((ok) => { if (!cancelled) setReadyAtStart(ok); })
      .catch(() => { /* 查不到就照常问 */ });
    return () => { cancelled = true; };
  }, []);
  const steps: OnboardingStep[] = useMemo(() => {
    if (connectOnly) return ['connect'];
    const seq: OnboardingStep[] = selectedAgentMode === 'work'
      ? ['theme', 'mode', 'connect', 'mobile']
      : ['theme', 'mode', 'migrate', 'connect', 'mobile'];
    /* 手机端那一屏推的是我们的 APK —— 只属于有账号体系的发行版 (开源版不出) */
    const withMobile = getEditionHook('hasAccount') ? seq : seq.filter((s) => s !== 'mobile');
    /* 人正停在 connect 时它必须还在序列里 (readyAtStart 是异步判出来的) */
    return readyAtStart && currentStep !== 'connect' ? withMobile.filter((s) => s !== 'connect') : withMobile;
  }, [selectedAgentMode, readyAtStart, currentStep, connectOnly]);
  const currentIndex = steps.indexOf(currentStep);
  const isLastStep = currentIndex === steps.length - 1;

  const runMigrateScan = useCallback(async () => {
    const api = (window as any).neox;
    if (typeof api?.migrateScan !== 'function') { setMigrateScan(null); setMigrateScanned(true); return; }
    setMigrateBusy(true);
    setMigrateProbe(0);
    const tick = window.setInterval(() => setMigrateProbe((n) => n + 1), 220);
    const startedAt = Date.now();
    try {
      const r: MigrateScanShape | null = await api.migrateScan();
      setMigrateScan(r);
      /* 默认勾上还没导过的技能和 MCP —— 用户来这一屏就是为了搬。
       * 会话是例外, 默认不勾: 一个会话可能几十 MB, 搬历史对话是"顺手可以"不是"默认应该"。 */
      if (r) {
        setMigratePicked(new Set([
          ...r.skills.filter((x) => !x.alreadyImported).map((x) => `skill:${x.path}`),
          ...r.mcp.filter((x) => !x.alreadyImported).map((x) => `mcp:${x.id}`),
        ]));
      }
    } catch {
      setMigrateScan(null);
    } finally {
      /* 计时器跟 busy 同时收 —— 在 finally 里立刻清会让进度停在第一条 (见 scanShell) */
      window.setTimeout(() => {
        window.clearInterval(tick);
        setMigrateBusy(false);
        setMigrateScanned(true);
      }, scanPacing(MIGRATE_SOURCES, startedAt));
    }
  }, []);

  /* Windows: 引导页无 .neox-topbar — mount / 换主题 / 换步时主动同步 caption overlay */
  useEffect(() => {
    syncWinTitleBar();
    const t = window.setTimeout(() => syncWinTitleBar(), 100);
    return () => clearTimeout(t);
  }, [currentStep, darkMode, darkModePreference, themePackId, colorTheme]);

  const goNextRef = useRef<(() => void) | null>(null);
  /* handleComplete 声明在下面, 用 ref 桥过来: 最后一步的主按钮 = 完成 */
  const handleCompleteRef = useRef<(() => void) | null>(null);
  const goNext = useCallback(() => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < steps.length) {
      setCurrentStep(steps[nextIndex]);
    } else {
      handleCompleteRef.current?.();
    }
  }, [currentIndex, steps]);

  goNextRef.current = goNext;

  /* goPrev — 在下方 connect 状态声明之后再实现 (依赖 connectMode/byokSubMode).
   * 这里只占位声明类型, 后面用 ref 桥接给顶部 nav 按钮调用. */

  /* 回车推进 —— 只在"这一屏没有非选不可的东西"时接管:
   *   外观 / 用途 两屏都有默认值, 回车 = 按现在这样继续;
   *   欢迎屏回车 = 开始使用。
   * 接入模型那屏**不接管**: 那里要么选服务商要么明确「稍后再说」, 回车替用户
   * 挑一个只会让人莫名其妙 (表单里的回车由输入框自己处理, 见 onKeyDown)。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || el?.isContentEditable) return;
      if (currentStep === 'theme' || currentStep === 'mode' || currentStep === 'mobile') { e.preventDefault(); goNextRef.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentStep]);

  const handleComplete = useCallback(() => {
    setIsAnimatingOut(true);
    setTimeout(() => {
      onComplete();
    }, 600);
  }, [onComplete]);
  handleCompleteRef.current = handleComplete;

  /* 只接模型模式的退出: 不是"完成", 是"先不接了" —— 淡出后交还调用方 */
  const handleCancel = useCallback(() => {
    setIsAnimatingOut(true);
    setTimeout(() => { (onCancel ?? onComplete)(); }, 200);
  }, [onCancel, onComplete]);

  /* 接上模型之后去哪: 完整引导往下走一步; 只接模型模式到这就结束了 */
  const finishConnect = useCallback(() => {
    if (connectOnly) handleComplete(); else goNext();
  }, [connectOnly, handleComplete, goNext]);

  const handleLanguageSelect = (lang: Language) => {
    changeLanguage(lang);
  };

  /* 没有账号体系的构建里「选择使用方式」只有 BYOK 一张卡 —— 那一屏就是多点一下, 直接落服务商列表 */
  const rootConnectMode: ConnectMode = connectOnly === 'byok' || !getEditionHook('hasAccount') ? 'byok' : 'choose';
  const [connectMode, setConnectMode] = useState<ConnectMode>(rootConnectMode);
  const [byokSubMode, setByokSubMode] = useState<'brand' | 'form'>('brand');
  /* Key 默认遮住, 但粘贴进来的东西得能看一眼 —— 多了空格 / 粘成了别家的 Key, 遮着永远查不出来 */
  const [showKey, setShowKey] = useState(false);
  const [profileChips, setProfileChips] = useState<Set<string>>(new Set());
  const [showLogin, setShowLogin] = useState(false);
  /* 浮层模式 Esc 关闭 (下拉面板开着时它们在捕获阶段先吃掉 Esc, 到不了这里) */
  useEffect(() => {
    if (!connectOnly || showLogin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      handleCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connectOnly, showLogin, handleCancel]);
  const hasAccount = getEditionHook('hasAccount'); /* 订阅入口 (含"登录占位"小字) 只属于有账号体系的发行版 */
  const SUBSCRIPTION_AVAILABLE = SUBSCRIPTION_BUILD_ON && hasAccount;
  const brands = language === 'zh' ? CN_BRANDS : GLOBAL_BRANDS;
  const [selectedBrand, setSelectedBrand] = useState<Brand | null>(null);
  const [brandQuery, setBrandQuery] = useState('');

  const byokGroupsRef = useRef<HTMLDivElement>(null);
  const [byokScrollable, setByokScrollable] = useState(false);
  useEffect(() => {
    const el = byokGroupsRef.current;
    if (!el) { setByokScrollable(false); return; }
    const check = () => setByokScrollable(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [connectMode, byokSubMode, brandQuery]);
  const [searchOpen, setSearchOpen] = useState(false);
  const brandSearchRef = useRef<HTMLInputElement | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<BrandProtocol | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  /* 选区域的平台 (Bedrock) 用它把 baseUrl 里的 {region} 换掉 */
  const [region, setRegion] = useState('');
  const [regionOpen, setRegionOpen] = useState(false);
  const regionSelectRef = useRef<HTMLDivElement | null>(null);
  const [modelName, setModelName] = useState(''); // 统一模型名 — 平台用候选下拉, custom 用户自填
  /* 'fetching-models' = 探活已过, 正在拉服务商模型目录 (见 fetchCatalogModels) —— 单列一态
   * 是因为它慢 (最多 15s/请求), 沿用「验证中…」会让人以为 Key 还没通。 */
  const [connectStatus, setConnectStatus] = useState<'idle' | 'verifying' | 'fetching-models' | 'ok' | 'tested' | 'error'>('idle');
  /* 这一屏拉到的模型目录 —— 拉过就用它当下拉候选 (而不是我们内置的那份静态清单),
   * 保存时也直接用, 不必再拉一遍。 */
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [pickedModels, setPickedModels] = useState<Set<string>>(new Set());
  const [modelsOpen, setModelsOpen] = useState(false);
  /* 面板里手填的模型名 (自定义服务商 / 目录里没有的新模型) + 搜索词 */
  const [typedModels, setTypedModels] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const modelSelectRef = useRef<HTMLDivElement | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [connectError, setConnectError] = useState('');

  /* 没有账号体系的构建只能接自带 Key: 主界面的门禁没有模型进不去, 这颗按钮实际是回上一步,
   * 写「稍后再说」用户会以为能先进去看看, 点了又被送回来。 */
  const skipLabel = connectOnly && !hasAccount
    ? (zh ? '返回' : 'Back')
    : (zh ? '稍后再说' : 'Skip for now');
  const skipConnect = useCallback(() => {
    if (connectOnly) { handleCancel(); return; }
    void canSkipWelcome()
      .catch(() => true)
      .then((ready) => { if (ready) goNext(); else handleComplete(); });
  }, [connectOnly, handleCancel, goNext, handleComplete]);

  /* 选品牌: 自动选 recommended 协议 → 直跳 form. 模型预填 protocol.defaultModel. */
  const pickBrand = (brand: Brand) => {
    setSelectedBrand(brand);
    setConnectStatus('idle'); setConnectError('');
    setRemoteModels([]); setModelsError('');
    setTypedModels([]); setModelQuery(''); setModelsOpen(false);
    setRegion(brand.regions?.[0] ?? ''); setRegionOpen(false);
    setShowKey(false);
    const recommended = brand.protocols.find(p => p.recommended) ?? brand.protocols[0];
    setSelectedProtocol(recommended);
    setModelName(recommended.defaultModel);
    /* 内置候选是我们写死的清单, 不保证这把 Key 都有 —— 先只勾推荐那一个;
     * 真拉到目录之后才全勾 (见 handleFetchModels)。默认模型必须始终在勾选里,
     * 否则"默认"徽标会挂在一个根本没装进来的模型上。 */
    setPickedModels(new Set([recommended.defaultModel].filter(Boolean)));
    if (brand.custom) { setCustomBaseUrl(''); }
    setByokSubMode('form');
  };

  /* 自定义服务商: 切换协议时, 自动重置模型 (新协议的 defaultModel) + 状态 */
  const switchCustomProtocol = (proto: BrandProtocol) => {
    setSelectedProtocol(proto);
    setModelName(proto.defaultModel);
    setPickedModels(new Set([proto.defaultModel].filter(Boolean)));
    setRemoteModels([]); setTypedModels([]); setModelQuery('');
    setConnectStatus('idle'); setConnectError('');
  };

  const goPrev = useCallback(() => {
    if (showLogin) { setShowLogin(false); return; }
    if (currentStep === 'connect') {
      setSearchOpen(false); setBrandQuery('');
      if (connectMode === 'byok' && byokSubMode === 'form') {
        setByokSubMode('brand');
        setSelectedBrand(null); setSelectedProtocol(null);
        return;
      }
      if (connectMode === 'scan') {
        setConnectMode('byok'); setByokSubMode('brand');
        return;
      }
      if (connectMode !== rootConnectMode && (connectMode === 'byok' || connectMode === 'sub')) {
        setConnectMode(rootConnectMode);
        return;
      }
    }
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) setCurrentStep(steps[prevIndex]);
    else if (connectOnly) handleCancel();
  }, [currentIndex, steps, currentStep, connectMode, byokSubMode, showLogin, rootConnectMode, connectOnly, handleCancel]);

  const resolveBaseUrl = useCallback((brand: Brand | null, proto: BrandProtocol | null): string => {
    if (!brand || !proto) return '';
    if (brand.custom) return customBaseUrl.trim();
    const r = region || brand.regions?.[0] || '';
    return proto.baseUrl.replace('{region}', r);
  }, [customBaseUrl, region]);

  /* 探测失败 → 一句能照着做的话。httpStatus 优先 (共享 httpStatusHint, 跟设置页同一套口径),
   * 没有状态码就是连都没连上 —— 那多半是网络/代理/域名, 单独说。 */
  const probeFailureMessage = useCallback((result: { httpStatus?: number; errorMessage?: string } | null | undefined): string => {
    const hint = httpStatusHint(result?.httpStatus, zh);
    if (hint) return hint;
    const raw = (result?.errorMessage || '').trim();
    if (/timeout|timed out|ETIMEDOUT|ECONNABORTED/i.test(raw)) {
      return zh ? '连接超时 — 网络或代理不通' : 'Timed out — network or proxy is blocked';
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|certificate|self.signed/i.test(raw)) {
      return zh ? '连不上服务商 — 检查网络 / 代理 / Base URL' : "Can't reach the provider — check network / proxy / Base URL";
    }
    if (raw) return raw.slice(0, 160);
    return zh ? '连接失败 — 检查 Key 与网络' : 'Connection failed — check the key and your network';
  }, [zh]);

  /* 共享: 只跑探活, 不落库. 返回 {ok, message}. */
  const runProbe = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    if (!selectedBrand || !selectedProtocol) return { ok: false, message: 'no provider' };
    const key = apiKey.trim();
    const baseUrl = resolveBaseUrl(selectedBrand, selectedProtocol);
    const model = modelName.trim() || selectedProtocol.defaultModel;
    if (!key) return { ok: false, message: zh ? '请粘贴 API Key' : 'Paste your API key' };
    if (selectedBrand.custom && (!baseUrl || !model)) {
      return { ok: false, message: zh ? '自建需填 Base URL 和模型名' : 'Custom needs Base URL and model' };
    }
    const api = (window as any).neox;
    try {
      const result = await api.checkProviderHealth({
        providerId: 'onboarding-probe',
        protocol: selectedProtocol.id,
        baseUrl, urlSuffix: selectedProtocol.urlSuffix, apiKey: key, model,
      });
      if (result?.status === 'offline' || result?.status === 'error') {
        /* 说清楚**到底哪儿不对**。
         *   探测早就把 httpStatus / errorMessage 一起返回了 (providerHealthCheck 里
         *   还专门注了"UI 侧会用 httpStatus 翻成一句人话"), 设置页的两处也确实在用
         *   共享的 httpStatusHint —— 只有引导页把它们全扔了, 一律回一句
         *   "连接失败 — 检查 Key / Base URL / 模型名 / 网络"。
         *   而这是新用户能不能用上这个软件的**唯一**一道关卡: 401(Key 打错)、
         *   402(没余额)、404(模型名不对)、超时(要走代理) 的处置办法完全不同。 */
        return { ok: false, message: probeFailureMessage(result) };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, message: probeFailureMessage({ errorMessage: err?.message }) };
    }
  }, [selectedBrand, selectedProtocol, apiKey, customBaseUrl, modelName, zh, resolveBaseUrl, probeFailureMessage]);

  useEffect(() => {
    if (!modelsOpen && !regionOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modelsOpen && modelSelectRef.current && !modelSelectRef.current.contains(t)) setModelsOpen(false);
      if (regionOpen && regionSelectRef.current && !regionSelectRef.current.contains(t)) setRegionOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setModelsOpen(false); setRegionOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [modelsOpen, regionOpen]);

  /* 仅测试连接 —— 不落库, 给一个绿勾。用户可以反复试错。 */
  const handleTest = useCallback(async () => {
    setConnectStatus('verifying'); setConnectError('');
    const r = await runProbe();
    if (r.ok) setConnectStatus('tested');
    else { setConnectStatus('error'); setConnectError(r.message || ''); }
  }, [runProbe]);

  /* 手动拉模型列表 —— 跟设置页「自动获取模型」同一个 IPC。
   * 拉到之后: 下拉候选换成真目录; 当前模型如果不在目录里, 换成目录第一个
   * (免得用户带着一个这把 Key 根本没有的模型名进主界面)。 */
  const handleFetchModels = useCallback(async () => {
    if (!selectedBrand || !selectedProtocol) return;
    const key = apiKey.trim();
    const baseUrl = resolveBaseUrl(selectedBrand, selectedProtocol);
    if (!key) { setModelsError(zh ? '先填 API Key' : 'Enter the API key first'); return; }
    setModelsLoading(true); setModelsError('');
    try {
      const api = (window as any).neox;
      const result = await api?.fetchProviderModels?.({
        protocol: selectedProtocol.id,
        baseUrl: baseUrl || undefined,
        urlSuffix: selectedProtocol.urlSuffix,
        apiKey: key,
      });
      const models: string[] = Array.isArray(result?.models)
        ? result.models.map((m: unknown) => String(m || '').trim()).filter(Boolean)
        : [];
      if (models.length === 0) {
        setRemoteModels([]); setPickedModels(new Set());
        setModelsError(result?.error
          ? probeFailureMessage({ errorMessage: result.error })
          : (zh ? '这个服务商没返回模型列表 — 手填模型名也能用' : 'No model list from this provider — typing the model name works too'));
        return;
      }
      setRemoteModels(models);
      setPickedModels(new Set(models));
      setModelsOpen(true);
      const current = modelName.trim().toLowerCase();
      if (!current || !models.some(m => m.toLowerCase() === current)) {
        setModelName(models[0]);
      }
      setConnectStatus('idle');
    } catch (err: any) {
      setRemoteModels([]); setPickedModels(new Set());
      setModelsError(probeFailureMessage({ errorMessage: err?.message }));
    } finally {
      setModelsLoading(false);
    }
  }, [selectedBrand, selectedProtocol, apiKey, customBaseUrl, modelName, zh, probeFailureMessage, resolveBaseUrl]);

  const fetchCatalogModels = useCallback(async (
    protocol: BrandProtocol,
    baseUrl: string,
    key: string,
    fallbackModel: string,
  ): Promise<string[]> => {
    const api = (window as any).neox;
    try {
      const result = await api?.fetchProviderModels?.({
        protocol: protocol.id,
        baseUrl: baseUrl || undefined,
        urlSuffix: protocol.urlSuffix,
        apiKey: key,
      });
      const fetched: string[] = Array.isArray(result?.models) ? result.models : [];
      /* 用户选中的那个模型必须排第一 —— providerStore 拿 models[0] 当
       * defaultModel 的兜底, 顺序错了默认模型就换人了。 */
      const seen = new Set([fallbackModel.toLowerCase()]);
      const merged = [fallbackModel];
      for (const m of fetched) {
        const id = String(m || '').trim();
        if (!id || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        merged.push(id);
      }
      return merged;
    } catch {
      return [fallbackModel];
    }
  }, []);

  /* 验证 + 保存 + 进欢迎页 (一键完成) */
  const handleVerifyAndContinue = useCallback(async () => {
    /* 刚点过「测试连接」且之后什么都没改 ('tested' 会被任何改动清掉) —— 不再探一遍,
     * 否则用户在同一把 Key 上连等两次, 慢的服务商一次就是好几秒。 */
    const alreadyTested = connectStatus === 'tested';
    setConnectStatus('verifying'); setConnectError('');
    const r = alreadyTested ? { ok: true as const, message: undefined } : await runProbe();
    if (!r.ok) {
      setConnectStatus('error'); setConnectError(r.message || '');
      return;
    }
    if (!selectedBrand || !selectedProtocol) return;
    const baseUrl = resolveBaseUrl(selectedBrand, selectedProtocol);
    const model = modelName.trim() || selectedProtocol.defaultModel;
    const api = (window as any).neox;
    try {
      /* 已经在这一屏手动拉过目录就直接用, 不再多打一次接口。 */
      let models: string[];
      if (remoteModels.length > 0) {
        /* 只存用户勾选的那些, 默认模型 (model) 永远排第一。 */
        const picked = remoteModels.filter(m => pickedModels.has(m));
        const seen = new Set([model.toLowerCase()]);
        models = [model, ...picked.filter(m => !seen.has(m.toLowerCase()) && seen.add(m.toLowerCase()))];
      } else {
        setConnectStatus('fetching-models');
        models = await fetchCatalogModels(selectedProtocol, baseUrl, apiKey.trim(), model);
      }
      const created = await api.addProvider({
        name: tx(selectedBrand.label, language),
        protocol: selectedProtocol.id,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl || undefined,
        urlSuffix: selectedProtocol.urlSuffix,
        models,
        defaultModel: model,
        setAsDefault: true,
      });
      if (created?.id) setByokPinned(created.id, true);
      setConnectStatus('ok');
      try { window.dispatchEvent(new CustomEvent('neox-providers-changed')); } catch { /* noop */ }
      setTimeout(() => finishConnect(), 700);
    } catch (err: any) {
      setConnectStatus('error'); setConnectError(err?.message || (zh ? '保存失败' : 'Save failed'));
    }
  }, [connectStatus, runProbe, selectedBrand, selectedProtocol, apiKey, customBaseUrl, modelName, zh, finishConnect, fetchCatalogModels, language, remoteModels, pickedModels, resolveBaseUrl]);

  useEffect(() => {
    setConnectStatus((s) => (s === 'tested' ? 'idle' : s));
  }, [modelName, region, customBaseUrl, selectedProtocol]);

  const openKeyUrl = (url: string) => {
    if (!url) return;
    try { (window as any).neox?.openExternal?.(url); } catch { /* noop */ }
  };

  const handleThemeSelect = (pref: DarkModePreference) => {
    setDarkModePreference(pref);
  };

  const handleThemePackSelect = (id: string) => {
    setThemePack(id);
  };

  const handleColorThemeSelect = (theme: ColorTheme) => {
    setColorTheme(theme);
  };

  const renderStepIndicator = () => (
    <div className="onboarding-step-indicator" data-tauri-drag-region>
      {steps.map((step, index) => (
        <div
          key={step}
          className={`step-dot ${index === currentIndex ? 'active' : ''} ${index < currentIndex ? 'completed' : ''}`}
        />
      ))}
      <span className="onboarding-step-indicator__count" aria-live="polite">
        {currentIndex + 1} / {steps.length}
      </span>
    </div>
  );

  /* 主题横向轨道 —— 箭头翻页 + 两端到头禁用。
   * canPrev/canNext 必须真量 scrollLeft, 不能靠"当前是第几页"猜:
   * 用户也可以用触控板横滑, 页码会跟真实位置脱节。 */
  const themeRailRef = useRef<HTMLDivElement | null>(null);
  const [themeRail, setThemeRail] = useState<{ canPrev: boolean; canNext: boolean; page: number; pages: number }>(
    { canPrev: false, canNext: true, page: 1, pages: 1 },
  );

  const syncThemeRail = useCallback(() => {
    const el = themeRailRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const pages = Math.max(1, Math.ceil(el.scrollWidth / Math.max(1, el.clientWidth)));
    setThemeRail({
      canPrev: el.scrollLeft > 4,
      canNext: el.scrollLeft < max - 4,
      page: Math.min(pages, Math.round(el.scrollLeft / Math.max(1, el.clientWidth)) + 1),
      pages,
    });
  }, []);

  const scrollThemeRail = useCallback((dir: 1 | -1) => {
    const el = themeRailRef.current;
    if (!el) return;
    /* 翻一整屏 (= 4 张卡 + 间距), 不是"一张一张挪" —— 一屏一屏才数得清看到哪了。 */
    el.scrollBy({ left: dir * el.clientWidth, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (currentStep !== 'theme') return;
    const id = window.setTimeout(syncThemeRail, 60);
    window.addEventListener('resize', syncThemeRail);
    return () => { window.clearTimeout(id); window.removeEventListener('resize', syncThemeRail); };
  }, [currentStep, syncThemeRail]);

  // 渲染真实主题包预览：使用 ThemePack 的 wallpaper / tokens / swatch，不再用旧的 4 张假代码卡。
  const renderThemePreview = (pack: ThemePack, isSelected: boolean) => {
    const isLight = pack.mode === 'light';
    const primary = pack.tokens?.primary600 ?? pack.swatch[2];
    const panel = pack.tokens?.bgCard ?? pack.swatch[1];
    // Onboarding 同屏会出现很多主题卡；如果每张都直接使用 wallpaper url，会在首次进入时并发加载大量图片。
    // 预览卡使用 pack swatch 生成轻量真实色调，当前页面背景仍使用真实 wallpaper。
    const previewGradient = `linear-gradient(135deg, ${pack.swatch[0]} 0%, ${pack.swatch[1]} 56%, ${pack.swatch[2]} 100%)`;
    return (
      <div
        className={`theme-preview-card theme-preview-card--pack ${isSelected ? 'selected' : ''}`}
        style={{
          '--preview-wallpaper': previewGradient,
          '--preview-bg': pack.swatch[0],
          '--preview-panel': panel,
          '--preview-accent': primary,
          '--preview-line-num': isLight ? 'rgba(38,43,56,.46)' : 'rgba(220,228,240,.42)',
        } as React.CSSProperties}
      >
        <div className="theme-preview-glass" aria-hidden="true">
          <span className="theme-preview-sidebar-mini" />
          <span className="theme-preview-card-mini a" />
          <span className="theme-preview-card-mini b" />
          <span className="theme-preview-card-mini c" />
          <span className="theme-preview-card-mini d" />
          <span className="theme-preview-pill-mini" />
        </div>
      </div>
    );
  };

  const titleWithMark = (text: string) => (
    <h2 className="step-title-with-mark">
      <img
        className="step-title-mark"
        src={brandLogoUrl(themePreset)}
        onError={onBrandImgError('logo')}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <span>{text}</span>
    </h2>
  );

  const renderThemeStep = () => (
    <div className="onboarding-step appearance-step">
      <div className="step-header">
        {/* 副标题全删。这一屏三个分组标题 (语言/布局/主题) 已经把内容说完了,
          * 再写一行"语言、布局、主题 — 随时可以在设置里改"就是复述 + 废话。
          * 标题也去掉文艺腔, 就叫它是什么。 */}
        {titleWithMark(language === 'zh' ? '外观' : 'Appearance')}
      </div>

      <div className="appearance-section">
        <h3>{language === 'zh' ? '语言' : 'Language'}</h3>
        {/* 按钮复用布局卡的 .layout-option —— 这一步的卡片观感被后面好几代样式反复改过
          * (玻璃底/边框/选中态), 自己另起一套必然跟旁边两排脱节: 第一版我照抄了那套
          * 早已被覆盖掉的 --glass-bg 配方, 未选中的按钮直接渲成了黑底。 */}
        <div className="lang-switch" role="group" aria-label={language === 'zh' ? '界面语言' : 'Interface language'}>
          {(['zh', 'en'] as Language[]).map((lang) => (
            <button
              key={lang}
              type="button"
              className={`layout-option lang-switch__btn${language === lang ? ' selected' : ''}`}
              aria-pressed={language === lang}
              onClick={() => handleLanguageSelect(lang)}
            >
              <span className="lang-switch__flag" aria-hidden="true">{lang === 'zh' ? '🇨🇳' : '🇺🇸'}</span>
              {lang === 'zh' ? '简体中文' : 'English'}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-section appearance-section--themes">
        <div className="appearance-section__head">
          <h3>{language === 'zh' ? '主题' : 'Theme'}</h3>
          <div className="theme-rail-nav">
            <button
              type="button"
              className="theme-rail-arrow"
              onClick={() => scrollThemeRail(-1)}
              disabled={!themeRail.canPrev}
              title={language === 'zh' ? '上一组' : 'Previous'}
              aria-label={language === 'zh' ? '上一组主题' : 'Previous themes'}
            >
              <Icons.ChevronLeft />
            </button>
            {/* 页码而不是总数: 光写个 20 只说明"有 20 张", 说不清"我翻到哪了"。 */}
            <span className="theme-rail-count">{themeRail.page} / {themeRail.pages}</span>
            <button
              type="button"
              className="theme-rail-arrow"
              onClick={() => scrollThemeRail(1)}
              disabled={!themeRail.canNext}
              title={language === 'zh' ? '下一组' : 'Next'}
              aria-label={language === 'zh' ? '下一组主题' : 'More themes'}
            >
              <Icons.ChevronRight />
            </button>
          </div>
        </div>
        <div className="theme-preset-options" ref={themeRailRef} onScroll={syncThemeRail}>
          {THEME_PACKS.map((pack) => (
            <button
              key={pack.id}
              className={`theme-preset-option ${themePackId === pack.id ? 'selected' : ''}`}
              onClick={() => handleThemePackSelect(pack.id)}
              title={language === 'zh' ? pack.tagline.zh : pack.tagline.en}
            >
              {renderThemePreview(pack, themePackId === pack.id)}
              <span className="theme-preset-name">
                <span>{language === 'zh' ? pack.name.zh : pack.name.en}</span>
                <small>{language === 'zh' ? pack.tagline.zh : pack.tagline.en}</small>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 主题色选择 */}
      <div className="appearance-section">
        <h3>{language === 'zh' ? '强调色' : 'Accent Color'}</h3>
        <div className="color-theme-grid">
          {/* 第一颗是「跟随主题」——
            *   1) 它本来就是真实存在的状态: 没主动选过强调色时, 生效的是主题包自己的主色
            *      (appStore.accentExplicit), 而这一排却给某个颜色打着勾, 跟界面对不上;
            *   2) 11 颗色点在这一行末尾正好空出一块 (用户圈了那块空白), 补足 12 颗填满。 */}
          <button
            className={`color-theme-btn color-theme-btn--auto${accentExplicit ? '' : ' selected'}`}
            onClick={resetColorTheme}
            title={language === 'zh' ? '跟随主题' : 'Match theme'}
            aria-label={language === 'zh' ? '跟随主题' : 'Match theme'}
          >
            <div className="color-swatch" />
            {!accentExplicit && (
              <div className="color-check"><Icons.Check /></div>
            )}
          </button>
          {COLOR_THEMES.map((theme) => (
            <button
              key={theme.id}
              className={`color-theme-btn ${accentExplicit && colorTheme === theme.id ? 'selected' : ''}`}
              onClick={() => handleColorThemeSelect(theme.id)}
              style={{ '--theme-color': theme.primaryColor } as React.CSSProperties}
              title={theme.name}
            >
              <div className="color-swatch" />
              {accentExplicit && colorTheme === theme.id && (
                <div className="color-check">
                  <Icons.Check />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 底部那句「你可以随时在设置中更改这些选项」删了 —— 副标题已经说过一遍,
        * 而且它在 760px 高的窗口里正好被挤出视口, 是"写了等于没写"的一行。 */}
      <div className="step-actions appearance-actions">
        <button className="continue-btn" onClick={goNext}>
          <span>{language === 'zh' ? '继续' : 'Continue'}</span>
          <Icons.ChevronRight />
        </button>
      </div>
    </div>
  );

  const renderModeStep = () => {
    const api = (window as any).neox;
    const cards: Array<{ id: 'work' | 'code'; title: string; desc: string; tag: string }> = zh
      ? [
          { id: 'work', title: '工作', tag: 'Work', desc: '改稿、文档表格、调研与汇报' },
          { id: 'code', title: '编码', tag: 'Code', desc: '写代码、调 bug、重构与代码审查' },
        ]
      : [
          { id: 'work', title: 'Work', tag: 'Work', desc: 'Docs, sheets, research and reports' },
          { id: 'code', title: 'Code', tag: 'Code', desc: 'Write code, debug, refactor, review' },
        ];
    const workChips: string[] = zh
      ? ['周报汇报', '方案提案', 'Excel 数据', '客户跟进', '行业调研', '会议纪要']
      : ['Reports', 'Proposals', 'Excel & data', 'Client follow-ups', 'Research', 'Meeting notes'];
    const showChips = selectedAgentMode === 'work';
    const saveAndNext = () => {
      if (showChips && profileChips.size > 0 && typeof api?.agentModeSaveProfile === 'function') {
        const md = `# User profile · ${selectedAgentMode}\n\n常用场景 (onboarding 勾选):\n${[...profileChips].map((c) => `- ${c}`).join('\n')}\n`;
        void api.agentModeSaveProfile(selectedAgentMode, md).catch(() => {});
      }
      goNext();
    };
    return (
      <div className="onboarding-step features-step mode-step">
        <div className="step-header step-header--branded">
          {/* 标题左侧挂品牌 mark —— 这一屏是整个引导里唯一在问"你是谁"的一屏,
            * 由 Neox 自己出面问更顺; 顺带把这一屏跟纯设置类的第 1 屏区分开。 */}
          {titleWithMark(zh ? '你主要用 Neox 做什么？' : 'What will you use Neox for?')}
        </div>
        <div className="mode-cards">
          {cards.map((card, index) => (
            <button
              key={card.id}
              type="button"
              className={`mode-card${selectedAgentMode === card.id ? ' is-selected' : ''}`}
              style={{ animationDelay: `${index * 0.08}s` }}
              onClick={() => {
                setSelectedAgentMode(card.id);
                setProfileChips(new Set());
                if (typeof api?.agentModeSetDefault === 'function') {
                  void api.agentModeSetDefault(card.id).catch(() => {});
                }
              }}
            >
              <span className="mode-card__art mode-card__art--illus" aria-hidden="true">
                <img src={card.id === 'work' ? NeoxIllus.onboardWork : NeoxIllus.onboardCode} alt="" draggable={false} />
              </span>
              <span className="mode-card__title">{card.title}</span>
              <span className="mode-card__desc">{card.desc}</span>
              <span className="mode-card__check" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 13 4.5 4.5L19 7" /></svg>
              </span>
            </button>
          ))}
        </div>
        {!showChips && <div className="mode-chips-placeholder" aria-hidden="true" />}
        {showChips && (
          <div className="mode-chips">
            <p className="mode-chips__hint">
              {zh ? '你最常需要哪些？(可跳过, 帮助 Neox 更懂你)' : 'What do you need most? (optional — helps Neox know you)'}
            </p>
            <div className="mode-chips__list">
              {workChips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className={`mode-chip${profileChips.has(chip) ? ' is-on' : ''}`}
                  onClick={() => setProfileChips((prev) => {
                    const next = new Set(prev);
                    if (next.has(chip)) next.delete(chip); else next.add(chip);
                    return next;
                  })}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="features-actions">
          <button className="continue-btn" onClick={saveAndNext}>
            <span>{zh ? '继续' : 'Continue'}</span>
          </button>
        </div>
      </div>
    );
  };


  /* ── connect 步: 模式选择 (订阅 vs BYOK) ── */
  const renderConnectChoose = () => (
    <div className="onboarding-step connect-step">
      <div className="step-header step-header--branded">
        {titleWithMark(SUBSCRIPTION_AVAILABLE
          ? (zh ? '选择使用方式' : 'Choose how to start')
          : (zh ? '接入模型开始用' : 'Connect a model to start'))}

      </div>

      <div className={`connect-mode-grid${SUBSCRIPTION_AVAILABLE ? '' : ' connect-mode-grid--single'}`}>
        {SUBSCRIPTION_AVAILABLE && (
          <button
            className="connect-mode-card connect-mode-card--sub"
            onClick={() => setShowLogin(true)}
          >
            <div className="connect-mode-icon connect-mode-icon--brand">
              <img
                src={brandLogoUrl(themePreset)}
                onError={onBrandImgError('logo')}
                alt="Neox"
                draggable={false}
              />
            </div>
            <div className="connect-mode-body">
              <div className="connect-mode-title-row">
                <span className="connect-mode-title">{zh ? '使用 Neox 订阅' : 'Use Neox Subscription'}</span>
              </div>
            </div>
            <Icons.ChevronRight />
          </button>
        )}

        {/* BYOK 卡 — 永远渲染, 出海 default channel 实际就是唯一的入口 */}
        <button
          className="connect-mode-card connect-mode-card--byok"
          onClick={() => { setConnectMode('byok'); setByokSubMode('brand'); }}
        >
          <div className="connect-mode-icon"><IconBYOK /></div>
          <div className="connect-mode-body">
            <div className="connect-mode-title-row">
              <span className="connect-mode-title">{zh ? '自带 API Key (BYOK)' : 'Bring your own key (BYOK)'}</span>
              <span className="connect-mode-badge connect-mode-badge--rec">
                {zh ? '无需账号' : 'No account'}
              </span>
            </div>
          </div>
          <Icons.ChevronRight />
        </button>

      </div>

      <div className="step-actions connect-actions">
        <button className="connect-skip" onClick={skipConnect}>
          {skipLabel}
        </button>
        {/* 订阅 OFF 状态:用一行小字 footer 给"想等订阅?登录占位"入口 — 不再用全卡 */}
        {hasAccount && !SUBSCRIPTION_AVAILABLE && (
          <button
            type="button"
            className="connect-skip"
            onClick={() => setConnectMode('sub')}
            style={{ fontSize: 11.5, opacity: 0.55, marginTop: 4 }}
          >
            {zh ? '想用 Neox 订阅?登录账号占位,上线后自动启用 →' : 'Want Neox subscription later? Sign in to reserve →'}
          </button>
        )}
      </div>
    </div>
  );

  /* ── connect 步: 订阅分支 (暂时只暴露登录入口, 等 NeoxCloud 订阅就绪) ── */
  const renderConnectSub = () => (
    <div className="onboarding-step connect-step connect-step--sub">
      <div className="step-header">
        <div className="step-icon step-icon--lg connect-sub-brand-mark">
          <img
            src={brandLogoUrl(themePreset)}
            onError={onBrandImgError('logo')}
            alt="Neox"
            draggable={false}
          />
        </div>
        <h2>{zh ? '使用 Neox 订阅' : 'Use Neox Subscription'}</h2>
        <p>
          {SUBSCRIPTION_AVAILABLE
            ? (zh ? '登录后使用统一模型入口与跨设备同步。' : 'Sign in for managed model access and cross-device sync.')
            : (zh ? '订阅服务即将开放。登录账号后，上线时可优先启用。' : 'Subscription access is coming soon. Sign in to reserve access for launch.')}
        </p>
      </div>

      <div className="connect-sub-features">
        <div className="connect-sub-feature">
          <IconModelCatalog />
          <span>{zh ? '托管模型，无需配置 Key 直接使用' : 'Managed models, ready without manual keys'}</span>
        </div>
        <div className="connect-sub-feature">
          <IconDeviceSync />
          <span>{zh ? '跨设备同步会话与设置' : 'Sync sessions and settings across devices'}</span>
        </div>
        <div className="connect-sub-feature">
          <IconUsageControl />
          <span>{zh ? '账号额度、用量与账单统一管理' : 'Usage, quota, and billing in one account'}</span>
        </div>
      </div>

      <div className="step-actions connect-actions connect-actions--subscription">
        <button className="continue-btn" onClick={() => setShowLogin(true)}>
          <span>{zh ? '登录 Neox 账号' : 'Sign in to Neox'}</span>
          <Icons.ChevronRight />
        </button>
        <button className="connect-skip" onClick={skipConnect}>
          {skipLabel}
        </button>
      </div>
    </div>
  );

  const renderByokBrand = () => {
    const q = brandQuery.trim().toLowerCase();
    const match = (b: Brand) => !q
      || tx(b.label, language).toLowerCase().includes(q)
      || tx(b.tagline, language).toLowerCase().includes(q)
      || b.id.toLowerCase().includes(q);
    const groups: Array<{ key: BrandGroup; title: string; items: Brand[] }> = [
      { key: 'hub' as BrandGroup, title: zh ? '聚合平台' : 'Aggregator hubs', items: brands.filter(b => b.group === 'hub' && match(b)) },
      { key: 'official' as BrandGroup, title: zh ? '官方厂商' : 'Official providers', items: brands.filter(b => b.group === 'official' && match(b)) },
      { key: 'custom' as BrandGroup, title: zh ? '自定义' : 'Custom', items: brands.filter(b => b.group === 'custom' && match(b)) },
    ].filter(g => g.items.length > 0);
    const hits = groups.reduce((n, g) => n + g.items.length, 0);

    const renderBrandCard = (b: Brand) => (
      <button key={b.id} className="byok-brand-card" onClick={() => pickBrand(b)}>
        {/* 官方 mark (assets/provider-logos), 自定义服务商没有品牌可言就不占位。 */}
        {!b.custom && (
          <span className="byok-brand-logo">
            <ProviderBrandLogo presetId={brandLogoId(b.id)} fallbackLabel={tx(b.label, language)} size={26} />
          </span>
        )}
        <div className="byok-brand-body">
          <div className="byok-brand-title-row">
            <span className="byok-brand-name">{tx(b.label, language)}</span>
            {b.recommended && <span className="byok-brand-badge">{zh ? '推荐' : 'Recommended'}</span>}
          </div>
          {b.tagline && <span className="byok-brand-tagline">{tx(b.tagline, language)}</span>}
        </div>
        <Icons.ChevronRight />
      </button>
    );

    return (
      <div className="onboarding-step connect-step">
        <div className="step-header step-header--branded">
          {titleWithMark(zh ? '选择服务商' : 'Choose a provider')}
        </div>

        <button
          type="button"
          className="byok-import-entry"
          onClick={() => setConnectMode('scan')}
        >
          <span className="byok-import-entry__icon" aria-hidden><IconScan /></span>
          <span className="byok-import-entry__body">
            <span className="byok-import-entry__title">
              {zh ? '从本机导入已配好的 Key' : 'Import keys already on this Mac'}
            </span>
            <span className="byok-import-entry__desc">
              {zh ? 'Codex / Claude Code / CC Switch 里配过的，扫出来一键导入' : 'From Codex / Claude Code / CC Switch'}
            </span>
          </span>
          <Icons.ChevronRight />
        </button>

        <div className="byok-picker">
          {/* 搜索控件独立渲染在 picker 右上角 (跟第一组标题同一行, 不占额外高度)。
            * 千万不能挂在 groups[0] 里 —— 搜到 0 结果时那个 section 不渲染,
            * 搜索框会跟着消失, 用户连退格都没得按 (第一版就是这么写的)。 */}
            <div className={`byok-search${searchOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="byok-search__btn"
                onClick={() => {
          setSearchOpen(o => {
            if (o) { setBrandQuery(''); return false; }
            window.setTimeout(() => brandSearchRef.current?.focus(), 60);
            return true;
          });
                }}
                title={zh ? '搜索服务商' : 'Search providers'}
                aria-label={zh ? '搜索服务商' : 'Search providers'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {searchOpen
            ? <path d="M18 6 6 18M6 6l12 12" />
            : <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>}
                </svg>
              </button>
              <input
                ref={brandSearchRef}
                className="byok-search__input"
                value={brandQuery}
                tabIndex={searchOpen ? 0 : -1}
                onChange={(e) => setBrandQuery(e.target.value)}
                placeholder={zh ? '搜索服务商' : 'Search providers'}
                onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); setBrandQuery(''); setSearchOpen(false); return; }
          if (e.key !== 'Enter' || hits !== 1) return;
          e.preventDefault();
          const only = groups[0]?.items[0];
          if (only) pickBrand(only);
                }}
              />
            </div>

          <div className="byok-groups" ref={byokGroupsRef} data-scrollable={byokScrollable ? 'true' : undefined}>
            {groups.map((g) => (
              <section key={g.key} className="byok-group">
                <div className="byok-group__head">
                  <span className="byok-group__title">{g.title}</span>
                </div>
                <div className="byok-group__grid">{g.items.map(renderBrandCard)}</div>
              </section>
            ))}
            {hits === 0 && (
              <p className="byok-empty">
                {zh ? '没有匹配的服务商 — 用「自定义」填 Base URL 也能接' : 'No match — use “Custom” to enter a Base URL'}
              </p>
            )}
          </div>
        </div>

        <div className="step-actions connect-actions">
          <button className="connect-skip" onClick={skipConnect}>
            {skipLabel}
          </button>
        </div>
      </div>
    );
  };

  const renderByokForm = () => {
    if (!selectedBrand || !selectedProtocol) return null;
    const busy = connectStatus === 'verifying' || connectStatus === 'fetching-models';
    const isCustom = !!selectedBrand.custom;
    /* 候选统一: 拉过目录就用真目录, 没拉就用品牌内置清单; 用户手填过的追加在后面。
     * 不管哪一种, 这个控件都是**同一个多选下拉** —— 上一版只有"拉过"才是多选,
     * 没拉时又退回成单选 combobox, 用户看到的就是"多选框怎么被你改掉了"。 */
    const baseModels = remoteModels.length > 0
      ? remoteModels
      : (selectedProtocol.models ?? (selectedProtocol.defaultModel ? [selectedProtocol.defaultModel] : []));
    const candidateModels = [...baseModels, ...typedModels.filter(m => !baseModels.includes(m))];
    const visibleModels = modelQuery.trim()
      ? candidateModels.filter(m => m.toLowerCase().includes(modelQuery.trim().toLowerCase()))
      : candidateModels;
    const needsModel = isCustom || !!selectedBrand.modelRequired;
    const canSubmit = !!apiKey.trim() && !busy && connectStatus !== 'ok' &&
      (!isCustom || !!customBaseUrl.trim()) &&
      (!needsModel || !!modelName.trim());
    const canFetchModels = !!apiKey.trim() && !busy && !modelsLoading && (!isCustom || !!customBaseUrl.trim());
    const regions = selectedBrand.regions ?? [];
    return (
      <div className="onboarding-step connect-step">
        <div className="step-header step-header--vendor">
          {/* 官方 mark, 不是我画的图标 */}
          <ProviderBrandLogo presetId={brandLogoId(selectedBrand.id)} fallbackLabel={tx(selectedBrand.label, language)} size={46} />
          <h2>{tx(selectedBrand.label, language)}</h2>

        </div>

        <div className="connect-form">
          {/* 自定义服务商: 协议 segmented 选择器 */}
          {isCustom && selectedBrand.protocols.length > 1 && (
            <div className="byok-proto-picker" role="tablist" aria-label={zh ? '协议' : 'Protocol'}>
              {selectedBrand.protocols.map(p => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedProtocol.id === p.id}
                  className={`byok-proto-pill ${selectedProtocol.id === p.id ? 'selected' : ''}`}
                  onClick={() => switchCustomProtocol(p)}
                  title={p.desc}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {/* 字段区 —— 输入框本身无边框无底色, 靠这块玻璃卡承载, 字段之间只有发丝线。 */}
          <div className="connect-fields">
            {isCustom && (
              <label className="connect-field">
                <span className="connect-field__label">Base URL</span>
                <input
                  className="connect-field__input"
                  placeholder={selectedProtocol.basePlaceholder ?? 'https://…'}
                  value={customBaseUrl}
                  onChange={e => { setCustomBaseUrl(e.target.value); setConnectStatus('idle'); setRemoteModels([]); setPickedModels(new Set()); }}
                />
              </label>
            )}

            {regions.length > 0 && (
              <div className="connect-field">
                <span className="connect-field__label">{zh ? '区域' : 'Region'}</span>
                <div className="connect-field__control">
                  <div className="model-select" ref={regionSelectRef}>
                    <button
                      type="button"
                      className={`model-select__summary${regionOpen ? ' is-open' : ''}`}
                      onClick={() => setRegionOpen(o => !o)}
                    >
                      <span className="model-select__text">{region || regions[0]}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                        <path d={regionOpen ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} />
                      </svg>
                    </button>
                    {regionOpen && (
                      <div className="model-select__panel" role="listbox">
                        {regions.map(rg => (
                          <div
                            key={rg}
                            role="option"
                            aria-selected={(region || regions[0]) === rg}
                            className={`model-opt is-clickable${(region || regions[0]) === rg ? ' is-on' : ''}`}
                            onClick={() => {
                              setRegion(rg); setRegionOpen(false);
                              setConnectStatus('idle'); setRemoteModels([]);
                            }}
                          >
                            <span className="model-opt__name">{rg}</span>
                            {(region || regions[0]) === rg && (
                              <span className="model-opt__badge">{zh ? '当前' : 'Current'}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="connect-field">
              <span className="connect-field__label">API Key</span>
              <div className="connect-field__control">
                <input
                  className="connect-field__input"
                  type={showKey ? 'text' : 'password'}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="API Key"
                  placeholder={zh ? '粘贴你的 Key' : 'Paste your key'}
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); setConnectStatus('idle'); setConnectError(''); setRemoteModels([]); setPickedModels(new Set()); setModelsError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter' && canSubmit) handleVerifyAndContinue(); }}
                />
                {apiKey && (
                  <button
                    type="button"
                    className="connect-inline-btn connect-inline-btn--icon"
                    onClick={() => setShowKey(v => !v)}
                    title={showKey ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')}
                    aria-label={showKey ? (zh ? '隐藏 Key' : 'Hide key') : (zh ? '显示 Key' : 'Show key')}
                    aria-pressed={showKey}
                  >
                    <svg className="connect-inline-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
                      <circle cx="12" cy="12" r="3" />
                      {showKey && <path d="M4 4l16 16" />}
                    </svg>
                  </button>
                )}
                {/* 没有 Key 的人第一件事就是去拿 —— 放在 Key 这一行, 跟下一行的「获取模型」对齐,
                  * 不再是字段区外面一行小字链接 */}
                {!isCustom && selectedBrand.keyUrl && (
                  <button
                    type="button"
                    className="connect-inline-btn"
                    onClick={() => openKeyUrl(selectedBrand.keyUrl)}
                    title={zh ? `在浏览器打开 ${tx(selectedBrand.label, language)} 控制台` : `Open the ${tx(selectedBrand.label, language)} console`}
                  >
                    <svg className="connect-inline-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
                    </svg>
                    <span>{zh ? '获取 Key' : 'Get a key'}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="connect-field connect-field--model">
              <span className="connect-field__label">{zh ? '模型' : 'Model'}</span>
              <div className="connect-field__control">
                {/* 模型选择器 = 一个多选下拉。候选来自"拉到的目录"或品牌内置清单,
                 * 面板顶部那行既是搜索也是手填 (回车把没见过的模型名加进来并勾上),
                 * 所以自定义服务商也用这一个控件, 不再另开一个单选 combobox。 */}
                <div className="model-select" ref={modelSelectRef}>
                  <button
                    type="button"
                    className={`model-select__summary${modelsOpen ? ' is-open' : ''}`}
                    onClick={() => setModelsOpen(o => !o)}
                  >
                    <span className="model-select__text">
                      {modelName || (zh ? '选择模型' : 'Pick a model')}
                      {pickedModels.size > 1 && (
                        <em className="model-select__more">+{pickedModels.size - 1}</em>
                      )}
                    </span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      <path d={modelsOpen ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} />
                    </svg>
                  </button>
                  {modelsOpen && (
                    <div className="model-select__panel" role="listbox" aria-multiselectable="true">
                      <div className="model-select__head">
                        <input
                          className="model-select__query"
                          value={modelQuery}
                          placeholder={zh ? '搜索, 或输入模型名回车添加' : 'Search, or type a model name and press Enter'}
                          onChange={(e) => setModelQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            const v = modelQuery.trim();
                            if (!v) return;
                            if (!candidateModels.some(m => m.toLowerCase() === v.toLowerCase())) {
                              setTypedModels(prev => [...prev, v]);
                            }
                            setPickedModels(prev => new Set(prev).add(v));
                            setModelName(v);
                            setModelQuery('');
                            setConnectStatus('idle');
                          }}
                        />
                        <button
                          type="button"
                          className="model-select__all"
                          onClick={() => setPickedModels(prev => (
                            prev.size >= candidateModels.length ? new Set([modelName].filter(Boolean)) : new Set(candidateModels)
                          ))}
                        >
                          {pickedModels.size >= candidateModels.length ? (zh ? '全不选' : 'Clear') : (zh ? '全选' : 'All')}
                        </button>
                      </div>
                      {visibleModels.length === 0 && (
                        <p className="model-select__empty">{zh ? '回车添加这个模型名' : 'Press Enter to add it'}</p>
                      )}
                      {visibleModels.map((m) => {
                        const checked = pickedModels.has(m);
                        const isDefault = m === modelName;
                        return (
                          <div key={m} className={`model-opt${checked ? ' is-on' : ''}`} role="option" aria-selected={checked}>
                            <label className="model-opt__pick">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setPickedModels(prev => {
                                  const next = new Set(prev);
                                  if (next.has(m)) next.delete(m); else next.add(m);
                                  /* 默认模型被取消勾选就换一个还勾着的 —— 不能把一个
                                   * 自己都没装进来的模型存成默认。 */
                                  if (m === modelName && !next.has(m)) {
                                    const fallback = candidateModels.find(x => next.has(x));
                                    if (fallback) setModelName(fallback);
                                  }
                                  return next;
                                })}
                              />
                              <span className="model-opt__name">{m}</span>
                            </label>
                            {isDefault ? (
                              <span className="model-opt__badge">{zh ? '默认' : 'Default'}</span>
                            ) : (
                              <button
                                type="button"
                                className="model-opt__default"
                                onClick={() => { setModelName(m); setPickedModels(prev => new Set(prev).add(m)); }}
                              >
                                {zh ? '设为默认' : 'Set default'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="connect-inline-btn"
                  onClick={handleFetchModels}
                  disabled={!canFetchModels}
                  title={zh ? '用这把 Key 从服务商拉取模型列表' : 'Fetch the model list from the provider with this key'}
                >
                  {/* 无边框 + 一枚刷新图标, 跟字段行的其它元素同一条基线 */}
                  <svg
                    className={`connect-inline-btn__icon${modelsLoading ? ' is-spinning' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 4v5h-5" />
                  </svg>
                  <span>{modelsLoading
                    ? (zh ? '获取中' : 'Fetching')
                    : remoteModels.length > 0
                      ? (zh ? '重新获取' : 'Refresh')
                      : (zh ? '获取模型' : 'Fetch models')}</span>
                </button>
              </div>
            </div>
          </div>

          {!remoteModels.length && modelsError && (
            <p className="connect-model-note connect-model-note--warn">{modelsError}</p>
          )}

          {connectStatus === 'tested' && (
            <div className="connect-status connect-status--ok">
              {zh ? '✓ 连接测试通过' : '✓ Connection test passed'}
            </div>
          )}
          {connectStatus === 'ok' && (
            <div className="connect-status connect-status--ok">
              {zh ? '✓ 连接成功,准备就绪' : '✓ Connected, you are ready'}
            </div>
          )}
          {connectStatus === 'error' && (
            <div className="connect-status connect-status--error">{connectError}</div>
          )}
        </div>

        <div className="step-actions connect-actions connect-actions--dual">
          <button
            type="button"
            className="connect-test-btn"
            onClick={handleTest}
            disabled={!apiKey.trim() || busy}
          >
            {connectStatus === 'verifying' ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试连接' : 'Test connection')}
          </button>
          <button className="continue-btn" onClick={handleVerifyAndContinue} disabled={!canSubmit}>
            <span>{
              connectStatus === 'fetching-models' ? (zh ? '正在获取模型…' : 'Fetching models…')
                : busy ? (zh ? '验证中…' : 'Verifying…')
                : (zh ? '验证并继续' : 'Verify & Continue')
            }</span>
            {!busy && <Icons.ChevronRight />}
          </button>
        </div>
        <div className="step-actions connect-actions connect-actions--skip-row">
          <button className="connect-skip" onClick={skipConnect}>
            {skipLabel}
          </button>
        </div>
      </div>
    );
  };

  /**
   * 迁移屏 —— 从 Claude Code / Codex / Cursor 搬技能和 MCP。
   *
   *   文案克制: 这是一张**回执**不是一篇说明。用户已经知道自己在用别的工具,
   *   不需要我们解释什么是 skill。所以只有"扫到了什么 / 要不要搬"两件事。
   */
  const renderMigrateStep = () => {
    const scan = migrateScan;
    const freshSkills = (scan?.skills ?? []).filter((x) => !x.alreadyImported);
    const freshMcp = (scan?.mcp ?? []).filter((x) => !x.alreadyImported);
    /* 会话可能上千条 (本机 1317)。这一屏只铺最近 SESSION_ROWS 条 —— 引导页不是会话管理器,
     * 用户要的是"把我最近在干的事带过来", 不是逐条勾一千个。 */
    const freshSessions = (scan?.sessions?.recent ?? []).filter((x) => !x.alreadyImported);
    const sessionRows = freshSessions.slice(0, SESSION_ROWS);
    const pickedEnvCount = freshMcp
      .filter((m) => migratePicked.has(`mcp:${m.id}`))
      .reduce((n, m) => n + m.envKeys.length, 0);

    const toggle = (key: string) => {
      setMigratePicked((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    };

    const apply = async () => {
      const api = (window as any).neox;
      if (typeof api?.migrateApply !== 'function') { goNext(); return; }
      setMigrateBusy(true);
      try {
        const r = await api.migrateApply({
          skillPaths: freshSkills.filter((x) => migratePicked.has(`skill:${x.path}`)).map((x) => x.path),
          mcpIds: freshMcp.filter((x) => migratePicked.has(`mcp:${x.id}`)).map((x) => x.id),
          withEnv: migrateWithEnv,
          sessions: sessionRows
            .filter((x) => migratePicked.has(`sess:${x.filePath}`))
            .map((x) => ({ filePath: x.filePath, source: x.source })),
        });
        setMigrateDone({
          imported: r?.imported ?? 0,
          failed: r?.failed ?? 0,
          envStripped: r?.envStripped ?? [],
          sessions: r?.sessionsImported ?? 0,
        });
      } catch {
        setMigrateDone({ imported: 0, failed: 1, envStripped: [], sessions: 0 });
      } finally {
        setMigrateBusy(false);
      }
    };

    /* ── 还没扫: 一段说明 + 一颗按钮 ── */
    if (!migrateScanned && !migrateBusy) {
      return (
        <div className="onboarding-step migrate-step">
          <ScanStyles />
          <div className="step-header">
            <h2>{zh ? '数据迁移' : 'Data migration'}</h2>
          </div>
          <div className="migrate-intro migrate-intro--start">
            <MigrateIllustration themePreset={themePreset} />
            <p className="migrate-intro__desc">
              {zh
                ? <>把 Claude Code、Codex 里的<b>技能</b>、<b>MCP</b> 和<b>历史会话</b>复制到 Neox，只读取，不改动原文件。</>
                : <>Copy your <b>skills</b>, <b>MCP servers</b> and <b>past sessions</b> from {'Claude Code'} and Codex into Neox. Your originals stay untouched.</>}
            </p>
          </div>
          <div className="step-actions migrate-actions">
            <button type="button" className="onboarding-skip migrate-skip" onClick={goNext}>
              {zh ? '稍后再说' : 'Later'}
            </button>
            <button type="button" className="continue-btn" onClick={() => { void runMigrateScan(); }}>
              {zh ? '开始扫描' : 'Start scan'}
            </button>
          </div>
        </div>
      );
    }

    /* ── 扫描中 ── */
    if (migrateBusy && !migrateScanned) {
      return (
        <div className="onboarding-step migrate-step">
          <ScanStyles />
          <div className="step-header">
            <h2>{zh ? '正在扫描…' : 'Scanning…'}</h2>
          </div>
          <div className="migrate-intro">
            <ScanProbe sources={MIGRATE_SOURCES} at={migrateProbe} zh={zh} />
          </div>
        </div>
      );
    }

    /* ── 空 ── */
    if (freshSkills.length === 0 && freshMcp.length === 0 && sessionRows.length === 0) {
      return (
        <div className="onboarding-step migrate-step">
          <ScanStyles />
          <div className="step-header">
            <h2>{zh ? '数据迁移' : 'Data migration'}</h2>
          </div>
          <div className="migrate-intro">
            <div className="nx-scan__empty">
              {zh
                ? '未检测到可迁移的内容。CLAUDE.md / AGENTS.md 无需迁移，Neox 直接读取。'
                : 'No migratable content found. CLAUDE.md / AGENTS.md need no migration — Neox reads them directly.'}
            </div>
          </div>
          <div className="step-actions migrate-actions">
            <button type="button" className="continue-btn" onClick={goNext}>
              {zh ? '继续' : 'Continue'}
            </button>
          </div>
        </div>
      );
    }

    /* ── 结果: 三列 ── */
    const column = (
      key: 'skill' | 'mcp' | 'sess',
      icon: React.ReactNode,
      label: string,
      rows: Array<{ id: string; name: string; source: string }>,
    ) => {
      /* 来源清单从数据里现算 —— 不写死 'Codex' / 'Claude Code', 以后多一家自动就有 */
      const sources = Array.from(new Set(rows.map((x) => x.source))).sort();
      const active = migrateFilter[key] ?? null;
      const q = (migrateQuery[key] ?? '').trim().toLowerCase();
      /* 全选/全不选只作用于**当前筛选下看得见的那些** —— 否则用户筛了 Codex
       * 点全选, 却把看不见的 Claude Code 那批也勾上了。 */
      const shown = rows.filter((x) =>
        (!active || x.source === active)
        && (!q || x.name.toLowerCase().includes(q)));
      const allOn = shown.length > 0 && shown.every((x) => migratePicked.has(`${key}:${x.id}`));
      const toggleColumn = () => setMigratePicked((prev) => {
        const next = new Set(prev);
        for (const x of shown) {
          if (allOn) next.delete(`${key}:${x.id}`); else next.add(`${key}:${x.id}`);
        }
        return next;
      });
      return (
      <div className="migrate-col">
        <div className="migrate-col__head">
          <span className="migrate-col__icon" aria-hidden>{icon}</span>
          <span className="migrate-col__title">{label}</span>
          <span className="migrate-col__count">
            {active ? `${shown.length}/${rows.length}` : rows.length}
          </span>
          <div className="migrate-col__filterwrap">
            <button
              type="button"
              className={`migrate-col__filter${(active || q) ? ' is-on' : ''}`}
              onClick={() => setMigrateMenu((m) => (m === key ? null : key))}
              title={zh ? '筛选' : 'Filter'}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 5h18l-7 8v6l-4 2v-8z" />
              </svg>
              {active && <span className="migrate-col__filter-tag">{active}</span>}
            </button>
            {migrateMenu === key && (
              <div className="migrate-menu" role="menu">
                <input
                  className="migrate-menu__search"
                  autoFocus
                  value={migrateQuery[key] ?? ''}
                  onChange={(e) => setMigrateQuery((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder={zh ? '搜名称…' : 'Search…'}
                />
                <button
                  type="button"
                  className={`migrate-menu__item${active === null ? ' is-on' : ''}`}
                  onClick={() => { setMigrateFilter((p) => ({ ...p, [key]: null })); setMigrateMenu(null); }}
                >
                  {zh ? '全部来源' : 'All sources'}
                  <span className="migrate-menu__n">{rows.length}</span>
                </button>
                {sources.map((src) => (
                  <button
                    key={src}
                    type="button"
                    className={`migrate-menu__item${active === src ? ' is-on' : ''}`}
                    onClick={() => { setMigrateFilter((p) => ({ ...p, [key]: src })); setMigrateMenu(null); }}
                  >
                    {src}
                    <span className="migrate-menu__n">{rows.filter((x) => x.source === src).length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {shown.length > 1 && (
            <button type="button" className="migrate-col__all" onClick={toggleColumn}>
              {allOn ? (zh ? '全不选' : 'None') : (zh ? '全选' : 'All')}
            </button>
          )}
        </div>
        {shown.length === 0 ? (
          <div className="migrate-col__empty">{zh ? '没有' : 'None'}</div>
        ) : (
          <div
            className="migrate-col__list"
            onScroll={(e) => {
              const top = (e.target as HTMLDivElement).scrollTop;
              setMigrateScrollTop((prev) => (
                Math.abs((prev[key] ?? 0) - top) < MIGRATE_ROW_H ? prev : { ...prev, [key]: top }
              ));
            }}
          >
            {(() => {
              const top = migrateScrollTop[key] ?? 0;
              const first = Math.max(0, Math.floor(top / MIGRATE_ROW_H) - 5);
              const last = Math.min(shown.length, first + MIGRATE_VISIBLE_ROWS + 10);
              return (
                <>
                  {first > 0 && <div style={{ height: first * MIGRATE_ROW_H }} aria-hidden />}
                  {shown.slice(first, last).map((x) => (
                    <label key={x.id} className="migrate-row">
                      <input
                        type="checkbox"
                        checked={migratePicked.has(`${key}:${x.id}`)}
                        onChange={() => toggle(`${key}:${x.id}`)}
                      />
                      <span className="migrate-row__name">{x.name}</span>
                      <span className="migrate-row__src">{x.source}</span>
                    </label>
                  ))}
                  {last < shown.length && <div style={{ height: (shown.length - last) * MIGRATE_ROW_H }} aria-hidden />}
                </>
              );
            })()}
          </div>
        )}
      </div>
      );
    };

    return (
      <div className="onboarding-step migrate-step">
        <ScanStyles />
        <div className="step-header">
          <h2>{zh ? '数据迁移' : 'Data migration'}</h2>
        </div>

        <div className="migrate-cols">
          {column('skill', <IconSkill />, zh ? '技能' : 'Skills',
            freshSkills.map((x) => ({ id: x.path, name: x.name || x.id, source: x.source })))}
          {column('mcp', <IconMcp />, 'MCP',
            freshMcp.map((x) => ({ id: x.id, name: x.id, source: x.source })))}
          {column('sess', <IconSession />, zh ? '历史会话' : 'Sessions',
            sessionRows.map((x) => ({
              id: x.filePath,
              name: x.title || (zh ? '未命名会话' : 'Untitled'),
              source: x.source === 'codex' ? 'Codex' : 'Claude Code',
            })))}
        </div>

        {freshMcp.length > 0 && (
          <label className={`migrate-envopt${pickedEnvCount > 0 ? '' : ' is-idle'}`}>
            <input
              type="checkbox"
              disabled={pickedEnvCount === 0}
              checked={migrateWithEnv && pickedEnvCount > 0}
              onChange={(e) => setMigrateWithEnv(e.target.checked)}
            />
            <span>
              {pickedEnvCount > 0
                ? (zh
                  ? `一并迁移 ${pickedEnvCount} 个环境变量（可能包含密钥，默认不迁移）`
                  : `Also migrate ${pickedEnvCount} env vars (may contain secrets; off by default)`)
                : (zh
                  ? '所选 MCP 不带环境变量'
                  : 'Selected MCP servers carry no env vars')}
            </span>
          </label>
        )}

        {migrateDone && (
          <div className="migrate-result">
            {zh ? `已迁移 ${migrateDone.imported} 项` : `Migrated ${migrateDone.imported}`}
            {migrateDone.sessions > 0 && (zh ? ` · 含 ${migrateDone.sessions} 个会话` : ` · ${migrateDone.sessions} sessions`)}
            {migrateDone.failed > 0 && (zh ? ` · 失败 ${migrateDone.failed} 项` : ` · ${migrateDone.failed} failed`)}
            {migrateDone.envStripped.length > 0 && (
              <span className="migrate-result__warn">
                {zh
                  ? ` · 已跳过 ${migrateDone.envStripped.length} 个 server 的环境变量`
                  : ` · env skipped for ${migrateDone.envStripped.length} server(s)`}
              </span>
            )}
          </div>
        )}

        <div className="step-actions migrate-actions">
          <button type="button" className="onboarding-skip migrate-skip" onClick={goNext}>
            {zh ? '稍后再说' : 'Later'}
          </button>
          {/* 重新扫描 —— 用户在别处新装了技能之后不用退出引导再进来一遍 */}
          <button
            type="button"
            className="migrate-rescan"
            disabled={migrateBusy}
            onClick={() => { setMigrateScanned(false); setMigrateScan(null); void runMigrateScan(); }}
            title={zh ? '重新扫描' : 'Rescan'}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.6-6.4" />
              <path d="M21 4v5h-5" />
            </svg>
            <span>{zh ? '重新扫描' : 'Rescan'}</span>
          </button>
          <button
            type="button"
            className="continue-btn"
            disabled={migrateBusy || migratePicked.size === 0}
            onClick={migrateDone ? goNext : apply}
          >
            {migrateDone
              ? (zh ? '继续' : 'Continue')
              : migrateBusy
                ? (zh ? '迁移中…' : 'Migrating…')
                : (zh ? `迁移 ${migratePicked.size} 项` : `Migrate ${migratePicked.size}`)}
          </button>
        </div>
      </div>
    );
  };

  /* 扫描独占一屏 —— 跟设置里的「添加服务商 → 从本机导入」是同一个组件、同一套外壳 */
  const renderConnectScan = () => (
    <div className="onboarding-step connect-step">
      <div className="step-header step-header--branded">
        {titleWithMark(zh ? '从本机导入' : 'Import from this Mac')}
      </div>
      <div className="connect-scan-slot">
        <ProviderScanImport zh={zh} variant="compact" onImported={() => finishConnect()} />
      </div>
      <div className="step-actions connect-actions">
        {/* 回品牌列表 —— 它是从 BYOK 里进来的, 退回去也该回那儿 */}
        <button className="connect-skip" onClick={() => { setConnectMode('byok'); setByokSubMode('brand'); }}>
          {zh ? '← 返回服务商列表' : '← Back to providers'}
        </button>
      </div>
    </div>
  );

  const renderConnectStep = () => {
    if (connectMode === 'scan') return renderConnectScan();
    if (connectMode === 'sub') return renderConnectSub();
    if (connectMode === 'byok') {
      if (byokSubMode === 'form') return renderByokForm();
      return renderByokBrand();
    }
    return renderConnectChoose();
  };

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 'theme':
        return renderThemeStep();
      case 'mode':
        return renderModeStep();
      case 'migrate':
        return renderMigrateStep();
      case 'connect':
        return renderConnectStep();
      case 'mobile':
        return <MobileAppStep zh={zh} title={titleWithMark(zh ? '手机上也能用' : 'Neox on your phone')} onContinue={goNext} isLast={isLastStep} />;
      default:
        return null;
    }
  };

  return (
    <div className={`onboarding-page ${isAnimatingOut ? 'animating-out' : ''}`}>
      <div className="drag-region" data-tauri-drag-region />
      {/* 顶部固定导航栏：箭头 + 步骤指示器 */}
      {/* data-tauri-drag-region: Tauri 下靠它拖窗 (它不认 CSS 的 -webkit-app-region)。
          挂在 header 上而不是那条隐形 .drag-region 上 —— header 盖在它上面, 拖不到。 */}
      <div className="onboarding-header" data-tauri-drag-region>
        {/* 子容器也要挂 —— data-tauri-drag-region 只在**鼠标直接命中该元素**时生效,
            而这些容器铺满了 header, 不挂的话鼠标永远落在它们身上, header 本体根本摸不到。 */}
        <div className="onboarding-nav" data-tauri-drag-region>
          {currentIndex > 0 || connectOnly ? (
            <button className="nav-arrow" onClick={goPrev} title={zh ? '上一步' : 'Back'} aria-label={zh ? '上一步' : 'Back'}>
              <Icons.ChevronLeft />
            </button>
          ) : (
            <span className="nav-arrow nav-arrow--placeholder" aria-hidden="true" />
          )}
        </div>
        {/* 只接模型就一步, 「1 / 1」是废话 —— 占位保住齿轮的位置 */}
        {connectOnly ? <div className="onboarding-step-indicator" data-tauri-drag-region /> : renderStepIndicator()}
        {/* 只接模型模式是叠在应用上的浮层 —— 设置会开在它底下, 点了等于没反应; 那里直接关掉 */}
        {connectOnly ? (
          <button
            type="button"
            className="onboarding-settings-btn"
            onClick={handleCancel}
            title={zh ? '关闭' : 'Close'}
            aria-label={zh ? '关闭' : 'Close'}
          >
            <Icons.X />
          </button>
        ) : (
          <button
            type="button"
            className="onboarding-settings-btn"
            onClick={() => {
              if (onOpenSettings) { onOpenSettings(); return; }
              try { window.dispatchEvent(new CustomEvent('neox:open-settings')); } catch { /* ignore */ }
            }}
            title={zh ? '设置' : 'Settings'}
            aria-label={zh ? '设置' : 'Settings'}
          >
            <Icons.Settings />
          </button>
        )}
      </div>
      <div className="onboarding-bg">
        <div className="bg-gradient" />
        <div className="bg-glow" />
      </div>
      <div className="onboarding-content">
        <div className="step-container" key={currentStep}>
          {renderCurrentStep()}
        </div>
      </div>

      {/* 订阅分支登录浮层 — onSuccess 后关浮层并跳到欢迎页 */}
      {showLogin && (
        <UiSlot name="auth.login" props={{
          onClose: () => setShowLogin(false),
          onSuccess: () => { setShowLogin(false); finishConnect(); /* 往下一步 (只接模型模式 / 已是最后一步: 直接结束) */ },
        }} />
      )}
    </div>
  );
};

export default OnboardingPage;
