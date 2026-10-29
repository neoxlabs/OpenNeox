import React, { useCallback, useEffect, useState } from 'react';
import { CustomSelect } from '../../../../components/CustomSelect';
import Icons from '../../../../components/Icons';
import { NeoxButton, Section, SettingsCard, SettingsRow, Switch } from '../../../../components/settings-base';
import { BlurInput, BlurTextarea, EngineRow, Glyph, KindChooser, ModelRow, SecretField, keyDesc, revealVoiceSecret, type VoiceKind } from './VoiceParts';
import { DashscopeHostSelect, DashscopeModelSelect, DASHSCOPE_ASR_MODELS, DEFAULT_MODEL_BY_MODE } from './dashscope';
import type { LocalVoice } from './useLocalVoice';
import { useVoiceSubscription } from '../../../../modules/agent-timeline/voiceReadiness';

type CloudProvider = 'official' | 'dashscope' | 'volc' | 'xfyun' | 'custom';

interface SttView {
  enabled: boolean;
  /** 用户自己选过服务商 (config.stt.provider 有值); 没选过时主进程走自动档 */
  providerExplicit?: boolean;
  provider: CloudProvider | 'local';
  apiUrl: string;
  apiKey: string;
  customModel: string;
  appId: string;
  apiSecret: string;
  volcAccessToken: string;
  volcResourceId: string;
  dashscopeApiHost: string;
  dashscopeConnMode: 'ws' | 'http';
  localModel: string;
  localFinalizer: string;
  hotwords: string;
  termFix: string;
}

const EMPTY: SttView = {
  enabled: true, provider: 'custom', apiUrl: '', apiKey: '', customModel: '', appId: '', apiSecret: '',
  volcAccessToken: '', volcResourceId: '', dashscopeApiHost: '', dashscopeConnMode: 'ws',
  localModel: '', localFinalizer: '', hotwords: '', termFix: '',
};

type SttApi = { sttGetConfig?: () => Promise<Partial<SttView>>; sttSetConfig?: (u: Record<string, unknown>) => Promise<unknown> };
const sttApi = (): SttApi => (window as unknown as { neox?: SttApi }).neox ?? {};

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

const CLOUD_OPTIONS = (zh: boolean, subscribed: boolean): Array<{ value: CloudProvider; label: string }> => [
  ...(subscribed ? [{ value: 'official' as const, label: zh ? 'Neox 订阅 · 不用配置' : 'Neox subscription · no setup' }] : []),
  { value: 'custom', label: zh ? 'OpenAI / 兼容接口 (Whisper)' : 'OpenAI / compatible (Whisper)' },
  { value: 'dashscope', label: zh ? '阿里云百炼' : 'Alibaba DashScope' },
  { value: 'volc', label: zh ? '火山引擎 (豆包)' : 'Volcengine (Doubao)' },
  { value: 'xfyun', label: zh ? '讯飞' : 'iFlytek' },
];

export const VoiceInputSection: React.FC<{ zh: boolean; lv: LocalVoice }> = ({ zh, lv }) => {
  const subscribed = useVoiceSubscription();
  const [cfg, setCfg] = useState<SttView>(EMPTY);
  /* 切到本地再切回云端时回到原来那家 (config 里只有一个 provider 字段, 这里记着上一个云端) */
  const [lastCloud, setLastCloud] = useState<CloudProvider>(subscribed ? 'official' : 'custom');

  const load = useCallback(async () => {
    const r = await sttApi().sttGetConfig?.().catch(() => null);
    if (!r) return;
    /* 显示的就是点麦克风时真会用的那一家: 订阅用户没自己选过 (也没装本地) = 走订阅; 不是订阅的存着 official 也用不了, 按 custom 显示 */
    if (subscribed && !r.providerExplicit && r.provider !== 'local') r.provider = 'official';
    if (r.provider === 'official' && !subscribed) r.provider = 'custom';
    setCfg(c => ({ ...c, ...r }) as SttView);
    if (r.provider && r.provider !== 'local') setLastCloud(r.provider as CloudProvider);
  }, [subscribed]);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: Partial<SttView> & { activeProfileId?: string }) => {
    setCfg(c => ({ ...c, ...patch }));
    await sttApi().sttSetConfig?.(patch);
    /* 输入框的麦克风按 stt.enabled 显隐 —— 广播一下让它马上跟上 (设置页是浮层, 输入框一直挂着) */
    try { window.dispatchEvent(new CustomEvent('neox:stt-config-changed')); } catch { /* noop */ }
    /* 换服务商时后端会把那一家存过的 key 恢复出来 (打码回显), 重读一次 */
    if (patch.provider) void load();
  }, [load]);

  const kind: VoiceKind = cfg.provider === 'local' ? 'local' : 'cloud';
  const pickKind = (k: VoiceKind) => {
    if (k === kind) return;
    void save({ provider: k === 'local' ? 'local' : lastCloud, activeProfileId: '' });
  };

  const asrModels = lv.models.filter(m => m.id.startsWith('asr-') || m.custom);
  const installed = asrModels.filter(m => m.installed);
  const main = installed.find(m => m.active) ?? null;
  const mainStreaming = !!main?.streaming;
  const finalizers = installed.filter(m => !m.streaming);

  return (
    <Section>
      <SettingsCard>
        <SettingsRow
          leading={<Glyph><Icons.Mic /></Glyph>}
          title={zh ? '在输入框说话' : 'Speak in the composer'}
          desc={zh ? '输入框多一个麦克风，说的话直接变成文字。' : 'Adds a microphone to the composer — speak instead of typing.'}
          control={<Switch checked={cfg.enabled} aria-label={zh ? '语音输入' : 'Voice input'} onChange={(v) => void save({ enabled: v })} />}
        />
      </SettingsCard>

      {cfg.enabled && <>
        <KindChooser
          zh={zh}
          value={kind}
          onPick={pickKind}
          localDisabled={!IS_MAC || !lv.supported}
          localDesc={!IS_MAC || !lv.supported
            ? (zh ? '目前只支持 Mac (Apple 芯片)。' : 'Mac (Apple silicon) only for now.')
            : (zh ? '不联网、不花钱，边说边出字。' : 'Offline and free, text as you speak.')}
          cloudDesc={zh ? '不用下载，选一家填 Key 就能用。' : 'No download — pick a provider and add a key.'}
        />

        {kind === 'local' && (
          <SettingsCard>
            <EngineRow zh={zh} lv={lv} />
            {asrModels.map(m => (
              <ModelRow key={m.id} zh={zh} lv={lv} m={m} note={
                m.id === 'asr-zipformer-zh-en' ? (zh ? '推荐 · 边说边出字' : 'Recommended · live text')
                  : m.id === 'asr-sensevoice' ? (zh ? '定稿用 · 中英日韩粤' : 'For finalizing · zh/en/ja/ko/yue')
                    : m.id === 'asr-paraformer-zh' ? (zh ? '定稿用 · 中文更准' : 'For finalizing · best for Chinese')
                      : m.custom ? (m.streaming ? (zh ? '导入 · 流式' : 'Imported · streaming') : (zh ? '导入 · 整段' : 'Imported · whole-utterance')) : undefined
              } />
            ))}
            <SettingsRow
              title={zh ? '导入自己的模型' : 'Import your own model'}
              desc={zh ? '选 sherpa-onnx 格式的模型文件夹 (解压后的官方模型包就是)。' : 'Pick a sherpa-onnx model folder (an unpacked release works as-is).'}
              control={<NeoxButton variant="ghost" size="sm" onClick={() => void importModel(zh, lv)}>{zh ? '选择文件夹…' : 'Choose folder…'}</NeoxButton>}
            />
            {installed.length > 1 && (
              <SettingsRow
                title={zh ? '识别用' : 'Recognize with'}
                desc={zh ? '自动 = 有实时识别先用它' : 'Auto prefers live recognition'}
                control={
                  <div style={{ width: 'min(100%, 240px)' }}>
                    <CustomSelect value={cfg.localModel} onChange={(v) => void save({ localModel: v })}
                      options={[{ value: '', label: zh ? '自动' : 'Auto' }, ...installed.map(m => ({ value: m.id, label: m.title }))]} />
                  </div>
                }
              />
            )}
            {mainStreaming && finalizers.length > 0 && (
              <SettingsRow
                title={zh ? '说完再定稿' : 'Finalize each sentence'}
                desc={zh ? '一句说完用整段模型再认一遍，更准，慢零点几秒。' : 'Re-reads each finished sentence with a whole-utterance model — more accurate, a fraction of a second slower.'}
                control={
                  <div style={{ width: 'min(100%, 240px)' }}>
                    <CustomSelect value={cfg.localFinalizer} onChange={(v) => void save({ localFinalizer: v })}
                      options={[
                        { value: '', label: zh ? '自动' : 'Auto' },
                        ...finalizers.map(m => ({ value: m.id, label: m.title })),
                        { value: 'off', label: zh ? '不定稿' : 'Off' },
                      ]} />
                  </div>
                }
              />
            )}
            {asrModels.some(m => !m.installed && !m.custom) ? (
              <SettingsRow
                title={zh ? '下载源' : 'Download source'}
                control={
                  <div style={{ width: 'min(100%, 200px)' }}>
                    <CustomSelect value={lv.source} onChange={(v) => lv.setSource(v as typeof lv.source)}
                      options={[
                        { value: 'auto', label: zh ? '自动 (国内优先)' : 'Auto' },
                        { value: 'cn', label: zh ? '国内镜像' : 'China mirror' },
                        { value: 'global', label: 'Hugging Face' },
                      ]} />
                  </div>
                }
              />
            ) : null}
          </SettingsCard>
        )}

        {kind === 'local' && installed.length > 0 && (
          <SettingsCard>
            <div className="vc-lexicon">
              <div className="vc-lexicon__head">
                <b>{zh ? '词库' : 'Vocabulary'}</b>
                <span>{mainStreaming
                  ? (zh ? '常说的专名，一行一个。识别时优先认成这些词，认错了也按读音改回来。' : 'Names you say often, one per line. Recognized first, and corrected by sound if misheard.')
                  : (zh ? '常说的专名，一行一个。认错了按读音改回来。' : 'Names you say often, one per line. Misheard ones are corrected by sound.')}</span>
              </div>
              <BlurTextarea value={cfg.hotwords} onSave={(v) => void save({ hotwords: v })} placeholder={zh ? '淮北师范大学\n人工智能学院\nNeox' : 'Neox\nKubernetes'} />
            </div>
            <div className="vc-lexicon">
              <div className="vc-lexicon__head">
                <b>{zh ? '专名纠正' : 'Corrections'}</b>
                <span>{zh ? '读音救不了的 (多是英文)，一行一条：正确写法: 常被听成的样子' : 'For words sound can’t fix (usually English): Correct: misheard, misheard'}</span>
              </div>
              <BlurTextarea value={cfg.termFix} onSave={(v) => void save({ termFix: v })} rows={3} placeholder={'DeepSeek: deep seek, deep sick\nQwen: queen'} />
            </div>
          </SettingsCard>
        )}

        {kind === 'cloud' && (
          <SettingsCard>
            <SettingsRow
              leading={<Glyph><Icons.Cloud /></Glyph>}
              title={zh ? '服务商' : 'Provider'}
              control={
                <div style={{ width: 'min(100%, 280px)' }}>
                  <CustomSelect value={cfg.provider} options={CLOUD_OPTIONS(zh, subscribed)}
                    onChange={(v) => { setLastCloud(v as CloudProvider); void save({ provider: v as CloudProvider, activeProfileId: '' }); }} />
                </div>
              }
            />
            <CloudFields zh={zh} cfg={cfg} save={save} />
          </SettingsCard>
        )}
      </>}
    </Section>
  );
};

async function importModel(zh: boolean, lv: LocalVoice): Promise<void> {
  const r = await lv.importModel();
  if (!r || r.canceled) return;
  const m = await import('../../../../components/notifyEvents');
  if (r.ok) m.dispatchHint(zh ? `已导入 ${r.title}${r.streaming ? ' (流式)' : ''}` : `Imported ${r.title}`, 'success');
  else m.dispatchHint(r.error || (zh ? '导入失败' : 'Import failed'), 'warning');
}

const CloudFields: React.FC<{ zh: boolean; cfg: SttView; save: (p: Partial<SttView>) => Promise<void> }> = ({ zh, cfg, save }) => {
  switch (cfg.provider) {
    case 'official':
      return <SettingsRow title={zh ? '不用配置' : 'Nothing to set up'} desc={zh ? '登录后直接能用，走订阅额度。' : 'Works once you are signed in; uses your plan.'} />;
    case 'dashscope':
      return <>
        <SettingsRow title="API Key" desc={keyDesc(zh, cfg.apiKey, zh ? '百炼控制台 → API-KEY 管理' : 'DashScope console → API keys')}
          control={<SecretField zh={zh} value={cfg.apiKey} placeholder="sk-..." reveal={revealVoiceSecret('stt', 'apiKey')} onSave={(v) => void save({ apiKey: v })} />} />
        <SettingsRow title={zh ? '地域' : 'Region'} desc={zh ? 'Key 在哪个地域开通就选哪个' : 'Where the key was created'}
          control={<DashscopeHostSelect zh={zh} value={cfg.dashscopeApiHost} onChange={(h) => void save({ dashscopeApiHost: h })} />} />
        <SettingsRow title={zh ? '出字方式' : 'Mode'} desc={zh ? '实时 = 边说边出字；整段 = 说完一起出' : 'Live = text as you speak; whole = after you stop'}
          control={
            <div style={{ width: 'min(100%, 200px)' }}>
              <CustomSelect value={cfg.dashscopeConnMode}
                onChange={(v) => {
                  const mode = v as 'ws' | 'http';
                  const spec = DASHSCOPE_ASR_MODELS.find(m => m.value === cfg.customModel);
                  const model = spec && !spec.supports.includes(mode) ? DEFAULT_MODEL_BY_MODE[mode] : cfg.customModel;
                  void save({ dashscopeConnMode: mode, customModel: model });
                }}
                options={[{ value: 'ws', label: zh ? '实时' : 'Live' }, { value: 'http', label: zh ? '整段' : 'Whole' }]} />
            </div>
          } />
        <SettingsRow title={zh ? '模型' : 'Model'}
          control={<DashscopeModelSelect zh={zh} value={cfg.customModel} connMode={cfg.dashscopeConnMode} onChange={(m) => void save({ customModel: m })} />} />
      </>;
    case 'volc':
      return <>
        <SettingsRow title="App Key" desc={zh ? '火山控制台 → 语音识别大模型 (流式) 开通后可见' : 'Volcengine console → streaming ASR'}
          control={<BlurInput value={cfg.appId} placeholder="0000000000" onSave={(v) => void save({ appId: v })} />} />
        <SettingsRow title="Access Token" desc={keyDesc(zh, cfg.volcAccessToken, zh ? '同一页的访问令牌' : 'Access token on the same page')}
          control={<SecretField zh={zh} value={cfg.volcAccessToken} reveal={revealVoiceSecret('stt', 'volcAccessToken')} onSave={(v) => void save({ volcAccessToken: v })} />} />
        <SettingsRow advanced title="Resource ID" desc={zh ? '按并发计费填 volc.bigasr.sauc.concurrent，其余留空' : 'Leave blank unless billed by concurrency'}
          control={<BlurInput value={cfg.volcResourceId} placeholder="volc.bigasr.sauc.duration" onSave={(v) => void save({ volcResourceId: v })} />} />
      </>;
    case 'xfyun':
      return <>
        <SettingsRow title="APPID" desc={zh ? '讯飞控制台 → 创建应用 → 开通「语音听写 (流式)」' : 'iFlytek console → app → streaming dictation'}
          control={<BlurInput value={cfg.appId} onSave={(v) => void save({ appId: v })} />} />
        <SettingsRow title="APIKey" desc={keyDesc(zh, cfg.apiKey, '')}
          control={<SecretField zh={zh} value={cfg.apiKey} reveal={revealVoiceSecret('stt', 'apiKey')} onSave={(v) => void save({ apiKey: v })} />} />
        <SettingsRow title="APISecret" desc={keyDesc(zh, cfg.apiSecret, '')}
          control={<SecretField zh={zh} value={cfg.apiSecret} reveal={revealVoiceSecret('stt', 'apiSecret')} onSave={(v) => void save({ apiSecret: v })} />} />
      </>;
    case 'custom':
      return <>
        <SettingsRow title={zh ? '接口地址' : 'Base URL'} desc={zh ? 'OpenAI 填 https://api.openai.com/v1；硅基流动等兼容接口同样填到 /v1' : 'e.g. https://api.openai.com/v1'}
          control={<BlurInput value={cfg.apiUrl} placeholder="https://api.openai.com/v1" onSave={(v) => void save({ apiUrl: v })} />} />
        <SettingsRow title="API Key" desc={keyDesc(zh, cfg.apiKey, '')}
          control={<SecretField zh={zh} value={cfg.apiKey} placeholder="sk-..." reveal={revealVoiceSecret('stt', 'apiKey')} onSave={(v) => void save({ apiKey: v })} />} />
        <SettingsRow title={zh ? '模型' : 'Model'} desc={zh ? '留空用 whisper-1' : 'Blank = whisper-1'}
          control={<BlurInput value={cfg.customModel} placeholder="whisper-1" onSave={(v) => void save({ customModel: v })} />} />
      </>;
    default:
      return null;
  }
};
