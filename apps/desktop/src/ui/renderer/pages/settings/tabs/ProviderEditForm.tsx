import React, { useState, useEffect, useRef } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { CustomSelect } from '../../../components/CustomSelect';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  NeoxInput,
  NeoxButton,
} from '../../../components/settings-base';
import { ProviderPresetGallery, presetToLegacyForm, type PresetPickExtras } from './ProviderPresetGallery';
import { ProviderBrandLogo } from './ProviderBrandLogo';
import { ProviderScanImport } from './ProviderScanImport';
import { httpStatusHint } from '../utils/httpStatusHint.js';
import { findApiDocs } from '../utils/apiDocsLinks.js';
import { cleanPastedSecret, parseAuthHint } from '../utils/detectApiKey';
import { PROVIDER_PRESETS as KERNEL_PRESETS, type ProviderPreset } from '@neoxlabs/kernel/models/providerPresets.js';
import { getByokHiddenModels, setByokModelShown, useByokPickerPrefsVersion } from '../../../state/byokPickerPrefs';
import { ProviderTestPopover } from './ProviderChatProbe';

/* 模型级挑选清单 — provider "显示到模型选择器" 开关开着时, 逐模型勾选是否进 BYOK 菜单.
 * 数据在 byokPickerPrefs (localStorage), 勾选即生效, 与 provider 配置解耦. */
const ByokModelChecklist: React.FC<{ providerId: string; models: string[]; zh: boolean }> = ({ providerId, models, zh }) => {
  const tick = useByokPickerPrefsVersion();
  void tick;
  const hidden = getByokHiddenModels(providerId);
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.08))', paddingTop: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
        {zh ? '挑选要显示的模型（默认全选）' : 'Pick which models appear (all by default)'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {models.map((m) => {
          const shown = !hidden.has(m);
          return (
            <button
              key={m}
              type="button"
              role="checkbox"
              aria-checked={shown}
              onClick={() => setByokModelShown(providerId, m, !shown)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${shown ? 'var(--accent, #6c7cff)' : 'var(--border-subtle, rgba(255,255,255,0.12))'}`,
                background: shown ? 'color-mix(in srgb, var(--accent, #6c7cff) 14%, transparent)' : 'transparent',
                color: shown ? 'inherit' : 'color-mix(in srgb, currentColor 45%, transparent)',
              }}
            >
              <span aria-hidden style={{ fontSize: 11 }}>{shown ? '✓' : '＋'}</span>
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'kimi', label: 'Kimi (Moonshot)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: 'Qwen (阿里云百炼)' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'doubao', label: '豆包 (Doubao)' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'glm', label: 'GLM (智谱 AI)' },
];

const ACCESS_FIELD_W = 360;

const FIELD_TEXT_INSET = 12;

/* 官方 Base URL 本来就不带 /v1 这类版本段的厂商 —— 对它们报 "缺 /v1" 是误报。
 * DeepSeek 官方就是 https://api.deepseek.com + /chat/completions。 */
const VERSIONLESS_HOSTS = ['api.deepseek.com'];

const CHANNEL_PROTOCOL_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic (对话)' },
  { value: 'openai', label: 'OpenAI 兼容 (对话)' },
  { value: 'openai-responses', label: 'OpenAI Responses (对话)' },
  { value: 'gemini', label: 'Gemini (对话)' },
  { value: 'openai-images', label: 'OpenAI Images (图像)' },
  { value: 'openrouter-images', label: 'OpenRouter Images (图像)' },
  { value: 'doubao-images', label: '豆包 Seedream (图像)' },
  { value: 'glm-images', label: '智谱 CogView (图像)' },
  { value: 'grok-images', label: 'Grok Image (图像)' },
  { value: 'gemini-images', label: 'Gemini Image (图像)' },
  { value: 'openai-tts', label: 'OpenAI TTS (语音)' },
  { value: 'openai-stt', label: 'OpenAI STT (转写)' },
];

/* 协议下拉的英文界面: 表里写的是中文括注 (对话 / 图像 …) */
function protocolLabelEn(label: string): string {
  const words: Record<string, string> = { 兼容: 'compatible', 对话: 'chat', 图像: 'image', 语音: 'speech', 转写: 'transcription', 豆包: 'Doubao', 智谱: 'Zhipu', 已有配置: 'existing' };
  return label.replace(/豆包|智谱|兼容|对话|图像|语音|转写|已有配置/g, (w) => words[w] ?? w);
}

/* 从协议推模态, 给渠道行显个小徽标 (对话/图像/语音…)。 */
function modalityBadge(protocol: string, zh: boolean): string {
  const p = (protocol || '').toLowerCase();
  if (p.includes('image')) return zh ? '图像' : 'image';
  if (p.includes('tts') || p.includes('speech')) return zh ? '语音' : 'tts';
  if (p.includes('stt') || p.includes('transcri')) return zh ? '转写' : 'stt';
  if (p.includes('embedding')) return zh ? '向量' : 'embed';
  return zh ? '对话' : 'chat';
}

interface LegacyPreset {
  id: string;
  label: string;
  protocol: string;
  baseUrl: string;
  urlSuffix: string;
  defaultModel: string;
  keyUrl?: string;
}
const PROVIDER_PRESETS: LegacyPreset[] = [
  {
    id: 'deepseek', label: 'DeepSeek 深度求索', protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com', urlSuffix: '/chat/completions',
    defaultModel: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen', label: '通义千问 Qwen', protocol: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', urlSuffix: '/chat/completions',
    defaultModel: 'qwen3.7-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'doubao', label: '豆包 Doubao', protocol: 'doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', urlSuffix: '/chat/completions',
    defaultModel: 'doubao-seed-1-6-251015',
    keyUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'kimi', label: 'Kimi 月之暗面', protocol: 'kimi',
    baseUrl: 'https://api.moonshot.cn/v1', urlSuffix: '/chat/completions',
    defaultModel: 'kimi-k2.6',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'glm', label: '智谱 GLM', protocol: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', urlSuffix: '/chat/completions',
    defaultModel: 'glm-5.1',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'minimax', label: 'MiniMax', protocol: 'minimax',
    baseUrl: 'https://api.minimax.chat/v1', urlSuffix: '/chat/completions',
    defaultModel: 'MiniMax-M3',
    keyUrl: 'https://platform.minimaxi.com/',
  },
  {
    id: 'siliconflow', label: '硅基流动 SiliconFlow', protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1', urlSuffix: '/chat/completions',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'modelscope', label: '魔搭 ModelScope', protocol: 'openai',
    baseUrl: 'https://api-inference.modelscope.cn/v1', urlSuffix: '/chat/completions',
    defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    keyUrl: 'https://modelscope.cn/my/myaccesstoken',
  },
  {
    id: 'baidu-qianfan', label: '百度千帆 Qianfan', protocol: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2', urlSuffix: '/chat/completions',
    defaultModel: 'ernie-4.5-turbo-128k',
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
  },
  {
    id: 'tencent-hunyuan', label: '腾讯混元 Hunyuan', protocol: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', urlSuffix: '/chat/completions',
    defaultModel: 'hunyuan-turbos-latest',
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
  },
  {
    id: '302ai', label: '302.AI (聚合)', protocol: 'openai',
    baseUrl: 'https://api.302.ai/v1', urlSuffix: '/chat/completions',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://302.ai/apis/list',
  },
  {
    /* Azure OpenAI · 2025+ v1 endpoint 走标准 OpenAI 协议 (Bearer auth + 标准 model name),
     * 不再需要 deployment name in URL / api-version query. 用户把 <resource> 替换成自己的
     * Azure 资源名即可 (可在 Azure Portal → OpenAI resource → Endpoint 拿到). */
    id: 'azure-openai', label: 'Azure OpenAI', protocol: 'openai',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', urlSuffix: '/chat/completions',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://portal.azure.com/#browse/Microsoft.CognitiveServicesOpenAI%2Faccounts',
  },
  {
    id: 'openrouter', label: 'OpenRouter (聚合)', protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api', urlSuffix: '/v1/chat/completions',
    defaultModel: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq', label: 'Groq', protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai', urlSuffix: '/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'xai', label: 'xAI (Grok)', protocol: 'openai',
    baseUrl: 'https://api.x.ai', urlSuffix: '/v1/chat/completions',
    defaultModel: 'grok-2-latest',
    keyUrl: 'https://console.x.ai/',
  },
  {
    id: 'mistral', label: 'Mistral', protocol: 'openai',
    baseUrl: 'https://api.mistral.ai', urlSuffix: '/v1/chat/completions',
    defaultModel: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys/',
  },
  {
    id: 'together', label: 'Together.ai', protocol: 'openai',
    baseUrl: 'https://api.together.xyz', urlSuffix: '/v1/chat/completions',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'perplexity', label: 'Perplexity', protocol: 'openai',
    baseUrl: 'https://api.perplexity.ai', urlSuffix: '/chat/completions',
    defaultModel: 'sonar',
    keyUrl: 'https://www.perplexity.ai/settings/api',
  },
];
const PRESET_OPTIONS = [
  { value: '', label: '— 自定义 (Custom) —' },
  ...PROVIDER_PRESETS.map(p => ({ value: p.id, label: p.label })),
];

const curProtocolForVerify = (tabs: Array<{ protocol?: string }>, i: number): string => tabs[i]?.protocol || 'openai';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; latency: number; grade: string }
  | { status: 'error'; message: string };

export const ProviderEditForm: React.FC = () => {
  const {
    t,
    showAddForm, editingProvider,
    setShowAddForm, setEditingProvider, resetForm,
    formName, setFormName,
    formProtocol, setFormProtocol,
    formApiKey, setFormApiKey,
    formBaseUrl, setFormBaseUrl,
    formUrlSuffix, setFormUrlSuffix,
    formMaxTokens, setFormMaxTokens,
    formMaxInputTokens, setFormMaxInputTokens,
    formModels, setFormModels,
    handleAddProvider, handleUpdateProvider,
    getDefaultUrlSuffix,
    getDefaultBaseUrl,
    renderModelSelector,
    formShowInModelPicker, setFormShowInModelPicker,
    formClaudeCodeMode, setFormClaudeCodeMode,
    formPresetId, setFormPresetId,
    formImageEditFormat, setFormImageEditFormat,
    formTabs, setFormTabs,
    fetchRemoteModels, remoteModelOptions, remoteModelsLoading, remoteModelsError,
  } = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';

  const mode: 'add' | 'edit' = editingProvider ? 'edit' : 'add';

  const presetId: string = formPresetId;
  const setPresetId = setFormPresetId;
  const [customMode, setCustomMode] = useState<boolean>(false);
  const [addPath, setAddPath] = useState<'apikey' | 'scan'>('apikey');
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  /* 「测试连接」用哪个模型 —— 空 = 跟着模型列表第一个走。用户在按钮旁边能看见/改。 */
  const [testModel, setTestModel] = useState<string>('');
  const [probeOpen, setProbeOpen] = useState(false);

  const tabs = (formTabs as Array<{ protocol: string; apiKey: string; models?: string[]; baseUrl?: string }>);
  const [activeTab, setActiveTab] = useState(0);
  const active = Math.min(activeTab, tabs.length - 1);
  const syncPrimaryMirror = (i: number, next: typeof tabs) => {
    /* formProtocol/formApiKey 始终镜像"当前正在看的 Tab" —— 端点预览 + Test 用它。 */
    const t = next[i] || next[0];
    if (t) { setFormProtocol(t.protocol as any); setFormApiKey(t.apiKey); }
  };
  const patchTab = (i: number, patch: Partial<typeof tabs[number]>) => {
    const next = tabs.map((t, j) => (j === i ? { ...t, ...patch } : t));
    setFormTabs(next);
    if (i === active) syncPrimaryMirror(i, next);
  };
  /* formModels (模型 section) 是"当前 Tab 的模型"的镜像。切 Tab 载入该 Tab 的模型; 编辑 formModels
   * 自动写回当前 Tab (下面 useEffect)。每 Tab 自己的 key 拉自己的模型, 不共用。 */
  const loadTabModels = (i: number, arr: typeof tabs) => setFormModels(arr[i]?.models || []);
  const addTab = () => {
    const next = [...tabs, { protocol: 'anthropic', apiKey: '', models: [], baseUrl: '' }];
    setFormTabs(next);
    setActiveTab(next.length - 1);
    setFormModels([]); // 新 Tab 模型列表为空 —— 等它自己的 key 去拉
    syncPrimaryMirror(next.length - 1, next);
  };
  const removeTab = (i: number) => {
    if (tabs.length <= 1) return;
    const next = tabs.filter((_, j) => j !== i);
    setFormTabs(next);
    const ni = Math.max(0, i - 1);
    setActiveTab(ni);
    loadTabModels(ni, next);
    syncPrimaryMirror(ni, next);
  };
  const switchTab = (i: number) => { setActiveTab(i); loadTabModels(i, tabs); syncPrimaryMirror(i, tabs); };

  /* 协议下拉的选项 = 精简后的列表 + (当前值若已被精简掉, 原样补回)。
   * 老配置存的是 'deepseek'/'qwen' 这类 OpenAI 兼容别名, 不能因为列表瘦身就显示成空白。 */
  const curProtocol = (tabs[active]?.protocol) || 'openai';
  const protocolOptions = CHANNEL_PROTOCOL_OPTIONS.some(o => o.value === curProtocol)
    ? CHANNEL_PROTOCOL_OPTIONS
    : [...CHANNEL_PROTOCOL_OPTIONS, { value: curProtocol, label: `${curProtocol}${zh ? ' (已有配置)' : ' (existing)'}` }];

  const [showAdvanced, setShowAdvanced] = useState(false);   // 「高级」折叠

  /* Tab 智能命名: 主 Tab (0) 用服务商名 (Grok); 新空 Tab → 未命名; 否则协议品牌名。 */
  const protoBrand = (p?: string) => (CHANNEL_PROTOCOL_OPTIONS.find(o => o.value === p)?.label || p || '').replace(/\s*\(.*\)\s*$/, '');
  const tabLabel = (tb: { protocol: string; apiKey: string; models?: string[]; label?: string }, i: number): string => {
    if (tb.label) return tb.label;
    if (i === 0 && formName.trim()) return formName.trim();
    const empty = !tb.apiKey?.trim() && !(tb.models?.length);
    if (empty) return zh ? '未命名' : 'Untitled';
    return protoBrand(tb.protocol) || modalityBadge(tb.protocol, zh);
  };
  /* 选中 chip 样式: accent 作文字色 + 浅底 (墨夜设计: primary 是字色不是填充色)。 */
  const chipStyle = (on: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
    /* --neox-border 这个 token 从来没定义过, 于是永远回退到 #e5e7eb (浅灰), 深色下是道亮边。
       真正存在的是 --neox-line 系列。 */
    border: '1px solid ' + (on ? 'var(--neox-accent, #6366f1)' : 'var(--neox-line, rgba(128,128,128,0.22))'),
    background: on ? 'color-mix(in srgb, var(--neox-accent, #6366f1) 10%, transparent)' : 'transparent',
    color: on ? 'var(--neox-accent, #4f46e5)' : 'var(--neox-fg-secondary, #6b7280)',
    fontWeight: on ? 600 : 400,
  });

  /* 贴 baseUrl 自动识别协议 (host 关键字 → 最可能协议)。识别不出保持不变。自定义代理走 openai 兼容兜底。 */
  const detectProtoFromBaseUrl = (url: string): string | undefined => {
    const h = (url || '').toLowerCase();
    if (!h) return undefined;
    if (h.includes('openrouter.ai')) return 'openai';
    if (h.includes('api.anthropic.com')) return 'anthropic';
    if (h.includes('api.deepseek.com')) return 'deepseek';
    if (h.includes('generativelanguage.googleapis') || h.includes('gemini')) return 'gemini';
    if (h.includes('dashscope') || h.includes('aliyun')) return 'qwen';
    if (h.includes('open.bigmodel.cn')) return 'glm';
    if (h.includes('volces') || h.includes('doubao') || h.includes('ark.cn')) return 'doubao';
    if (h.includes('moonshot')) return 'kimi';
    if (h.includes('minimax')) return 'minimax';
    return undefined; // 未知 host: 不覆盖用户已选 (自定义代理常是 openai 兼容, 保留当前值)
  };
  const onBaseUrlChange = (val: string) => {
    setFormBaseUrl(val);
    const detected = detectProtoFromBaseUrl(val);
    if (detected && detected !== (tabs[active]?.protocol)) {
      patchTab(active, { protocol: detected });
      setFormUrlSuffix(getDefaultUrlSuffix(detected as any));
    }
  };

  /* formModels 变化 → 写回当前 Tab.models (每 Tab 独立模型列表)。相等则不写, 防循环。 */
  useEffect(() => {
    const cur = tabs[active]?.models || [];
    if (JSON.stringify(cur) !== JSON.stringify(formModels)) {
      setFormTabs(tabs.map((t, j) => (j === active ? { ...t, models: formModels } : t)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formModels]);

  const activeKey = (tabs[active]?.apiKey || '').trim();
  const [verifyFor, setVerifyFor] = useState<string>('');
  const autoPickedRef = useRef<string>('');
  const [autoPicked, setAutoPicked] = useState<string>('');
  const [showKey, setShowKey] = useState(false);
  useEffect(() => {
    if (activeKey.length < 12 || !formBaseUrl.trim()) return;
    const sig = `${activeKey}|${formBaseUrl.trim()}|${curProtocolForVerify(tabs, active)}`;
    const timer = setTimeout(() => {
      setVerifyFor(sig);
      void fetchRemoteModels({ silent: true, openDropdown: false });
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, formBaseUrl, tabs[active]?.protocol]);
  const verifySig = `${activeKey}|${formBaseUrl.trim()}|${curProtocolForVerify(tabs, active)}`;
  const verifyCurrent = verifyFor !== '' && verifyFor === verifySig;
  const remoteList: string[] = Array.isArray(remoteModelOptions) ? remoteModelOptions : [];

  const verifyTestSigRef = useRef('');
  const [testSig, setTestSig] = useState('');
  /* 编辑时打开表单不发请求 (那把 key 早就验过了); 只有改了 key 才验 */
  const initialKeyRef = useRef(mode === 'edit' ? activeKey : '');
  useEffect(() => {
    if (!verifyCurrent || remoteModelsLoading) return;
    if (verifyTestSigRef.current === verifySig) return;
    if (mode === 'edit' && activeKey === initialKeyRef.current) return;
    const kp = KERNEL_PRESETS.find((p) => p.id === presetId);
    const presetChat = (kp?.commonModels || []).filter((m) => (m.modalities ?? ['chat']).includes('chat')).map((m) => m.name);
    let model: string | undefined = formModels[0];
    if (!model && remoteList.length > 0) {
      const lower = new Map(remoteList.map((m) => [m.toLowerCase(), m]));
      const preferred = presetChat.map((n) => lower.get(n.toLowerCase())).find(Boolean);
      const fallback = remoteList.find((m) => !/image|dall-?e|imagen|flux|tts|whisper|embed|rerank|audio|speech|moderation|sora|veo|video/i.test(m));
      model = preferred || fallback;
      if (model && mode === 'add' && autoPickedRef.current !== verifySig) {
        autoPickedRef.current = verifySig;
        setFormModels([model]);
        setAutoPicked(model);
      }
    }
    if (!model) model = presetChat[0];
    if (!model) return;
    verifyTestSigRef.current = verifySig;
    setTestSig(verifySig);
    void handleTest(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyCurrent, remoteModelsLoading, remoteList.length]);

  const testForCurrent = verifyCurrent && testSig === verifySig;
  const verifyState: 'idle' | 'busy' | 'ok' | 'err' = !verifyCurrent
    ? (activeKey.length >= 12 && formBaseUrl.trim() ? 'busy' : 'idle')
    : remoteModelsLoading ? 'busy'
      : testForCurrent
        ? (testState.status === 'testing' ? 'busy' : testState.status === 'ok' ? 'ok' : testState.status === 'error' ? 'err' : 'busy')
        : remoteModelsError ? 'err' : 'idle';
  const verifyError = testForCurrent && testState.status === 'error' ? testState.message : String(remoteModelsError || '');

  const kernelPreset = KERNEL_PRESETS.find((p) => p.id === presetId);
  const legacyPreset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  const auth = parseAuthHint(kernelPreset?.authHint);
  const keyUrl = auth.keyUrl || legacyPreset?.keyUrl;

  const applyPick = (patch: { protocol?: string; baseUrl?: string; urlSuffix?: string; name?: string }, extras?: PresetPickExtras) => {
    const tab0 = { ...(tabs[0] || { protocol: 'openai', apiKey: '' }) };
    if (patch.protocol) tab0.protocol = patch.protocol;
    if (extras?.apiKey) tab0.apiKey = extras.apiKey;
    const next = [tab0, ...tabs.slice(1)];
    setFormTabs(next);
    setActiveTab(0);
    setFormProtocol(tab0.protocol as any);
    setFormApiKey(tab0.apiKey);
    const base = extras?.baseUrl || patch.baseUrl;
    if (base !== undefined) setFormBaseUrl(base);
    if (patch.urlSuffix !== undefined) setFormUrlSuffix(patch.urlSuffix);
    if (patch.name && !formName?.trim()) setFormName(patch.name);
    setTestState({ status: 'idle' });
    setAutoPicked('');
    autoPickedRef.current = '';
  };

  const handleBack = () => {
    if (mode === 'edit') setEditingProvider(null);
    else setShowAddForm(false);
    resetForm();
  };

  const handlePresetChange = (nextId: string) => {
    setPresetId(nextId);
    setTestState({ status: 'idle' });
    const preset = PROVIDER_PRESETS.find(p => p.id === nextId);
    if (!preset) return;
    setFormProtocol(preset.protocol as any);
    /* 关键: 预设协议要落到 Tab0 —— 保存用 formTabs[0], 不同步会把非 openai 预设存成 openai。 */
    setFormTabs((tabs as any[]).map((t: any, i: number) => (i === 0 ? { ...t, protocol: preset.protocol as any } : t)));
    setFormBaseUrl(preset.baseUrl);
    setFormUrlSuffix(preset.urlSuffix);
    if (!formName?.trim()) setFormName(preset.label);
  };

  /** overrideModel: Key 行自动验证时传入; 手动点「测试连接」不传。 */
  const handleTest = async (overrideModel?: string) => {
    setTestState({ status: 'testing' });
    /* 手动测的结果显示在按钮旁边; 自动验证的结果只显示在 Key 那一行, 不重复两处 */
    if (!overrideModel) setTestSig('manual');

    const preset = PROVIDER_PRESETS.find(p => p.id === presetId);
    const model: string = overrideModel
      || (formModels.includes(testModel) ? testModel : '')
      || (Array.isArray(formModels) && formModels[0])
      || preset?.defaultModel
      || 'gpt-4o-mini';
    const apiKey: string = (formApiKey && formApiKey.trim())
      || (mode === 'edit' && editingProvider?.apiKey)
      || '';

    if (!apiKey) {
      setTestState({ status: 'error', message: zh ? '请先填入 API Key' : 'Please enter API Key first' });
      return;
    }
    if (!formBaseUrl?.trim()) {
      setTestState({ status: 'error', message: zh ? '请先填入 Base URL' : 'Please enter Base URL first' });
      return;
    }

    try {
      const request = {
        providerId: editingProvider?.id ?? `test-${Date.now()}`,
        protocol: formProtocol,
        baseUrl: formBaseUrl,
        urlSuffix: formUrlSuffix || getDefaultUrlSuffix(formProtocol),
        apiKey,
        model,
        disableCaching: true,
        /* 测试连通性必须走跟真实 chat 请求相同的 Claude Code 身份策略, 否则出现"测试通过
         *   但 chat 报 400"或反之 (陷阱 4). 只对 anthropic 生效, 其它 protocol 传 undefined. */
        claudeCodeMode: formProtocol === 'anthropic' ? formClaudeCodeMode : undefined,
      };
      const result = await (window as any).neox?.checkProviderHealth?.(request);
      if (!result) {
        setTestState({ status: 'error', message: zh ? '桌面 IPC 未就绪' : 'Desktop IPC not ready' });
        return;
      }
      if (result.status === 'offline' || result.status === 'error') {
        const hint = httpStatusHint(result.httpStatus, zh);
        const keyProblem = result.httpStatus === 401 || result.httpStatus === 403;
        setTestState({
          status: 'error',
          message: keyProblem && hint
            ? (result.errorMessage ? `${hint} · ${result.errorMessage}` : hint)
            : (result.errorMessage || hint || (zh ? '连接失败' : 'Connection failed')),
        });
      } else {
        setTestState({
          status: 'ok',
          latency: Number(result.latency ?? 0),
          grade: String(result.status),
        });
      }
    } catch (err: any) {
      setTestState({
        status: 'error',
        message: err?.message || (zh ? '未知错误' : 'Unknown error'),
      });
    }
  };

  const handleSave = mode === 'edit' ? handleUpdateProvider : handleAddProvider;

  const testStatusBadge = () => {
    if (testState.status === 'idle') return null;
    if (testState.status === 'testing') {
      return (
        <span className="apf-verify is-busy"><span className="apf-verify__dot" />{zh ? '测试中…' : 'Testing…'}</span>
      );
    }
    if (testState.status === 'ok') {
      const gradeLabel: Record<string, string> = zh
        ? { excellent: '连接正常', good: '连接正常', poor: '能连通, 偏慢' }
        : { excellent: 'Connected', good: 'Connected', poor: 'Connected, slow' };
      return (
        <span className="apf-test is-ok">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 5 5L20 7" /></svg>
          {gradeLabel[testState.grade] ?? testState.grade} · {testState.latency}ms
        </span>
      );
    }
    const docs = findApiDocs(formBaseUrl);
    return (
      <span className="apf-test is-err">
        {testState.message.length > 300 ? testState.message.slice(0, 300) + '…' : testState.message}
        {/* 测失败时最该看的就是厂商自己的文档 (地址/鉴权/模型名都在那儿)。命中已知厂商才显。 */}
        {docs && (
          <a href={docs.url} target="_blank" rel="noreferrer">
            {zh ? `查看 ${docs.vendor} 官方接口文档 ↗` : `Open ${docs.vendor} API docs ↗`}
          </a>
        )}
      </span>
    );
  };

  return (
    <div className="settings-content apiv2 apiv2-edit">
      {/* 顶部 PageTitle + 返回 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <PageTitle
          title={mode === 'edit'
            ? (t?.settings?.providers?.editProvider ?? (zh ? '编辑服务商' : 'Edit Provider'))
            : (t?.settings?.providers?.addProvider ?? (zh ? '添加服务商' : 'Add Provider'))}
          subtitle={mode === 'edit'
            ? (zh ? '修改 API Key / 模型 / 接入参数' : 'Update API key / models / connection params')
            : (zh ? '填 API Key，或从本机已有的配置导入' : 'Paste an API key, or import what is already on this Mac')}
        />
        <NeoxButton
          variant="ghost"
          size="sm"
          onClick={handleBack}
          leading={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          }
        >
          {zh ? '返回' : 'Back'}
        </NeoxButton>
      </div>

      {/* 从本机导入 —— 独占一屏 */}
      {mode === 'add' && addPath === 'scan' && !presetId && !customMode && (
        <Section>
          <div className="apiv2__add-path-toolbar">
            <button type="button" className="apiv2__btn" onClick={() => setAddPath('apikey')}>
              {zh ? '← 返回选服务商' : '← Back to providers'}
            </button>
          </div>
          <ProviderScanImport zh={zh} variant="page" onImported={() => handleBack()} />
        </Section>
      )}

      {/* 选服务商 (顶上可以直接粘 key) */}
      {mode === 'add' && addPath === 'apikey' && !presetId && !customMode && (
        <Section>
          <ProviderPresetGallery
            selectedId={presetId}
            zh={zh}
            onImport={() => setAddPath('scan')}
            onPick={(preset: ProviderPreset, extras?: PresetPickExtras) => {
              setPresetId(preset.id);
              setCustomMode(false);
              const legacy = presetToLegacyForm(preset);
              /* 模型不预填 —— 见 handlePresetChange 里同日的注释; Key 填好后自动拉真实清单再挑。 */
              applyPick({ protocol: legacy.protocol, baseUrl: preset.baseUrl, urlSuffix: legacy.urlSuffix, name: preset.label }, extras);
            }}
            onCustom={(extras?: PresetPickExtras) => {
              setPresetId('');
              setCustomMode(true);
              const detected = extras?.baseUrl ? detectProtoFromBaseUrl(extras.baseUrl) : undefined;
              applyPick({ protocol: detected, urlSuffix: detected ? getDefaultUrlSuffix(detected as any) : undefined }, extras);
            }}
          />
        </Section>
      )}
      {/* Step 2: 显 "已选 preset · 更换" chip, 下方 form 才展开. */}
      {mode === 'add' && (presetId || customMode) && (
        <div className="apf-picked">
          {kernelPreset
            ? <ProviderBrandLogo presetId={kernelPreset.id} fallbackLabel={kernelPreset.label} brandColor={kernelPreset.brandColor} size={40} variant="tile" />
            : (
              <span className="provider-logo-tile" style={{ width: 40, height: 40, borderRadius: 10, color: 'var(--neox-fg-secondary)' }} aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1" /><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1" /></svg>
              </span>
            )}
          <div className="apf-picked__meta">
            <span className="apf-picked__name">{kernelPreset?.label || legacyPreset?.label || (zh ? '自定义服务商' : 'Custom provider')}</span>
            <span className="apf-picked__tag">
              {kernelPreset?.tagline || (zh ? '中转站 / 自建网关 —— 填地址和 Key, 协议按地址自动识别' : 'Proxy / self-hosted — enter URL and key; protocol is detected from the URL')}
            </span>
          </div>
          <div className="apf-picked__actions">
            {keyUrl && (
              <a className="apiv2__btn apiv2__btn--primary" href={keyUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                {zh ? '获取 API Key ↗' : 'Get API key ↗'}
              </a>
            )}
            <button
              type="button"
              className="apiv2__btn"
              style={{ background: 'color-mix(in srgb, var(--neox-fg-primary) 7%, transparent)', color: 'var(--neox-fg-primary)' }}
              onClick={() => {
                setPresetId('');
                setCustomMode(false);
                setAddPath('apikey');
                resetForm();
                setTestState({ status: 'idle' });
                setAutoPicked('');
              }}
            >
              {zh ? '更换' : 'Change'}
            </button>
          </div>
        </div>
      )}

      {(mode === 'edit' || presetId || customMode) && (
      <>
      <Section>
        {/* 标题行 + 右侧 tab 条 (含 + 号)。 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{zh ? '接入' : 'Access'}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {tabs.length > 1 && tabs.map((t, i) => (
              <span key={i} onClick={() => switchTab(i)} style={chipStyle(i === active)}>
                {tabLabel(t, i)}
                <span onClick={(e) => { e.stopPropagation(); removeTab(i); }} title={zh ? '删除' : 'Remove'} style={{ opacity: 0.5, fontSize: 11, marginLeft: 1 }}>✕</span>
              </span>
            ))}
            <button type="button" onClick={addTab} className="ppg-link" style={{ fontSize: 12 }}
              title={zh ? '同一家的另一种协议 / 另一把 key (例如同一中转站的 Claude 口和 OpenAI 口)' : 'Another protocol or key for the same provider'}>
              {zh ? '+ 再加一种协议' : '+ Add protocol'}
            </button>
          </div>
        </div>
        <div className="apf-card">
          {/* API Key 放第一行 —— 选完厂商后唯一必须用户自己给的就是它 */}
          <div className="apf-field">
            <label className="apf-label" htmlFor="apf-key">
              <span>
                {t?.settings?.providers?.apiKey ?? 'API Key'}
                {tabs.length > 1 && <small> · {tabLabel(tabs[active], active)}</small>}
                {mode === 'edit' && <small> · {zh ? '已保存, 改了才会更新' : 'saved — only changes if you edit it'}</small>}
              </span>
              {keyUrl && mode === 'edit' && (
                <a href={keyUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--neox-primary-600)' }}>{zh ? '获取 Key ↗' : 'Get key ↗'}</a>
              )}
            </label>
            <div className="apf-key">
              <NeoxInput
                id="apf-key"
                type={showKey ? 'text' : 'password'}
                value={(tabs[active]?.apiKey) || ''}
                onChange={(e) => patchTab(active, { apiKey: e.target.value.replace(/\s+/g, '') })}
                /* 粘进来的常是整行 env / 带引号 / 带 Bearer —— 粘的那一下就洗干净 */
                onPaste={(e) => {
                  const raw = e.clipboardData.getData('text');
                  const cleaned = cleanPastedSecret(raw);
                  if (cleaned && cleaned !== raw) {
                    e.preventDefault();
                    patchTab(active, { apiKey: cleaned });
                  }
                }}
                placeholder={auth.format ? (zh ? `粘贴 Key (${auth.format})` : `Paste key (${auth.format})`) : (zh ? '粘贴 API Key' : 'Paste API key')}
                autoComplete="off"
                spellCheck={false}
                autoFocus={mode === 'add' && !activeKey}
              />
              <div className="apf-key__tools">
                <button type="button" className="apf-key__btn" onClick={() => setShowKey((v) => !v)} title={showKey ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')} aria-label={showKey ? (zh ? '隐藏 Key' : 'Hide key') : (zh ? '显示 Key' : 'Show key')}>
                  {showKey ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 4.2A10 10 0 0 1 12 4c5 0 9 5 10 8a13 13 0 0 1-3.2 4.3M6.6 6.6A13 13 0 0 0 2 12c1 3 5 8 10 8a9.8 9.8 0 0 0 5.4-1.6" /></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
                  )}
                </button>
              </div>
            </div>
            <div className={`apf-verify${verifyState === 'busy' ? ' is-busy' : verifyState === 'ok' ? ' is-ok' : verifyState === 'err' ? ' is-err' : ''}`} aria-live="polite">
              {verifyState !== 'idle' && <span className="apf-verify__dot" aria-hidden />}
              <span className="apf-verify__msg">
                {verifyState === 'busy' && (zh ? '正在用这个 Key 连一下…' : 'Checking this key…')}
                {verifyState === 'ok' && testState.status === 'ok' && (
                  <>
                    {zh ? <>Key 可用 · {testState.latency}ms</> : <>Key works · {testState.latency}ms</>}
                    {remoteList.length > 0 && (zh ? <> · 找到 <b>{remoteList.length}</b> 个模型</> : <> · <b>{remoteList.length}</b> models</>)}
                    {autoPicked && formModels.includes(autoPicked) && (zh ? `, 先选了 ${autoPicked}, 下面可以增减` : `; picked ${autoPicked} to start — adjust below`)}
                  </>
                )}
                {verifyState === 'err' && (
                  <>{zh ? '没通过: ' : 'Didn’t work: '}{verifyError.slice(0, 240)}</>
                )}
                {verifyState === 'idle' && !activeKey && mode === 'add' && (
                  zh ? '粘上后会自动验证, 并拉取这个 Key 能用的模型' : 'Once pasted we verify it and fetch the models this key can use'
                )}
              </span>
            </div>
          </div>

          <div className="apf-row2">
          {/* 名称 */}
          <div className="apf-field">
            <label className="apf-label" htmlFor="apf-name"><span>{t?.settings?.providers?.name ?? (zh ? '名称' : 'Name')}</span></label>
            <NeoxInput id="apf-name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={editingProvider?.name ?? (kernelPreset?.label || 'My Provider')} />
            <span className="apf-sub">{zh ? '模型选择器里显示的名字' : 'Shown in the model picker'}</span>
          </div>
          {/* Base URL —— 贴址自动识别协议; 协议下拉; 实时请求预览。三样合一。 */}
          <div className="apf-field">
            <label className="apf-label" htmlFor="apf-base"><span>{t?.settings?.providers?.baseUrl ?? (zh ? '接口地址' : 'Base URL')} <small>{zh ? '· 协议按地址自动识别' : '· protocol auto-detected'}</small></span></label>
              <div>
                <NeoxInput
                  id="apf-base"
                  value={formBaseUrl}
                  onChange={(e) => onBaseUrlChange(e.target.value)}
                  placeholder={getDefaultBaseUrl((tabs[active]?.protocol as any) || 'openai')}
                />
                <div style={{ marginTop: 8 }}>
                  <CustomSelect
                    value={curProtocol}
                    onChange={(value: string) => { patchTab(active, { protocol: value }); setFormUrlSuffix(getDefaultUrlSuffix(value as any)); }}
                    options={zh ? protocolOptions : protocolOptions.map((o) => ({ ...o, label: protocolLabelEn(o.label) }))}
                  />
                </div>
                {/* 实时请求预览 (+ 缺 /v1 警告) */}
                {(() => {
                  const base = formBaseUrl.trim();
                  if (!base) return null;
                  let joined = ''; let origin = ''; let basePath = '';
                  try {
                    const u = new URL(base);
                    origin = u.origin;
                    basePath = u.pathname.replace(/\/+$/, '');
                    const suffix = (formUrlSuffix || getDefaultUrlSuffix(formProtocol) || '').trim();
                    joined = `${basePath}${suffix && !suffix.startsWith('/') ? '/' : ''}${suffix}`;
                  } catch { return null; }
                  const docs = findApiDocs(base);
                  const missingVersion = /^openai/i.test(formProtocol)
                    && !/\/v\d/.test(joined)
                    && !VERSIONLESS_HOSTS.some(h => origin.includes(h));
                  return (
                    <div style={{ marginTop: 6, paddingLeft: FIELD_TEXT_INSET, fontSize: 11, lineHeight: 1.5, color: missingVersion ? 'var(--neox-warning-600, #b45309)' : 'var(--neox-fg-hint)' }}>
                      {zh ? '实际请求: ' : 'Requests go to: '}<code>{origin}{joined || '/'}</code>
                      {missingVersion && (
                        <div>{zh
                          ? `⚠️ 路径里没有 /v1 — Base URL 可能应为 ${origin}${basePath}/v1`
                          : `⚠️ No /v1 in path — Base URL likely should be ${origin}${basePath}/v1`}</div>
                      )}
                      {docs && (
                        <div style={{ marginTop: 2 }}>
                          <a
                            href={docs.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--neox-primary-500, #6366f1)', textDecoration: 'none' }}
                          >
                            {zh ? `${docs.vendor} 官方接口文档 ↗` : `${docs.vendor} API docs ↗`}
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
          </div>
          </div>
        </div>
      </Section>

      <Section>
        <div onClick={() => setShowAdvanced(v => !v)}
          role="button"
          aria-expanded={showAdvanced}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, padding: '4px 0' }}>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
            style={{
              flexShrink: 0,
              color: 'var(--neox-fg-secondary, #9ca3af)',
              transform: showAdvanced ? 'rotate(90deg)' : 'none',
              transition: 'transform 160ms ease',
            }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          {zh ? '高级' : 'Advanced'}
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--neox-fg-secondary, #9ca3af)' }}>
            {zh ? '路径后缀 · Token 上限 · 身份策略' : 'path suffix · token limits · identity'}
          </span>
        </div>
        {showAdvanced && (
          <SettingsCard>
            <SettingsRow
              className="nx-row--top"
              title={zh ? '路径后缀' : 'Path Suffix'}
              desc={zh ? '留空按协议默认, 如 /v1/chat/completions' : 'Empty = protocol default'}
              control={<div style={{ width: ACCESS_FIELD_W }}><NeoxInput value={formUrlSuffix} onChange={(e) => setFormUrlSuffix(e.target.value)} placeholder={getDefaultUrlSuffix(formProtocol)} /></div>}
            />
            {tabs.length > 1 && (
              <SettingsRow
                className="nx-row--top"
                title={zh ? '此 Tab Base URL' : 'Tab Base URL'}
                desc={zh ? '留空 = 用上面账户地址' : 'Empty = account baseUrl'}
                control={<div style={{ width: ACCESS_FIELD_W }}><NeoxInput value={(tabs[active]?.baseUrl) || ''} onChange={(e) => patchTab(active, { baseUrl: e.target.value })} placeholder={zh ? '可选' : 'optional'} /></div>}
              />
            )}
            <SettingsRow
              className="nx-row--top"
              title={t?.settings?.providers?.maxTokens ?? (zh ? '最大输出 Tokens' : 'Max Output Tokens')}
              desc={zh ? '单次最大输出 token' : 'Max output per request'}
              control={<div style={{ width: ACCESS_FIELD_W }}><NeoxInput type="number" value={formMaxTokens} onChange={(e) => setFormMaxTokens(e.target.value)} placeholder="8192" /></div>}
            />
            <SettingsRow
              className="nx-row--top"
              title={t?.settings?.providers?.maxInputTokens ?? (zh ? '最大输入 Tokens' : 'Max Input Tokens')}
              desc={zh ? '上下文窗口 (留空自动)' : 'Context window (auto if empty)'}
              control={<div style={{ width: ACCESS_FIELD_W }}><NeoxInput type="number" value={formMaxInputTokens} onChange={(e) => setFormMaxInputTokens(e.target.value)} placeholder="120000" /></div>}
            />
            {formProtocol === 'anthropic' && (
              <SettingsRow
                className="nx-row--top"
                title={zh ? 'Claude Code 身份' : 'Claude Code Identity'}
                desc={zh ? '自动按 baseUrl 判。某些第三方代理必须收 Claude Code 头才放行。' : 'Auto by baseUrl; some proxies require Claude Code headers.'}
                control={<div style={{ width: ACCESS_FIELD_W }}>
                  <CustomSelect value={formClaudeCodeMode} onChange={(v: string) => setFormClaudeCodeMode(v as 'auto' | 'on' | 'off')}
                    options={[{ value: 'auto', label: zh ? '自动 (按 baseUrl)' : 'Auto (by baseUrl)' }, { value: 'on', label: zh ? '强制 Claude Code' : 'Force Claude Code' }, { value: 'off', label: zh ? 'Neox 原生' : 'Neox Native' }]} />
                </div>}
              />
            )}
            {/* 图生图编辑格式 (协议层) —— 不同代理载荷不一样, 这里明确选, 不靠运行时试错. */}
            <SettingsRow
              className="nx-row--top"
              title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {zh ? '图片编辑格式' : 'Image edit format'}
                <span
                  title={zh
                    ? '图生图（去背景/换装/改图）把图片发给上游的载荷格式，不同代理不一样：\n· images 数组 = 现代 gpt-image 代理——默认，绝大多数选它\n· image 字段 = 经典 OpenAI 兼容\n· OpenRouter 自动（走 input_references），不看此项\n图生图报「images[].image_url is required」这类错误时，换另一种。'
                    : 'Payload format for image-to-image edits (varies by upstream):\n· images array = modern gpt-image proxies (default)\n· image field = classic OpenAI-compatible\n· OpenRouter is automatic (input_references).\nIf edits fail with "images[].image_url is required", switch.'}
                  style={{ display: 'inline-flex', cursor: 'help', color: 'var(--neox-fg-hint, #b0b0b8)' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                </span>
              </span>}
              desc={zh ? '图生图上传格式，一般用默认即可' : 'Payload format for image-to-image; default is fine for most'}
              control={<div style={{ width: ACCESS_FIELD_W }}>
                <CustomSelect value={formImageEditFormat || ''} onChange={(v: string) => setFormImageEditFormat(v as '' | 'images-array' | 'image-field')}
                  options={[
                    { value: '', label: zh ? '默认 (images 数组)' : 'Default (images array)' },
                    { value: 'images-array', label: zh ? 'images 数组 (现代代理)' : 'images array (modern)' },
                    { value: 'image-field', label: zh ? '经典 image 字段' : 'classic image field' },
                  ]} />
              </div>}
            />
          </SettingsCard>
        )}
      </Section>

      {/* 模型 — 复用 SettingsPage 的 renderModelSelector.
       *   注意: renderModelSelector 内部 CSS 用 .modal-form .xxx scope (历史包袱), 必须包
       *   <div className="modal-form"> wrapper 让 dropdown/preset-option 等 CSS 真正命中.
       *   不能放 SettingsCard 里 — SettingsCard overflow:hidden 会切 absolute dropdown. */}
      <Section className="apiv2-model-section">
        <SectionTitle
          title={tabs.length > 1 ? (zh ? `模型 · 当前 Tab${active + 1}` : `Models · Tab${active + 1}`) : (zh ? '模型' : 'Models')}
          desc={tabs.length > 1
            ? (zh ? '切 Tab 编辑各自的模型。' : 'Switch tabs to edit each.')
            : undefined} />
        <div className="modal-form apiv2-edit-host">
          {renderModelSelector()}
        </div>
      </Section>

      <Section>
        <SectionTitle
          title={zh ? '显示控制' : 'Display Controls'}
          desc={zh ? '只控制这个服务商是否出现在模型选择器的 BYOK 菜单' : 'Only controls whether this provider appears in the BYOK menu'}
        />
        <div className="apiv2-display-control">
          <button
            type="button"
            role="switch"
            aria-checked={formShowInModelPicker}
            className={`apiv2-display-control__switch${formShowInModelPicker ? ' is-on' : ''}`}
            onClick={() => setFormShowInModelPicker((v: boolean) => !v)}
          >
            <span className="apiv2-display-control__copy">
              <strong>{zh ? '显示到模型选择器' : 'Show in model picker'}</strong>
              <span>
                {formShowInModelPicker
                  ? (zh ? '会在 BYOK 菜单中显示' : 'Shown in the BYOK menu')
                  : (zh ? '配置保留，但从 BYOK 菜单隐藏' : 'Configured, but hidden from the BYOK menu')}
              </span>
            </span>
            <span className="apiv2-display-control__track" aria-hidden>
              <span />
            </span>
          </button>
          <p className="apiv2-display-control__note">
            {mode === 'add'
              ? (zh ? '新增服务商默认开启，保存后马上可在模型选择器里找到。' : 'New providers are shown by default after saving.')
              : (zh ? '这里不影响 API Key、模型列表和实际调用能力。' : 'This does not affect API keys, models, or runtime calls.')}
          </p>
          {formShowInModelPicker && mode === 'edit' && editingProvider?.id && formModels.length > 0 && (
            <ByokModelChecklist providerId={editingProvider.id} models={formModels} zh={zh} />
          )}
        </div>
      </Section>

      </>
      )}

      {/* 底部 Test / Cancel / Save. 只在 Step 2 显 (preset picked / custom / edit). */}
      {(mode === 'edit' || presetId || customMode) && (
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, marginTop: 24, paddingBottom: 12, flexWrap: 'wrap',
      }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', minHeight: 32 }}>
          <NeoxButton
            variant="secondary"
            onClick={() => setProbeOpen((v) => !v)}
            aria-expanded={probeOpen}
            leading={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            }
          >
            {zh ? '测试' : 'Test'}
          </NeoxButton>
          {probeOpen && (
            <ProviderTestPopover
              zh={zh}
              models={formModels as string[]}
              model={(formModels.includes(testModel) ? testModel : formModels[0]) || ''}
              onModelChange={(v) => { setTestModel(v); setTestState({ status: 'idle' }); }}
              runConnection={() => { void handleTest(); }}
              connection={testSig === 'manual' ? testStatusBadge() : null}
              onClose={() => setProbeOpen(false)}
              getBase={(model) => {
                const apiKey = (formApiKey && formApiKey.trim()) || (mode === 'edit' && editingProvider?.apiKey) || '';
                if (!formBaseUrl?.trim()) return { error: zh ? '请先填入 Base URL' : 'Please enter Base URL first' };
                if (!model) return { error: zh ? '先在上面加一个模型' : 'Add a model above first' };
                if (!apiKey) return { error: zh ? '请先填入 API Key' : 'Please enter API Key first' };
                return {
                  providerId: editingProvider?.id,
                  protocol: formProtocol,
                  baseUrl: formBaseUrl,
                  urlSuffix: formUrlSuffix || getDefaultUrlSuffix(formProtocol),
                  /* 编辑模式 Key 留空: 不传, 主进程按 providerId 用已存的 */
                  apiKey: (formApiKey || '').trim() || undefined,
                  model,
                  claudeCodeMode: formProtocol === 'anthropic' ? formClaudeCodeMode : undefined,
                };
              }}
            />
          )}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <NeoxButton variant="secondary" onClick={handleBack}>
            {t?.common?.cancel ?? (zh ? '取消' : 'Cancel')}
          </NeoxButton>
          <NeoxButton variant="primary" onClick={handleSave}>
            {mode === 'edit'
              ? (t?.common?.save ?? (zh ? '保存' : 'Save'))
              : (t?.common?.add ?? (zh ? '添加' : 'Add'))}
          </NeoxButton>
        </div>
      </div>
      )}
    </div>
  );
};

export default ProviderEditForm;
