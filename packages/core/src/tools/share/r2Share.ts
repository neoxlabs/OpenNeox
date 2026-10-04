import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';

export interface R2ShareConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 桶的公开访问地址, 如 https://pub-xxxx.r2.dev 或 https://share.example.com */
  publicBaseUrl: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.csv': 'text/csv; charset=utf-8',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

const sha256hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** 路径段逐段编码 (S3 规范: 斜杠保留) */
const encodeKey = (key: string) => key.split('/').map((s) => encodeURIComponent(s)).join('/');

/** SigV4 签好的 PUT。R2: region = auto, service = s3。 */
export function signR2Put(cfg: R2ShareConfig, key: string, body: Buffer, contentType: string, now = new Date()) {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const path = `/${cfg.bucket}/${encodeKey(key)}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const headers: Record<string, string> = {
    'content-type': contentType,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  /* 规范请求: 方法 / 路径 / 查询串(空) / 头部块 (每行 name:value\n, 块后再空一行) / 签名头列表 / 负载哈希 */
  const canonicalHeaders = names.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonical = ['PUT', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    url: `https://${host}${path}`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export async function putToR2(cfg: R2ShareConfig, key: string, body: Buffer, contentType: string): Promise<void> {
  const { url, headers } = signR2Put(cfg, key, body, contentType);
  /* host 参与签名, 但 fetch 不许手动设 (它按 URL 自己带, 值一样) */
  const sendHeaders: Record<string, string> = { ...headers };
  delete sendHeaders.host;
  const res = await fetch(url, { method: 'PUT', headers: sendHeaders, body: new Uint8Array(body), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new Error(`R2 ${res.status}${code ? ` ${code}` : ''}: ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}`);
  }
}

export function missingR2Fields(cfg: Partial<R2ShareConfig> | undefined): string[] {
  const need: Array<keyof R2ShareConfig> = ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey', 'publicBaseUrl'];
  return need.filter((k) => !String(cfg?.[k] ?? '').trim());
}

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** 要传哪些文件: 单个文件, 或整个目录 (跳过隐藏文件和 node_modules) */
export function collectShareFiles(target: string): Array<{ abs: string; rel: string }> {
  const st = statSync(target);
  if (st.isFile()) return [{ abs: target, rel: basename(target) }];
  const out: Array<{ abs: string; rel: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const abs = join(dir, name);
      const s = statSync(abs);
      if (s.isDirectory()) walk(abs);
      else out.push({ abs, rel: relative(target, abs).split(sep).join('/') });
      if (out.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files — share a smaller folder`);
    }
  };
  walk(target);
  return out;
}

/**
 * 设置页「测试」: 传一个小页面, 再去公开地址取回来。
 * 分开报两段 —— 传不上去 (密钥 / 桶名 / 账号 ID 不对) 和 传上去了但公开地址打不开 (没开公开访问 / 地址填错)
 * 是两件事, 用户要改的地方不一样。
 */
export async function testR2Share(cfg: Partial<R2ShareConfig>): Promise<{ ok: boolean; stage?: 'config' | 'upload' | 'public'; url?: string; error?: string; missing?: string[] }> {
  const missing = missingR2Fields(cfg);
  if (missing.length) return { ok: false, stage: 'config', missing };
  const full = cfg as R2ShareConfig;
  const key = `neox/test-${randomBytes(3).toString('hex')}/index.html`;
  const marker = `neox-share-test-${randomBytes(4).toString('hex')}`;
  try {
    await putToR2(full, key, Buffer.from(`<!doctype html><meta charset=utf-8><title>Neox</title><p>${marker}</p>`), 'text/html; charset=utf-8');
  } catch (err: any) {
    return { ok: false, stage: 'upload', error: String(err?.message ?? err) };
  }
  const url = `${full.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok || !text.includes(marker)) return { ok: false, stage: 'public', url, error: `HTTP ${res.status}` };
    return { ok: true, url };
  } catch (err: any) {
    return { ok: false, stage: 'public', url, error: String(err?.message ?? err) };
  }
}

/** 传上去, 返回入口页的公开链接 */
export async function shareToR2(cfg: R2ShareConfig, target: string, entry?: string): Promise<{ url: string; files: number; bytes: number }> {
  const files = collectShareFiles(target);
  if (files.length === 0) throw new Error('nothing to share — the folder is empty');
  const bodies = files.map((f) => ({ ...f, body: readFileSync(f.abs) }));
  const bytes = bodies.reduce((a, b) => a + b.body.length, 0);
  if (bytes > MAX_TOTAL_BYTES) throw new Error(`${Math.round(bytes / 1048576)}MB is over the 50MB share limit`);
  const prefix = `neox/${randomBytes(4).toString('hex')}`;
  for (const f of bodies) await putToR2(cfg, `${prefix}/${f.rel}`, f.body, contentTypeFor(f.rel));
  const entryRel = entry ?? (bodies.find((f) => f.rel === 'index.html') ?? bodies.find((f) => /\.html?$/i.test(f.rel)) ?? bodies[0]).rel;
  return { url: `${cfg.publicBaseUrl.replace(/\/+$/, '')}/${prefix}/${encodeKey(entryRel)}`, files: bodies.length, bytes };
}
