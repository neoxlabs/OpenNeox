/**
 * sttService - 语音识别 (STT) 服务
 *
 * 走 NeoxCloud 网关 /n1/audio/transcriptions (火山豆包等上游), 复用 chat 路径同一套
 * gateway base + HMAC 签名。客户端(渲染端)录音 → 主进程 → daemon → 这里 → 网关 → 文本。
 *
 * 与 TTS 对称: 一次性识别短音频 (一句话), 返整段文本。实时流式识别后续再做。
 */

import { createHash } from 'node:crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadAutoHmacSigner } from '@neoxlabs/kernel/models/openai.js';

export interface STTGatewayEntry {
  /** 网关 base URL (以 /n1 结尾), 同 chat 路径. */
  baseUrl: string;
  /** 网关鉴权 key (nxk / JWT). */
  apiKey: string;
}

export interface TranscribeOptions {
  /** 网关里配置的 STT 渠道 modelId, 如 'doubao-asr'. */
  model: string;
  /** 音频格式 wav/mp3/ogg/pcm/m4a, 缺省 wav. */
  format?: string;
  /** 可选语种, 如 'zh'. */
  language?: string;
}

/**
 * 通过 NeoxCloud 网关把 base64 音频识别成文本。
 * @returns 识别文本; 失败抛错。
 */
export async function transcribeViaGateway(
  entry: STTGatewayEntry,
  audioBase64: string,
  opts: TranscribeOptions,
): Promise<string> {
  if (!entry.baseUrl || !entry.apiKey) {
    throw new Error('STT 网关凭证缺失 (未登录订阅 / routing 未就绪)');
  }
  if (!audioBase64) {
    throw new Error('STT: 空音频');
  }

  const payload = {
    model: opts.model || 'doubao-asr',
    audio: audioBase64,
    format: opts.format || 'wav',
    ...(opts.language ? { language: opts.language } : {}),
  };
  const bodyStr = JSON.stringify(payload);

  const url = `${entry.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const sigPath = new URL(url).pathname; // /n1/audio/transcriptions

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${entry.apiKey}`,
  };
  const signer = loadAutoHmacSigner();
  if (signer) {
    const { getNeoxDeviceFp } = await import('@neoxlabs/kernel/models/openai.js');
    const bodyHexHash = createHash('sha256').update(bodyStr).digest('hex');
    const nxkId = createHash('sha256').update(entry.apiKey).digest('hex').slice(0, 16);
    const deviceFp = getNeoxDeviceFp();
    const sig = await signer(sigPath, bodyHexHash, { nxkId, deviceFp });
    headers['X-Sig-Ts'] = sig.ts;
    headers['X-Sig-Nonce'] = sig.nonce;
    headers['X-Sig'] = sig.sig;
    headers['X-Sig-Proto'] = '2';
    headers['X-Device-FP'] = deviceFp;
    headers['X-Client-Version'] = sig.version;
  }

  const resp = await fetch(url, { method: 'POST', headers, body: bodyStr });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`NeoxCloud STT failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const json = (await resp.json().catch(() => ({}))) as { text?: string };
  const text = (json.text || '').trim();
  cliLogger.info('STT', `transcribed ${audioBase64.length} b64 chars → "${text.slice(0, 40)}"`);
  return text;
}
