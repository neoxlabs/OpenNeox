/* 阿里云百炼: 地域 / 识别模型两个选择器 (语音输入、语音播报都用到地域) */
import React, { useState } from 'react';
import { CustomSelect } from '../../../../components/CustomSelect';

export interface AsrModelSpec { value: string; label: string; supports: Array<'ws' | 'http'> }
export const DASHSCOPE_ASR_MODELS: AsrModelSpec[] = [
  { value: 'paraformer-realtime-v2', label: 'paraformer-realtime-v2 · 中英混说', supports: ['ws'] },
  { value: 'fun-asr-realtime', label: 'fun-asr-realtime · 七大方言', supports: ['ws'] },
  { value: 'gummy-realtime-v2', label: 'gummy-realtime-v2 · 识别 + 翻译', supports: ['ws'] },
  { value: 'paraformer-realtime-8k-v2', label: 'paraformer-realtime-8k-v2 · 电话录音', supports: ['ws'] },
  { value: 'qwen3-asr-flash', label: 'qwen3-asr-flash · Qwen3 语音', supports: ['http'] },
  { value: 'fun-asr', label: 'fun-asr · 整段 (含方言)', supports: ['http'] },
  { value: 'paraformer-v2', label: 'paraformer-v2 · 整段', supports: ['http'] },
  { value: 'sensevoice-v1', label: 'sensevoice-v1 · 整段', supports: ['http'] },
];
export const DEFAULT_MODEL_BY_MODE: Record<'ws' | 'http', string> = { ws: 'paraformer-realtime-v2', http: 'qwen3-asr-flash' };

const HOSTS = (zh: boolean) => [
  { value: '', label: zh ? '北京 (国内)' : 'Beijing (China)' },
  { value: 'dashscope-intl.aliyuncs.com', label: zh ? '新加坡 (海外)' : 'Singapore (international)' },
  { value: '__custom__', label: zh ? '私有部署 (填实例域名)' : 'Private deployment' },
];

export const DashscopeHostSelect: React.FC<{ value: string; onChange: (h: string) => void; zh: boolean }> = ({ value, onChange, zh }) => {
  const hosts = HOSTS(zh);
  const isPreset = hosts.some(h => h.value === value && h.value !== '__custom__');
  const [custom, setCustom] = useState(!!value && !isPreset);
  const [draft, setDraft] = useState(custom ? value : '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 'min(100%, 280px)' }}>
      <CustomSelect
        value={custom ? '__custom__' : value}
        onChange={(v) => {
          if (v === '__custom__') { setCustom(true); if (draft) onChange(draft); return; }
          setCustom(false);
          onChange(v);
        }}
        options={hosts}
      />
      {custom && (
        <input type="text" className="settings-input" value={draft} placeholder="llm-xxxx.cn-beijing.maas.aliyuncs.com"
          onChange={(e) => setDraft(e.target.value)} onBlur={() => onChange(draft.trim())} />
      )}
    </div>
  );
};

export const DashscopeModelSelect: React.FC<{ value: string; connMode: 'ws' | 'http'; onChange: (m: string) => void; zh: boolean }> = ({ value, connMode, onChange, zh }) => {
  const opts = DASHSCOPE_ASR_MODELS.filter(m => m.supports.includes(connMode));
  const known = opts.some(m => m.value === value);
  const [custom, setCustom] = useState(!!value && !known && !DASHSCOPE_ASR_MODELS.some(m => m.value === value));
  const [draft, setDraft] = useState(custom ? value : '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 'min(100%, 280px)' }}>
      <CustomSelect
        value={custom ? '__custom__' : (known ? value : DEFAULT_MODEL_BY_MODE[connMode])}
        onChange={(v) => {
          if (v === '__custom__') { setCustom(true); if (draft) onChange(draft); return; }
          setCustom(false);
          onChange(v);
        }}
        options={[...opts, { value: '__custom__', label: zh ? '其他 (填模型名)' : 'Other (enter ID)' }]}
      />
      {custom && (
        <input type="text" className="settings-input" value={draft} placeholder={zh ? '模型名' : 'Model ID'}
          onChange={(e) => setDraft(e.target.value)} onBlur={() => onChange(draft.trim())} />
      )}
    </div>
  );
};
