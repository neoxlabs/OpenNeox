
import React, { useMemo, useRef, useState } from 'react';
import {
  getPresetsInRecommendedOrder,
  type ProviderPreset,
} from '@neoxlabs/kernel/models/providerPresets.js';
import type { Modality } from '@neoxlabs/kernel/types/configTypes.js';
import { ProviderBrandLogo } from './ProviderBrandLogo';
import { defaultIsZh } from '../../../hooks/useI18n';
import { NeoxIllus } from '../../../media/illus';
import { detectPasted } from '../utils/detectApiKey';

export interface PresetPickExtras {
  /** 用户在顶部粘的 key (已清洗) —— 表单直接填上 */
  apiKey?: string;
  /** 用户粘的接口地址 */
  baseUrl?: string;
}

interface Props {
  selectedId?: string;
  onPick: (preset: ProviderPreset, extras?: PresetPickExtras) => void;
  onCustom?: (extras?: PresetPickExtras) => void;
  onImport?: () => void;
  zh?: boolean;
}

const MOD_SHORT_ZH: Record<Modality, string> = {
  'chat': '对话', 'image': '图像', 'image-edit': '', 'tts': '语音',
  'stt': '转写', 'embedding': '向量', 'video': '视频', 'rerank': '',
};
const MOD_SHORT_EN: Record<Modality, string> = {
  'chat': 'Chat', 'image': 'Image', 'image-edit': '', 'tts': 'TTS',
  'stt': 'STT', 'embedding': 'Embed', 'video': 'Video', 'rerank': '',
};

function summarizeCapabilities(preset: ProviderPreset, zh: boolean): string[] {
  const seen = new Set<Modality>();
  for (const cap of preset.capabilities) seen.add(cap.modality);
  const labels = zh ? MOD_SHORT_ZH : MOD_SHORT_EN;
  return [...seen].map((m) => labels[m]).filter(Boolean);
}

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

export const ProviderPresetGallery: React.FC<Props> = ({ selectedId, onPick, onCustom, onImport, zh = defaultIsZh() }) => {
  const presets = useMemo(() => getPresetsInRecommendedOrder(), []);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const text = (cn: string, en: string) => (zh ? cn : en);

  const detection = useMemo(() => detectPasted(input), [input]);
  const pendingKey = detection.kind === 'key' ? detection.value : undefined;
  const candidates = detection.kind === 'key' ? detection.candidates : [];

  const query = detection.kind === 'text' ? input.trim().toLowerCase() : '';
  const matches = (p: ProviderPreset) =>
    !query
    || p.label.toLowerCase().includes(query)
    || p.id.includes(query)
    || p.tagline.toLowerCase().includes(query);
  const visible = presets.filter(matches);
  const global = visible.filter((p) => p.region === 'global');
  const china = visible.filter((p) => p.region === 'china');

  /* 粘进来的那一下就处理 —— 等用户再点一次"识别"是多余的一步。
   * 只在 paste 时自动跳: 打字过程中的半截字符串会被误判。 */
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const raw = e.clipboardData.getData('text');
    const d = detectPasted(raw);
    if (d.kind === 'key' && d.confident) {
      const preset = presets.find((p) => p.id === d.candidates[0]);
      if (preset) {
        e.preventDefault();
        onPick(preset, { apiKey: d.value });
        return;
      }
    }
    if (d.kind === 'url') {
      e.preventDefault();
      const host = hostOf(d.value);
      const preset = host ? presets.find((p) => hostOf(p.baseUrl) === host) : undefined;
      if (preset) onPick(preset, { baseUrl: d.value });
      else onCustom?.({ baseUrl: d.value });
    }
    /* 其余 (候选多家 / 认不出 / 普通文字) 照常落进输入框, 下面的提示行接手 */
  };

  const pick = (preset: ProviderPreset) => onPick(preset, pendingKey ? { apiKey: pendingKey } : undefined);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setInput(''); return; }
    if (e.key !== 'Enter') return;
    if (detection.kind === 'url') {
      onCustom?.({ baseUrl: detection.value });
    } else if (candidates.length > 0) {
      const first = presets.find((p) => p.id === candidates[0]);
      if (first) pick(first);
    } else if (detection.kind === 'text' && visible.length === 1) {
      pick(visible[0]!);
    }
  };

  const hint = (() => {
    if (!input.trim()) return null;
    if (detection.kind === 'url') {
      return <>{text('按回车用这个地址添加自定义服务商', 'Press Enter to add a custom provider with this URL')}</>;
    }
    if (detection.kind === 'key') {
      if (candidates.length === 0) {
        return <>{text('认不出是哪家的 Key —— 点一下对应的服务商, Key 会自动填进去', 'Can’t tell which provider this key is for — pick one below and the key goes with it')}</>;
      }
      const names = candidates
        .map((id) => presets.find((p) => p.id === id)?.label)
        .filter(Boolean)
        .join(text('、', ', '));
      if (detection.confident) {
        return <>{text(`认出来了, 是 ${names} 的 Key —— 回车或点它继续`, `That’s a ${names} key — press Enter or click it to continue`)}</>;
      }
      return <>{text(`这种格式几家都在用, 可能是 ${names} —— 点选后 Key 自动填入`, `Several providers use this format — likely ${names}. Pick one and the key goes with it`)}</>;
    }
    if (visible.length === 0) {
      return <>{text('没有匹配的服务商, 可以用最后一张「自定义」手动接入', 'No match — use the Custom card to connect manually')}</>;
    }
    return null;
  })();

  const renderCard = (preset: ProviderPreset) => {
    const caps = summarizeCapabilities(preset, zh);
    const isCandidate = candidates.includes(preset.id);
    const dimmed = candidates.length > 0 && !isCandidate;
    return (
      <button
        key={preset.id}
        type="button"
        onClick={() => pick(preset)}
        className="ppg-card"
        data-selected={selectedId === preset.id ? 'true' : undefined}
        data-candidate={isCandidate ? 'true' : undefined}
        data-dimmed={dimmed ? 'true' : undefined}
        title={preset.tagline}
      >
        <ProviderBrandLogo presetId={preset.id} fallbackLabel={preset.label} brandColor={preset.brandColor} size={36} variant="tile" />
        <span className="ppg-card__body">
          <span className="ppg-card__title">
            <span className="ppg-card__name">{preset.label}</span>
            {preset.id === 'openrouter' && <span className="ppg-card__badge">{text('推荐', 'Pick')}</span>}
          </span>
          <span className="ppg-card__caps">{caps.join(' · ')}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="ppg">
      <div className="ppg-hero">
        <img className="ppg-hero__art" src={NeoxIllus.routing} alt="" aria-hidden draggable={false} />
        <div className="ppg-hero__main">
          <div className="ppg-hero__title">{text('粘贴 API Key, 自动认出是哪家', 'Paste an API key — we’ll recognise the provider')}</div>
          <div className="ppg-search">
            <svg className="ppg-search__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              className="ppg-search__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={onKeyDown}
              placeholder={text('粘贴 Key / 接口地址, 或搜索服务商', 'Paste a key / API URL, or search providers')}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            {input && (
              <button type="button" className="ppg-search__clear" onClick={() => { setInput(''); inputRef.current?.focus(); }} aria-label={text('清空', 'Clear')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            )}
          </div>
          <div className={`ppg-hero__hint${hint ? ' is-active' : ''}`}>
            {hint ?? (onImport ? (
              <>
                {text('在 Codex / Claude Code / CC Switch 里配过? ', 'Already set up in Codex / Claude Code / CC Switch? ')}
                <button type="button" className="ppg-link" onClick={onImport}>{text('从本机导入', 'Import from this Mac')}</button>
              </>
            ) : null)}
          </div>
        </div>
      </div>

      {global.length > 0 && (
        <section className="ppg-group">
          <h4 className="ppg-group__head">{text('海外', 'Global')}</h4>
          <div className="ppg-grid">{global.map(renderCard)}</div>
        </section>
      )}

      <section className="ppg-group">
        {china.length > 0 && <h4 className="ppg-group__head">{text('国内', 'China')}</h4>}
        <div className="ppg-grid">
          {china.map(renderCard)}
          {onCustom && (
            <button
              type="button"
              onClick={() => onCustom(pendingKey ? { apiKey: pendingKey } : undefined)}
              className="ppg-card ppg-card--custom"
              data-dimmed={candidates.length > 0 ? 'true' : undefined}
            >
              <span className="provider-logo-tile ppg-card__plus" style={{ width: 36, height: 36, borderRadius: 9 }} aria-hidden>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </span>
              <span className="ppg-card__body">
                <span className="ppg-card__title"><span className="ppg-card__name">{text('自定义', 'Custom')}</span></span>
                <span className="ppg-card__caps">{text('中转站 / 自建网关 · 手填地址', 'Proxy / self-hosted · enter URL')}</span>
              </span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
};

/** 从 preset 转成老 form 需要的字段. chat 模型优先, 图像模型排后 (不污染 chat 首选). */
export function presetToLegacyForm(preset: ProviderPreset): {
  protocol: string;
  baseUrl: string;
  urlSuffix: string;
  defaultModel: string;
  models: string[];
  keyUrl: string;
} {
  const chatCap = preset.capabilities.find(c => c.modality === 'chat');
  const firstCap = chatCap ?? preset.capabilities[0];
  const protocol = firstCap?.protocol ?? 'openai';
  const urlSuffix = firstCap?.endpoint ?? '/chat/completions';
  /* chat 模型排在前, 图像/tts/等在后. chat 是默认 protocol 的匹配, 其他 modality 由 capability 系统按需选. */
  const chatModels = preset.commonModels.filter(m => (m.modalities ?? ['chat']).includes('chat'));
  const otherModels = preset.commonModels.filter(m => !(m.modalities ?? ['chat']).includes('chat'));
  const models = [...chatModels, ...otherModels].map(m => m.name);
  const defaultModel = chatModels[0]?.name ?? preset.commonModels[0]?.name ?? '';
  return {
    protocol,
    baseUrl: preset.baseUrl,
    urlSuffix,
    defaultModel,
    models,
    keyUrl: preset.docsUrl,
  };
}
