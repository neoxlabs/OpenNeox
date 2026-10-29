
const TARGET_SAMPLE_RATE = 16000;

export interface VoiceRecorder {
  stop: () => Promise<{ base64: string; format: 'wav' }>;
  cancel: () => void;
}

export async function startRecording(): Promise<VoiceRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx: AudioContext = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  // ScriptProcessor 已废弃但 Electron/Chromium 仍稳定可用, 比 AudioWorklet 少一个文件。
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);

  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);

  const teardown = () => {
    try { processor.disconnect(); } catch { /* noop */ }
    try { source.disconnect(); } catch { /* noop */ }
    try { stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    void audioCtx.close().catch(() => { /* noop */ });
  };

  return {
    async stop() {
      const inputRate = audioCtx.sampleRate;
      teardown();
      const merged = mergeFloat32(chunks);
      const down = downsample(merged, inputRate, TARGET_SAMPLE_RATE);
      const wav = encodeWav(down, TARGET_SAMPLE_RATE);
      return { base64: uint8ToBase64(new Uint8Array(wav)), format: 'wav' as const };
    },
    cancel() {
      teardown();
      chunks.length = 0;
    },
  };
}

function mergeFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function downsample(buffer: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (targetRate >= inputRate) return buffer;
  const ratio = inputRate / targetRate;
  const newLen = Math.floor(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const next = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = Math.floor(i * ratio); j < next && j < buffer.length; j++) {
      sum += buffer[j];
      count++;
    }
    result[i] = count > 0 ? sum / count : 0;
  }
  return result;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);      // PCM chunk size
  view.setUint16(20, 1, true);       // audio format = PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
