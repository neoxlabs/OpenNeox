
const TARGET_RATE = 16000;

export interface VoiceStream {
  stop: () => void;
  /* AnalyserNode 挂 mic 源, 用于波形可视化 (Composer 顶栏 mini viz).
   * fftSize=256 是"看得清峰值又不过密"的甜点; getByteFrequencyData 返 128 bin. */
  analyser: AnalyserNode;
}

export interface VoiceStreamOptions {
  /** 说完静音 N 毫秒后自动结束 (触发 onSilence)。默认 1500ms。0/未传 onSilence = 不自动停。 */
  silenceMs?: number;
  getSilenceMs?: () => number;
  /** 检测到"说过话后持续静音"时回调一次 (用于自动结束录音)。 */
  onSilence?: () => void;
  /** ScriptProcessor 缓冲样本数 (默认 4096≈85ms@48k)。抢话探针用 2048 把反应粒度减半。 */
  bufferSize?: number;
}

export async function startVoiceStream(
  onChunk: (pcm: ArrayBuffer) => void,
  opts: VoiceStreamOptions = {},
): Promise<VoiceStream> {
  /* AEC 显式开 — 语音模式抢话打断的命门: TTS 从扬声器出来会灌回麦克风,
   * Chromium AEC 以本 app 音频输出为参考信号做回声消除, 人声才浮得出来 */
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx: AudioContext = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(opts.bufferSize ?? 4096, 1, 1);
  const inputRate = audioCtx.sampleRate;
  /* 并联 AnalyserNode: source → analyser (只读, 不进 processor 链), 波形可视化用.
   * smoothingTimeConstant 0.6 让柱形不至于刷新过快 (人眼舒适档). */
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);

  /* 静音自动停 (VAD): 算每帧 RMS, 超过阈值算"在说话"。一旦说过话, 又持续静音超过
   * silenceMs, 触发 onSilence (只触发一次)。说话前的初始静音不算 (hasSpoken 门控)。 */
  const silenceMs = opts.silenceMs ?? 1500;
  let noiseFloor = 0.01;
  let hasSpoken = false;
  let voicedRun = 0;   /* 连续有声帧确认 — 拍桌/关门脉冲不算开口 */
  let lastVoiceAt = Date.now();
  let silenceFired = false;

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0);
    if (opts.onSilence && !silenceFired) {
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      if (rms < noiseFloor) noiseFloor = rms * 0.3 + noiseFloor * 0.7;
      else noiseFloor = Math.min(noiseFloor * 1.008, 0.04);
      const thr = Math.min(0.12, Math.max(0.018, noiseFloor * 3));
      const now = Date.now();
      if (rms >= thr) {
        voicedRun += 1;
        if (voicedRun >= 3) { hasSpoken = true; lastVoiceAt = now; }
      } else if (voicedRun > 0 && !hasSpoken) {
        voicedRun = 0;
      } else if (hasSpoken) {
        /* 动态阈值 (语义收口) 优先; 异常/未传回落固定 silenceMs */
        let effMs = silenceMs;
        if (opts.getSilenceMs) {
          try { effMs = opts.getSilenceMs() || silenceMs; } catch { /* noop */ }
        }
        if (now - lastVoiceAt >= effMs) {
          silenceFired = true;
          try { opts.onSilence(); } catch { /* noop */ }
        }
      }
    }
    const down = downsample(input, inputRate, TARGET_RATE);
    const pcm = floatToInt16(down);
    if (pcm.byteLength > 0) onChunk(pcm);
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);

  return {
    stop() {
      try { processor.disconnect(); } catch { /* noop */ }
      try { analyser.disconnect(); } catch { /* noop */ }
      try { source.disconnect(); } catch { /* noop */ }
      try { stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
      void audioCtx.close().catch(() => { /* noop */ });
    },
    analyser,
  };
}

function downsample(buffer: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (targetRate >= inputRate) return buffer;
  const ratio = inputRate / targetRate;
  const newLen = Math.floor(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const next = Math.floor((i + 1) * ratio);
    let sum = 0, count = 0;
    for (let j = Math.floor(i * ratio); j < next && j < buffer.length; j++) {
      sum += buffer[j]; count++;
    }
    result[i] = count > 0 ? sum / count : 0;
  }
  return result;
}

function floatToInt16(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
