
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, renameSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { lazyElectron } from '../lazyElectron.js';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const net = lazyElectron<typeof import('electron').net>('net');
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { importPackModule } from './assetPackService.js';
import type { WebContents } from 'electron';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const MODELS_ROOT = join(homedir(), NEOX_HOME_DIRNAME, 'models');

/* ==================== 模型注册表 ==================== */

export interface LocalModelSpec {
  id: 'asr-zipformer-zh-en' | 'asr-sensevoice' | 'asr-paraformer-zh' | 'tts-melo-zh-en' | 'tts-kokoro-multi';
  title: string;
  sizeMB: number;
  repo: string;          /* HF 仓库路径 (双源共用) */
  files: string[];       /* 仓库相对路径 */
  tarUrls?: string[];
}

export const LOCAL_MODELS: LocalModelSpec[] = [
  {
    id: 'asr-zipformer-zh-en',
    title: 'Zipformer 实时识别 (中英)',
    sizeMB: 200,
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    files: [
      'encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.int8.onnx', 'joiner-epoch-99-avg-1.int8.onnx',
      'tokens.txt', 'bpe.vocab',
    ],
  },
  {
    id: 'asr-sensevoice',
    title: 'SenseVoice 识别 (中英日韩粤)',
    sizeMB: 240,
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    files: ['model.int8.onnx', 'tokens.txt'],
    /* HF 经典 LFS 快, 逐文件为主; GitHub tar 兜底 */
    tarUrls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2'],
  },
  {
    id: 'asr-paraformer-zh',
    title: 'Paraformer 识别 (中文 · 更准)',
    sizeMB: 230,
    repo: '',
    files: ['model.int8.onnx', 'tokens.txt'],
    tarUrls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2'],
  },
  {
    id: 'tts-melo-zh-en',
    title: 'MeloTTS 合成 (中英混说)',
    sizeMB: 185,
    repo: 'csukuangfj/vits-melo-tts-zh_en',
    tarUrls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2'],
    files: [
      'model.onnx', 'lexicon.txt', 'tokens.txt',
      'date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst',
      'dict/hmm_model.utf8', 'dict/idf.utf8', 'dict/jieba.dict.utf8',
      'dict/stop_words.utf8', 'dict/user.dict.utf8',
      'dict/pos_dict/char_state_tab.utf8', 'dict/pos_dict/prob_emit.utf8',
      'dict/pos_dict/prob_start.utf8', 'dict/pos_dict/prob_trans.utf8',
    ],
  },
  {
    /* Kokoro-82M 多语 (中英) — 音质档但 RTF 0.6 (Melo 2.5 倍慢), 仅显式选择时用.
     * 中文音色 45-52 (47=小晓默认). */
    id: 'tts-kokoro-multi',
    title: 'Kokoro 合成 (中英 · 音质档)',
    sizeMB: 350,
    repo: '',
    files: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt'],
    tarUrls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2'],
  },
];

const SOURCES: Record<string, string> = {
  cn: 'https://hf-mirror.com',
  global: 'https://huggingface.co',
};

export function isPlatformSupported(): boolean {
  return process.platform === 'darwin';
}

export function modelDir(id: string): string { return join(MODELS_ROOT, id); }
export { MODELS_ROOT };

export type CustomAsrKind = 'transducer' | 'sense-voice' | 'paraformer' | 'whisper';
export interface CustomModelManifest {
  kind: CustomAsrKind;
  title: string;
  /** kind 对应的文件 (相对模型目录): transducer = encoder/decoder/joiner, 其余 = model (+ whisper 的 encoder/decoder) */
  files: Record<string, string>;
  tokens: string;
  bpeVocab?: string;
  sizeMB: number;
  importedAt: number;
}

export function readCustomManifest(id: string): CustomModelManifest | null {
  if (!id.startsWith('custom-')) return null;
  try {
    const m = JSON.parse(readFileSync(join(modelDir(id), 'neox-model.json'), 'utf8')) as CustomModelManifest;
    const all = [...Object.values(m.files), m.tokens];
    return all.every(f => existsSync(join(modelDir(id), f))) ? m : null;
  } catch { return null; }
}

export function listCustomModelIds(): string[] {
  try {
    return readdirSync(MODELS_ROOT).filter(n => n.startsWith('custom-') && readCustomManifest(n) !== null);
  } catch { return []; }
}

export function isModelInstalled(id: string): boolean {
  if (id.startsWith('custom-')) return readCustomManifest(id) !== null;
  const spec = LOCAL_MODELS.find(m => m.id === id);
  if (!spec) return false;
  return spec.files.every(f => existsSync(join(modelDir(id), f)));
}

/** 这个识别模型是不是流式的 (边说边出字): 内置 Zipformer + 导入的 transducer */
export function isStreamingAsr(id: string): boolean {
  return id === 'asr-zipformer-zh-en' || readCustomManifest(id)?.kind === 'transducer';
}

export function modelsStatus(): Array<{ id: string; title: string; sizeMB: number; installed: boolean; active?: boolean; partialPct?: number; custom?: boolean; streaming?: boolean }> {
  const asrActive = effectiveAsrId();
  const ttsActive = effectiveTtsId();
  const customs = listCustomModelIds().map(id => {
    const m = readCustomManifest(id)!;
    return { id, title: m.title, sizeMB: m.sizeMB, installed: true, custom: true, streaming: m.kind === 'transducer', ...(id === asrActive ? { active: true } : {}) };
  });
  return [...LOCAL_MODELS.map(m => {
    const installed = isModelInstalled(m.id);
    const active = installed && (m.id === asrActive || m.id === ttsActive);
    let partialPct: number | undefined;
    if (!installed) {
      /* 已完成文件 + 大文件断点字节 → 续传起点百分比 (重启 app 也显示) */
      let got = fileDoneBytes(join(MODELS_ROOT, `${m.id}.tar.bz2`));
      for (const f of m.files) {
        const dest = join(modelDir(m.id), f);
        if (existsSync(dest)) got += statSync(dest).size;
        else got += fileDoneBytes(dest);
      }
      if (got > 0) partialPct = Math.min(99, Math.round((got / (m.sizeMB * 1024 * 1024)) * 100));
    }
    return { id: m.id, title: m.title, sizeMB: m.sizeMB, installed, ...(m.id === 'asr-zipformer-zh-en' ? { streaming: true } : {}), ...(active ? { active } : {}), ...(partialPct !== undefined ? { partialPct } : {}) };
  }), ...customs];
}

export function removeModel(id: string): void {
  disposeEngines();
  try { rmSync(modelDir(id), { recursive: true, force: true }); } catch { /* noop */ }
}

/* ==================== 下载 (逐文件 + 进度事件) ==================== */

const downloading = new Set<string>();
const activeControllers = new Map<string, AbortController>();

export function pauseDownload(id: string): { ok: boolean } {
  const c = activeControllers.get(id);
  if (!c) return { ok: false };
  c.abort();
  return { ok: true };
}


const PARALLEL_PARTS = 6;
const PARALLEL_MIN_BYTES = 8 * 1024 * 1024;

async function streamToFile(resp: Response, dest: string, onBytes: (n: number) => void): Promise<void> {
  const tmp = `${dest}.part`;
  const out = createWriteStream(tmp);
  let outError: Error | null = null;
  out.on('error', (e: Error) => { outError = e; });
  const reader = resp.body!.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (outError) throw outError;
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => { out.off('error', onError); resolve(); };
          const onError = (e: Error) => { out.off('drain', onDrain); reject(e); };
          out.once('drain', onDrain);
          out.once('error', onError);
        });
      }
      onBytes(value.byteLength);
    }
    /* 收尾前补一次 —— 错误可能在我们挂监听之前就发完了, 不补就永远等不到 end 的回调 */
    if (outError) throw outError;
    await new Promise<void>((res, rej) => out.end((e: unknown) => (e ? rej(e) : res())));
    renameSync(tmp, dest);
  } catch (e) {
    out.destroy();
    try { rmSync(tmp, { force: true }); } catch { /* noop */ }
    throw e;
  }
}

interface DlState { total: number; partSize: number; done: number[] }

function stateFile(dest: string): string { return `${dest}.dl.json`; }

function readDlState(dest: string): DlState | null {
  try {
    const st = JSON.parse(readFileSync(stateFile(dest), 'utf8')) as DlState;
    return st && st.total > 0 && Array.isArray(st.done) ? st : null;
  } catch { return null; }
}

/** 已落盘字节数 (暂停/重启后续传的起点; UI 显示"已暂停 · X%") */
export function fileDoneBytes(dest: string): number {
  const st = readDlState(dest);
  return st ? st.done.reduce((a, b) => a + b, 0) : 0;
}

async function downloadFile(url: string, dest: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  /* Range 探针: 206 = 支持分段, content-range 里拿总大小 */
  const probe = await net.fetch(url, {
    headers: { Range: 'bytes=0-0' },
    redirect: 'follow',
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (probe.status !== 206) {
    if (!probe.ok || !probe.body) throw new Error(`HTTP ${probe.status} @ ${url}`);
    return streamToFile(probe, dest, onBytes);   /* 服务端无视 Range — 这个响应就是全文件 */
  }
  const total = Number(probe.headers.get('content-range')?.split('/')[1] || 0);
  try { await probe.body?.cancel(); } catch { /* noop */ }
  if (!total || total < PARALLEL_MIN_BYTES) {
    const full = await net.fetch(url, { redirect: 'follow', signal });
    if (!full.ok || !full.body) throw new Error(`HTTP ${full.status} @ ${url}`);
    return streamToFile(full, dest, onBytes);
  }

  /* 6 路分段 + 字节级断点: .dl.json 记每段已落盘字节, 暂停/重启后从断点接着拉 */
  const tmp = `${dest}.part`;
  const partSize = Math.ceil(total / PARALLEL_PARTS);
  let st = readDlState(dest);
  const fresh = !st || st.total !== total || st.partSize !== partSize || !existsSync(tmp);
  if (fresh) st = { total, partSize, done: new Array(PARALLEL_PARTS).fill(0) };
  const state = st!;
  const resumed = state.done.reduce((a, b) => a + b, 0);
  if (resumed > 0) onBytes(resumed);   /* 续传起点计入进度 */

  const { openSync, closeSync, ftruncateSync, writeSync } = await import('node:fs');
  const fd = openSync(tmp, fresh ? 'w' : 'r+');
  let sinceFlush = 0;
  const flushState = () => { try { writeFileSync(stateFile(dest), JSON.stringify(state)); } catch { /* noop */ } };
  try {
    if (fresh) ftruncateSync(fd, total);
    flushState();
    await Promise.all(Array.from({ length: PARALLEL_PARTS }, (_, i) => (async () => {
      const partStart = i * partSize;
      const end = Math.min(total - 1, partStart + partSize - 1);
      let pos = partStart + state.done[i];
      if (pos > end) return;   /* 该段已完成 */
      const r = await net.fetch(url, {
        headers: { Range: `bytes=${pos}-${end}` },
        redirect: 'follow',
        signal,
      });
      if (r.status !== 206 || !r.body) throw new Error(`Range HTTP ${r.status} @ ${url}`);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        writeSync(fd, buf, 0, buf.length, pos);   /* 各段写各自偏移, 事件循环单线程安全 */
        pos += buf.length;
        state.done[i] += buf.length;
        sinceFlush += buf.length;
        if (sinceFlush > 4 * 1024 * 1024) { sinceFlush = 0; flushState(); }
        onBytes(buf.length);
      }
    })()));
    closeSync(fd);
    renameSync(tmp, dest);
    try { rmSync(stateFile(dest), { force: true }); } catch { /* noop */ }
  } catch (e) {
    flushState();   /* 断点留给下次 — 暂停/网络断都能续 */
    try { closeSync(fd); } catch { /* noop */ }
    throw e;
  }
}

/** source: 'auto'(国内先, 失败换海外) | 'cn' | 'global' */
export async function downloadModel(
  id: string,
  source: 'auto' | 'cn' | 'global',
  wc: WebContents,
): Promise<{ ok: boolean; error?: string }> {
  const spec = LOCAL_MODELS.find(m => m.id === id);
  if (!spec) return { ok: false, error: `未知模型 ${id}` };
  if (!isPlatformSupported()) return { ok: false, error: '本地语音暂只支持 Mac (Apple Silicon), Windows 稍后支持' };
  if (downloading.has(id)) return { ok: false, error: '已在下载中' };
  downloading.add(id);
  const controller = new AbortController();
  activeControllers.set(id, controller);
  const progress = (payload: Record<string, unknown>) => {
    if (!wc.isDestroyed()) { try { wc.send('localvoice:progress', { modelId: id, ...payload }); } catch { /* noop */ } }
  };
  try {
    const bases = source === 'auto' ? [SOURCES.cn, SOURCES.global] : [SOURCES[source]];
    const totalBytes = spec.sizeMB * 1024 * 1024;   /* 估算总量, 进度显示用 */
    type Plan = { kind: 'tar'; url: string } | { kind: 'files'; base: string };
    /* melo: HF xet 后端慢到没法用 → tar 优先; ASR: HF 经典 LFS 快 → 逐文件优先 */
    const tarPlans: Plan[] = (spec.tarUrls ?? []).map(url => ({ kind: 'tar' as const, url }));
    const filePlans: Plan[] = spec.repo ? bases.map(base => ({ kind: 'files' as const, base })) : [];
    const plans: Plan[] = id === 'asr-sensevoice' ? [...filePlans, ...tarPlans] : [...tarPlans, ...filePlans];
    let lastErr: Error | null = null;
    for (const plan of plans) {
      try {
        let got = 0;
        const onBytes = (n: number) => {
          got += n;
          progress({ pct: Math.min(99, Math.round((got / totalBytes) * 100)) });
        };
        if (plan.kind === 'tar') {
          const tarDest = join(MODELS_ROOT, `${id}.tar.bz2`);
          await downloadFile(plan.url, tarDest, onBytes, controller.signal);
          progress({ pct: 99, file: 'extract' });
          const { execFileSync } = await import('node:child_process');
          const dir = modelDir(id);
          mkdirSync(dir, { recursive: true });
          /* macOS bsdtar 原生解 bz2; --strip-components 去掉包内顶层目录 */
          execFileSync('/usr/bin/tar', ['-xjf', tarDest, '-C', dir, '--strip-components=1'], { timeout: 120_000 });
          try { rmSync(tarDest, { force: true }); } catch { /* noop */ }
          if (!isModelInstalled(id)) throw new Error('tar 解包后文件不全');
        } else {
          for (const f of spec.files) {
            const dest = join(modelDir(id), f);
            if (existsSync(dest) && statSync(dest).size > 0) { got += statSync(dest).size; continue; }
            progress({ pct: Math.min(99, Math.round((got / totalBytes) * 100)), file: f });
            await downloadFile(`${base_of(plan)}/${spec.repo}/resolve/main/${f}`, dest, onBytes, controller.signal);
          }
        }
        progress({ pct: 100, done: true });
        return { ok: true };
      } catch (e: any) {
        if (controller.signal.aborted) {
          /* 用户暂停 — 断点已落盘, 不算错误 */
          progress({ paused: true });
          return { ok: false, error: 'paused' };
        }
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    const msg = `下载失败: ${lastErr?.message ?? '未知错误'}`;
    progress({ error: msg });
    return { ok: false, error: msg };
  } finally {
    downloading.delete(id);
    activeControllers.delete(id);
  }
}

function base_of(plan: { kind: 'files'; base: string }): string { return plan.base; }

/* ==================== 引擎 (懒加载, 模型删除时释放) ==================== */

let ttsEngineId: string | null = null;

/** 删模型 / 换模型时丢掉已加载的引擎 (识别引擎的缓存在 localAsr, 一起丢) */
function disposeEngines(): void {
  ttsEngine = null;
  ttsEngineId = null;
  void import('./localAsr.js').then(m => m.disposeAsrEngines()).catch(() => { /* 没加载过 */ });
}

/** 生效的识别模型 (主引擎): 配置指定且已装 → 用之; 否则自动 —
 *  流式 Zipformer 优先 (边说边出字), 再 Paraformer (整段更准), 再 SenseVoice */
export function effectiveAsrId(): string | null {
  const want = loadConfig().stt?.localModel;
  if (want && isModelInstalled(want)) return want;
  if (isModelInstalled('asr-zipformer-zh-en')) return 'asr-zipformer-zh-en';
  if (isModelInstalled('asr-paraformer-zh')) return 'asr-paraformer-zh';
  if (isModelInstalled('asr-sensevoice')) return 'asr-sensevoice';
  return null;
}

/** 定稿引擎 (第二遍): 主引擎是流式的才有意义 —— 一句说完用整段模型再认一遍, 准确率靠它。
 *  stt.localFinalizer: 'off' = 不定稿; 模型 id = 指定; 空 = 自动 (装了 Paraformer / SenseVoice 就用)。 */
export function effectiveFinalizerId(): string | null {
  const main = effectiveAsrId();
  if (!main || !isStreamingAsr(main)) return null;
  const want = (loadConfig().stt as { localFinalizer?: string } | undefined)?.localFinalizer ?? '';
  if (want === 'off') return null;
  if (want && want !== main && isModelInstalled(want) && !isStreamingAsr(want)) return want;
  if (isModelInstalled('asr-sensevoice')) return 'asr-sensevoice';
  if (isModelInstalled('asr-paraformer-zh')) return 'asr-paraformer-zh';
  const custom = listCustomModelIds().find(id => !isStreamingAsr(id));
  return custom ?? null;
}

export function effectiveTtsId(): string | null {
  const want = loadConfig().tts?.localModel;
  if (want && isModelInstalled(want)) return want;
  if (isModelInstalled('tts-melo-zh-en')) return 'tts-melo-zh-en';
  if (isModelInstalled('tts-kokoro-multi')) return 'tts-kokoro-multi';
  return null;
}


/** STT 默认档: provider 未设置且本地识别模型已装 → 'local'; 否则 null (走原缺省) */
export function resolveDefaultSttProvider(): 'local' | null {
  return isPlatformSupported() && effectiveAsrId() !== null ? 'local' : null;
}

/** TTS 默认档: provider 未设置且本地合成模型已装 → 'local'; 否则 null (走原缺省 edge) */
export function resolveDefaultTtsProvider(): 'local' | null {
  return isPlatformSupported() && effectiveTtsId() !== null ? 'local' : null;
}

export async function sherpa(): Promise<any> {
  return importPackModule('voice-engine', 'sherpa-onnx-node');
}

/** 16k mono Int16 PCM → 文本 (整段)。识别本身 (流式主引擎 / 定稿 / 词库 / 专名映射) 在 localAsr.ts */
export async function transcribeLocal(pcm: Int16Array): Promise<string> {
  const { transcribeWhole } = await import('./localAsr.js');
  return transcribeWhole(pcm);
}


const TTS_PORT = 43117;

let ttsEngine: any = null;

async function getTtsEngine(): Promise<any> {
  const id = effectiveTtsId();
  if (!id) throw new Error('本地合成模型未下载 — 设置 → 语音 → 本地语音模型');
  if (ttsEngine && ttsEngineId === id) return ttsEngine;   /* 选择变了 → 重建 */
  ttsEngine = null;
  ttsEngineId = id;
  const s = await sherpa();
  if (id === 'tts-kokoro-multi') {
    const dir = modelDir('tts-kokoro-multi');
    ttsEngine = new s.OfflineTts({
      model: {
        kokoro: {
          model: join(dir, 'model.onnx'),
          voices: join(dir, 'voices.bin'),
          tokens: join(dir, 'tokens.txt'),
          dataDir: join(dir, 'espeak-ng-data'),
          dictDir: join(dir, 'dict'),
          lexicon: [join(dir, 'lexicon-us-en.txt'), join(dir, 'lexicon-zh.txt')].join(','),
        },
        numThreads: 2, provider: 'cpu', debug: 0,
      },
      maxNumSentences: 1,
      ruleFsts: ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'].map(f => join(dir, f)).filter(f => existsSync(f)).join(','),
    });
    return ttsEngine;
  }
  const dir = modelDir('tts-melo-zh-en');
  ttsEngine = new s.OfflineTts({
    model: {
      vits: {
        model: join(dir, 'model.onnx'),
        lexicon: join(dir, 'lexicon.txt'),
        tokens: join(dir, 'tokens.txt'),
        dictDir: join(dir, 'dict'),
      },
      numThreads: 2, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
    ruleFsts: ['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst'].map(f => join(dir, f)).join(','),
  });
  return ttsEngine;
}

function floatToWav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + samples.length * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return data;
}

/** 文本 → WAV (MeloTTS 本地, 热合成 ~700ms/句) */
export async function synthesizeLocal(text: string, speed: number, voice?: string): Promise<Buffer> {
  const engine = await getTtsEngine();
  /* Kokoro 音色 = 编号 (voices.bin 里的说话人); Melo 单音色忽略。
   * 未填时 Kokoro 默认 18 (中文女声, sherpa 官方示例同款)。 */
  /* Kokoro 中文音色 45-52 (45 小北/47 小晓/49 云健/50 云希…), 默认 47;
   * 曾默认 18 = 英文音色念中文, '音色有问题'实录 */
  const sid = voice && /^\d+$/.test(voice.trim())
    ? Number(voice.trim())
    : (ttsEngineId === 'tts-kokoro-multi' ? 47 : 0);
  /* generateAsync — 同步 generate 会把主进程事件循环卡住整个合成期 (短句 0.6s,
   * 曾整句 8.5s), IPC/UI 全冻。异步版在 worker 线程跑, 主循环自由。 */
  const audio = await engine.generateAsync({
    text,
    sid,
    speed: Math.min(2, Math.max(0.5, speed || 1)),
    enableExternalBuffer: false,   /* 命门: Electron 禁外部缓冲区, 拷贝模式绕开 */
  });
  return floatToWav(audio.samples, audio.sampleRate);
}

let ttsServer: import('node:http').Server | null = null;
let ttsServerUrl: string | null = null;

function killTtsServer(): void {
  try { ttsServer?.close(); } catch { /* noop */ }
  ttsServer = null;
  ttsServerUrl = null;
  ttsEngine = null;
}

export async function ensureLocalTtsServer(): Promise<string> {
  const url = `http://127.0.0.1:${TTS_PORT}/v1`;
  if (ttsServerUrl) return ttsServerUrl;
  const { createServer } = await import('node:http');
  ttsServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('healthz')) { res.end('ok'); return; }
    if (req.method !== 'POST' || !req.url?.includes('/audio/speech')) { res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string; speed?: number; voice?: string };
          const wav = await synthesizeLocal(body.input || '', body.speed ?? 1, body.voice);
          res.writeHead(200, { 'Content-Type': 'audio/wav' });
          res.end(wav);
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? String(e) }));
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ttsServer!.once('error', (e: NodeJS.ErrnoException) => {
      /* EADDRINUSE = 多窗口/上个实例已在跑 — 直接复用 */
      if (e.code === 'EADDRINUSE') { ttsServer = null; resolve(); } else reject(e);
    });
    ttsServer!.listen(TTS_PORT, '127.0.0.1', () => resolve());
  });
  ttsServerUrl = url;
  return url;
}

export function getLocalTtsUrl(): string | null { return ttsServerUrl; }
