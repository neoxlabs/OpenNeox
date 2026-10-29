
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { lazyElectron } from '../lazyElectron.js';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const net = lazyElectron<typeof import('electron').net>('net');
import { neoxLogger } from '@neoxlabs/kernel/platform/neoxLogger.js';
import { importPackModule } from './assetPackService.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const MODEL_DIR = join(homedir(), NEOX_HOME_DIRNAME, 'models');
const MODEL_PATH = join(MODEL_DIR, 'campplus.onnx');
const PRINT_PATH = join(homedir(), NEOX_HOME_DIRNAME, 'voiceprint.json');

const MODEL_SOURCES = [
  /* CosyVoice 官方资产里的 CAM++ — modelscope 国内 CDN 直连 */
  'https://modelscope.cn/models/iic/CosyVoice-300M/resolve/master/campplus.onnx',
  /* sherpa-onnx 同架构导出 (GitHub, 海外兜底) */
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
];

/* 默认阈值: CAM++ zh 同人 cosine 通常 >0.55, 异人 <0.25 — 0.38 偏放行 (宁可放过旁人
 * 一两句, 不能把主人锁在门外)。config 可调。 */
const DEFAULT_THRESHOLD = 0.38;

interface VoicePrint {
  version: 1;
  embedding: number[];
  createdAt: number;
}

/* ============ kaldi 兼容 fbank (对齐 torchaudio.compliance.kaldi.fbank 缺省 +
 * 3D-Speaker FBank(80, mean_nor=True)): dither=0, remove_dc, preemph 0.97,
 * povey 窗 400/160, 512-FFT, mel 低频 20 高频 nyquist, log(max(x, eps)), 最后 CMN ============ */

const SAMPLE_RATE = 16000;
const FRAME_LEN = 400;   /* 25ms */
const FRAME_SHIFT = 160; /* 10ms */
const NFFT = 512;
const NUM_BINS = 80;
const MEL_LOW = 20;

function hzToMel(hz: number): number { return 1127 * Math.log(1 + hz / 700); }

let melBanksCache: Array<{ start: number; weights: Float32Array }> | null = null;
function melBanks(): Array<{ start: number; weights: Float32Array }> {
  if (melBanksCache) return melBanksCache;
  const numFftBins = NFFT / 2 + 1;
  const nyquist = SAMPLE_RATE / 2;
  const melLow = hzToMel(MEL_LOW);
  const melHigh = hzToMel(nyquist);
  const melDelta = (melHigh - melLow) / (NUM_BINS + 1);
  const fftBinWidth = SAMPLE_RATE / NFFT;
  const banks: Array<{ start: number; weights: Float32Array }> = [];
  for (let b = 0; b < NUM_BINS; b++) {
    const left = melLow + b * melDelta;
    const center = melLow + (b + 1) * melDelta;
    const right = melLow + (b + 2) * melDelta;
    let start = -1;
    const ws: number[] = [];
    for (let i = 0; i < numFftBins; i++) {
      const mel = hzToMel(fftBinWidth * i);
      if (mel > left && mel < right) {
        const w = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
        if (start === -1) start = i;
        ws.push(w);
      }
    }
    banks.push({ start: Math.max(0, start), weights: Float32Array.from(ws) });
  }
  melBanksCache = banks;
  return banks;
}

/* 迭代 radix-2 FFT (实输入, 输出 [re, im] 交错) */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

let poveyCache: Float32Array | null = null;
function poveyWindow(): Float32Array {
  if (poveyCache) return poveyCache;
  const w = new Float32Array(FRAME_LEN);
  for (let i = 0; i < FRAME_LEN; i++) {
    w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1)), 0.85);
  }
  poveyCache = w;
  return w;
}

/** Int16 PCM (16k mono) → [T, 80] log-mel fbank, 已做 CMN。返回扁平 Float32Array。 */
export function computeFbank(pcm: Int16Array): { data: Float32Array; frames: number } {
  const numFrames = pcm.length < FRAME_LEN ? 0 : 1 + Math.floor((pcm.length - FRAME_LEN) / FRAME_SHIFT);
  const out = new Float32Array(numFrames * NUM_BINS);
  if (numFrames === 0) return { data: out, frames: 0 };
  const banks = melBanks();
  const win = poveyWindow();
  const EPS = 1.1920928955078125e-7; /* FLT_EPSILON, kaldi 同款 */
  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);
  const frame = new Float32Array(FRAME_LEN);

  for (let f = 0; f < numFrames; f++) {
    const off = f * FRAME_SHIFT;
    /* kaldi 与 torchaudio 对齐: int16 不除 32768 (幅度只影响 log 偏置, CMN 会抵消) */
    let mean = 0;
    for (let i = 0; i < FRAME_LEN; i++) { frame[i] = pcm[off + i]; mean += frame[i]; }
    mean /= FRAME_LEN;
    for (let i = 0; i < FRAME_LEN; i++) frame[i] -= mean;                    /* remove DC */
    for (let i = FRAME_LEN - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1]; /* 预加重 */
    frame[0] -= 0.97 * frame[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME_LEN; i++) re[i] = frame[i] * win[i];
    fft(re, im);
    for (let b = 0; b < NUM_BINS; b++) {
      const { start, weights } = banks[b];
      let energy = 0;
      for (let k = 0; k < weights.length; k++) {
        const idx = start + k;
        energy += (re[idx] * re[idx] + im[idx] * im[idx]) * weights[k];
      }
      out[f * NUM_BINS + b] = Math.log(Math.max(energy, EPS));
    }
  }
  /* CMN: 按维减时间均值 (3D-Speaker mean_nor=True) */
  for (let b = 0; b < NUM_BINS; b++) {
    let m = 0;
    for (let f = 0; f < numFrames; f++) m += out[f * NUM_BINS + b];
    m /= numFrames;
    for (let f = 0; f < numFrames; f++) out[f * NUM_BINS + b] -= m;
  }
  return { data: out, frames: numFrames };
}

/* ============ ONNX 推理 ============ */

let sessionPromise: Promise<any> | null = null;

async function loadOrt(): Promise<any> {
  return importPackModule('voice-engine', 'onnxruntime-node');
}

async function getSession(): Promise<any> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const o = await loadOrt();
      return o.InferenceSession.create(MODEL_PATH, { executionProviders: ['cpu'] });
    })();
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

async function extractEmbedding(pcm: Int16Array): Promise<Float32Array> {
  const ort = await loadOrt();
  const session = await getSession();
  const { data, frames } = computeFbank(pcm);
  if (frames < 30) throw new Error('音频太短 (至少 ~0.5 秒有效语音)');
  const input = new ort.Tensor('float32', data, [1, frames, NUM_BINS]);
  const feeds: Record<string, any> = { [session.inputNames[0]]: input };
  const results = await session.run(feeds);
  const out = results[session.outputNames[0]].data as Float32Array;
  return Float32Array.from(out);
}

function trimSilence(pcm: Int16Array): { trimmed: Int16Array; voicedMs: number } {
  const FRAME = 160; /* 10ms @16k */
  const n = Math.floor(pcm.length / FRAME);
  if (n === 0) return { trimmed: pcm, voicedMs: 0 };
  const rms = new Float32Array(n);
  let peak = 0;
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = 0; i < FRAME; i++) { const v = pcm[f * FRAME + i] / 32768; s += v * v; }
    rms[f] = Math.sqrt(s / FRAME);
    if (rms[f] > peak) peak = rms[f];
  }
  const thr = Math.max(0.008, peak * 0.15);
  let first = -1, last = -1, voiced = 0;
  for (let f = 0; f < n; f++) {
    if (rms[f] >= thr) { if (first === -1) first = f; last = f; voiced++; }
  }
  if (first === -1) return { trimmed: pcm, voicedMs: 0 };
  const PAD = 10; /* 100ms 上下文 */
  const s = Math.max(0, first - PAD) * FRAME;
  const e = Math.min(pcm.length, (last + 1 + PAD) * FRAME);
  return { trimmed: pcm.subarray(s, e), voicedMs: voiced * 10 };
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/* ============ 模型下载 (首次启用) ============ */

let downloadPromise: Promise<void> | null = null;

export function isModelReady(): boolean { return existsSync(MODEL_PATH); }

export async function ensureModel(onProgress?: (pct: number) => void): Promise<void> {
  if (existsSync(MODEL_PATH)) return;
  if (downloadPromise) return downloadPromise;
  downloadPromise = (async () => {
    mkdirSync(MODEL_DIR, { recursive: true });
    let lastErr: Error | null = null;
    for (const url of MODEL_SOURCES) {
      try {
        /* net.fetch 走系统代理 — Node fetch 直连 modelscope/github 会被网络环境掐 */
        const resp = await net.fetch(url, { signal: AbortSignal.timeout(180_000), redirect: 'follow' });
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
        const total = Number(resp.headers.get('content-length')) || 0;
        const reader = resp.body.getReader();
        const parts: Uint8Array[] = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.byteLength;
          if (total && onProgress) onProgress(Math.round((got / total) * 100));
        }
        const buf = Buffer.concat(parts);
        if (buf.length < 1_000_000) throw new Error('下载内容异常 (太小)');
        const tmp = `${MODEL_PATH}.part`;
        writeFileSync(tmp, buf);
        renameSync(tmp, MODEL_PATH);
        return;
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw new Error(`声纹模型下载失败: ${lastErr?.message ?? '未知错误'}`);
  })();
  downloadPromise.finally(() => { downloadPromise = null; });
  return downloadPromise;
}

/* ============ 注册 / 比对 / 状态 ============ */

function loadPrint(): VoicePrint | null {
  try {
    const p = JSON.parse(readFileSync(PRINT_PATH, 'utf8')) as VoicePrint;
    return Array.isArray(p?.embedding) && p.embedding.length > 0 ? p : null;
  } catch { return null; }
}

export function voiceprintStatus(): { modelReady: boolean; enrolled: boolean; createdAt?: number } {
  const p = loadPrint();
  return { modelReady: isModelReady(), enrolled: !!p, ...(p ? { createdAt: p.createdAt } : {}) };
}

/** 注册: pcmBase64 = 16k mono 16bit LE 裸 PCM (若带 WAV 头由调用方剥) */
export async function enrollVoiceprint(pcmBase64: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureModel();
    const buf = Buffer.from(pcmBase64, 'base64');
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    /* 裁静音再提特征 — 点按钮后的静默/收尾静音会把 CMN 拉偏, 注册出偏移声纹 */
    const { trimmed, voicedMs } = trimSilence(pcm);
    neoxLogger.info('VOICE', `voiceprint enroll: total=${Math.round(pcm.length / 16)}ms voiced=${voicedMs}ms`);
    if (voicedMs < 1500) {
      return { ok: false, error: `有效语音太短 (${(voicedMs / 1000).toFixed(1)}s) — 请持续说满 5 秒再试` };
    }
    const emb = await extractEmbedding(trimmed);
    const print: VoicePrint = { version: 1, embedding: Array.from(emb), createdAt: Date.now() };
    writeFileSync(PRINT_PATH, JSON.stringify(print));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function clearVoiceprint(): void {
  try { if (existsSync(PRINT_PATH)) unlinkSync(PRINT_PATH); } catch { /* noop */ }
}

/** 比对: 未注册/模型未就绪 → pass (声纹锁只在完整配置后才拦人) */
export async function verifyVoiceprint(pcmBase64: string, threshold?: number): Promise<{ match: boolean; score: number }> {
  const print = loadPrint();
  if (!print || !isModelReady()) return { match: true, score: 1 };
  try {
    const buf = Buffer.from(pcmBase64, 'base64');
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    /* 同注册: 裁静音 — 验证段前有 VAD 等待期静音, 后有收口静音, 不裁 CMN 全歪 */
    const { trimmed, voicedMs } = trimSilence(pcm);
    if (voicedMs < 800) {
      /* "嗯/好的"这种短句 CAM++ 分数本来就不可靠 — 放行, 别把主人的应答吞了 */
      neoxLogger.info('VOICE', `voiceprint verify: voiced=${voicedMs}ms too short — pass`);
      return { match: true, score: -1 };
    }
    const emb = await extractEmbedding(trimmed);
    const score = cosine(emb, print.embedding);
    const thr = threshold ?? DEFAULT_THRESHOLD;
    const match = score >= thr;
    neoxLogger.info('VOICE', `voiceprint verify: score=${score.toFixed(3)} thr=${thr} voiced=${voicedMs}ms match=${match}`);
    return { match, score };
  } catch (e: any) {
    /* 特征/推理失败 — 放行, 声纹锁绝不能把语音对话搞挂 */
    neoxLogger.warn('VOICE', `voiceprint verify failed (pass-through): ${e?.message ?? e}`);
    return { match: true, score: 1 };
  }
}
