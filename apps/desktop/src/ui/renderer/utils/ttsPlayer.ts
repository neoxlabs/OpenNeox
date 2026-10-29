/**
 * ttsPlayer - 渲染端 TTS 音频播放器(单例)
 *
 * 背景:server 端 (chatEventPublisher) 在 run_result 后合成音频并 publish `tts_audio`
 * 事件,但渲染端一直没有播放代码 → 设置里的「语音合成」是摆设。本模块补上最后一公里。
 *
 * 设计:
 * - 队列化:多条回复的音频顺序播放,不重叠。
 * - 格式:mp3 / opus 直接走 HTMLAudioElement;pcm(16bit/24kHz/mono raw)走 Web Audio 解码。
 * - 语速:server 端 Edge/云端合成时已按 config.speed 烘焙进音频(rate 参数),
 *   渲染端默认不再二次 playbackRate,避免双重加速。如需强制可传 playbackRate。
 * - 中断:新一轮用户发言 / 用户点停止时调用 stopTtsPlayback() 清空队列。
 */

export type TtsAudioFormat = 'mp3' | 'opus' | 'pcm' | string;

interface TtsQueueItem {
  audioBase64?: string;
  format: TtsAudioFormat;
  voiceSummary?: string;
  stream?: TtsStreamHandle;
}

/** 句内流式 clip 聚合体 — ingestTtsAudioChunk 喂, 播放循环消费 */
interface TtsStreamHandle {
  clipId: string;
  format: TtsAudioFormat;   /* 'pcm' | 'mp3' */
  sampleRate: number;       /* pcm 用 */
  chunks: Uint8Array[];     /* 已到未消费的分片 */
  bytes: number;            /* chunks 内字节数 */
  totalBytes: number;       /* 已接收总量 (含已消费) — 内存保险丝用 */
  done: boolean;            /* final 帧已到 */
  failed: boolean;          /* 半途断流 — 播完已缓冲部分即止 / 直接跳过 */
  wake: (() => void) | null; /* 播放循环等数据时的唤醒钩子 */
}

/** 单 clip 缓冲保险丝 — TTS 单句音频不应超过这个量级, 超了按断流处理防内存失控 */
const STREAM_CLIP_MAX_BYTES = 16 * 1024 * 1024;

const PCM_SAMPLE_RATE = 24000; // Edge TTS / 多数云端 pcm 默认 24kHz
const PCM_CHANNELS = 1;
const DUCK_LEVEL = 0.25;

/* [VOICE] 持久化日志 → ~/.neox/logs/neox-app-*.log — muted 丢音频曾是静默黑洞 */
const plog = (message: string) => {
  try {
    (window as unknown as { neox?: { logInfo?: (tag: string, msg: string) => void } })
      .neox?.logInfo?.('VOICE', `ttsPlayer: ${message}`);
  } catch { /* noop */ }
};

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function mimeFor(format: TtsAudioFormat): string {
  switch (format) {
    case 'opus': return 'audio/ogg; codecs=opus';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';   /* 本地 MeloTTS 桥返回 WAV */
    default: return 'audio/mpeg';
  }
}

class TtsPlayer {
  private queue: TtsQueueItem[] = [];
  private playing = false;
  private currentAudio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private audioCtx: AudioContext | null = null;
  private currentPcmSource: AudioBufferSourceNode | null = null;
  private playbackRate = 1.0;
  private muted = false;
  /** 还在收分片的 clip (final/error 后移除; 播放循环独立经 queue item 持有 handle) */
  private activeStreams = new Map<string, TtsStreamHandle>();
  /** 已丢弃 clip (muted 期/首帧缺失) — 后续分片静默丢, 防"无头 mp3"入队 */
  private droppedStreamClips = new Set<string>();
  /** 正在播放的 stream handle — stop() 要能戳醒并废掉它 */
  private currentStream: TtsStreamHandle | null = null;
  /** 代际号: stop() 自增, 在播的流式循环发现代际变了立刻退出 */
  private streamPlaybackToken = 0;
  /** pcm 流式在播的已排期 source — stop() 全停 */
  private currentStreamSources: Set<AudioBufferSourceNode> | null = null;
  private gainNode: GainNode | null = null;
  private ducked = false;
  private listeners = new Set<(playing: boolean) => void>();
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Uint8Array<ArrayBuffer> | null = null;
  private textListeners = new Set<(text: string) => void>();

  /** 订阅播放状态 (true=开播 false=队列播完/被停)。返回退订函数。 */
  subscribe(listener: (playing: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 订阅"正在念的句子" — 每条 clip 开播时回调其 voiceSummary (无文本的 clip 不回调) */
  subscribeText(listener: (text: string) => void): () => void {
    this.textListeners.add(listener);
    return () => this.textListeners.delete(listener);
  }

  private emitText(text: string): void {
    for (const l of this.textListeners) { try { l(text); } catch { /* noop */ } }
  }

  isPlaying(): boolean { return this.playing; }

  /** 当前输出电平 0-1 (无播放/无 analyser 返回 0) — VoiceMode 音浪用 */
  getLevel(): number {
    if (!this.playing || !this.analyser || !this.analyserBuf) return 0;
    this.analyser.getByteTimeDomainData(this.analyserBuf);
    let sum = 0;
    for (let i = 0; i < this.analyserBuf.length; i++) {
      const v = (this.analyserBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.analyserBuf.length) * 4);
  }

  private emit(playing: boolean): void {
    for (const l of this.listeners) { try { l(playing); } catch { /* noop */ } }
  }

  private ensureCtx(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.audioCtx;
  }

  private ensureAnalyser(ctx: AudioContext): AnalyserNode {
    if (!this.analyser || this.analyser.context !== ctx) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = this.ducked ? DUCK_LEVEL : 1;
      this.analyser.connect(this.gainNode);
      this.gainNode.connect(ctx.destination);
      this.analyserBuf = new Uint8Array(this.analyser.frequencyBinCount);
    }
    return this.analyser;
  }

  /** 压低/还原音量 — 不打断播放, 影子声纹确认期用 */
  setDucked(ducked: boolean): void {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    plog(`ducked → ${ducked}`);
    const target = ducked ? DUCK_LEVEL : 1;
    if (this.gainNode && this.audioCtx) {
      try { this.gainNode.gain.setTargetAtTime(target, this.audioCtx.currentTime, 0.04); }
      catch { this.gainNode.gain.value = target; }
    }
    /* ctx 路由失败退回元素直出的场合 — 元素音量兜底 */
    if (this.currentAudio) { try { this.currentAudio.volume = target; } catch { /* noop */ } }
  }

  /** 入队并触发播放(若空闲) */
  enqueue(item: TtsQueueItem): void {
    if (this.muted) {
      plog(`clip dropped (muted) text="${(item.voiceSummary || '').slice(0, 40)}"`);
      return;
    }
    if (!item.audioBase64 && !item.stream) return;
    this.queue.push(item);
    if (!this.playing) void this.drain();
  }

  ingestChunk(evt: {
    clipId: string;
    seq: number;
    audio?: string;
    audioFormat: string;
    sampleRate?: number;
    voiceSummary?: string;
    final?: boolean;
    error?: boolean;
  }): void {
    const { clipId } = evt;
    if (!clipId) return;
    if (this.droppedStreamClips.has(clipId)) return;
    let h = this.activeStreams.get(clipId);
    if (!h) {
      /* muted / 首帧缺失 (乱序或前帧被 muted 丢) → 整 clip 拉黑 */
      if (this.muted || evt.seq !== 0 || evt.error) {
        if (evt.seq === 0) plog(`stream clip dropped (${this.muted ? 'muted' : 'error-head'}) text="${(evt.voiceSummary || '').slice(0, 40)}"`);
        this.markStreamClipDropped(clipId);
        return;
      }
      h = {
        clipId,
        format: evt.audioFormat || 'mp3',
        sampleRate: evt.sampleRate || PCM_SAMPLE_RATE,
        chunks: [],
        bytes: 0,
        totalBytes: 0,
        done: false,
        failed: false,
        wake: null,
      };
      this.activeStreams.set(clipId, h);
      this.queue.push({ format: h.format, voiceSummary: evt.voiceSummary, stream: h });
      if (!this.playing) void this.drain();
    }
    if (evt.audio) {
      const bytes = base64ToUint8(evt.audio);
      if (bytes.byteLength > 0) {
        h.totalBytes += bytes.byteLength;
        if (h.totalBytes > STREAM_CLIP_MAX_BYTES) {
          plog(`stream clip ${clipId} exceeded ${STREAM_CLIP_MAX_BYTES}B — treat as failed`);
          h.failed = true;
          h.done = true;
        } else {
          h.chunks.push(bytes);
          h.bytes += bytes.byteLength;
        }
      }
    }
    if (evt.error) {
      h.failed = true;
      h.done = true;
      plog(`stream clip ${clipId} errored midway (buffered=${h.totalBytes}B)`);
    } else if (evt.final) {
      h.done = true;
    }
    if (h.done) this.activeStreams.delete(clipId);
    h.wake?.();
  }

  private markStreamClipDropped(clipId: string): void {
    this.droppedStreamClips.add(clipId);
    /* 集合只增会漏 — 语音长会话几百句, 简单容量圈养 */
    if (this.droppedStreamClips.size > 256) {
      const first = this.droppedStreamClips.values().next().value;
      if (first !== undefined) this.droppedStreamClips.delete(first);
    }
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.min(2.0, Math.max(0.5, rate || 1.0));
    if (this.currentAudio) this.currentAudio.playbackRate = this.playbackRate;
  }

  /** 静音:停止当前并丢弃后续,直到再次 enqueue 前保持 */
  setMuted(muted: boolean): void {
    if (this.muted !== muted) plog(`muted → ${muted}`);
    this.muted = muted;
    if (muted) this.stop();
  }

  /** 停止当前播放并清空队列 */
  stop(): void {
    this.queue = [];
    if (this.playing) this.emit(false);
    this.playing = false;
    if (this.currentAudio) {
      try { this.currentAudio.pause(); } catch { /* noop */ }
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    if (this.currentPcmSource) {
      try { this.currentPcmSource.stop(); } catch { /* noop */ }
      this.currentPcmSource = null;
    }
    /* ── 流式 clip 清场: 代际号自增让在播循环退出, 排期中的 pcm source 全停,
     * 在收的 handle 标失败并戳醒等待者 (打断/静音必须立刻无声, 不能等分片播完) ── */
    this.streamPlaybackToken++;
    if (this.currentStreamSources) {
      for (const s of this.currentStreamSources) { try { s.stop(); } catch { /* noop */ } }
      this.currentStreamSources = null;
    }
    if (this.currentStream) {
      this.currentStream.failed = true;
      this.currentStream.done = true;
      this.currentStream.wake?.();
      this.currentStream = null;
    }
    for (const h of this.activeStreams.values()) {
      h.failed = true;
      h.done = true;
      this.markStreamClipDropped(h.clipId);
      h.wake?.();
    }
    this.activeStreams.clear();
  }

  private async drain(): Promise<void> {
    this.playing = true;
    this.emit(true);
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.voiceSummary?.trim()) this.emitText(item.voiceSummary.trim());
      try {
        if (item.stream) {
          await this.playStream(item.stream);
        } else if (item.format === 'pcm') {
          await this.playPcm(item.audioBase64!);
        } else {
          await this.playEncoded(item.audioBase64!, item.format);
        }
      } catch (err) {
        // 单条失败不阻塞队列后续
        console.warn('[ttsPlayer] playback failed:', err);
      }
    }
    if (this.playing) this.emit(false);
    this.playing = false;
  }


  private async playStream(h: TtsStreamHandle): Promise<void> {
    const token = ++this.streamPlaybackToken;
    this.currentStream = h;
    try {
      if (h.format === 'pcm') {
        await this.playPcmStream(h, token);
      } else if (h.format === 'mp3' && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')) {
        await this.playMseStream(h, token);
      } else {
        /* 未知格式/环境不支持 MSE — 攒满整句退化播放, 不流式但不无声 */
        await this.waitForStream(h, () => h.done, token);
        if (h.failed || this.streamPlaybackToken !== token) return;
        const total = new Uint8Array(h.bytes);
        let off = 0;
        for (const c of h.chunks) { total.set(c, off); off += c.byteLength; }
        h.chunks = [];
        h.bytes = 0;
        let bin = '';
        for (let i = 0; i < total.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, total.subarray(i, i + 0x8000) as unknown as number[]);
        }
        await this.playEncoded(btoa(bin), h.format);
      }
    } finally {
      if (this.currentStream === h) this.currentStream = null;
    }
  }

  /** 等待条件满足 / clip 失败 / 播放代际切换 (stop) — 数据驱动, 无轮询 */
  private waitForStream(h: TtsStreamHandle, ready: () => boolean, token: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (ready() || h.failed || this.streamPlaybackToken !== token) {
          h.wake = null;
          resolve();
          return true;
        }
        return false;
      };
      if (check()) return;
      h.wake = () => { check(); };
    });
  }

  /** pcm 流式: 分片攒到起播水位后按采样时间轴首尾排期 — 分片间无缝, 无爆音。
   * 水位 (~200ms) 防启动即断供; 断供时小跳重锚 (听感短顿, 不炸音)。 */
  private async playPcmStream(h: TtsStreamHandle, token: number): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* noop */ } }
    const analyser = this.ensureAnalyser(ctx);
    const sources = new Set<AudioBufferSourceNode>();
    this.currentStreamSources = sources;
    const sampleRate = h.sampleRate || PCM_SAMPLE_RATE;
    /* 起播水位 200ms + 每片最少 60ms: 排期粒度太细会积累调度开销, 太粗增加首声延迟 */
    const PREBUFFER_BYTES = Math.floor(sampleRate * 0.2) * 2;
    const MIN_SLICE_BYTES = Math.floor(sampleRate * 0.06) * 2;
    let carry: Uint8Array | null = null;   /* 分片可能非 2 字节对齐 — 半个采样留到下片 */
    let nextAt = 0;
    let tailEnd: Promise<void> = Promise.resolve();

    const takeBytes = (): Uint8Array | null => {
      if (h.bytes === 0 && !carry) return null;
      const merged = new Uint8Array((carry?.byteLength || 0) + h.bytes);
      let off = 0;
      if (carry) { merged.set(carry, off); off += carry.byteLength; carry = null; }
      for (const c of h.chunks) { merged.set(c, off); off += c.byteLength; }
      h.chunks = [];
      h.bytes = 0;
      const usable = merged.byteLength & ~1;   /* 偶数字节 = 完整 Int16 采样 */
      if (usable < merged.byteLength) carry = merged.subarray(usable);
      return usable > 0 ? merged.subarray(0, usable) : null;
    };

    const schedule = (bytes: Uint8Array) => {
      const sampleCount = bytes.byteLength / 2;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const buffer = ctx.createBuffer(PCM_CHANNELS, sampleCount, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = this.playbackRate;
      src.connect(analyser);
      /* 断供后时间轴落后于当前时刻 → 重锚到 now+30ms (小跳); 正常时严格首尾相接 */
      const startAt = Math.max(ctx.currentTime + 0.03, nextAt);
      src.start(startAt);
      nextAt = startAt + buffer.duration / Math.max(0.5, this.playbackRate);
      sources.add(src);
      tailEnd = new Promise<void>((resolve) => {
        src.onended = () => { sources.delete(src); resolve(); };
      });
    };

    try {
      /* 起播水位: 攒够 PREBUFFER 或 clip 已收尾 (短句) 才开排, 防开播即断供 */
      await this.waitForStream(h, () => h.bytes >= PREBUFFER_BYTES || h.done, token);
      for (;;) {
        if (this.streamPlaybackToken !== token) return;
        /* 半途断流: 未排期的残片丢弃 (宁缺勿重), 已排期部分自然播完 */
        if (h.failed) break;
        if (h.bytes >= MIN_SLICE_BYTES || (h.done && h.bytes > 0)) {
          const bytes = takeBytes();
          if (bytes) schedule(bytes);
          continue;
        }
        if (h.done) break;   /* 只剩 carry 半采样 — 尾部残字节丢弃 */
        await this.waitForStream(h, () => h.bytes >= MIN_SLICE_BYTES || h.done, token);
      }
      /* 全部排期完 — 等最后一片播完 (stop 会直接 src.stop 触发 onended) */
      await tailEnd;
    } finally {
      if (this.currentStreamSources === sources) this.currentStreamSources = null;
      for (const s of sources) { try { s.stop(); } catch { /* noop */ } }
    }
  }

  /** mp3 流式: MediaSource 追加 — mp3 帧自同步, 分片任意边界都能被解析器消化。
   * 起播水位 0.15s 缓冲; stop() 通过代际号 + currentAudio.pause 双保险掐断。 */
  private playMseStream(h: TtsStreamHandle, token: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const ms = new MediaSource();
      const url = URL.createObjectURL(ms);
      const audio = new Audio(url);
      audio.playbackRate = this.playbackRate;
      try { audio.volume = this.ducked ? DUCK_LEVEL : 1; } catch { /* noop */ }
      try {
        const ctx = this.ensureCtx();
        if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* noop */ });
        const srcNode = ctx.createMediaElementSource(audio);
        srcNode.connect(this.ensureAnalyser(ctx));
      } catch { /* noop — 直接元素直出, 只丢电平不丢声 */ }
      this.currentAudio = audio;
      this.currentUrl = url;

      let settled = false;
      let started = false;
      let pumping = false;
      let sb: SourceBuffer | null = null;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        h.wake = null;
        if (this.currentUrl === url) { URL.revokeObjectURL(url); this.currentUrl = null; }
        if (this.currentAudio === audio) this.currentAudio = null;
        try { audio.pause(); } catch { /* noop */ }
        resolve();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;

      const maybeStart = () => {
        if (started) return;
        /* 水位: 缓冲 ≥0.15s 或流已收尾 — 防播-停-播的结巴 */
        let buffered = 0;
        try { buffered = audio.buffered.length > 0 ? audio.buffered.end(audio.buffered.length - 1) : 0; } catch { /* noop */ }
        if (buffered >= 0.15 || h.done) {
          started = true;
          audio.play().catch(() => cleanup());
        }
      };

      const pump = () => {
        if (settled) return;
        if (this.streamPlaybackToken !== token) { cleanup(); return; }
        if (!sb || sb.updating || pumping) return;
        if (h.bytes > 0) {
          pumping = true;
          const merged = new Uint8Array(h.bytes);
          let off = 0;
          for (const c of h.chunks) { merged.set(c, off); off += c.byteLength; }
          h.chunks = [];
          h.bytes = 0;
          try { sb.appendBuffer(merged.buffer as ArrayBuffer); }
          catch (e) { console.warn('[ttsPlayer] MSE append failed:', e); cleanup(); return; }
          return;
        }
        if (h.done) {
          if (h.failed && !started) { cleanup(); return; }   /* 没开播就断流 — 静默跳过 */
          try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* noop */ }
          maybeStart();   /* 短句: 水位没到就收尾 → 立即起播 */
        }
      };

      ms.addEventListener('sourceopen', () => {
        if (settled) return;
        try {
          sb = ms.addSourceBuffer('audio/mpeg');
        } catch (e) {
          console.warn('[ttsPlayer] MSE addSourceBuffer failed:', e);
          cleanup();
          return;
        }
        sb.addEventListener('updateend', () => {
          pumping = false;
          maybeStart();
          pump();
        });
        h.wake = pump;
        pump();
      });
    });
  }

  private playEncoded(base64: string, format: TtsAudioFormat): Promise<void> {
    return new Promise<void>((resolve) => {
      const bytes = base64ToUint8(base64);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeFor(format) });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = this.playbackRate;
      try { audio.volume = this.ducked ? DUCK_LEVEL : 1; } catch { /* noop */ }
      /* 路由进 analyser 供电平读取 — createMediaElementSource 后音频只走 ctx 链路,
       * analyser 已 connect(destination)。失败 (罕见) 就退回元素直出, 只丢电平不丢声。 */
      try {
        const ctx = this.ensureCtx();
        if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* noop */ });
        const srcNode = ctx.createMediaElementSource(audio);
        srcNode.connect(this.ensureAnalyser(ctx));
      } catch { /* noop — 直接走 HTMLAudio 输出 */ }
      this.currentAudio = audio;
      this.currentUrl = url;
      const cleanup = () => {
        if (this.currentUrl === url) {
          URL.revokeObjectURL(url);
          this.currentUrl = null;
        }
        if (this.currentAudio === audio) this.currentAudio = null;
        resolve();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      audio.play().catch(() => cleanup());
    });
  }

  private async playPcm(base64: string): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* noop */ }
    }
    const bytes = base64ToUint8(base64);
    // 16-bit signed little-endian PCM → Float32
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = ctx.createBuffer(PCM_CHANNELS, sampleCount, PCM_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }
    await new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.playbackRate;
      source.connect(this.ensureAnalyser(ctx));
      this.currentPcmSource = source;
      source.onended = () => {
        if (this.currentPcmSource === source) this.currentPcmSource = null;
        resolve();
      };
      source.start();
    });
  }
}

let singleton: TtsPlayer | null = null;

export function getTtsPlayer(): TtsPlayer {
  if (!singleton) singleton = new TtsPlayer();
  return singleton;
}

/** 便捷:入队播放一段 base64 音频 */
export function playTtsAudio(audioBase64: string, format: TtsAudioFormat, voiceSummary?: string): void {
  getTtsPlayer().enqueue({ audioBase64, format, voiceSummary });
}

export function ingestTtsAudioChunk(evt: {
  clipId: string;
  seq: number;
  audio?: string;
  audioFormat: string;
  sampleRate?: number;
  voiceSummary?: string;
  final?: boolean;
  error?: boolean;
}): void {
  getTtsPlayer().ingestChunk(evt);
}

/** 停止并清空(新一轮发言/用户停止时调用) */
export function stopTtsPlayback(): void {
  singleton?.stop();
}

/** 订阅 TTS 播放状态 (VoiceMode 用: 开播→speaking, 播完→回到听) */
export function subscribeTtsPlayback(listener: (playing: boolean) => void): () => void {
  return getTtsPlayer().subscribe(listener);
}

/** 订阅正在念的句子文本 (VoiceMode 滚动字幕) */
export function subscribeTtsText(listener: (text: string) => void): () => void {
  return getTtsPlayer().subscribeText(listener);
}

/** 当前 TTS 输出电平 0-1 (VoiceMode 音浪) */
export function getTtsOutputLevel(): number {
  return getTtsPlayer().getLevel();
}

/** TTS 是否正在播 */
export function isTtsPlaying(): boolean {
  return singleton?.isPlaying() ?? false;
}
