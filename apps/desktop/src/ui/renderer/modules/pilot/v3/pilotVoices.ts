/**
 * 分身能选的声音 —— 跟着设置里当前的语音合成引擎走 (Edge / Neox Cloud / 百炼 各有各的音色名)。
 * 音色表跟设置页 (pages/settings/tabs/voice/VoiceOutputSection.tsx) 同一份口径; OpenAI / 自定义 / 本地
 * 没有统一音色表, 那几家只给「跟设置里一样」。
 */
export interface VoiceChoice { id: string; label: string }

const EDGE: VoiceChoice[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男' },
];
const COSY_V2: VoiceChoice[] = [
  { id: 'longxiaochun_v2', label: '龙小淳 · 女' }, { id: 'longxiaoxia_v2', label: '龙小夏 · 女' }, { id: 'longwan_v2', label: '龙婉 · 女' },
  { id: 'longcheng_v2', label: '龙橙 · 男' }, { id: 'longhua_v2', label: '龙华 · 男' },
];
const COSY_V3: VoiceChoice[] = [
  { id: 'longanyang', label: '龙安杨 · 男' }, { id: 'longxiaochun_v3', label: '龙小淳 · 女' }, { id: 'longxiaoxia_v3', label: '龙小夏 · 女' },
  { id: 'longwan_v3', label: '龙婉 · 女' }, { id: 'longcheng_v3', label: '龙橙 · 男' }, { id: 'longhua_v3', label: '龙华 · 男' },
];

export function voicesFor(provider: string | undefined, model: string | undefined): VoiceChoice[] {
  switch (provider ?? 'edge') {
    case 'edge': return EDGE;
    case 'neoxcloud': return COSY_V2;
    case 'dashscope': return /v2/.test(model ?? '') ? COSY_V2 : COSY_V3;
    default: return [];
  }
}

/** 试听那一句 */
export const VOICE_SAMPLE = '你好，我是你的分身。明早八点五十，我打电话叫你开会。';
