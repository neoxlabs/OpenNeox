import type { EventBus } from '../eventBus.js';
import type { TTSService } from '../../services/ttsService.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface CreateChatEventPublisherOptions {
  bus: EventBus;
  sessionId: string;
  ttsService: TTSService;
  /** 语音回合 (<voice-turn>) — 工具启动时模型还没开口就由服务端垫一句 */
  isVoiceTurn?: boolean;
}

const TOOL_FILLER_ZH: Record<string, string> = {
  get_weather: '我看下天气哈。',
  web_search: '我查一下，稍等。',
  web_fetch: '我打开网页看看，稍等哈。',
  fetch: '我打开网页看看，稍等哈。',
  schedule_reminder: '好，我设一下提醒。',
  calendar_events: '我看下日历哈。',
  list_pending_tasks: '我看下待办。',
  memory: '我想想啊。',
  knowledge: '我翻下资料，稍等。',
  readfile: '我看下资料，稍等。',
};
const fillerFor = (name?: string): string =>
  TOOL_FILLER_ZH[(name || '').toLowerCase()] || '稍等，我看一下。';

interface WorkerResultData {
  agentId: string;
  success: boolean;
  output: string;
}

type TtsAudioEvent = {
  type: 'tts_audio';
  audio: string;
  audioFormat: string;
  voiceSummary: string;
  durationMs?: number;
};

type TtsAudioChunkEvent = {
  type: 'tts_audio_chunk';
  clipId: string;
  seq: number;
  audio?: string;
  audioFormat: string;
  sampleRate?: number;
  voiceSummary?: string;
  final?: boolean;
  error?: boolean;
};

type RuntimeErrorEvent = {
  type: 'error';
  message: string;
  code?: string;
};

type ErrorWithCode = Error & { code?: string };

const SENTENCE_SPLIT = /([。！？；!?]+|\.(?=\s)|\n+)/;
/** 句子短于此长度先攒着 — 防"好。""嗯。"碎片化合成, 音频断续 */
const MIN_SPOKEN_CHARS = 10;

export function createChatEventPublisher(options: CreateChatEventPublisherOptions) {
  const { bus, sessionId, ttsService, isVoiceTurn } = options;

  let sentenceBuf = '';
  let pendingShort = '';        /* 不足 MIN_SPOKEN_CHARS 的短句攒接 */
  let turnText = '';            /* 整轮累计文本 — 只用来数 ``` 奇偶判围栏内外 */
  let spokeViaStream = false;
  let fillerSpoken = false;     /* 本轮已垫过话 — 只垫一次 */
  let synthChain: Promise<void> = Promise.resolve();
  let turnEpoch = 0;
  let firstDeltaAt = 0;
  let sentenceSeq = 0;

  const resetTtsState = () => {
    sentenceBuf = '';
    pendingShort = '';
    turnText = '';
    spokeViaStream = false;
    fillerSpoken = false;
    turnEpoch = 0;
    firstDeltaAt = 0;
    sentenceSeq = 0;
  };

  const CLAUSE_SPLIT = /([，、；：,;]+)/;
  const MAX_LOCAL_CLAUSE = 20;
  const splitForLocalTts = (piece: string): string[] => {
    if (piece.length <= MAX_LOCAL_CLAUSE) return [piece];
    const parts = piece.split(CLAUSE_SPLIT);
    const out: string[] = [];
    let cur = '';
    for (let i = 0; i < parts.length; i += 2) {
      const seg = parts[i] + (parts[i + 1] ?? '');
      if (cur && (cur + seg).length > MAX_LOCAL_CLAUSE) { out.push(cur); cur = seg; }
      else cur += seg;
    }
    if (cur) {
      /* 尾段太短并进前一段, 防碎片音频 */
      if (out.length > 0 && cur.length < 6) out[out.length - 1] += cur;
      else out.push(cur);
    }
    return out.filter(x => x.trim());
  };

  const enqueueSpeak = (raw: string) => {
    const whole = raw.trim();
    if (!whole) return;
    if (ttsService.getConfig().provider === 'local') {
      for (const clause of splitForLocalTts(whole)) enqueueSpeakOne(clause);
      return;
    }
    enqueueSpeakOne(whole);
  };

  let streamingTripped = false;

  /** 句内流式发布: 音频分片到达即 publish tts_audio_chunk。返回:
   *  'ok' 成功 | 'fallback' 没出过声就失败 (可安全整句重合成) | 'aborted' 半途断流
   *  (已播出前半句, 回退会重复念 — 只发 error 帧丢弃残句)。 */
  const speakStreamToBus = async (piece: string, seq: number, queuedAt: number): Promise<'ok' | 'fallback' | 'aborted'> => {
    const meta = ttsService.getStreamingMeta();
    const clipId = `clip-${sessionId.slice(0, 8)}-${Date.now().toString(36)}-${seq}`;
    let chunkCount = 0;
    let voiceText = '';
    const publishChunk = (data: TtsAudioChunkEvent) => {
      bus.publish({ sessionId, type: 'tts_audio_chunk', data, timestamp: Date.now() });
    };
    try {
      const synthStart = Date.now();
      const result = await ttsService.speakStream(
        piece,
        (b64, index) => {
          if (index === 0) {
            cliLogger.info('VOICE_TIMING', `sentence#${seq} first-chunk +${turnEpoch ? Date.now() - turnEpoch : -1}ms (stream, waited=${synthStart - queuedAt}ms)`);
          }
          publishChunk({
            type: 'tts_audio_chunk',
            clipId,
            seq: index,
            audio: b64,
            audioFormat: meta.format,
            ...(meta.sampleRate ? { sampleRate: meta.sampleRate } : {}),
            /* 首帧带字幕文本 — voiceText 由 onStart 先行拿到 (清洗/摘要后) */
            ...(index === 0 && voiceText ? { voiceSummary: voiceText } : {}),
          });
          chunkCount++;
        },
        (vt) => { voiceText = vt; },
      );
      if (!result) return 'ok'; /* 洗空/未启用 — 无声但不算故障, 不必回退 */
      if (chunkCount === 0) return 'fallback'; /* 连接成功但零音频 — 整句重试 */
      publishChunk({ type: 'tts_audio_chunk', clipId, seq: chunkCount, audioFormat: meta.format, final: true });
      cliLogger.info('VOICE_TIMING', `sentence#${seq} stream done chunks=${chunkCount} +${turnEpoch ? Date.now() - turnEpoch : -1}ms`);
      return 'ok';
    } catch (err: any) {
      cliLogger.warn('SERVER', `sentence TTS stream failed (chunks=${chunkCount}): ${err?.message ?? err}`);
      if (chunkCount > 0) {
        /* 半途断流: 前半句已在播 — 整句回退会重复念, 只丢残句 (罕见, 宁缺勿重) */
        publishChunk({ type: 'tts_audio_chunk', clipId, seq: chunkCount, audioFormat: meta.format, error: true });
        return 'aborted';
      }
      return 'fallback';
    }
  };

  const enqueueSpeakOne = (raw: string) => {
    const piece = raw.trim();
    if (!piece) return;
    spokeViaStream = true;
    const seq = ++sentenceSeq;
    const queuedAt = Date.now();
    cliLogger.info('VOICE_TIMING', `sentence#${seq} queued +${turnEpoch ? queuedAt - turnEpoch : -1}ms len=${piece.length}`);
    synthChain = synthChain.then(async () => {
      if (!streamingTripped && ttsService.getStreamingMeta().capable) {
        const r = await speakStreamToBus(piece, seq, queuedAt);
        if (r === 'ok' || r === 'aborted') return;
        streamingTripped = true; /* 没出声就失败 → 本轮降回整句, 不再逐句撞墙 */
        cliLogger.warn('SERVER', 'TTS streaming tripped — fallback to whole-sentence path for this turn');
      }
      const synthStart = Date.now();
      const result = await ttsService.speak(piece); /* speak 内含 markdown 清洗; 洗空返回 null */
      cliLogger.info('VOICE_TIMING', `sentence#${seq} synth=${Date.now() - synthStart}ms waited=${synthStart - queuedAt}ms ok=${!!result}`);
      if (!result) return;
      cliLogger.info('VOICE_TIMING', `sentence#${seq} published +${turnEpoch ? Date.now() - turnEpoch : -1}ms`);
      bus.publish({
        sessionId,
        type: 'tts_audio',
        data: {
          type: 'tts_audio',
          audio: result.audio,
          audioFormat: result.format,
          voiceSummary: result.voiceSummary,
          durationMs: result.durationMs ?? 0,
        } satisfies TtsAudioEvent,
        timestamp: Date.now(),
      });
    }).catch(err => {
      cliLogger.warn('SERVER', `sentence TTS failed: ${err?.message ?? err}`);
    });
  };

  const hasOpenBareJson = (text: string): boolean => {
    const segs = text.split('```');
    if ((segs.length - 1) % 2 === 1) return false;   /* 正在围栏内 — inFence 已挡 */
    const seg = segs[segs.length - 1];
    let i = 0;
    for (;;) {
      const start = seg.indexOf('{"', i);
      if (start === -1) return false;
      /* 字符串感知配平 */
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = start; j < seg.length; j++) {
        const c = seg[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end === -1) return true;
      i = end + 1;
    }
  };

  /** 从 sentenceBuf 提取完整句子送合成; force=true 时把余量也清掉 (turn 收尾) */
  const drainSentences = (force = false) => {
    /* 围栏内不切句 — 数整轮文本里 ``` 的奇偶 (marker 可能被 delta 撕开,
     * 所以必须在累计文本上数, 不能只看当前 buf)。围栏里的内容等闭合后照常
     * 进切句, stripMarkdownForSpeech 会把整块丢掉不念。 */
    const inFence = ((turnText.match(/```/g) || []).length % 2) === 1;
    if (inFence && !force) return;
    /* 裸卡 JSON 在途 — 同围栏待遇, 等闭合再切 */
    if (!force && hasOpenBareJson(turnText)) return;
    if (!spokeViaStream && !force && ttsService.getConfig().provider === 'local') {
      /* 首块压到 4-14 字 — 合成时间随字数涨 (10字0.6s/24字1.2s), 首块越小
       * 出声越早; 后续块 20 字正常节奏, 韵律不受影响 */
      const m = sentenceBuf.match(/^([^。！？；!?\n]{4,14}[，、；：,;])/);
      if (m && !SENTENCE_SPLIT.test(sentenceBuf.slice(0, m[1].length))) {
        sentenceBuf = sentenceBuf.slice(m[1].length);
        enqueueSpeakOne(pendingShort + m[1]);
        pendingShort = '';
      }
    }
    const parts = sentenceBuf.split(SENTENCE_SPLIT);
    let rebuilt = '';
    for (let i = 0; i + 1 < parts.length; i += 2) {
      rebuilt += parts[i] + (parts[i + 1] ?? '');
    }
    sentenceBuf = parts.length % 2 === 1 ? parts[parts.length - 1] : '';
    if (rebuilt) {
      const candidate = pendingShort + rebuilt;
      if (candidate.trim().length >= MIN_SPOKEN_CHARS) {
        pendingShort = '';
        enqueueSpeak(candidate);
      } else {
        pendingShort = candidate;
      }
    }
    if (force) {
      const rest = (pendingShort + sentenceBuf).trim();
      pendingShort = '';
      sentenceBuf = '';
      if (rest) enqueueSpeak(rest);
    }
  };

  const publishRawEvent = (event: any, tracker?: any) => {
    cliLogger.info('SERVER', `📡 publishRawEvent: type=${event.type} sessionId=${sessionId}`);
    bus.publish({
      sessionId,
      type: event.type,
      data: event,
      tracker,
      timestamp: Date.now(),
    });

    /* [VOICE_TIMING] 回合起点锚 — reset 后第一个事件 (通常是用户消息进 runtime) */
    if (!turnEpoch) turnEpoch = Date.now();

    if (!ttsService.isEnabled()) return;

    if (isVoiceTurn && !fillerSpoken && !spokeViaStream
        && (event.type === 'tool_call_start' || event.type === 'tool_call') && !event.taskAgentId
        && (event.name ?? event.toolName) !== 'load_instructions') {
      fillerSpoken = true;
      const toolName = (event.name ?? event.toolName) as string | undefined;
      cliLogger.info('VOICE_TIMING', `tool filler spoken for ${toolName ?? 'tool'}`);
      enqueueSpeakOne(fillerFor(toolName));
      spokeViaStream = false;
    }

    /* 主 agent 的流式正文 → 按句合成 (task agent 的 delta 带 taskAgentId, 不念) */
    if (event.type === 'text' && typeof event.delta === 'string' && !event.taskAgentId) {
      if (!turnEpoch) turnEpoch = Date.now();
      if (!firstDeltaAt) {
        firstDeltaAt = Date.now();
        cliLogger.info('VOICE_TIMING', `first-delta at ${new Date(firstDeltaAt).toISOString()}`);
      }
      sentenceBuf += event.delta;
      turnText += event.delta;
      drainSentences(false);
      return;
    }
    if (event.type === 'text_complete' && !event.taskAgentId) {
      drainSentences(true);
      return;
    }

    if (event.type === 'run_result') {
      drainSentences(true);
      /* 兜底: 整轮没有流式 delta (非流式 provider / 全被围栏吃掉) 才整段合成 —
       * 走老路径 (含 autoSummarize)。有流式播报时绝不重复念。 */
      if (!spokeViaStream) {
        const ttsText = event.currentTurnText || event.output;
        if (ttsText) {
          ttsService.speak(ttsText).then(ttsResult => {
            if (!ttsResult) return;
            bus.publish({
              sessionId,
              type: 'tts_audio',
              data: {
                type: 'tts_audio',
                audio: ttsResult.audio,
                audioFormat: ttsResult.format,
                voiceSummary: ttsResult.voiceSummary,
                durationMs: ttsResult.durationMs ?? 0,
              } satisfies TtsAudioEvent,
              timestamp: Date.now(),
            });
          }).catch(err => {
            cliLogger.warn('SERVER', `TTS generation failed: ${err.message}`);
          });
        }
      }
      resetTtsState();
      return;
    }
    if (event.type === 'error') {
      resetTtsState();
    }
  };

  const publishError = (error: Error) => {
    bus.publish({
      sessionId,
      type: 'error',
      data: { type: 'error', message: error.message, code: (error as ErrorWithCode).code } satisfies RuntimeErrorEvent,
      timestamp: Date.now(),
    });
  };

  const publishWorkerResult = (data: WorkerResultData) => {
    bus.publish({
      sessionId,
      type: 'worker_result',
      data: {
        type: 'worker_result',
        agentId: data.agentId,
        success: data.success,
        output: data.output,
      },
      timestamp: Date.now(),
    });
  };

  return {
    publishRawEvent,
    publishError,
    publishWorkerResult,
  };
}
