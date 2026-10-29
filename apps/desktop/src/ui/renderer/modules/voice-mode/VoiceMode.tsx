
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';
import { startVoiceStream, type VoiceStream } from '../../utils/voiceStream';
import { stopTtsPlayback, subscribeTtsPlayback, subscribeTtsText, getTtsOutputLevel, getTtsPlayer, isTtsPlaying, playTtsAudio } from '../../utils/ttsPlayer';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useTimelineFeed } from '../../state/timelineFeedStore';
import { useSubAgents } from '../../state/subAgentsStore';
import { isSemanticallyComplete } from './semanticEndpoint';
import { isLikelyEcho, type SpokenLine } from './echoGuard';

const TOOL_ACTIVITY_ZH: Record<string, string> = {
  get_weather: '正在查天气…',
  web_search: '正在搜索…',
  web_fetch: '正在看网页…',
  fetch: '正在看网页…',
  schedule_reminder: '正在设置提醒…',
  update_profile: '记一下…',
  calendar_events: '正在看日历…',
  list_pending_tasks: '正在看待办…',
  memory: '正在回忆…',
  knowledge: '正在翻资料…',
  readfile: '正在看资料…',
};
const toolActivityLabel = (toolName: string | undefined, zh: boolean): string => {
  const t = (toolName || '').toLowerCase();
  if (zh) return TOOL_ACTIVITY_ZH[t] || '正在处理…';
  return t ? `Working: ${t.replace(/_/g, ' ')}…` : 'Working…';
};

type VoiceState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error';

const vlog = (message: string, data?: unknown) => {
  try {
    (window.neox as unknown as { logInfo?: (tag: string, msg: string, data?: unknown) => void })
      ?.logInfo?.('VOICE', message, data);
  } catch { /* noop */ }
};

/** 16k PCM 块合并 → base64 (声纹比对用) */
function mergePcmToB64(chunks: ArrayBuffer[]): string {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(new Uint8Array(c), off); off += c.byteLength; }
  let bin = '';
  for (let i = 0; i < merged.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, merged.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(bin);
}

/** 声纹比对原始结果 (score=-1 表示"太短未比对直接放行"); null=失败 */
async function verifyOwnerRaw(chunks: ArrayBuffer[]): Promise<{ match?: boolean; score?: number } | null> {
  try {
    const api = window.neox as unknown as { voiceprintVerify?: (b64: string) => Promise<{ match?: boolean; score?: number }> };
    return (await api.voiceprintVerify?.(mergePcmToB64(chunks))) ?? null;
  } catch { return null; }
}

/** 声纹比对: false = 确认不是主人; true = 是主人/太短/未注册/失败 (放行系) */
async function verifyOwner(chunks: ArrayBuffer[]): Promise<boolean> {
  const r = await verifyOwnerRaw(chunks);
  return !(r && r.match === false);
}

export interface VoiceCallBinding {
  id: string;
  /** 接通后先说的那句 —— 响铃时已合成好的音频优先, 没有才现合成 */
  opening?: string;
  openingAudio?: { audio: string; format?: string; voiceSummary?: string } | null;
  /** 打来的这个分身的音色 (没预合成好时现合成也用它) */
  voice?: string;
}

interface VoiceModeProps {
  /** 发送一轮用户发言 (AppShell 桥到 composer 直发) */
  onSubmit: (text: string) => void;
  onClose: () => void;
  call?: VoiceCallBinding;
}

type PilotCallApi = {
  pilotCallAction?: (a: string) => Promise<unknown>;
  pilotCallReport?: (r: { callId: string; voice: string; caption?: string; level?: number }) => void;
  onPilotCall?: (ev: string, cb: (p: any) => void) => () => void;
  ttsSpeak?: (t: string, voice?: string) => Promise<{ audio?: string; format?: string; voiceSummary?: string; error?: string }>;
};
const pilotApi = (): PilotCallApi => (window.neox as unknown as PilotCallApi) ?? {};

/** thinking 状态看门狗 — TTS 迟迟不来 (合成失败/回复超长) 就回到听, 别让用户干等 */
const THINKING_WATCHDOG_MS = 90_000;

const SEMANTIC_CLOSE_MS = 400;
const FALLBACK_CLOSE_MS = 700;
const REJOIN_WINDOW_MS = 800;

const ASR_HALLUCINATIONS = [
  '谢谢观看', '谢谢大家', '感谢观看', '请不吝点赞', '字幕由', '明镜与点点',
  'thank you for watching', 'thanks for watching', 'subtitles by',
];
function isGarbageTranscript(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  /* 没有任何 CJK 或字母 = 纯数字/标点碎片 */
  if (!/[\u4e00-\u9fff\u3040-\u30ffa-zA-Z]/.test(t)) return true;
  const lower = t.toLowerCase();
  if (t.length <= 14 && ASR_HALLUCINATIONS.some(h => lower.includes(h.toLowerCase()))) return true;
  return false;
}

export const VoiceMode: React.FC<VoiceModeProps> = ({ onSubmit, onClose, call }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntimeOptional();
  const timelineEvents = useTimelineFeed();
  const [state, setState] = useState<VoiceState>('connecting');
  const [transcript, setTranscript] = useState('');
  const [lastSent, setLastSent] = useState('');
  const [activity, setActivity] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<Array<{ id: number; text: string }>>([]);
  const spokenIdRef = useRef(0);
  const [rounds, setRounds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const levelRef = useRef(0);

  const stateRef = useRef<VoiceState>('connecting');
  const closedRef = useRef(false);
  const voiceStreamRef = useRef<VoiceStream | null>(null);
  const sttStreamIdRef = useRef<string | null>(null);
  const sttUnsubRef = useRef<(() => void) | null>(null);
  const transcriptRef = useRef('');
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const ttsWasDisabledRef = useRef(false);
  const customSttRef = useRef<boolean | null>(null);
  /* 讯飞 BYOK 真流式 — 走 sttStream 链路但免登录 (主进程按配置直连讯飞) */
  const xfyunRef = useRef(false);
  /* 本地识别 — 单趟 100-200ms, 增量刷新可以拧到 350ms (云端批式 1s) */
  const localSttRef = useRef(false);
  const pcmChunksRef = useRef<ArrayBuffer[]>([]);
  const voiceLockRef = useRef(false);
  const vpRejectStreakRef = useRef(0);
  /* 当前采集段的身份是否已坐实 — 播放仲裁 ("用户优先"掐播报) 只认已验明的主人,
   * 噪音/旁人的在途转写不配掐 agent 的回复 (18:14 实录: 噪音转写掐掉了天气回答) */
  const identityOkRef = useRef(false);
  const mutedByProbeRef = useRef(false);
  /* 假抢话自愈: 探针触发后 N 秒没等到人话 → 判定误触, 解除静音让回复尾段继续念 */
  const bargeFalseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearBargeFalseTimer = useCallback(() => {
    if (bargeFalseTimerRef.current) { clearTimeout(bargeFalseTimerRef.current); bargeFalseTimerRef.current = null; }
  }, []);
  const unmuteIfProbe = useCallback((why: string) => {
    if (!mutedByProbeRef.current) return;
    mutedByProbeRef.current = false;
    getTtsPlayer().setMuted(false);
    vlog(`unmute (${why}) — probe barge judged false, resume tail`);
  }, []);
  const prevModelRef = useRef<{ id: string } | null>(null);
  /* runtime/子 agent 快照走 ref — 回调多数挂着 eslint 豁免的窄依赖, 直接引 context
   * 值会拿到 stale 闭包 (streaming 状态判错 → 该中止的没中止) */
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState('');
  const camOnRef = useRef(false);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const stopCam = useCallback(() => {
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    camOnRef.current = false;
    setCamOn(false);
  }, []);
  const toggleCam = useCallback(async () => {
    if (camOnRef.current) { stopCam(); return; }
    setCamError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      camStreamRef.current = stream;
      camOnRef.current = true;
      setCamOn(true);
    } catch (e) {
      /* 没给摄像头权限 / 没有摄像头: 按钮上说清楚, 通话照常 */
      setCamError((e as Error)?.name === 'NotAllowedError' ? 'denied' : 'unavailable');
    }
  }, [stopCam]);
  useEffect(() => {
    const v = camVideoRef.current;
    if (v && camStreamRef.current && v.srcObject !== camStreamRef.current) {
      v.srcObject = camStreamRef.current;
      void v.play().catch(() => { /* 自动播放被拦也能抓帧 */ });
    }
  }, [camOn]);
  useEffect(() => () => { camStreamRef.current?.getTracks().forEach((t) => t.stop()); }, []);
  /** 当前画面 → JPEG base64 (长边 ≤ 1024) */
  const grabFrame = useCallback((): string | null => {
    const v = camVideoRef.current;
    if (!v || !v.videoWidth) return null;
    const scale = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.75);
    return url.slice(url.indexOf(',') + 1) || null;
  }, []);
  const subAgents = useSubAgents(runtime?.activeSession?.id ?? null);
  const subAgentsRef = useRef(subAgents);
  subAgentsRef.current = subAgents;
  /* 语义早收口后武装的续说拼接窗: text=已送出的上一段, at=doSend 时刻 */
  const rejoinRef = useRef<{ text: string; at: number } | null>(null);
  /* 通话是对面 (来电小窗 / 主进程) 挂的 —— 这边收尾时不用再发一次挂断 */
  const remoteEndedRef = useRef(false);
  /* 通话前因只随第一句发一次 */
  const callContextSentRef = useRef(false);
  /* 最近念过的句子 —— 回声门拿识别结果跟它比 */
  const recentSpokenRef = useRef<SpokenLine[]>([]);

  const abortInflightRun = useCallback((why: string): boolean => {
    const rt = runtimeRef.current;
    if (!rt || !rt.streaming) return false;   /* 无在途 run — 没什么可中止 */
    if (subAgentsRef.current.some(a => a.status === 'running')) {
      vlog(`abort skipped (${why}) — background sub-agent running, keep run alive (§8)`);
      return false;
    }
    vlog(`abort in-flight run (${why})`);
    /* stopCurrent = 停止按钮同款通道: 同步落 stopped gate + streaming=false,
     * 再 IPC chat:interrupt → agentBridge → runtime abortController */
    void rt.stopCurrent().catch(() => { /* noop */ });
    return true;
  }, []);

  /* 发出一轮语音回合 — 上一轮 run 还在生成时先中止再发 (voice 是严格回合制,
   * 用户开新口 = 旧回合作废; 无声纹/无影子确认路径的抢话在这里坐实)。
   * 中止后不能走 composer-fill (其 streaming 闭包未必刷新, 会误入排队), 直接
   * runtime.sendPrompt — steering "打断并发送" 同款先例。 */
  const submitVoiceTurn = useCallback((text: string) => {
    let body = text;
    const lines: string[] = [];
    if (call && !callContextSentRef.current) {
      callContextSentRef.current = true;
      lines.push(call.opening
        ? `这是一通电话, 用户刚接起你打过去的电话。你接通后已经说了: 「${call.opening}」。接着这句往下聊, 不要重复开场白。`
        : '这是一通电话, 用户刚打给你。');
    }
    const frame = camOnRef.current ? grabFrame() : null;
    if (frame) lines.push('用户开着摄像头, 附图是他说这句话时摄像头里的画面。他让你看什么就看图回答; 没提就别主动描述画面。');
    if (lines.length) body = `${text}\n\n<neox-directive>${lines.join('\n')}</neox-directive>`;
    const payload = `<voice-turn>${body}</voice-turn>`;
    const rt = runtimeRef.current;
    if (camOnRef.current) vlog(`camera on, frame ${frame ? `${Math.round(frame.length * 0.75 / 1024)} KB` : 'not captured'}`);
    const images = frame ? [{ mediaType: 'image/jpeg', data: frame, name: 'camera.jpg' }] : undefined;
    /* 通话条挂在 AppShell 上, 拿不到 runtime (rt 为空) —— 照旧投 composer-fill, 图跟着带上;
     * Pilot 页 (PilotVoiceBar) 在 runtime 底下接住它发出去 */
    if (!rt && images) {
      try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: payload, send: true, images } })); }
      catch { /* ignore */ }
      return;
    }
    /* 拿得到 runtime 时带图只能走 runtime.sendPrompt (composer 那条路没有图) */
    if (rt && images) {
      void (async () => {
        if (rt.streaming && !subAgentsRef.current.some(a => a.status === 'running')) {
          try { await rt.stopCurrent(); } catch { /* noop */ }
        }
        try {
          await rt.sendPrompt(payload, { images });
        } catch (e) {
          vlog(`send turn failed: ${(e as Error)?.message ?? e}`);
          try { onSubmit(payload); } catch { /* noop */ }
        }
      })();
      return;
    }
    if (rt?.streaming && !subAgentsRef.current.some(a => a.status === 'running')) {
      vlog('voice turn while run in-flight — abort then send (barge = 中止生成)');
      void (async () => {
        try { await rt.stopCurrent(); } catch { /* noop */ }
        try { await rt.sendPrompt(payload); }
        catch { try { onSubmit(payload); } catch { /* noop */ } }
      })();
      return;
    }
    /* 后台派活在跑 (§8 不 abort) 或空闲 — 老路径: 空闲直发 / 运行中由 composer 排队 */
    onSubmit(payload);
  }, [onSubmit, call, grabFrame]);

  const setSt = useCallback((s: VoiceState) => {
    if (stateRef.current !== s) vlog(`state ${stateRef.current} → ${s}`);
    stateRef.current = s;
    setState(s);
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const cleanupStt = useCallback(() => {
    try { voiceStreamRef.current?.stop(); } catch { /* noop */ }
    voiceStreamRef.current = null;
    if (sttUnsubRef.current) { sttUnsubRef.current(); sttUnsubRef.current = null; }
    const id = sttStreamIdRef.current;
    sttStreamIdRef.current = null;
    if (id) { void window.neox?.sttStreamStop?.(id).catch(() => { /* noop */ }); }
  }, []);

  const bargeStreamRef = useRef<VoiceStream | null>(null);
  const stopBargeProbe = useCallback(() => {
    try { bargeStreamRef.current?.stop(); } catch { /* noop */ }
    bargeStreamRef.current = null;
    getTtsPlayer().setDucked(false);   /* 影子确认期被拆 (状态切换) — 音量还原 */
  }, []);

  /** 收口来源标记 — 语义早收口要武装续说拼接窗; rejoinPrev = 本段要拼接的上一段文本 */
  interface SendOpts { semanticEarly?: boolean; rejoinPrev?: string | null }

  /* ---------- 发送一轮 ----------
   * strictL2: 抢话/误触发起且身份未经影子确认的采集段 — 声纹短句豁免不适用
   * (17:55 实录: thinking 期噪音触发抢话, "嗯" 670ms 走短句豁免被当成指令发出) */
  const sendOut = useCallback((text: string, strictL2 = false, sendOpts?: SendOpts) => {
    if (closedRef.current) return;
    const t = text.trim();
    if (!t) return;
    if (isGarbageTranscript(t)) {
      /* 噪声碎片 — 不发, 静默回到听; 抢话若是误触, 顺手解除静音 */
      vlog(`L1 garbage filtered: "${t.slice(0, 40)}"`);
      unmuteIfProbe('garbage transcript');
      void startListening();
      return;
    }
    if (isLikelyEcho(t, recentSpokenRef.current, Date.now())) {
      vlog(`L0 echo filtered: "${t.slice(0, 40)}"`);
      unmuteIfProbe('echo transcript');
      void startListening();
      return;
    }
    if (voiceLockRef.current && pcmChunksRef.current.length > 0) {
      void verifyOwnerRaw(pcmChunksRef.current).then((r) => {
        if (closedRef.current) return;
        const notOwner = !!r && r.match === false;
        /* strict: 抢话来源 + 太短没比对成 (score=-1) — 宁丢一句"嗯", 不让噪音插队 */
        const shortUnverified = strictL2 && r?.score === -1;
        if (notOwner || shortUnverified) {
          vpRejectStreakRef.current += 1;
          vlog(`L2 send-gate ${notOwner ? 'rejected' : 'short-unverified (barge origin)'} (score=${r?.score?.toFixed?.(3) ?? '?'} streak=${vpRejectStreakRef.current}): "${t.slice(0, 40)}"`);
          unmuteIfProbe('voiceprint reject');
          void startListening();
          return;
        }
        vpRejectStreakRef.current = 0;
        doSend(t, sendOpts);
      });
      return;
    }
    doSend(t, sendOpts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSubmit]);

  const doSend = useCallback((t: string, sendOpts?: SendOpts) => {
    if (closedRef.current) return;
    cleanupStt();
    /* 续说拼接 (§8): 上一段被语义早收口送出后用户 300ms 内继续说 — 本段与上一段
     * 拼成完整一句重发; 上一段触发的在途 run 由 submitVoiceTurn 里的中止逻辑收掉。 */
    const full = sendOpts?.rejoinPrev ? `${sendOpts.rejoinPrev} ${t}` : t;
    if (sendOpts?.rejoinPrev) {
      vlog(`rejoin concat: "${sendOpts.rejoinPrev.slice(0, 30)}" + "${t.slice(0, 30)}"`);
    }
    setLastSent(full);
    setTranscript('');
    transcriptRef.current = '';
    setSpoken([]);          /* 新一轮 — 清上一轮字幕 */
    setRounds(r => r + 1);
    setSt('thinking');
    levelRef.current = 0;
    /* 新一轮开始 → 解除打断静音 (interrupt 设的 muted 只管到下一轮) */
    clearBargeFalseTimer();
    mutedByProbeRef.current = false;
    getTtsPlayer().setMuted(false);
    /* 语义早收口 → 武装续说拼接窗; 其它收口 (700ms 兜底/手动/12s 硬收) 清窗 */
    rejoinRef.current = sendOpts?.semanticEarly ? { text: full, at: Date.now() } : null;
    vlog(`send turn: "${full.slice(0, 60)}"${sendOpts?.semanticEarly ? ' (semantic-early close)' : ''}`);
    submitVoiceTurn(full);
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      /* TTS 没来 (合成失败等) — 回到听, 对话别死在 thinking */
      if (!closedRef.current && stateRef.current === 'thinking') {
        vlog('thinking watchdog fired — no TTS within 90s, back to listening');
        void startListening();
      }
    }, THINKING_WATCHDOG_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSubmit, submitVoiceTurn]);

  const startLocalLevelProbe = useCallback(async () => {
    try {
      voiceStreamRef.current = await startVoiceStream((chunk) => {
        const view = new Int16Array(chunk);
        let sum = 0;
        for (let i = 0; i < view.length; i++) { const v = view[i] / 32768; sum += v * v; }
        levelRef.current = Math.min(1, Math.sqrt(sum / Math.max(1, view.length)) * 5);
      }, {});
    } catch { /* 麦克风权限也没有 — 波形保持静息 */ }
  }, []);

  /* custom STT 手动收口 (Enter 键) — 实际逻辑由 startListening 的当轮闭包提供 */
  const finalizeCustomRef = useRef<() => void>(() => {});

  /* ---------- 听 (官方=流式 STT / custom=整段识别) ----------
   * seedChunks: 抢话打断交接来的预滚 PCM — 用户开口那几百毫秒的音频, 先喂进识别
   * identityPreOk: 影子声纹已确认是主人 (抢话 commit 交接) — 字幕即刻上屏不再等复验 */
  const startListening = useCallback(async (seedChunks?: ArrayBuffer[], identityPreOk = false) => {
    if (closedRef.current) return;
    stopBargeProbe();
    cleanupStt();
    clearWatchdog();
    setError(null);
    setTranscript('');
    transcriptRef.current = '';
    setSt('connecting');
    /* 读一次 BYOK 识别配置 (缓存) — custom 免登录 */
    if (customSttRef.current === null) {
      try {
        const api = window.neox as unknown as { sttGetConfig?: () => Promise<{ provider?: string; apiUrl?: string; appId?: string }> };
        const cfg = await api.sttGetConfig?.();
        /* local = 本地 SenseVoice, 走同一条整段+投机+增量伪流式路 (本地 <200ms, 增量≈免费) */
        customSttRef.current = (cfg?.provider === 'custom' && !!cfg.apiUrl) || cfg?.provider === 'local';
        localSttRef.current = cfg?.provider === 'local';
        xfyunRef.current = cfg?.provider === 'xfyun' && !!cfg.appId;
        /* 通话里不用声纹锁: 9/30 日志里主人本人只拿到 0.23~0.37 分 (门槛 0.38), 真话被静默吞掉;
         * 它原本还兼着挡回声, 这件事改由上面按内容判的回声门做 */
        voiceLockRef.current = !call && !!(cfg as { voiceLockEnabled?: boolean })?.voiceLockEnabled;
      } catch { customSttRef.current = false; }
    }
    vlog(`listening start engine=${customSttRef.current ? (localSttRef.current ? 'local' : 'custom') : (xfyunRef.current ? 'xfyun' : 'cloud')} seed=${seedChunks?.length ?? 0} preOk=${identityPreOk} voiceLock=${voiceLockRef.current}`);
    /* 抢话/误触发起且身份未坐实 — 送出时声纹从严 (短句豁免不适用) */
    const strictL2 = !!seedChunks && !identityPreOk;
    identityOkRef.current = identityPreOk || !voiceLockRef.current;
    const rejoinArmed = rejoinRef.current;
    rejoinRef.current = null;
    const rejoinPrevText = (seedChunks && rejoinArmed && Date.now() - rejoinArmed.at <= REJOIN_WINDOW_MS)
      ? rejoinArmed.text : null;
    if (rejoinPrevText) vlog(`rejoin window hit (+${Date.now() - (rejoinArmed as { at: number }).at}ms) — will concat previous segment`);
    if (customSttRef.current) {
      try {
        pcmChunksRef.current = seedChunks ? [...seedChunks] : [];
        const api = window.neox as unknown as { sttTranscribe?: (b64: string, fmt?: string) => Promise<{ success?: boolean; text?: string; error?: string }> };
        const transcribeBuf = async (): Promise<string | null> => {
          const r = await api.sttTranscribe?.(pcmToWavBase64([...pcmChunksRef.current], 16000), 'wav');
          if (r && r.success === false) throw new Error(r.error || 'STT failed');
          return (r?.text ?? '').trim() || null;
        };
        let hasSpoken = false;
        let voicedRun = 0;       /* 连续有声帧 — 拍桌子/关门是 1-2 帧脉冲, 人声是连续的 */
        let utterStartAt = 0;
        let identityOk = identityPreOk || !voiceLockRef.current;
        let identityBusy = false;
        let voicedMsAcc = 0;
        let noiseFloor = 0.01;   /* 噪声地板自适应 — 固定阈值在底噪环境里永不收口 (粘连实录) */
        let lastVoiceAt = Date.now();
        let lastPartialAt = 0;
        let partialBusy = false;
        let specPromise: Promise<string | null> | null = null;
        let finalized = false;
        const finalizeWith = async (spec: Promise<string | null> | null, semanticEarly = false) => {
          if (closedRef.current) return;
          try { voiceStreamRef.current?.stop(); } catch { /* noop */ }
          voiceStreamRef.current = null;
          try {
            let text: string | null = null;
            try { text = await (spec ?? transcribeBuf()); }
            catch { text = await transcribeBuf(); }   /* 投机在网络抖动时失败 — 现场重识别一次 */
            if (closedRef.current) return;
            if (text) {
              vlog(`finalize text="${text.slice(0, 60)}"${semanticEarly ? ' (semantic-early)' : ''}`);
              transcriptRef.current = text;
              if (identityOk) setTranscript(text);   /* 身份没确认 (短句直发) — 等 L2 send-gate 判 */
              sendOut(text, strictL2, { semanticEarly, rejoinPrev: rejoinPrevText });
            } else if (stateRef.current === 'listening' || stateRef.current === 'connecting') {
              vlog('finalize empty — false barge or silence, back to listening');
              unmuteIfProbe('empty finalize');
              void startListening();   /* 没说出内容 — 重新听 */
            }
          } catch (e: unknown) {
            if (closedRef.current) return;
            setError(e instanceof Error ? e.message : String(e));
            setSt('error');
          }
        };
        finalizeCustomRef.current = () => {
          if (finalized) return;
          finalized = true;
          void finalizeWith(specPromise);
        };
        voiceStreamRef.current = await startVoiceStream(
          (chunk) => {
            if (finalized || closedRef.current) return;
            pcmChunksRef.current.push(chunk.slice(0));
            const view = new Int16Array(chunk);
            let sum = 0;
            for (let i = 0; i < view.length; i++) { const v = view[i] / 32768; sum += v * v; }
            const rms = Math.sqrt(sum / Math.max(1, view.length));
            levelRef.current = Math.min(1, rms * 5);
            const now = Date.now();
            if (rms < noiseFloor) noiseFloor = rms * 0.3 + noiseFloor * 0.7;
            else noiseFloor = Math.min(noiseFloor * 1.008, 0.04);
            const thr = Math.min(0.12, Math.max(0.018, noiseFloor * 3));
            /* 12s 硬收口 — 任何环境下都不无限等 */
            if (hasSpoken && utterStartAt && now - utterStartAt > 12_000) {
              finalized = true;
              void finalizeWith(specPromise);
              return;
            }
            if (rms >= thr) {
              voicedRun += 1;
              if (!hasSpoken && voicedRun < 3) return;
              if (!hasSpoken) { utterStartAt = now; clearBargeFalseTimer(); }   /* 人话确认 — 抢话不是误触 */
              hasSpoken = true;
              lastVoiceAt = now;
              voicedMsAcc += view.length / 16;   /* 16 samples/ms @16k */
              specPromise = null;   /* 说话恢复 — 投机作废 */
              /* 影子身份验证: 攒够 1s 人声后台比对一次 (本地 ~50-80ms) */
              if (!identityOk && !identityBusy && voicedMsAcc >= 1000) {
                identityBusy = true;
                void verifyOwner([...pcmChunksRef.current]).then((ok) => {
                  identityBusy = false;
                  if (finalized || closedRef.current) return;
                  if (ok) {
                    identityOk = true;
                    identityOkRef.current = true;
                    vpRejectStreakRef.current = 0;
                    if (transcriptRef.current) setTranscript(transcriptRef.current);   /* 亮出已攒字幕 */
                    return;
                  }
                  vlog('L2 mid-capture rejected — discard silently');
                  /* 不是主人 — 整段作废重新攒, UI 全程无感 (自愈放行已删: 18:14
                   * 实录里正确拦截旁人的连拒反而把锁拆了, 噪音接管会话) */
                  pcmChunksRef.current = [];
                  hasSpoken = false;
                  voicedRun = 0;
                  voicedMsAcc = 0;
                  transcriptRef.current = '';
                });
              }
              /* 增量识别: 说满 ~0.7s 起单飞不排队。节奏按引擎速度分档:
               * 本地 SenseVoice 单趟 100-200ms → 350ms 刷 (接近逐词);
               * 云端 HTTP ~300-500ms 一趟 → 1s 刷是不排队的极限 */
              const partialGap = localSttRef.current ? 350 : 1000;
              if (!partialBusy && now - lastPartialAt >= partialGap && pcmChunksRef.current.length >= 8) {
                partialBusy = true;
                lastPartialAt = now;
                transcribeBuf().then((t) => {
                  partialBusy = false;
                  if (t && !finalized && !closedRef.current) {
                    transcriptRef.current = t;
                    if (identityOk) setTranscript(t);   /* 身份没确认前字幕不上屏 */
                  }
                }).catch(() => { partialBusy = false; });
              }
            } else {
              voicedRun = 0;
              if (!hasSpoken) return;
              const gap = now - lastVoiceAt;
              if (gap >= 350 && !specPromise) {
                specPromise = transcribeBuf();   /* 投机: 静音初期就开跑 */
                specPromise.catch(() => { /* 定稿时兜底重试 */ });
              }
              const semanticReady = gap >= SEMANTIC_CLOSE_MS
                && !!transcriptRef.current.trim()
                && isSemanticallyComplete(transcriptRef.current);
              if (semanticReady || gap >= FALLBACK_CLOSE_MS) {
                finalized = true;
                const early = semanticReady && gap < FALLBACK_CLOSE_MS;
                if (early) vlog(`semantic close at ${Math.round(gap)}ms: "${transcriptRef.current.slice(0, 40)}"`);
                void finalizeWith(specPromise, early);
              }
            }
          },
          {},
        );
        if (closedRef.current) { cleanupStt(); return; }
        setSt('listening');
      } catch (e: unknown) {
        if (closedRef.current) return;
        const err = e as { name?: string; message?: string };
        setError(err?.name === 'NotAllowedError'
          ? (isZh ? '麦克风权限被拒绝' : 'Microphone permission denied')
          : (err?.message || (isZh ? '无法启动麦克风' : 'Failed to start microphone')));
        setSt('error');
      }
      return;
    }
    if (!customSttRef.current) pcmChunksRef.current = seedChunks ? [...seedChunks] : [];
    try {
      const res = await window.neox?.sttStreamStart?.();
      if (closedRef.current) return;
      if (!res?.ok || !res.streamId) {
        throw new Error(res?.error || (isZh ? '无法启动语音识别' : 'Failed to start speech recognition'));
      }
      const streamId = res.streamId;
      sttStreamIdRef.current = streamId;
      /* 声纹影子门 (云端流式版): 转写先不上屏, 攒 1s 人声验完身份再亮 —
       * 不是主人直接静默重听, 网关那边的识别结果全程不见天日 */
      let cloudIdentityOk = identityPreOk || !voiceLockRef.current;
      let cloudIdentityBusy = false;
      let cloudVoicedMs = 0;
      let cloudSemanticEarly = false;
      /* 抢话交接的预滚音频先入流 — 网关按序识别, 开口的字不丢 */
      if (seedChunks) {
        for (const c of seedChunks) window.neox?.sttStreamAudio?.(streamId, c);
      }
      sttUnsubRef.current = window.neox?.onSttStreamEvent?.((data) => {
        if (data.streamId !== streamId || closedRef.current) return;
        if ((data.type === 'transcript' || data.type === 'final') && data.text) {
          clearBargeFalseTimer();   /* 网关吐出转写 = 人话确认, 抢话不是误触 */
          transcriptRef.current = data.text;
          if (cloudIdentityOk) setTranscript(data.text);
        }
        if (data.type === 'final' || data.type === 'close') {
          /* 网关收尾 — 有话就发, 没说话 (误触静音) 就重新听 */
          const finalText = transcriptRef.current.trim();
          if (finalText) {
            vlog(`gateway final text="${finalText.slice(0, 60)}"${cloudSemanticEarly ? ' (semantic-early)' : ''}`);
            sendOut(finalText, strictL2, { semanticEarly: cloudSemanticEarly, rejoinPrev: rejoinPrevText });
          } else if (stateRef.current === 'listening' || stateRef.current === 'connecting') {
            vlog('gateway final empty — false barge or silence, back to listening');
            unmuteIfProbe('empty gateway final');
            void startListening();
          }
        } else if (data.type === 'error') {
          setError(data.message || (isZh ? '识别失败' : 'Recognition failed'));
          setSt('error');
          cleanupStt();
        }
      }) || null;
      voiceStreamRef.current = await startVoiceStream(
        (chunk) => {
          window.neox?.sttStreamAudio?.(streamId, chunk);
          /* 声纹门要整段音频 — 旁路积累一份 (≤60s, 几百 KB) */
          if (voiceLockRef.current && pcmChunksRef.current.length < 700) pcmChunksRef.current.push(chunk.slice(0));
          /* 麦克风电平: 直接从 16-bit PCM 块算 RMS, 不再另起 analyser */
          const view = new Int16Array(chunk);
          let sum = 0;
          for (let i = 0; i < view.length; i++) { const v = view[i] / 32768; sum += v * v; }
          const rms = Math.sqrt(sum / Math.max(1, view.length));
          levelRef.current = Math.min(1, rms * 5);
          /* 影子身份验证 (云端版): 攒够 1s 人声比对一次 */
          if (!cloudIdentityOk && !cloudIdentityBusy) {
            if (rms >= 0.02) cloudVoicedMs += view.length / 16;
            if (cloudVoicedMs >= 1000) {
              cloudIdentityBusy = true;
              void verifyOwner([...pcmChunksRef.current]).then((ok) => {
                cloudIdentityBusy = false;
                if (closedRef.current || sttStreamIdRef.current !== streamId) return;
                if (ok) {
                  cloudIdentityOk = true;
                  identityOkRef.current = true;
                  vpRejectStreakRef.current = 0;
                  if (transcriptRef.current) setTranscript(transcriptRef.current);
                  return;
                }
                vlog('L2 mid-capture rejected cloud — restart silently');
                /* 不是主人 — 静默收掉这条流重新听 (字幕从未上屏, UI 无感; 自愈放行已删) */
                transcriptRef.current = '';
                void startListening();
              });
            }
          }
        },
        {
          silenceMs: FALLBACK_CLOSE_MS,
          getSilenceMs: () => (
            transcriptRef.current.trim() && isSemanticallyComplete(transcriptRef.current)
              ? SEMANTIC_CLOSE_MS : FALLBACK_CLOSE_MS
          ),
          onSilence: () => {
            /* 说完 → 停采集 + 通知网关收尾, final 事件驱动 sendOut */
            cloudSemanticEarly = !!transcriptRef.current.trim()
              && isSemanticallyComplete(transcriptRef.current);
            if (cloudSemanticEarly) vlog(`semantic close (stream): "${transcriptRef.current.slice(0, 40)}"`);
            try { voiceStreamRef.current?.stop(); } catch { /* noop */ }
            voiceStreamRef.current = null;
            const id = sttStreamIdRef.current;
            if (id) { void window.neox?.sttStreamStop?.(id).catch(() => { /* noop */ }); }
          },
        },
      );
      if (closedRef.current) { cleanupStt(); return; }
      setSt('listening');
    } catch (e: unknown) {
      if (closedRef.current) return;
      const err = e as { name?: string; message?: string };
      setError(err?.name === 'NotAllowedError'
        ? (isZh ? '麦克风权限被拒绝' : 'Microphone permission denied')
        : (err?.message || (isZh ? '无法启动麦克风' : 'Failed to start microphone')));
      setSt('error');
      cleanupStt();
    }
  }, [cleanupStt, clearWatchdog, isZh, sendOut, setSt, stopBargeProbe]);

  /* speakGraceRef 提前声明 — 抢话触发时要掐掉句间回听宽限 */
  const speakGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 探针麦克风电平 — speaking 时波形取 max(TTS 输出, 用户人声): 一开口波纹立刻响应 */
  const bargeMicLevelRef = useRef(0);
  const startBargeProbe = useCallback(async () => {
    if (bargeStreamRef.current || closedRef.current) return;
    const preRoll: ArrayBuffer[] = [];
    let voiced = 0;
    let triggered = false;
    let floor = 0.008;
    let shadow: ArrayBuffer[] | null = null;
    let shadowVoicedMs = 0;
    let shadowBusy = false;
    let shadowNextCheckMs = 800;   /* 首验 800ms 人声 — 打断确认要快 ("TTS还在输出"实录) */
    /* lock 关着但有整段识别 (local/BYOK) → ASR 确认: 影子段转写得出"人话"才算
     * 真抢话 — 键盘/关门/音乐转不出文字, 不再掐播报 */
    const asrConfirm = async (chunks: ArrayBuffer[]): Promise<boolean> => {
      try {
        const api = window.neox as unknown as { sttTranscribe?: (b64: string, fmt?: string) => Promise<{ success?: boolean; text?: string }> };
        const r = await api.sttTranscribe?.(pcmToWavBase64(chunks, 16000), 'wav');
        const text = (r?.text ?? '').trim();
        return !!text && !isGarbageTranscript(text);
      } catch { return true; }   /* 识别挂了 — 放行走老路, 打断功能别跟着死 */
    };
    const resetShadow = (why: string) => {
      vlog(`barge shadow reset (${why}) — playback untouched`);
      shadow = null;
      shadowVoicedMs = 0;
      shadowNextCheckMs = 800;
      voiced = 0;
      triggered = false;
      getTtsPlayer().setDucked(false);
    };
    const commitInterrupt = (seed: ArrayBuffer[]) => {
      getTtsPlayer().setDucked(false);
      mutedByProbeRef.current = true;
      getTtsPlayer().setMuted(true);
      stopTtsPlayback();
      abortInflightRun('barge shadow confirmed');
      /* 自愈窗: 转正式收音后迟迟没人话 = 误判 — 解除静音, 回复后续句子照常播
       * (abort 已发生的话残句本就不会再来, 自愈只管播放层) */
      clearBargeFalseTimer();
      bargeFalseTimerRef.current = setTimeout(() => {
        bargeFalseTimerRef.current = null;
        if (!closedRef.current) unmuteIfProbe('no speech within 3.5s');
      }, 3500);
      if (speakGraceRef.current) { clearTimeout(speakGraceRef.current); speakGraceRef.current = null; }
      void startListening(seed, true);   /* 影子已验明正身 — 字幕即刻上屏 */
    };
    try {
      bargeStreamRef.current = await startVoiceStream((chunk) => {
        if (closedRef.current) return;
        const view = new Int16Array(chunk);
        let sum = 0;
        for (let i = 0; i < view.length; i++) { const v = view[i] / 32768; sum += v * v; }
        const rms = Math.sqrt(sum / Math.max(1, view.length));
        bargeMicLevelRef.current = Math.min(1, rms * 5);
        /* 噪声地板跟踪 — 快降慢升 */
        if (rms < floor) floor = rms * 0.3 + floor * 0.7;
        else floor = Math.min(floor * 1.01, 0.05);
        /* ---- 影子模式: 攒音频等身份/内容裁决 ---- */
        if (shadow) {
          shadow.push(chunk.slice(0));
          if (rms >= Math.max(0.02, floor * 3)) shadowVoicedMs += view.length / 16;
          if (shadow.length > 240) { resetShadow('overrun ~10s'); return; }   /* 保险丝 */
          if (shadowVoicedMs >= shadowNextCheckMs && !shadowBusy) {
            shadowBusy = true;
            if (voiceLockRef.current) {
              void verifyOwnerRaw([...shadow]).then((r) => {
                shadowBusy = false;
                if (closedRef.current || !shadow) return;
                if (r && r.match === false) { resetShadow('not owner'); return; }
                if (r && r.score === -1) {
                  /* 有效人声还不够比对 — 再攒 350ms 重验, 别放行也别干等
                   * (曾把短样本当"放行系"直接 commit — 噪音能借道打断) */
                  shadowNextCheckMs = shadowVoicedMs + 350;
                  return;
                }
                vlog('barge shadow: owner confirmed — commit interrupt');
                const seed = [...shadow];
                shadow = null;
                commitInterrupt(seed);
              });
            } else {
              void asrConfirm([...shadow]).then((ok) => {
                shadowBusy = false;
                if (closedRef.current || !shadow) return;
                if (!ok) { resetShadow('no speech content'); return; }
                vlog('barge shadow: speech confirmed — commit interrupt');
                const seed = [...shadow];
                shadow = null;
                commitInterrupt(seed);
              });
            }
          }
          return;
        }
        if (triggered) return;
        preRoll.push(chunk.slice(0));
        /* ~430ms 预滚: 够住开口首音节, 又不把 TTS 回声残留/环境音整秒喂给识别
         * (曾 1s — "识别的不是我说的话"实录) */
        if (preRoll.length > 10) preRoll.shift();
        /* 触发阈自适应: 底噪抬高阈值跟着抬 — 2048 缓冲 ≈43ms/帧, 连续 3 帧确认 */
        const trigThr = Math.min(0.12, Math.max(0.03, floor * 4));
        if (rms >= trigThr) voiced += 1; else voiced = 0;
        if (voiced >= 3) {
          triggered = true;
          const playing = isTtsPlaying();
          vlog(`barge trigger rms=${rms.toFixed(4)} floor=${floor.toFixed(4)} thr=${trigThr.toFixed(3)} playing=${playing} state=${stateRef.current} lock=${voiceLockRef.current}`);
          if (playing && (voiceLockRef.current || customSttRef.current)) {
            /* 影子确认: 先 duck 不掐播 — 声纹(lock开)/转写出人话(lock关) 坐实才动手 */
            getTtsPlayer().setDucked(true);
            shadow = [...preRoll];
            shadowVoicedMs = 150;
            return;
          }
          /* 只在真的在播报时才静音+掐播 (排障根治"回复了不出声"): thinking 期间
           * 误触曾 setMuted(true) 把随后整条回复音频静默丢弃。 */
          if (playing) {
            mutedByProbeRef.current = true;
            getTtsPlayer().setMuted(true);
            stopTtsPlayback();
            clearBargeFalseTimer();
            bargeFalseTimerRef.current = setTimeout(() => {
              bargeFalseTimerRef.current = null;
              if (!closedRef.current) unmuteIfProbe('no speech within 3.5s');
            }, 3500);
          }
          if (speakGraceRef.current) { clearTimeout(speakGraceRef.current); speakGraceRef.current = null; }
          void startListening([...preRoll]);
        }
      }, { bufferSize: 2048 });
    } catch { /* 麦克风拿不到 — 退回点按打断 */ }
  }, [startListening, clearBargeFalseTimer, unmuteIfProbe, abortInflightRun]);

  /* thinking / speaking 全程挂探针 — 用户任何时刻开口都立刻接管 */
  useEffect(() => {
    if (state === 'thinking' || state === 'speaking') void startBargeProbe();
    else stopBargeProbe();
  }, [state, startBargeProbe, stopBargeProbe]);

  /* ---------- 手动"说完了" (不等静音) ---------- */
  const finishSpeaking = useCallback(() => {
    if (stateRef.current !== 'listening') return;
    if (customSttRef.current) { finalizeCustomRef.current(); return; }
    try { voiceStreamRef.current?.stop(); } catch { /* noop */ }
    voiceStreamRef.current = null;
    const id = sttStreamIdRef.current;
    if (id) { void window.neox?.sttStreamStop?.(id).catch(() => { /* noop */ }); }
  }, []);

  /* ---------- 打断播报 ---------- */
  const interrupt = useCallback(() => {
    if (stateRef.current !== 'speaking') return;
    vlog('manual interrupt');
    /* 段级 TTS 下 turn 可能还在流式生成, 后续句子会继续 publish —
     * 静音到下一轮发言, 否则打断 1 秒后残句进队"复活"接着念。
     * 手动打断是明确意图 — 不进假警报自愈, 残句绝不复活。 */
    clearBargeFalseTimer();
    mutedByProbeRef.current = false;
    getTtsPlayer().setMuted(true);
    stopTtsPlayback();       // subscribe(false) 回调会带我们回 listening (900ms 宽限)
    abortInflightRun('manual interrupt');
  }, [clearBargeFalseTimer, abortInflightRun]);

  const pauseListening = useCallback(() => {
    vlog('mic paused by user');
    cleanupStt();
    stopBargeProbe();
    clearWatchdog();
    clearBargeFalseTimer();
    levelRef.current = 0;
    setTranscript('');
    transcriptRef.current = '';
    setSt('paused');
  }, [cleanupStt, stopBargeProbe, clearWatchdog, clearBargeFalseTimer, setSt]);

  /* ---------- 结束对话 ---------- */
  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    vlog('voice mode closed');
    clearWatchdog();
    clearBargeFalseTimer();
    cleanupStt();
    try { bargeStreamRef.current?.stop(); } catch { /* noop */ }
    bargeStreamRef.current = null;
    /* muted/ducked 是全局单例状态 — 关语音模式必须还原, 否则文字对话的播报也哑了 */
    getTtsPlayer().setMuted(false);
    getTtsPlayer().setDucked(false);
    stopTtsPlayback();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (prevModelRef.current && runtime?.availableModels) {
      const prev = runtime.availableModels.find(m => m.id === prevModelRef.current!.id);
      if (prev) runtime.setSelectedModel(prev);
      prevModelRef.current = null;
    }
    /* 还原临时打开的 TTS */
    if (ttsWasDisabledRef.current) {
      void (window.neox as unknown as { ttsSetEnabled?: (v: boolean) => Promise<unknown> })?.ttsSetEnabled?.(false)?.catch(() => { /* noop */ });
    }
    /* 通话: 这边结束 = 挂电话 (对面已经挂了的话主进程那边是空操作) */
    if (call && !remoteEndedRef.current) void pilotApi().pilotCallAction?.('hangup')?.catch(() => { /* noop */ });
    onClose();
  }, [cleanupStt, clearWatchdog, clearBargeFalseTimer, onClose, runtime, call]);

  const callId = call?.id;
  const pauseListeningRef = useRef(pauseListening);
  pauseListeningRef.current = pauseListening;
  const startListeningRef = useRef(startListening);
  startListeningRef.current = startListening;
  const closeRef = useRef(close);
  closeRef.current = close;
  const captionRef = useRef('');
  captionRef.current = state === 'speaking' && spoken.length > 0
    ? spoken[spoken.length - 1].text
    : (transcript || (state === 'thinking' ? (activity ?? lastSent) : ''));
  useEffect(() => {
    if (!callId) return;
    const send = () => pilotApi().pilotCallReport?.({
      callId, voice: stateRef.current, caption: captionRef.current, level: levelRef.current,
    });
    send();
    /* 电平 10 Hz 就够小窗的光圈跟上嘴 —— 再密只是白白占 IPC */
    const h = window.setInterval(send, 100);
    return () => window.clearInterval(h);
  }, [callId, state, spoken, transcript, activity, lastSent]);
  useEffect(() => {
    if (!callId) return;
    const offs = [
      pilotApi().onPilotCall?.('state', (s: { id?: string; muted?: boolean } | null) => {
        if (!s || s.id !== callId) return;
        if (s.muted && stateRef.current !== 'paused') pauseListeningRef.current();
        else if (!s.muted && stateRef.current === 'paused') void startListeningRef.current();
      }),
      pilotApi().onPilotCall?.('end', (p: { callId?: string }) => {
        if (p?.callId !== callId) return;
        remoteEndedRef.current = true;
        closeRef.current();
      }),
    ];
    return () => { for (const off of offs) off?.(); };
  }, [callId]);

  /* ---------- 逐句字幕: 每条 clip 开播广播文本 → 滚动上屏 ---------- */
  useEffect(() => {
    const unsub = subscribeTtsText((text) => {
      if (closedRef.current) return;
      const now = Date.now();
      recentSpokenRef.current = [...recentSpokenRef.current.filter((l) => now - l.at < 30_000), { text, at: now }];
      spokenIdRef.current += 1;
      const id = spokenIdRef.current;
      setSpoken(prev => [...prev.slice(-2), { id, text }]);   /* 最多留 3 行 */
    });
    return unsub;
  }, []);

  /* ---------- TTS 播放状态驱动对话状态机 (speakGraceRef 在抢话探针前声明) ---------- */
  useEffect(() => {
    const unsub = subscribeTtsPlayback((playing) => {
      if (closedRef.current) return;
      if (playing) {
        /* 段级 TTS: 下一句音频到了 → 取消回听宽限 */
        if (speakGraceRef.current) { clearTimeout(speakGraceRef.current); speakGraceRef.current = null; }
        clearWatchdog();
        /* 迟到音频 (假抢话自愈解除静音后 server 继续 publish 的句子) 在 listening
         * 态开播: 用户还没开口 → 收回麦克风正常转 speaking, 别让开着的识别流
         * 吃进 TTS 回声; 用户已在说话 → 用户优先, 掐掉这条播报。 */
        const st = stateRef.current;
        if (st === 'listening' || st === 'connecting') {
          /* "用户优先"只认验明的主人 — 18:14 实录: 噪音转写曾冒充"用户在说话"
           * 掐掉了 agent 的天气回答。身份没坐实的在途采集让位给播报。 */
          if (transcriptRef.current.trim() && identityOkRef.current) {
            vlog('late tts while owner speaking — mute it, user wins');
            mutedByProbeRef.current = true;
            getTtsPlayer().setMuted(true);
            stopTtsPlayback();
            return;
          }
          vlog('late tts while idle/unverified-listening — reclaim mic, switch to speaking');
          cleanupStt();
        }
        setSt('speaking');
        /* 音浪 = max(TTS 输出, 探针人声) — 用户一开口波纹立刻跟手, 不等打断确认 */
        const poll = () => {
          if (closedRef.current || stateRef.current !== 'speaking') return;
          bargeMicLevelRef.current *= 0.92;   /* 探针块间衰减, 停口即回落 */
          levelRef.current = Math.max(getTtsOutputLevel(), bargeMicLevelRef.current);
          rafRef.current = requestAnimationFrame(poll);
        };
        poll();
      } else if (stateRef.current === 'speaking') {
        /* 段级 TTS 下句间会有空隙 (下一句还在合成) — 900ms 宽限再回听,
         * 期间新句音频到达则取消。没有宽限会在句间抢开麦克风吃进 TTS 尾音。 */
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        levelRef.current = 0;
        if (speakGraceRef.current) clearTimeout(speakGraceRef.current);
        speakGraceRef.current = setTimeout(() => {
          speakGraceRef.current = null;
          if (!closedRef.current && stateRef.current === 'speaking') void startListening();
        }, 900);
      }
    });
    return () => {
      unsub();
      if (speakGraceRef.current) clearTimeout(speakGraceRef.current);
    };
  }, [clearWatchdog, cleanupStt, setSt, startListening]);

  /* ---------- 挂载: 强制 TTS + 开听; 卸载: 全清 ---------- */
  useEffect(() => {
    void (async () => {
      try {
        const api = window.neox as unknown as {
          ttsGetConfig?: () => Promise<{ enabled?: boolean }>;
          ttsSetEnabled?: (v: boolean) => Promise<unknown>;
        };
        const cfg = await api?.ttsGetConfig?.();
        if (cfg && cfg.enabled === false) {
          ttsWasDisabledRef.current = true;
          await api?.ttsSetEnabled?.(true);
        }
        const vm = (cfg as { voiceChatModel?: string } | undefined)?.voiceChatModel?.trim();
        if (vm && runtime?.availableModels?.length && runtime.selectedModel && runtime.selectedModel.id !== vm) {
          const target = runtime.availableModels.find(m => m.id === vm);
          if (target) {
            prevModelRef.current = { id: runtime.selectedModel.id };
            runtime.setSelectedModel(target);
          }
        }
      } catch { /* noop — TTS 配置拿不到也不阻塞对话 */ }
      if (call?.openingAudio?.audio || call?.opening) {
        try {
          const a = call.openingAudio?.audio ? call.openingAudio : await pilotApi().ttsSpeak?.(call.opening!, call.voice);
          if (a?.audio && !closedRef.current) {
            vlog('call opening → play');
            playTtsAudio(a.audio, a.format || 'mp3', a.voiceSummary);
            return;
          }
        } catch { /* 合成失败就直接听 —— 开场白字幕仍在会话里 */ }
      }
      void startListening();
    })();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter') { e.preventDefault(); finishSpeaking(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state !== 'thinking') { setActivity(null); return; }
    const events = timelineEvents;
    if (!events || events.length === 0) return;
    const latest = events[events.length - 1] as { type?: string; toolName?: string; name?: string; title?: string } | undefined;
    if (!latest) return;
    if (latest.type === 'tool_call' || latest.type === 'tool_call_start') {
      setActivity(toolActivityLabel(latest.toolName || latest.name || latest.title, isZh));
    } else if (latest.type === 'thinking') setActivity(isZh ? '在想…' : 'Thinking…');
  }, [state, timelineEvents, isZh]);

  const statusText = (() => {
    if (state === 'listening' && rounds === 0) return isZh ? '想聊点什么？' : 'What can I help you with?';
    if (state === 'thinking') return activity ?? (isZh ? '在想…' : 'Thinking…');
    if (state === 'paused') return isZh ? '已静音 — 点击继续' : 'Muted — tap to resume';
    if (state === 'error') return error ?? (isZh ? '出错了' : 'Error');
    return '';
  })();

  const onWaveClick = useCallback(() => {
    const st = stateRef.current;
    if (st === 'speaking') interrupt();
    else if (st === 'listening') finishSpeaking();
    else if (st === 'paused' || st === 'error') void startListening();
  }, [interrupt, finishSpeaking, startListening]);

  /* 波幅合成: listening/speaking 电平驱动; error 也吃本地探针电平 (说话有波动,
   * 只是不解析); thinking 慢呼吸; 其余静息微澜 */
  const getAmp = useCallback(() => {
    const st = stateRef.current;
    if (st === 'listening' || st === 'speaking') return 0.14 + levelRef.current * 1.15;
    if (st === 'error') return 0.1 + levelRef.current * 1.0;
    if (st === 'thinking') return 0.2 + 0.09 * Math.sin(performance.now() / 420);
    if (st === 'paused') return 0.06;
    return 0.1;
  }, []);

  if (call) {
    const caption = captionRef.current;
    return createPortal(
      <div className="neox-voicemode-call" role="region" aria-label={isZh ? '通话中' : 'In call'}>
        {camOn && (
          /* 自己的画面 (镜像, 跟照镜子一样); 抓帧抓的是原图, 不镜像 */
          <video ref={camVideoRef} className="neox-voicemode-call__cam" muted playsInline aria-label={isZh ? '你的摄像头画面' : 'Your camera'} />
        )}
        <div className="neox-voicemode-call__wave">
          <SiriWaveCanvas getAmp={getAmp} onClick={onWaveClick} label={statusText || (isZh ? '通话' : 'Call')} />
        </div>
        <div className="neox-voicemode-call__text">
          <div className="neox-voicemode-call__status">
            {state === 'listening' ? (isZh ? '在听' : 'Listening')
              : state === 'speaking' ? (isZh ? '在说' : 'Speaking')
              : state === 'paused' ? (isZh ? '已静音' : 'Muted')
              : statusText || (isZh ? '接通中' : 'Connecting')}
          </div>
          <div className="neox-voicemode-call__caption" aria-live="polite">{caption || ' '}</div>
        </div>
        <div className="neox-voicemode-call__btns">
          {state === 'speaking' && (
            <button type="button" className="neox-voicemode-call__btn" onClick={interrupt}>
              {isZh ? '打断' : 'Interrupt'}
            </button>
          )}
          <button
            type="button"
            className={`neox-voicemode-call__btn${state === 'paused' ? ' is-on' : ''}`}
            onClick={() => void pilotApi().pilotCallAction?.(state === 'paused' ? 'unmute' : 'mute')}
          >
            {state === 'paused' ? (isZh ? '取消静音' : 'Unmute') : (isZh ? '静音' : 'Mute')}
          </button>
          <button
            type="button"
            className={`neox-voicemode-call__btn${camOn ? ' is-on' : ''}`}
            onClick={() => void toggleCam()}
            title={camError === 'denied' ? (isZh ? '没有摄像头权限: 系统设置 → 隐私 → 摄像头' : 'Camera permission denied') : undefined}
          >
            {camOn ? (isZh ? '关摄像头' : 'Camera off')
              : camError ? (isZh ? '摄像头不可用' : 'No camera')
              : (isZh ? '开摄像头' : 'Camera')}
          </button>
          <button type="button" className="neox-voicemode-call__btn neox-voicemode-call__btn--hang" onClick={() => { stopCam(); close(); }}>
            {isZh ? '挂断' : 'Hang up'}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="neox-voicemode__scrim neox-voicemode__scrim--siri" role="dialog" aria-modal="true">
      <div className="neox-voicemode neox-voicemode--siri">
        {/* 空文字也保留占位 — 状态切换时波形不上下跳 */}
        <div className={`neox-voicemode__siri-status${state === 'thinking' ? ' is-thinking' : ''}`}>{statusText || ' '}</div>
        {state === 'speaking' && spoken.length > 0 ? (
          /* 滚动字幕: 正在念的句子亮且大, 念过的上移缩小变暗 (歌词式) */
          <div className="neox-voicemode__captions" aria-live="polite">
            {spoken.map((s, i) => (
              <div key={s.id} className={`neox-voicemode__caption${i === spoken.length - 1 ? ' is-current' : ''}`}>
                {s.text}
              </div>
            ))}
          </div>
        ) : (transcript || (state === 'thinking' && lastSent)) ? (
          <div className="neox-voicemode__siri-transcript">
            {transcript || lastSent}
          </div>
        ) : null}
        <SiriWaveCanvas getAmp={getAmp} onClick={onWaveClick} label={statusText || (isZh ? '语音对话' : 'Voice chat')} />
        {state === 'listening' && rounds === 0 && (
          <>
            <div className="neox-voicemode__siri-hint">
              {isZh ? '说完稍停自动发送 · Esc 结束' : 'Pause briefly to send · Esc to end'}
            </div>
            {/* 空态示例引导 — 第一次进语音对话的用户常常"不知道能说什么", 给 3 个真实场景种子.
             * 点击后走 composer-fill send:true, 跟"从麦克风说出这句话"等价 —
             * TimelineComposer 的 onFill handler 已经处理排队/发送分支. */}
            <div className="neox-voicemode__seeds" aria-label={isZh ? '你可以试着说' : 'Try saying'}>
              <span className="neox-voicemode__seeds-lead">{isZh ? '试试:' : 'Try:'}</span>
              {(isZh
                ? ['帮我定明早 8 点闹钟', '上海天气怎么样', '记住我不吃辣']
                : ['Wake me up 8am tomorrow', 'Weather in Shanghai', 'Remember I don\'t eat spicy']
              ).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="neox-voicemode__seed"
                  onClick={() => {
                    try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: s, send: true } })); }
                    catch { /* noop */ }
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="neox-voicemode__actions">
          <button
            type="button"
            className="neox-voicemode__btn neox-voicemode__btn--ghost"
            onClick={close}
          >
            {isZh ? '结束对话 (Esc)' : 'End (Esc)'}
          </button>
          {state === 'listening' && (
            <button
              type="button"
              className="neox-voicemode__btn neox-voicemode__btn--ghost"
              onClick={pauseListening}
              title={isZh ? '和别人说话时先静音, 免得被当成指令' : 'Mute while talking to others'}
            >
              {isZh ? '静音' : 'Mute'}
            </button>
          )}
          {state === 'paused' && (
            <button
              type="button"
              className="neox-voicemode__btn neox-voicemode__btn--primary"
              onClick={() => void startListening()}
            >
              {isZh ? '继续听' : 'Resume'}
            </button>
          )}
          {state === 'listening' && transcript.trim() && (
            <button
              type="button"
              className="neox-voicemode__btn neox-voicemode__btn--primary"
              onClick={finishSpeaking}
            >
              {isZh ? '说完了 (Enter)' : 'Done (Enter)'}
            </button>
          )}
          {state === 'speaking' && (
            <button
              type="button"
              className="neox-voicemode__btn neox-voicemode__btn--stop"
              onClick={interrupt}
            >
              {isZh ? '打断' : 'Interrupt'}
            </button>
          )}
          {state === 'error' && (
            <button
              type="button"
              className="neox-voicemode__btn neox-voicemode__btn--primary"
              onClick={() => void startListening()}
            >
              {isZh ? '重试' : 'Retry'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

/** 16k 单声道 Int16 PCM 块 → WAV base64 (custom STT 整段识别用) */
function pcmToWavBase64(chunks: ArrayBuffer[], sampleRate: number): string {
  const dataLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           /* PCM */
  view.setUint16(22, 1, true);           /* mono */
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  let off = 44;
  for (const c of chunks) {
    new Uint8Array(buf, off, c.byteLength).set(new Uint8Array(c));
    off += c.byteLength;
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

const SiriWaveCanvas: React.FC<{
  getAmp: () => number;
  onClick: () => void;
  label: string;
}> = React.memo(({ getAmp, onClick, label }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    /* 波形色从 CSS var 读 (主题切换自动跟随 — canvas 每帧读, 免主题切时波形抖).
     * 亮主题: --vm-wave-primary=品牌紫, --vm-wave-accent=紫粉混合 (对比深底不需要);
     * 暗主题: --vm-wave-primary=#a89bff (亮紫), --vm-wave-accent=#ff6bb8 (粉).
     * additive 混合在亮底容易白爆 → 亮主题下自动降 vigor + 关 shadowBlur. */
    const parseRgb = (col: string): [number, number, number] | null => {
      const c = col.trim();
      if (c.startsWith('#')) {
        const hex = c.slice(1);
        const full = hex.length === 3 ? hex.split('').map(x => x + x).join('') : hex;
        return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
      }
      const m = c.match(/rgba?\(([\d\s.]+)[,\s]+([\d\s.]+)[,\s]+([\d\s.]+)/i);
      return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : null;
    };
    const readTheme = () => {
      /* 读取容器最近祖先的主题 (data-theme). 用 document 根较通用. */
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const cs = getComputedStyle(canvas);
      const primary = parseRgb(cs.getPropertyValue('--vm-wave-primary').trim() || (isDark ? '#a89bff' : '#6d5df3')) || [168, 155, 255];
      const accent = parseRgb(cs.getPropertyValue('--vm-wave-accent').trim() || (isDark ? '#ff6bb8' : '#c96ee0')) || [255, 107, 184];
      return { primary, accent, isDark };
    };

    let raf = 0;
    let t = 0;
    let smooth = 0.1;
    const draw = () => {
      t += 0.016;
      const target = Math.max(0.05, Math.min(1.3, getAmp()));
      smooth += (target - smooth) * 0.09;
      const W = canvas.width;
      const H = canvas.height;
      const mid = H * 0.52;
      ctx.clearRect(0, 0, W, H);
      const { primary, accent, isDark } = readTheme();
      /* 亮主题 additive 会白爆 — 用 source-over; 暗主题保留 lighter 出流光效果 */
      ctx.globalCompositeOperation = isDark ? 'lighter' : 'source-over';
      const vigor = 0.3 + 0.7 * Math.min(1, smooth);
      /* 两股色带交替: primary / accent / primary / accent, 各自速度相位错开 */
      const STRANDS = [
        { rgb: primary, speed: 1.00, off: 0.0 },
        { rgb: accent,  speed: 1.26, off: 1.7 },
        { rgb: primary, speed: 0.82, off: 3.9 },
        { rgb: accent,  speed: 1.55, off: 5.1 },
      ];
      /* 亮主题描线不透明, 减少层数, 减弱 shadowBlur; 暗主题保留 3 层叠 + 强发光 */
      const layers = isDark ? 3 : 2;
      const baseAlpha = isDark ? 0.42 : 0.55;
      const shadowBlurPx = isDark ? 13 : 4;
      for (const s of STRANDS) {
        for (let j = 0; j < layers; j++) {
          const amp = smooth * H * 0.4 * (1 - j * 0.24);
          ctx.beginPath();
          const step = Math.max(3, Math.round(4 * dpr));
          for (let px = 0; px <= W; px += step) {
            const x = (px / W) * 2 - 1;
            const env = Math.pow(Math.max(0, 1 - x * x), 2);
            const y = mid + env * amp
              * Math.sin((px / W) * (5 + j * 1.4) * Math.PI + t * 2.1 * s.speed + s.off + j * 0.9)
              * (0.62 + 0.38 * Math.sin(t * 0.66 * s.speed + s.off * 2 + j));
            if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
          }
          ctx.strokeStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${((baseAlpha - j * 0.11) * vigor).toFixed(3)})`;
          ctx.lineWidth = (2.2 - j * 0.55) * dpr;
          ctx.shadowColor = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${(0.75 * vigor).toFixed(3)})`;
          ctx.shadowBlur = shadowBlurPx * dpr;
          ctx.stroke();
        }
      }
      /* 左右渐隐 mask — 光带在两端柔和消失, 不顶着画布边缘一刀切 */
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = 'destination-in';
      const fade = ctx.createLinearGradient(0, 0, W, 0);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(0.12, 'rgba(0,0,0,1)');
      fade.addColorStop(0.88, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, W, H);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [getAmp]);

  return (
    <canvas
      ref={canvasRef}
      className="neox-voicemode__wave"
      onClick={onClick}
      role="button"
      aria-label={label}
    />
  );
});

export default VoiceMode;
