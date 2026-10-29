import React, { useCallback, useEffect, useState } from 'react';
import { CustomSelect } from '../../../../components/CustomSelect';
import Icons from '../../../../components/Icons';
import { Section, SettingsCard, SettingsRow, SliderRow, Switch, SwitchRow } from '../../../../components/settings-base';
import { isLiteEdition } from '../../../../utils/edition';
import { useAgentModeVariant } from '../../../../hooks/useAgentModeVariant';
import { BlurInput, EngineRow, Glyph, KindChooser, ModelRow, SecretField, SpeakerIcon, keyDesc, revealVoiceSecret, type VoiceKind } from './VoiceParts';
import { DashscopeHostSelect } from './dashscope';
import type { LocalVoice } from './useLocalVoice';

type CloudProvider = 'edge' | 'neoxcloud' | 'dashscope' | 'openai' | 'custom';

interface TtsView {
  enabled: boolean;
  provider: CloudProvider | 'local';
  voice: string;
  model: string;
  speed: number;
  format: string;
  autoSummarize: boolean;
  apiUrl: string;
  apiKey: string;
  dashscopeApiHost: string;
  localModel: string;
}

const EMPTY: TtsView = {
  enabled: false, provider: 'edge', voice: '', model: '', speed: 1, format: 'mp3', autoSummarize: true,
  apiUrl: '', apiKey: '', dashscopeApiHost: '', localModel: '',
};

type TtsApi = { ttsGetConfig?: () => Promise<Partial<TtsView>>; ttsSetConfig?: (u: Record<string, unknown>) => Promise<{ runtimeWarning?: string } | unknown> };
const ttsApi = (): TtsApi => (window as unknown as { neox?: TtsApi }).neox ?? {};

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

const CLOUD_OPTIONS = (zh: boolean): Array<{ value: CloudProvider; label: string }> => [
  { value: 'edge', label: zh ? 'Edge · 免费, 不用配置' : 'Edge · free, no setup' },
  { value: 'neoxcloud', label: zh ? 'Neox Cloud · 订阅内' : 'Neox Cloud · included in plan' },
  { value: 'dashscope', label: zh ? '国内 · 阿里云百炼 CosyVoice' : 'China · Alibaba CosyVoice' },
  { value: 'openai', label: zh ? '海外 · OpenAI' : 'Global · OpenAI' },
  { value: 'custom', label: zh ? '其他 · OpenAI 兼容接口 (硅基流动等)' : 'Other · OpenAI-compatible' },
];

const V3_VOICES = [
  ['longanyang', '龙安杨 · 男'], ['longxiaochun_v3', '龙小淳 · 女'], ['longxiaoxia_v3', '龙小夏 · 女'], ['longwan_v3', '龙婉 · 女'],
  ['longcheng_v3', '龙橙 · 男'], ['longhua_v3', '龙华 · 男'], ['longshu_v3', '龙书 · 男'],
];
const V2_VOICES = [
  ['longxiaochun_v2', '龙小淳 · 女'], ['longxiaoxia_v2', '龙小夏 · 女'], ['longwan_v2', '龙婉 · 女'], ['longcheng_v2', '龙橙 · 男'], ['longhua_v2', '龙华 · 男'],
];
/** 老配置里存的是失效裸名 (longxiaobai 等), 合成时 core 归一到真实音色 —— 选择器跟着显示归一后的那个 */
function effectiveV3Voice(voice: string, model: string): string {
  if (/v2/.test(model)) return voice;
  if (V3_VOICES.some(([v]) => v === voice)) return voice;
  if (voice === 'longxiaobai' || voice === 'longxiaobai_v3') return 'longxiaochun_v3';
  const v3 = `${voice.replace(/_v[23]$/, '')}_v3`;
  return V3_VOICES.some(([v]) => v === v3) ? v3 : 'longanyang';
}

export const VoiceOutputSection: React.FC<{ zh: boolean; lv: LocalVoice }> = ({ zh, lv }) => {
  const { isWork: plain } = useAgentModeVariant();
  const [cfg, setCfg] = useState<TtsView>(EMPTY);
  const [lastCloud, setLastCloud] = useState<CloudProvider>('edge');

  const load = useCallback(async () => {
    const r = await ttsApi().ttsGetConfig?.().catch(() => null);
    if (!r) return;
    setCfg(c => ({ ...c, ...r }) as TtsView);
    if (r.provider && r.provider !== 'local') setLastCloud(r.provider as CloudProvider);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: Partial<TtsView>) => {
    setCfg(c => ({ ...c, ...patch }));
    try {
      const r = await ttsApi().ttsSetConfig?.(patch) as { runtimeWarning?: string } | undefined;
      if (r?.runtimeWarning) {
        const m = await import('../../../../components/notifyEvents');
        m.dispatchHint(zh ? '已保存，重启后当前会话才会用上' : 'Saved — applies after restart', 'warning');
      }
    } catch (e) {
      const m = await import('../../../../components/notifyEvents');
      m.dispatchHint(`${zh ? '保存失败' : 'Save failed'}: ${e instanceof Error ? e.message : String(e)}`, 'warning');
    }
    /* 换服务商时后端恢复那一家存过的音色 / key, 重读 */
    if (patch.provider) void load();
  }, [load, zh]);

  const kind: VoiceKind = cfg.provider === 'local' ? 'local' : 'cloud';
  /* 极简版不推本地合成 (几十 MB 模型下载跟"极简"冲突); 已经选了本地的照常显示, 否则会看到一个选不回去的当前值 */
  const localBlocked = !IS_MAC || !lv.supported || (isLiteEdition() && kind !== 'local');
  const pickKind = (k: VoiceKind) => { if (k !== kind) void save({ provider: k === 'local' ? 'local' : lastCloud }); };

  const ttsModels = lv.models.filter(m => m.id.startsWith('tts-'));
  const installed = ttsModels.filter(m => m.installed);
  const active = installed.find(m => m.active);

  return (
    <Section>
      <SettingsCard>
        <SettingsRow
          leading={<Glyph><SpeakerIcon /></Glyph>}
          title={zh ? '把回复念出来' : 'Read replies aloud'}
          desc={zh ? 'Agent 回复完自动念给你听。' : 'Replies are read to you when they finish.'}
          control={<Switch checked={cfg.enabled} aria-label={zh ? '语音播报' : 'Read replies aloud'} onChange={(v) => void save({ enabled: v })} />}
        />
      </SettingsCard>

      {cfg.enabled && <>
        <KindChooser
          zh={zh}
          value={kind}
          onPick={pickKind}
          localDisabled={localBlocked}
          localDesc={localBlocked
            ? (!IS_MAC || !lv.supported ? (zh ? '目前只支持 Mac (Apple 芯片)。' : 'Mac (Apple silicon) only for now.') : (zh ? '极简版不带本地合成。' : 'Not in the Lite edition.'))
            : (zh ? '不联网，首句最快。' : 'Offline, fastest first sentence.')}
          cloudDesc={zh ? '音色更多，Edge 免费。' : 'More voices; Edge is free.'}
        />

        {kind === 'local' && (
          <SettingsCard>
            <EngineRow zh={zh} lv={lv} />
            {ttsModels.map(m => (
              <ModelRow key={m.id} zh={zh} lv={lv} m={m} note={
                m.id === 'tts-melo-zh-en' ? (zh ? '推荐 · 快, 中英混说' : 'Recommended · fast, zh/en')
                  : m.id === 'tts-kokoro-multi' ? (zh ? '音质更好, 慢 2.5 倍' : 'Better voice, 2.5× slower') : undefined
              } />
            ))}
            {installed.length > 1 && (
              <SettingsRow
                title={zh ? '合成用' : 'Speak with'}
                control={
                  <div style={{ width: 'min(100%, 240px)' }}>
                    <CustomSelect value={cfg.localModel} onChange={(v) => void save({ localModel: v })}
                      options={[{ value: '', label: zh ? '自动 (Melo)' : 'Auto (Melo)' }, ...installed.map(m => ({ value: m.id, label: m.title }))]} />
                  </div>
                }
              />
            )}
            {active?.id === 'tts-kokoro-multi' && (
              <SettingsRow
                title={zh ? '音色编号' : 'Voice number'}
                desc={zh ? '中文 45–52：45 小北 · 47 小晓 (默认) · 49 云健 · 50 云希' : 'Chinese voices 45–52 (47 default)'}
                control={<BlurInput width={100} value={cfg.voice} placeholder="47" onSave={(v) => void save({ voice: v })} />}
              />
            )}
          </SettingsCard>
        )}

        {kind === 'cloud' && (
          <SettingsCard>
            <SettingsRow
              leading={<Glyph><Icons.Cloud /></Glyph>}
              title={zh ? '服务商' : 'Provider'}
              control={
                <div style={{ width: 'min(100%, 280px)' }}>
                  <CustomSelect value={cfg.provider} options={CLOUD_OPTIONS(zh)}
                    onChange={(v) => { setLastCloud(v as CloudProvider); void save({ provider: v as CloudProvider }); }} />
                </div>
              }
            />
            <CloudFields zh={zh} cfg={cfg} save={save} />
          </SettingsCard>
        )}

        <SettingsCard>
          <SliderRow title={zh ? '语速' : 'Speed'} value={cfg.speed} min={0.5} max={2} step={0.1}
            onChange={(v) => void save({ speed: v })} formatValue={(v) => `${v.toFixed(1)}x`} />
          <SwitchRow
            leading={<Glyph><Icons.Sparkles /></Glyph>}
            title={zh ? '长回复先缩短再念' : 'Shorten long replies first'}
            desc={zh ? '压成几句要点，免得听一大段。' : 'Condensed to a few points so you are not read a wall of text.'}
            checked={cfg.autoSummarize}
            onChange={(v) => void save({ autoSummarize: v })}
          />
          {!plain && kind === 'cloud' && (
            <SettingsRow advanced title={zh ? '音频格式' : 'Format'}
              control={
                <div style={{ width: 'min(100%, 140px)' }}>
                  {/* 当前值不在这三项里 (用过本地合成留下的 wav) 时补进列表, 显示的永远是实际在用的那个 */}
                  <CustomSelect value={cfg.format} onChange={(v) => void save({ format: v })}
                    options={[{ value: 'mp3', label: 'MP3' }, { value: 'opus', label: 'Opus' }, { value: 'pcm', label: 'PCM' },
                      ...(['mp3', 'opus', 'pcm'].includes(cfg.format) ? [] : [{ value: cfg.format, label: cfg.format.toUpperCase() }])]} />
                </div>
              } />
          )}
        </SettingsCard>
      </>}
    </Section>
  );
};

const CloudFields: React.FC<{ zh: boolean; cfg: TtsView; save: (p: Partial<TtsView>) => Promise<void> }> = ({ zh, cfg, save }) => {
  switch (cfg.provider) {
    case 'edge':
      return <SettingsRow title={zh ? '不用配置' : 'Nothing to set up'} desc={zh ? '微软 Edge 的在线音色，免费。' : 'Microsoft Edge online voices, free.'} />;
    case 'neoxcloud':
      return (
        <SettingsRow title={zh ? '音色' : 'Voice'} desc={zh ? '走订阅，不用 Key' : 'Uses your plan, no key'}
          control={
            <div style={{ width: 'min(100%, 200px)' }}>
              <CustomSelect value={cfg.voice || 'longxiaochun_v2'} onChange={(v) => void save({ voice: v })}
                options={V2_VOICES.map(([value, label]) => ({ value, label }))} />
            </div>
          } />
      );
    case 'dashscope': {
      const v2 = /v2/.test(cfg.model);
      return <>
        <SettingsRow title="API Key" desc={keyDesc(zh, cfg.apiKey, zh ? '百炼控制台 → API-KEY 管理' : 'DashScope console → API keys')}
          control={<SecretField zh={zh} value={cfg.apiKey} placeholder="sk-..." reveal={revealVoiceSecret('tts', 'apiKey')} onSave={(v) => void save({ apiKey: v })} />} />
        <SettingsRow title={zh ? '地域' : 'Region'}
          control={<DashscopeHostSelect zh={zh} value={cfg.dashscopeApiHost} onChange={(h) => void save({ dashscopeApiHost: h })} />} />
        <SettingsRow title={zh ? '模型' : 'Model'}
          control={
            <div style={{ width: 'min(100%, 240px)' }}>
              <CustomSelect value={cfg.model || 'cosyvoice-v3-plus'} onChange={(v) => void save({ model: v })}
                options={[
                  { value: 'cosyvoice-v3-plus', label: zh ? 'v3-plus · 音质最好' : 'v3-plus · best' },
                  { value: 'cosyvoice-v3-flash', label: zh ? 'v3-flash · 最快' : 'v3-flash · fastest' },
                  { value: 'cosyvoice-v2', label: zh ? 'v2 · 稳定' : 'v2 · stable' },
                ]} />
            </div>
          } />
        <SettingsRow title={zh ? '音色' : 'Voice'}
          control={
            <div style={{ width: 'min(100%, 200px)' }}>
              <CustomSelect value={v2 ? (cfg.voice || 'longxiaochun_v2') : effectiveV3Voice(cfg.voice || 'longanyang', cfg.model)}
                onChange={(v) => void save({ voice: v })}
                options={(v2 ? V2_VOICES : V3_VOICES).map(([value, label]) => ({ value, label }))} />
            </div>
          } />
      </>;
    }
    case 'openai':
    case 'custom':
      return <>
        {cfg.provider === 'custom' && (
          <SettingsRow title={zh ? '接口地址' : 'Base URL'} desc={zh ? '填到 /v1，如 https://api.siliconflow.cn/v1' : 'e.g. https://api.siliconflow.cn/v1'}
            control={<BlurInput value={cfg.apiUrl} placeholder="https://api.siliconflow.cn/v1" onSave={(v) => void save({ apiUrl: v })} />} />
        )}
        <SettingsRow title="API Key" desc={keyDesc(zh, cfg.apiKey, '')}
          control={<SecretField zh={zh} value={cfg.apiKey} placeholder="sk-..." reveal={revealVoiceSecret('tts', 'apiKey')} onSave={(v) => void save({ apiKey: v })} />} />
        <SettingsRow title={zh ? '模型' : 'Model'} desc={cfg.provider === 'openai' ? (zh ? '留空用 tts-1' : 'Blank = tts-1') : (zh ? '如 FunAudioLLM/CosyVoice2-0.5B' : 'e.g. FunAudioLLM/CosyVoice2-0.5B')}
          control={<BlurInput value={cfg.model} placeholder={cfg.provider === 'openai' ? 'tts-1' : 'FunAudioLLM/CosyVoice2-0.5B'} onSave={(v) => void save({ model: v })} />} />
        <SettingsRow title={zh ? '音色' : 'Voice'} desc={cfg.provider === 'openai' ? 'alloy / nova / shimmer …' : (zh ? '硅基流动写成 模型名:音色名' : 'SiliconFlow: model:voice')}
          control={<BlurInput value={cfg.voice} placeholder={cfg.provider === 'openai' ? 'alloy' : 'FunAudioLLM/CosyVoice2-0.5B:alex'} onSave={(v) => void save({ voice: v })} />} />
      </>;
    default:
      return null;
  }
};
