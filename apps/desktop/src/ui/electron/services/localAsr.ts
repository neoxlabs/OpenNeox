
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import {
  MODELS_ROOT, modelDir, sherpa, effectiveAsrId, effectiveFinalizerId, isStreamingAsr,
  readCustomManifest, type CustomAsrKind, type CustomModelManifest,
} from './localVoiceService.js';

const SAMPLE_RATE = 16000;
const ZIPFORMER = 'asr-zipformer-zh-en';

interface SttLocalCfg { hotwords?: string; termFix?: string }
const sttCfg = (): SttLocalCfg => (loadConfig().stt ?? {}) as SttLocalCfg;

/* ==================== 词库 / 专名映射 ==================== */

/** 词库文本 → 词表 (一行一个, 也认逗号 / 顿号分隔; 去重, 至少 2 个字) */
export function parseHotwords(text: string | undefined): string[] {
  const out = new Set<string>();
  for (const w of (text ?? '').split(/[\n,，、;；]/)) {
    const t = w.trim();
    if (t.length >= 2) out.add(t);
  }
  return [...out];
}

/** 专名映射文本 → [听错的写法, 标准写法]。一行一条: `DeepSeek: deep seek, deep sick, 地普希克` */
export function parseTermFix(text: string | undefined): Array<[RegExp, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of (text ?? '').split('\n')) {
    const m = /^\s*([^:：]+?)\s*[:：]\s*(.+)$/.exec(line);
    if (!m) continue;
    const canon = m[1].trim();
    for (const v of m[2].split(/[,，、]/)) {
      const bad = v.trim();
      /* 跟标准写法只差大小写的也留着 —— 识别输出多是小写, 要归一成 DeepSeek */
      if (bad && bad !== canon) pairs.push([bad, canon]);
    }
    /* 标准写法自己也算一条, 顺手把大小写归一 */
    if (/[a-z]/i.test(canon)) pairs.push([canon, canon]);
  }
  /* 长的先换: 「deep seek」必须比「seek」先命中 */
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.map(([bad, good]) => [new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), good]);
}

type PinyinFn = (text: string, opts: { toneType: 'none'; type: 'array' }) => string[];
let pinyinFn: PinyinFn | null | undefined;
async function loadPinyin(): Promise<PinyinFn | null> {
  if (pinyinFn !== undefined) return pinyinFn;
  try {
    /* 拼音表 (~0.9MB) 只有本地识别用得上 —— 跟 sherpa 一起放在按需下载的本地引擎包里, 安装包不带。
     * 不写静态 import: 那样 tsup 会把它打进主进程包。 */
    const { importPackModule } = await import('./assetPackService.js');
    const m = await importPackModule('voice-engine', 'pinyin-pro') as unknown as { pinyin: PinyinFn };
    pinyinFn = m.pinyin;
  } catch { pinyinFn = null; }
  return pinyinFn;
}

/** 同音纠错: 拼音滑窗对词库 (长词优先), 拼音一致写法不同就换 */
async function homophoneFix(text: string, words: string[]): Promise<string> {
  const zhWords = words.filter(w => /[一-鿿]/.test(w));
  if (!text || !zhWords.length) return text;
  const py = await loadPinyin();
  if (!py) return text;
  const chars = [...text];
  const charPy = py(text, { toneType: 'none', type: 'array' });
  if (charPy.length !== chars.length) return text;   /* 对不齐 (混了表情等) 就不动, 宁可放过 */
  const table = zhWords
    .map(w => ({ w, len: [...w].length, py: py(w, { toneType: 'none', type: 'array' }).join(' ') }))
    .sort((a, b) => b.len - a.len);
  const out: string[] = [];
  for (let i = 0; i < chars.length;) {
    const hit = table.find(t => i + t.len <= chars.length && charPy.slice(i, i + t.len).join(' ') === t.py);
    if (hit) { out.push(hit.w); i += hit.len; } else { out.push(chars[i]); i += 1; }
  }
  return out.join('');
}

/** 定稿纠错: 专名映射 → 同音纠错。流式中间结果不走这里 */
export async function polishFinal(text: string): Promise<string> {
  const cfg = sttCfg();
  let t = tidy(text);
  for (const [re, good] of parseTermFix(cfg.termFix)) t = t.replace(re, good);
  return homophoneFix(t, parseHotwords(cfg.hotwords));
}

/** Zipformer 的英文是全大写 BPE (「HELLO WORLD」): 全大写的词降成小写, 专名映射再把该大写的改回来 */
function tidy(text: string): string {
  return text.trim().replace(/\b[A-Z][A-Z']+\b/g, s => s.toLowerCase()).replace(/\s{2,}/g, ' ');
}

/** 断句拼接: 两段在英文词处相接时补一个空格 (「monday」+「today」不能拼成「mondaytoday」) */
function joinSegments(parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out += out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(p) ? ` ${p}` : p;
  }
  return out;
}

/* ==================== 引擎 (懒加载, 配置变了重建) ==================== */

let online: { key: string; rec: any } | null = null;
const offline = new Map<string, any>();

export function disposeAsrEngines(): void {
  online = null;
  offline.clear();
}

/** 词库落盘 (sherpa 只认文件); 返回路径, 没词返回 null */
function writeHotwordsFile(words: string[]): string | null {
  if (!words.length) return null;
  mkdirSync(MODELS_ROOT, { recursive: true });
  const file = join(MODELS_ROOT, 'hotwords.txt');
  const body = `${words.join('\n')}\n`;
  try { if (existsSync(file) && readFileSync(file, 'utf8') === body) return file; } catch { /* 重写 */ }
  writeFileSync(file, body);
  return file;
}

function transducerFiles(id: string): { encoder: string; decoder: string; joiner: string; tokens: string; bpeVocab: string | null } {
  if (id === ZIPFORMER) {
    const d = modelDir(id);
    return {
      encoder: join(d, 'encoder-epoch-99-avg-1.int8.onnx'),
      decoder: join(d, 'decoder-epoch-99-avg-1.int8.onnx'),
      joiner: join(d, 'joiner-epoch-99-avg-1.int8.onnx'),
      tokens: join(d, 'tokens.txt'),
      bpeVocab: join(d, 'bpe.vocab'),
    };
  }
  const m = readCustomManifest(id);
  if (!m || m.kind !== 'transducer') throw new Error(`${id} 不是流式模型`);
  const d = modelDir(id);
  return {
    encoder: join(d, m.files.encoder), decoder: join(d, m.files.decoder), joiner: join(d, m.files.joiner),
    tokens: join(d, m.tokens), bpeVocab: m.bpeVocab ? join(d, m.bpeVocab) : null,
  };
}

async function getOnline(id: string): Promise<any> {
  const words = parseHotwords(sttCfg().hotwords);
  const f = transducerFiles(id);
  /* 词库只在有 bpe.vocab 时开: 没有它 sherpa 没法把英文热词切成 BPE, 会直接建不起识别器 */
  const hotwordsFile = f.bpeVocab && existsSync(f.bpeVocab) ? writeHotwordsFile(words) : null;
  const key = `${id}|${hotwordsFile ? createHash('sha1').update(words.join('\n')).digest('hex') : '-'}`;
  if (online?.key === key) return online.rec;
  const s = await sherpa();
  const rec = new s.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
      tokens: f.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
      ...(hotwordsFile ? { modelingUnit: 'cjkchar+bpe', bpeVocab: f.bpeVocab! } : {}),
    },
    ...(hotwordsFile
      ? { decodingMethod: 'modified_beam_search', maxActivePaths: 4, hotwordsFile, hotwordsScore: 2.0 }
      : { decodingMethod: 'greedy_search' }),
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  });
  online = { key, rec };
  return rec;
}

async function getOffline(id: string): Promise<any> {
  const cached = offline.get(id);
  if (cached) return cached;
  const s = await sherpa();
  const base = { tokens: '', numThreads: 2, provider: 'cpu', debug: 0 };
  let modelConfig: Record<string, unknown>;
  if (id === 'asr-paraformer-zh') {
    const d = modelDir(id);
    modelConfig = { ...base, tokens: join(d, 'tokens.txt'), paraformer: { model: join(d, 'model.int8.onnx') } };
  } else if (id === 'asr-sensevoice') {
    const d = modelDir(id);
    modelConfig = { ...base, tokens: join(d, 'tokens.txt'), senseVoice: { model: join(d, 'model.int8.onnx'), language: '', useItn: 1 } };
  } else {
    const m = readCustomManifest(id);
    if (!m || m.kind === 'transducer') throw new Error(`${id} 不是整段识别模型`);
    const d = modelDir(id);
    const tokens = join(d, m.tokens);
    modelConfig = m.kind === 'sense-voice'
      ? { ...base, tokens, senseVoice: { model: join(d, m.files.model), language: '', useItn: 1 } }
      : m.kind === 'paraformer'
        ? { ...base, tokens, paraformer: { model: join(d, m.files.model) } }
        : { ...base, tokens, whisper: { encoder: join(d, m.files.encoder), decoder: join(d, m.files.decoder), language: '', task: 'transcribe' } };
  }
  const rec = new s.OfflineRecognizer({ featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig });
  offline.set(id, rec);
  return rec;
}

function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

async function decodeOffline(id: string, samples: Float32Array): Promise<string> {
  const rec = await getOffline(id);
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  rec.decode(stream);
  return String(rec.getResult(stream)?.text ?? '').trim();
}

/** 流式模型跑整段: 灌完 + 补 0.4s 静音 (不补末尾几个字出不来) + inputFinished, 解到底 */
async function decodeOnlineWhole(id: string, samples: Float32Array): Promise<string> {
  const rec = await getOnline(id);
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(Math.round(SAMPLE_RATE * 0.4)) });
  stream.inputFinished();
  while (rec.isReady(stream)) rec.decode(stream);
  return String(rec.getResult(stream)?.text ?? '').trim();
}

/** 短于 0.3s 的没有重识别价值 (数字人同一条) */
const MIN_FINALIZE_SAMPLES = SAMPLE_RATE * 0.3;

/** 整段识别 (语音对话的伪流式、旧的整段路径都走这里): 有定稿引擎用定稿, 否则主引擎; 最后纠错 */
export async function transcribeWhole(pcm: Int16Array): Promise<string> {
  const main = effectiveAsrId();
  if (!main) throw new Error('本地识别模型还没下载 (设置 → 语音 → 语音输入 → 本地)');
  const samples = toFloat(pcm);
  const fin = effectiveFinalizerId();
  const raw = fin && samples.length >= MIN_FINALIZE_SAMPLES
    ? await decodeOffline(fin, samples)
    : isStreamingAsr(main) ? await decodeOnlineWhole(main, samples) : await decodeOffline(main, samples);
  return polishFinal(raw);
}

/* ==================== 流式会话 (输入框麦克风: 边说边出字) ==================== */

export interface LocalAsrSession {
  push(pcm: Int16Array): void;
  /** 说完了: 返回定稿文本 */
  finish(): Promise<string>;
}

/** 主引擎是流式时才返回会话; 整段模型返回 null (调用方走累积后整段识别) */
export async function openStreamingSession(onText: (full: string) => void): Promise<LocalAsrSession | null> {
  const main = effectiveAsrId();
  if (!main || !isStreamingAsr(main)) return null;
  const rec = await getOnline(main);
  const stream = rec.createStream();
  const committed: string[] = [];
  const all: Float32Array[] = [];
  let last = '';
  let closed = false;

  const pump = () => {
    while (rec.isReady(stream)) rec.decode(stream);
    const cur = tidy(String(rec.getResult(stream)?.text ?? ''));
    const endpoint = rec.isEndpoint(stream);
    if (endpoint) {
      /* 断句: 这一句收进已定部分 (流式阶段不纠错, 定稿时整段统一纠) */
      if (cur) committed.push(cur);
      rec.reset(stream);
    }
    const full = joinSegments([...committed, endpoint ? '' : cur]);
    if (full !== last) { last = full; onText(full); }
  };

  return {
    push(pcm) {
      if (closed) return;
      const f = toFloat(pcm);
      all.push(f);
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: f });
      pump();
    },
    async finish() {
      if (closed) return last;
      closed = true;
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(Math.round(SAMPLE_RATE * 0.4)) });
      stream.inputFinished();
      while (rec.isReady(stream)) rec.decode(stream);
      const tail = tidy(String(rec.getResult(stream)?.text ?? ''));
      const streamed = joinSegments([...committed, tail]);
      const fin = effectiveFinalizerId();
      const total = all.reduce((n, a) => n + a.length, 0);
      if (fin && total >= MIN_FINALIZE_SAMPLES) {
        const merged = new Float32Array(total);
        let off = 0;
        for (const a of all) { merged.set(a, off); off += a.length; }
        try {
          const text = await decodeOffline(fin, merged);
          if (text) return polishFinal(text);
        } catch { /* 定稿失败就用流式结果, 不让一句话白说 */ }
      }
      return polishFinal(streamed);
    },
  };
}

/* ==================== 导入用户自己的模型 ==================== */

function listFiles(dir: string, depth = 2): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (depth > 0) out.push(...listFiles(p, depth - 1)); } else out.push(p);
  }
  return out;
}

/** 同一种文件有 int8 版就用 int8 (快 2~3 倍, 准确率几乎不掉) */
function pick(files: string[], re: RegExp): string | undefined {
  const hits = files.filter(f => re.test(basename(f)));
  return hits.find(f => /int8/.test(basename(f))) ?? hits[0];
}

/**
 * 认出文件夹里是哪种模型, 把要用的文件拷到 models/custom-<名字>/, 写 neox-model.json。
 *   transducer (流式): encoder*.onnx + decoder*.onnx + joiner*.onnx + tokens.txt (+ bpe.vocab 才能用词库)
 *   whisper: *encoder*.onnx + *decoder*.onnx + *tokens.txt, 文件夹名带 whisper
 *   sense-voice / paraformer: model*.onnx + tokens.txt, 文件夹名带 sense / paraformer
 * sherpa-onnx 官方发布的模型包解压后就是这个样子, 直接选那个文件夹即可。
 */
export function importCustomModel(srcDir: string): { ok: true; id: string; title: string; kind: CustomAsrKind; streaming: boolean } | { ok: false; error: string } {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return { ok: false, error: '选的不是文件夹' };
  const files = listFiles(srcDir).filter(f => /\.(onnx|txt|vocab)$/.test(f));
  const folder = basename(srcDir);
  const lower = folder.toLowerCase();
  const tokens = files.find(f => /(^|-)tokens\.txt$/.test(basename(f)));
  if (!tokens) return { ok: false, error: '没找到 tokens.txt —— sherpa-onnx 格式的模型都带它' };

  let kind: CustomAsrKind;
  let chosen: Record<string, string | undefined>;
  const enc = pick(files, /encoder.*\.onnx$/);
  const dec = pick(files, /decoder.*\.onnx$/);
  const joi = pick(files, /joiner.*\.onnx$/);
  if (enc && dec && joi) {
    kind = 'transducer';
    chosen = { encoder: enc, decoder: dec, joiner: joi };
  } else if (enc && dec && lower.includes('whisper')) {
    kind = 'whisper';
    chosen = { encoder: enc, decoder: dec };
  } else {
    const model = pick(files, /^model.*\.onnx$/);
    if (!model) return { ok: false, error: '认不出这个模型: 要么有 encoder / decoder / joiner 三个 .onnx (流式), 要么有 model.onnx' };
    if (lower.includes('sense')) kind = 'sense-voice';
    else if (lower.includes('paraformer')) kind = 'paraformer';
    else return { ok: false, error: '只有一个 model.onnx 时认不出是哪种: 文件夹名里带上 sense-voice 或 paraformer 再导入' };
    chosen = { model };
  }

  const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'model';
  let id = `custom-${slug}`;
  for (let n = 2; existsSync(modelDir(id)); n++) id = `custom-${slug}-${n}`;
  const dest = modelDir(id);
  mkdirSync(dest, { recursive: true });

  const copy = (src: string): string => { const name = basename(src); cpSync(src, join(dest, name)); return name; };
  const manifestFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(chosen)) if (v) manifestFiles[k] = copy(v);
  const bpe = files.find(f => basename(f) === 'bpe.vocab');
  const manifest: CustomModelManifest = {
    kind,
    title: folder,
    files: manifestFiles,
    tokens: copy(tokens),
    ...(bpe ? { bpeVocab: copy(bpe) } : {}),
    sizeMB: Math.round(readdirSync(dest).reduce((n, f) => n + statSync(join(dest, f)).size, 0) / 1048576),
    importedAt: Date.now(),
  };
  writeFileSync(join(dest, 'neox-model.json'), JSON.stringify(manifest, null, 2));
  return { ok: true, id, title: folder, kind, streaming: kind === 'transducer' };
}
