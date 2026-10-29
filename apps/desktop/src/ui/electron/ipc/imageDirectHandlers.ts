/**
 * imageDirectHandlers — renderer 直连 image gen IPC (bypass LLM).
 *
 * 图片模式 UX 路径:
 *   composer 挂"创建图片" chip → 用户敲文本 → 走这个 IPC (不经过 LLM/agent runtime) →
 *   ImageGenService (共用 agent 通道那一套 provider resolver) → 出图落到
 *   <userData>/neox-artifacts/generated/YYYY-MM-DD/ → 返绝对路径给 renderer 渲染.
 *
 * 跟 agent 通道 (generate_image tool) 的区别:
 *   · 无 LLM 参与, 直接透传 prompt → provider
 *   · 无对话上下文 (每次独立)
 *   · timeline 显示: 仅用户 chip + 图卡, 无 assistant 文字
 *   · 可选走轻量 prompt-optimizer (小模型改写中文口语 → 结构化英文, 默认关闭省成本)
 *
 * 计费: 走 NeoxCloud 时网关自己会 fire image-usage/record; BYOK 时不计费.
 */

import { ipcMain, app, shell, clipboard, nativeImage, BrowserWindow, ShareMenu, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import sharp from 'sharp';
import { getImageGenService, IMAGE_TIER_BUSY } from '@neoxlabs/core/services/imageGenService.js';

function tierBusyMessage(err: unknown): string | null {
  const msg = (err as Error)?.message ?? String(err ?? '');
  return msg.includes(IMAGE_TIER_BUSY)
    ? '当前出图服务繁忙，请稍后再试，或在参数面板切换到「高级」档。'
    : null;
}
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { revealPathWithFallback } from './openPathFallback.js';
import { absoluteToAssetUrl } from '../../shared/assetUrlPath.js';

export interface ImageDirectRequest {
  tier?: 'standard' | 'advanced';
  /** 用户在选择器里点中的 provider —— 有它就按它走, 不猜 (订阅 vs BYOK 由用户决定) */
  providerId?: string;
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  /** 背景 (gpt-image): auto | opaque | transparent. */
  background?: 'auto' | 'opaque' | 'transparent';
  /** 输出压缩 0-100. */
  outputCompression?: number;
  /** provider 特定透传键. */
  providerOptions?: Record<string, unknown>;
  /** 图生图/改图参考图 (dataURL/URL, 单张或多张) → input_references. */
  image?: string | string[];
  /** 是否跑一遍轻量 optimizer 把中文口语转结构化英文. 默认 false 省一次 LLM 调用. */
  optimizePrompt?: boolean;
}

export interface ImageDirectResult {
  ok: boolean;
  paths?: string[];         // 绝对路径, 落在 neox-artifacts 里, renderer 可读
  fileUrls?: string[];      // file:// url, <img src> 直接用
  count?: number;
  mode?: string;            // 'neoxcloud' | 'byok'
  providerLabel?: string;
  model?: string;           // 实际出图 model (上游 raw)
  size?: string;            // 出图尺寸
  latencyMs?: number;
  createdAt?: number;       // 出图完成时间戳 (ms)
  revisedPrompt?: string;
  error?: string;
}


const normalizeForCompare = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;

/** realpath 解析 (symlink 展开); 目标不存在时 realpath 父目录再拼回文件名 (防父目录是 symlink). */
function realpathOrResolve(value: string): string {
  const resolved = path.resolve(value);
  try {
    return typeof realpathSync.native === 'function'
      ? realpathSync.native(resolved)
      : realpathSync(resolved);
  } catch {
    try {
      const parent = path.dirname(resolved);
      const realParent = typeof realpathSync.native === 'function'
        ? realpathSync.native(parent)
        : realpathSync(parent);
      return path.join(realParent, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** target (realpath 后) 是否严格在 root 之内 (root 本身不算, 跟原 startsWith(root+sep) 语义一致). */
function isInsideArtifactsRoot(root: string, target: string): boolean {
  const base = normalizeForCompare(realpathOrResolve(root));
  const probe = normalizeForCompare(realpathOrResolve(target));
  const rel = path.relative(base, probe);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 图片模式产物的 artifact 子目录. renderer surface guard 已放这条根. */
function getGeneratedDir(): string {
  const root = path.join(app.getPath('userData'), 'neox-artifacts', 'generated');
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dir = path.join(root, stamp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(prompt: string): string {
  return prompt
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';
}

/* renderer 走 http://127.0.0.1 源, 直接 <img src="file://"> 会被 CSP/Electron 拦 → 图裂.
 * 用 Neox 自定义协议 neox-asset://local/<encoded-abs> (main.ts protocol.handle 服务, 已放行
 * neox-artifacts 根). 格式必须跟 Markdown.tsx toNeoxAssetUrl 一致. */
const absPathToAssetUrl = absoluteToAssetUrl;

/** 打包内 / 仓库内的 showcase 种子目录 (每分类一张预生成图). */
function resolveBundledShowcaseDir(): string | null {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'image-showcase'));
  }
  try {
    candidates.push(path.join(app.getAppPath(), 'apps/desktop/resources/image-showcase'));
  } catch { /* app 未 ready */ }
  let cwd = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(cwd, 'apps/desktop/resources/image-showcase'));
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  /* ui:dev 主进程常在 apps/cli/dist/ui-electron/electron/ */
  let cur = path.dirname(typeof __filename !== 'undefined' ? __filename : process.execPath);
  for (let i = 0; i < 10; i++) {
    candidates.push(path.join(cur, 'apps/desktop/resources/image-showcase'));
    candidates.push(path.join(cur, 'resources/image-showcase'));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * 确保 <userData>/neox-artifacts/showcase 有图.
 * 空/缺文件时从 bundled resources 拷贝 (neox-asset 协议只放行 artifacts 根).
 */
async function ensureShowcaseDir(): Promise<string> {
  const dest = path.join(app.getPath('userData'), 'neox-artifacts', 'showcase');
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  const bundled = resolveBundledShowcaseDir();
  if (!bundled) return dest;
  try {
    const files = await fs.readdir(bundled);
    for (const f of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const target = path.join(dest, f);
      if (existsSync(target)) continue;
      /* 同名不同后缀 (旧 png / 新 webp) — 有任一即可, 避免重复占位 */
      const stem = f.replace(/\.(png|jpe?g|webp)$/i, '');
      const already = (await fs.readdir(dest)).some((x) =>
        new RegExp(`^${stem}\\.(png|jpe?g|webp)$`, 'i').test(x),
      );
      if (already) continue;
      await fs.copyFile(path.join(bundled, f), target);
    }
  } catch (err: any) {
    console.warn('[image:showcase] seed failed', err?.message || String(err));
  }
  return dest;
}

function extOfImageBuffer(buf: Buffer): 'png' | 'jpg' | 'webp' | 'gif' {
  if (buf.length >= 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  }
  return 'png';
}

/** 把 base64 图批量落盘, 返绝对路径. generate / stream 共用. */
async function persistB64Images(b64List: string[], stem: string): Promise<string[]> {
  const dir = getGeneratedDir();
  const ts = Date.now();
  const paths: string[] = [];
  for (let i = 0; i < b64List.length; i++) {
    const buf = Buffer.from(b64List[i]!, 'base64');
    const ext = extOfImageBuffer(buf);
    const filename = b64List.length === 1 ? `${stem}-${ts}.${ext}` : `${stem}-${ts}-${i + 1}.${ext}`;
    const abs = path.join(dir, filename);
    await fs.writeFile(abs, buf);
    paths.push(abs);
  }
  return paths;
}

/**
 * 把结果条目批量落盘 —— b64 或 url 都吃 (统一处理).
 * 关键: 有些代理 (如 relay-b 图生图/编辑) 返回的是 **URL** 不是 b64_json, 只认 b64 会把成功的图当"无图"丢掉.
 * 返回成功落盘的绝对路径; 单条都取不到图会 throw (交给上层统一错误兜底).
 */
async function persistImageItems(items: Array<{ b64Json?: string; url?: string }>, stem: string): Promise<string[]> {
  const dir = getGeneratedDir();
  const ts = Date.now();
  const paths: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    /* 扩展名同样按真实文件头判 (见 extOfImageBuffer) —— 这条路是 url 下载的,
     * 更不能凭 URL 后缀猜: 很多渠道的 CDN 链接根本不带扩展名。 */
    let buf: Buffer | null = null;
    if (item.b64Json) {
      buf = Buffer.from(item.b64Json, 'base64');
    } else if (item.url) {
      const resp = await fetch(item.url);
      if (!resp.ok) throw new Error(`下载出图失败 (${resp.status})`);
      buf = Buffer.from(await resp.arrayBuffer());
    }
    if (buf) {
      const ext = extOfImageBuffer(buf);
      const filename = items.length === 1 ? `${stem}-${ts}.${ext}` : `${stem}-${ts}-${i + 1}.${ext}`;
      const abs = path.join(dir, filename);
      await fs.writeFile(abs, buf);
      paths.push(abs);
      continue;
    }
    /* 既无 b64 又无 url → 跳过 (不当成功) */
  }
  return paths;
}

async function topUpImages(
  got: Array<{ b64Json?: string; url?: string; revisedPrompt?: string }>,
  want: number,
  baseReq: Record<string, unknown>,
  service: { generate: (r: never) => Promise<{ data?: Array<{ b64Json?: string; url?: string }> }> },
): Promise<Array<{ b64Json?: string; url?: string; revisedPrompt?: string }>> {
  const missing = want - got.length;
  if (missing <= 0) return got;
  const extra = await Promise.all(
    Array.from({ length: missing }, async () => {
      try {
        const r = await service.generate({ ...baseReq, n: 1 } as never);
        return r?.data?.[0] ?? null;
      } catch {
        return null;   /* 补齐失败不拖垮已成功的那几张 */
      }
    }),
  );
  return [...got, ...extra.filter(Boolean) as Array<{ b64Json?: string; url?: string }>];
}

/** streamId → AbortController, 供 renderer 取消流式出图. */
const streamAborters = new Map<string, AbortController>();

/**
 * 绿幕抠图 —— 把绿幕 (chroma green) 背景 key 成透明 PNG.
 * gpt-image-2 经 OpenRouter 不吃 background=transparent (只 auto/opaque), 所以走"生成绿幕→本地 key"
 * 这条通吃所有模型的路子. eGreen = G - max(R,B): 强绿→全透明, 边缘绿→半透明 + 去绿溢色 (despill).
 */
async function chromaKeyGreenToTransparent(pngBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels; // 4 (RGBA)
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const eGreen = g - Math.max(r, b);
    if (eGreen > 60) {
      data[i + 3] = 0;                                   // 强绿 → 全透明
    } else if (eGreen > 20) {
      data[i + 3] = Math.round((255 * (60 - eGreen)) / 40); // 边缘 → 渐变 alpha
      const cap = Math.max(r, b);
      if (g > cap) data[i + 1] = cap;                    // despill: 压掉溢到主体上的绿
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).png().toBuffer();
}

function broadcastImageGenerated(
  event: IpcMainInvokeEvent,
  prompt: string,
  result: ImageDirectResult,
): void {
  if (!result?.ok || !result.paths?.length) return;
  try {
    if (!event?.sender.isDestroyed()) {
      event?.sender.send('image:generated', {
        prompt,
        paths: result.paths,
        fileUrls: result.fileUrls,
        count: result.count,
        mode: result.mode,
        providerLabel: result.providerLabel,
        model: result.model,
        size: result.size,
        latencyMs: result.latencyMs,
        createdAt: result.createdAt ?? Date.now(),
        revisedPrompt: result.revisedPrompt,
      });
    }
  } catch { /* renderer gone */ }
}

export function registerImageDirectIpcHandlers(): void {
  ipcMain.handle('image:direct-generate', async (event, request: ImageDirectRequest): Promise<ImageDirectResult> => {
    try {
      const raw = (request?.prompt ?? '').trim();
      if (!raw) return { ok: false, error: 'prompt required' };

      /* 目前 optimizer 是占位 — 想启用得再挂一层 chat provider (haiku/gpt-nano) 改写.
       * v1 直接透传, 用户输入啥就 hit 上游啥. */
      const prompt = raw;

      const service = getImageGenService();
      const size = (request.size as any) || '1024x1024';
      const want = Math.min(Math.max(request.n ?? 1, 1), 10);
      const baseReq = {
        model: request.model || 'gpt-image-1',
        /* 档位透传 —— 决定走第三方(普通) 还是全参数聚合商(高级)。
           缺省不传, 由 service 走通用选路 (兼容老调用方)。 */
        tier: request.tier,
        providerId: request.providerId,
        prompt,
        size,
        quality: (request.quality as any) || 'high',
        background: request.background,
        outputCompression: typeof request.outputCompression === 'number' ? request.outputCompression : undefined,
        providerOptions: request.providerOptions,
        image: request.image,
        responseFormat: 'b64_json' as const,
      };

      const result = await service.generate({ ...baseReq, n: want });

      if (!result.data || result.data.length === 0) {
        return { ok: false, error: 'provider returned no images' };
      }

      /* 「张数」补齐 —— 见 topUpImages 里的说明。上游少给了就并发补, 不让旋钮撒谎。 */
      const items = await topUpImages(result.data, want, baseReq, service);

      const stem = slugify(prompt);
      const savedPaths = await persistImageItems(items, stem);
      if (savedPaths.length === 0) {
        return { ok: false, error: 'provider returned no images' };
      }

      const out: ImageDirectResult = {
        ok: true,
        paths: savedPaths,
        fileUrls: savedPaths.map(absPathToAssetUrl),
        count: savedPaths.length,
        mode: result.mode,
        providerLabel: (result as any).providerLabel,
        model: result.model,
        size,
        latencyMs: result.usage?.latencyMs,
        createdAt: Date.now(),
        revisedPrompt: result.data[0]?.revisedPrompt,
      };
      /* 通知 renderer 挂 timeline 卡 — 图库扫盘总能看见, timeline 必须有人 emit turn. */
      broadcastImageGenerated(event, prompt, out);
      return out;
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  ipcMain.handle('image:direct-generate-stream', async (event, request: ImageDirectRequest & { streamId?: string }): Promise<ImageDirectResult & { streamed?: boolean; partial?: boolean }> => {
    const streamId = request?.streamId || '';
    const send = (msg: Record<string, unknown>): void => {
      try { if (!event?.sender.isDestroyed()) event?.sender.send('image:stream-event', { streamId, ...msg }); } catch { /* renderer gone */ }
    };
    const aborter = new AbortController();
    if (streamId) streamAborters.set(streamId, aborter);
    const completedB64: string[] = [];
    let startedAt = Date.now();
    const prompt = (request?.prompt ?? '').trim();
    try {
      if (!prompt) return { ok: false, error: 'prompt required' };
      const service = getImageGenService();
      const size = (request.size as any) || '1024x1024';
      startedAt = Date.now();
      const result = await service.generateStream({
        model: request.model || 'gpt-image-1',
        /* 档位透传 —— 决定走第三方(普通) 还是全参数聚合商(高级)。
           缺省不传, 由 service 走通用选路 (兼容老调用方)。 */
        tier: request.tier,
        providerId: request.providerId,
        prompt,
        n: Math.min(Math.max(request.n ?? 1, 1), 10),
        size,
        quality: (request.quality as any) || 'high',
        background: request.background,
        outputCompression: typeof request.outputCompression === 'number' ? request.outputCompression : undefined,
        providerOptions: request.providerOptions,
        image: request.image,
        responseFormat: 'b64_json',
      }, (ev) => {
        if (ev.type === 'partial' && ev.b64Json) {
          send({ kind: 'partial', dataUrl: `data:${ev.mediaType || 'image/png'};base64,${ev.b64Json}`, partialIndex: ev.partialIndex });
        } else if (ev.type === 'completed' && ev.b64Json) {
          completedB64.push(ev.b64Json);
          /* 完成一张就推它的清晰预览 + 攒住 b64 用于兜底落盘 */
          send({ kind: 'image', dataUrl: `data:${ev.mediaType || 'image/png'};base64,${ev.b64Json}`, imageIndex: ev.imageIndex });
        }
      }, aborter.signal);

      /* 优先用 service 返回的 data (完整, 可能是 b64 或 url); 兜底用 onEvent 攒的 completedB64.
       * 关键修复: data 条目可能只有 url (relay-b 图生图返 URL 不返 b64) —— 一并落盘, 别当无图丢. */
      const items: Array<{ b64Json?: string; url?: string }> = (result.data && result.data.length > 0)
        ? result.data.map(d => ({ b64Json: d.b64Json, url: (d as { url?: string }).url }))
        : completedB64.map(b => ({ b64Json: b }));
      const savedPaths = await persistImageItems(items, slugify(prompt));
      if (savedPaths.length === 0) return { ok: false, error: 'provider returned no images' };
      const out: ImageDirectResult & { streamed?: boolean } = {
        ok: true,
        paths: savedPaths,
        fileUrls: savedPaths.map(absPathToAssetUrl),
        count: savedPaths.length,
        mode: result.mode,
        providerLabel: (result as any).providerLabel,
        model: result.model,
        size,
        latencyMs: result.usage?.latencyMs ?? (Date.now() - startedAt),
        createdAt: Date.now(),
        streamed: (result as any).streamed === true,
      };
      send({ kind: 'done', result: out });
      /* 流式路径由 TimelineComposer.emitDirectImageTurn 挂卡; 这里不广播, 避免同 path 双卡. */
      return out;
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      /* 断连/取消不掉图: 已到的 completed 帧照样落盘返回. */
      if (completedB64.length > 0) {
        try {
          const savedPaths = await persistB64Images(completedB64, slugify(prompt) + (aborted ? '-partial' : '-salvaged'));
          const out: ImageDirectResult & { partial?: boolean } = {
            ok: true, partial: true,
            paths: savedPaths, fileUrls: savedPaths.map(absPathToAssetUrl), count: savedPaths.length,
            latencyMs: Date.now() - startedAt, createdAt: Date.now(),
          };
          send({ kind: 'done', result: out });
          return out;
        } catch { /* fall through to error */ }
      }
      const errResult: ImageDirectResult = { ok: false, error: aborted ? '已取消' : (err?.message || String(err)) };
      send({ kind: 'error', error: errResult.error });
      return errResult;
    } finally {
      if (streamId) streamAborters.delete(streamId);
    }
  });

  /* 取消进行中的流式出图 (renderer 点"停止"). */
  ipcMain.handle('image:direct-generate-abort', (_event, streamId: string): { ok: boolean } => {
    const a = streamAborters.get(streamId);
    if (a) { a.abort(); return { ok: true }; }
    return { ok: false };
  });

  ipcMain.handle('image:showcase', async (): Promise<Record<string, string>> => {
    try {
      const dir = await ensureShowcaseDir();
      if (!existsSync(dir)) return {};
      const files = await fs.readdir(dir);
      const out: Record<string, string> = {};
      for (const f of files) {
        const m = /^(.+)\.(png|jpe?g|webp)$/i.exec(f);
        if (m) out[m[1]] = absPathToAssetUrl(path.join(dir, f));
      }
      return out;
    } catch (err: any) {
      console.warn('[image:showcase] failed', err?.message || String(err));
      return {};
    }
  });

  /* 删一张生成图 (图库用). 只允许删 neox-artifacts/generated 下的文件 (防越权删任意文件).
   * realpath 判 containment — symlink 指向根外时拒删. */
  ipcMain.handle('image:delete-file', async (_event, absPath: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const root = path.join(app.getPath('userData'), 'neox-artifacts', 'generated');
      const resolved = realpathOrResolve(absPath || '');
      if (!isInsideArtifactsRoot(root, resolved)) return { ok: false, error: 'path outside gallery root' };
      await fs.unlink(resolved);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  /* 在 Finder/Explorer 高亮一张生成图 (图库/详情用). 通用 file:reveal-in-finder 只放行 workspace 根,
   * 图片产物在 <userData>/neox-artifacts 里会被拒 —— 这里用 artifacts 根自己校验后 reveal.
   * reveal 是只读操作 (只是高亮文件), 放行 app 自有的 artifacts 根安全. */
  ipcMain.handle('image:reveal-file', async (_event, absPath: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const root = path.join(app.getPath('userData'), 'neox-artifacts');
      const resolved = realpathOrResolve(absPath || '');
      if (!isInsideArtifactsRoot(root, resolved)) return { ok: false, error: 'path outside artifacts root' };
      if (!existsSync(resolved)) return { ok: false, error: 'file not found' };
      /* 同样不直接走 shell.showItemInFolder: Windows 上它失败时啥也不返回 (见 openPathFallback.ts) */
      const revealErr = await revealPathWithFallback(resolved);
      if (revealErr) return { ok: false, error: revealErr };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  /* artifacts 根校验 (share/copy/export 共用, 语义同 reveal: 只放行 app 自有产物).
   * realpath 判 containment, 防 symlink 逃逸. */
  const resolveArtifact = (absPath: string): { ok: true; resolved: string } | { ok: false; error: string } => {
    const root = path.join(app.getPath('userData'), 'neox-artifacts');
    const resolved = realpathOrResolve(absPath || '');
    if (!isInsideArtifactsRoot(root, resolved)) return { ok: false, error: 'path outside artifacts root' };
    if (!existsSync(resolved)) return { ok: false, error: 'file not found' };
    return { ok: true, resolved };
  };

  /* macOS 原生分享菜单 (AirDrop/信息/邮件/微信…). 其他平台明确报不支持, 不做假分享. */
  ipcMain.handle('image:share-file', async (event, absPath: string, pos?: { x: number; y: number }): Promise<{ ok: boolean; error?: string }> => {
    try {
      if (process.platform !== 'darwin') return { ok: false, error: 'share sheet is macOS only' };
      const r = resolveArtifact(absPath);
      if (!r.ok) return { ok: false, error: r.error };
      const win = BrowserWindow.fromWebContents(event?.sender) ?? undefined;
      const menu = new ShareMenu({ urls: [], filePaths: [r.resolved] });
      menu.popup({ window: win, ...(pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: Math.round(pos.x), y: Math.round(pos.y) } : {}) });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  /* 复制图片到系统剪贴板 (nativeImage 读盘, 粘到微信/备忘录都是真图不是路径). */
  ipcMain.handle('image:copy-file', async (_event, absPath: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = resolveArtifact(absPath);
      if (!r.ok) return { ok: false, error: r.error };
      const img = nativeImage.createFromPath(r.resolved);
      if (img.isEmpty()) return { ok: false, error: 'unreadable image' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  /* 平台尺寸导出 (电商交付闭环) — sharp 纯工程: pad=白底 contain (主图类, 商品完整不裁),
   * cover=裁满 (社媒封面类). 预设表由 renderer 传入 (淘宝/PDD/京东/亚马逊/小红书/X/抖音…),
   * main 保持通用不写死平台. 输出到 neox-artifacts/exports/<名>-<ts>/, 完成后 Finder 高亮. */
  ipcMain.handle('image:export-sizes', async (_event, req: {
    source: string;
    presets: Array<{ id: string; label: string; w: number; h: number; fit: 'cover' | 'pad' }>;
    reveal?: boolean;
  }): Promise<{ ok: boolean; dir?: string; files?: string[]; error?: string }> => {
    try {
      const r = resolveArtifact(req?.source || '');
      if (!r.ok) return { ok: false, error: r.error };
      const presets = Array.isArray(req.presets) ? req.presets.filter(p => p && p.w > 0 && p.h > 0 && p.w <= 8192 && p.h <= 8192) : [];
      if (presets.length === 0) return { ok: false, error: 'no presets' };
      const stem = path.basename(r.resolved).replace(/\.[^.]+$/, '').slice(0, 40) || 'image';
      const outDir = path.join(app.getPath('userData'), 'neox-artifacts', 'exports', `${stem}-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });
      const files: string[] = [];
      for (const p of presets) {
        const out = path.join(outDir, `${stem}-${p.id}-${p.w}x${p.h}.png`);
        await sharp(r.resolved)
          .resize(p.w, p.h, p.fit === 'pad'
            ? { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }
            : { fit: 'cover', position: 'attention' })
          .png()
          .toFile(out);
        files.push(out);
      }
      if (req.reveal !== false && files[0]) void revealPathWithFallback(files[0]);
      return { ok: true, dir: outDir, files };
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  ipcMain.handle('image:track', async (_event, ev: { event: string; props?: Record<string, unknown>; ts?: number }): Promise<{ ok: boolean }> => {
    try {
      if (!ev?.event || typeof ev.event !== 'string') return { ok: false };
      const dir = path.join(app.getPath('userData'), 'metrics');
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ event: ev.event.slice(0, 64), props: ev.props ?? {}, ts: ev.ts || Date.now() }) + '\n';
      await fs.appendFile(path.join(dir, 'image-events.jsonl'), line, 'utf8');
      return { ok: true };
    } catch {
      return { ok: false };   // 埋点失败静默, 永不影响业务
    }
  });

  ipcMain.handle('image:save-turn', (_event, req: { sessionId: string; turnId: string; payload: string; createdAt: number }) => {
    try {
      if (!req?.sessionId || !req?.turnId || typeof req.payload !== 'string') return { ok: false };
      getDatabase().upsertImageTurn(req.sessionId, req.turnId, req.payload, req.createdAt || Date.now());
      return { ok: true };
    } catch (err: any) {
      console.warn('[image:save-turn] failed', err?.message || String(err));
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  ipcMain.handle('image:model-capabilities', async (): Promise<Record<string, Record<string, unknown>>> => {
    try {
      /* 用 core provider 列表 (解密+实时) 找 OpenRouter provider 的 key, 拉能力目录. */
      const providers = getImageGenService().listProviders();
      const or = providers.find((p: any) => (p?.baseUrl || '').toLowerCase().includes('openrouter.ai') && p?.apiKey);
      if (!or?.apiKey || !or.baseUrl) return {};
      const base = or.baseUrl.replace(/\/+$/, '');
      const resp = await fetch(`${base}/images/models`, {
        headers: { Authorization: `Bearer ${or.apiKey}`, 'HTTP-Referer': 'https://neox-dev.com', 'X-Title': 'Neox' },
      });
      if (!resp.ok) return {};
      const json: any = await resp.json();
      const out: Record<string, Record<string, unknown>> = {};
      for (const m of (json?.data || [])) {
        if (m?.id && m?.supported_parameters) out[m.id] = m.supported_parameters;
      }
      return out;
    } catch (err: any) {
      console.warn('[image:model-capabilities] failed', err?.message || String(err));
      return {};
    }
  });

  ipcMain.handle('image:project-list', () => {
    try { return getDatabase().listImageProjects(); } catch (e: any) { console.warn('[image:project-list]', e?.message); return []; }
  });
  ipcMain.handle('image:project-create', (_event, name: string) => {
    try {
      const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      getDatabase().createImageProject(id, (name || '新项目').trim() || '新项目', Date.now());
      return { ok: true, id };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('image:project-rename', (_event, id: string, name: string) => {
    try { getDatabase().renameImageProject(id, (name || '').trim() || '未命名'); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('image:project-delete', (_event, id: string) => {
    try { getDatabase().deleteImageProject(id); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('image:asset-assign', (_event, assetPath: string, projectId: string | null) => {
    try { getDatabase().assignImageAsset(assetPath, projectId || null, Date.now()); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('image:project-map', () => {
    try { return getDatabase().getImageAssetProjectMap(); } catch (e: any) { console.warn('[image:project-map]', e?.message); return {}; }
  });

  ipcMain.handle('image:delete-turns', (_event, sessionId: string) => {
    try {
      if (!sessionId) return { ok: false };
      getDatabase().deleteImageTurns(sessionId);
      return { ok: true };
    } catch (err: any) {
      console.warn('[image:delete-turns] failed', err?.message || String(err));
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('image:list-turns', (_event, sessionId: string): Array<{ turnId: string; payload: string; createdAt: number }> => {
    try {
      if (!sessionId) return [];
      return getDatabase().listImageTurns(sessionId);
    } catch (err: any) {
      console.warn('[image:list-turns] failed', err?.message || String(err));
      return [];
    }
  });

  /* 历史图库列表 — 扫 <userData>/neox-artifacts/generated/**  返 mtime desc.
   * ImageStudioPage 打开时拉一次, 出新图后 300ms 再拉一次. */
  ipcMain.handle('image:gallery-list', async (_event, opts?: { limit?: number }): Promise<Array<{ path: string; fileUrl: string; filename: string; mtime: number }>> => {
    try {
      const root = path.join(app.getPath('userData'), 'neox-artifacts', 'generated');
      if (!existsSync(root)) return [];
      const found: Array<{ path: string; fileUrl: string; filename: string; mtime: number }> = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { await walk(full); continue; }
          if (!/\.(png|jpe?g|webp|gif)$/i.test(e.name)) continue;
          try {
            const stat = await fs.stat(full);
            found.push({
              path: full,
              fileUrl: absPathToAssetUrl(full),
              filename: e.name,
              mtime: stat.mtimeMs,
            });
          } catch { /* skip */ }
        }
      };
      await walk(root);
      found.sort((a, b) => b.mtime - a.mtime);
      const limit = opts?.limit ?? 60;
      return found.slice(0, limit);
    } catch (err: any) {
      console.warn('[image:gallery-list] failed', err?.message || String(err));
      return [];
    }
  });

  ipcMain.handle('image:direct-cutout', async (_event, request: { source: string; model?: string }): Promise<ImageDirectResult & { fellBackToWhite?: boolean }> => {
    try {
      const source = (request?.source ?? '').trim();
      if (!source) return { ok: false, error: 'source required' };
      let inline = source;
      if (path.isAbsolute(source)) {
        const buf = await fs.readFile(source);
        const ext = source.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        inline = `data:${mime};base64,${buf.toString('base64')}`;
      }
      const service = getImageGenService();
      const model = request.model || 'gpt-image-1';
      const GREEN_PROMPT = 'Replace the entire background with a solid uniform chroma key green screen, pure bright green (#00FF00), evenly lit. Keep the foreground subject exactly the same with clean sharp edges. Do not tint or spill green onto the subject.';
      const WHITE_PROMPT = 'Replace the entire background with a pure solid white (#FFFFFF) seamless studio backdrop. Keep the foreground subject exactly the same with clean edges. No shadows on the backdrop.';
      const startedAt = Date.now();

      /* 主路: 绿幕 + 本地 chroma-key → 真透明. */
      try {
        const green = await service.edit({ model, prompt: GREEN_PROMPT, image: inline, size: 'auto', responseFormat: 'b64_json' , inputFidelity: 'high' });
        const g0 = green.data?.[0]?.b64Json;
        if (!g0) throw new Error('green-screen returned no image');
        const transparent = await chromaKeyGreenToTransparent(Buffer.from(g0, 'base64'));
        const dir = getGeneratedDir();
        const abs = path.join(dir, `cutout-nobg-${Date.now()}.png`);
        await fs.writeFile(abs, transparent);
        return {
          ok: true,
          paths: [abs],
          fileUrls: [absPathToAssetUrl(abs)],
          count: 1,
          mode: green.mode,
          providerLabel: (green as any).providerLabel,
          model: green.model,
          latencyMs: green.usage?.latencyMs ?? (Date.now() - startedAt),
          createdAt: Date.now(),
          fellBackToWhite: false,
        };
      } catch (greenErr: any) {
        /* 系统边界兜底: 绿幕/sharp 失败 → 白底 (上屏 fellBackToWhite). */
        const white = await service.edit({ model, prompt: WHITE_PROMPT, image: inline, size: 'auto', responseFormat: 'b64_json' , inputFidelity: 'high' });
        if (!white.data || white.data.length === 0) return { ok: false, error: `cutout failed: ${greenErr?.message || greenErr}` };
        const b64s = white.data.map(d => d.b64Json).filter((x): x is string => !!x);
        const savedPaths = await persistB64Images(b64s, 'cutout-white');
        return {
          ok: true,
          paths: savedPaths,
          fileUrls: savedPaths.map(absPathToAssetUrl),
          count: savedPaths.length,
          mode: white.mode,
          providerLabel: (white as any).providerLabel,
          model: white.model,
          latencyMs: white.usage?.latencyMs ?? (Date.now() - startedAt),
          createdAt: Date.now(),
          fellBackToWhite: true,
        };
      }
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });

  /* 图片编辑 (再改一下). source: 绝对路径 → 读盘转 dataURL. */
  ipcMain.handle('image:direct-edit', async (_event, request: ImageDirectRequest & { source: string; mask?: string; references?: string[] }): Promise<ImageDirectResult> => {
    try {
      const raw = (request?.prompt ?? '').trim();
      const source = (request?.source ?? '').trim();
      if (!raw || !source) return { ok: false, error: 'prompt and source required' };

      /* abs 路径 → 读盘转 dataURL; 已是 dataURL/URL 原样. */
      const toInline = async (p: string): Promise<string> => {
        if (!path.isAbsolute(p)) return p;
        const buf = await fs.readFile(p);
        const ext = p.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        return `data:${mime};base64,${buf.toString('base64')}`;
      };

      const sourceInline = await toInline(source);
      let maskInline = request.mask;
      if (maskInline && path.isAbsolute(maskInline)) maskInline = await toInline(maskInline);

      /* 额外参考图 (模特换装的服装等) → 跟 source 一起进 input_references. */
      const refs = Array.isArray(request.references) ? request.references.filter(Boolean) : [];
      const refInlines = await Promise.all(refs.map(toInline));
      const image = refInlines.length > 0 ? [sourceInline, ...refInlines] : sourceInline;

      const service = getImageGenService();
      const result = await service.edit({
        model: request.model || 'gpt-image-1',
        /* 档位透传 —— 决定走第三方(普通) 还是全参数聚合商(高级)。
           缺省不传, 由 service 走通用选路 (兼容老调用方)。 */
        tier: request.tier,
        providerId: request.providerId,
        prompt: raw,
        n: Math.min(Math.max(request.n ?? 1, 1), 4),
        size: (request.size as any) || '1024x1024',
        responseFormat: 'b64_json',
        image,
        mask: maskInline,
        inputFidelity: 'high',   // 编辑保留原图脸/背景 (换装/改图/去水印通用)
      });

      if (!result.data || result.data.length === 0) {
        return { ok: false, error: 'edit returned no images' };
      }

      /* 落盘统一走 persistImageItems: 扩展名按**真实文件头**判, 不写死 .png。
         编辑后的图很可能是 jpeg (改图渠道常自己转码), 扩展名撒谎会连累系统预览、
         上传时的 MIME 校验, 以及把这张图再喂给 edit_image 时的读取。 */
      const savedPaths = await persistImageItems(result.data, slugify(raw) + '-edited');

      return {
        ok: true,
        paths: savedPaths,
        fileUrls: savedPaths.map(absPathToAssetUrl),
        count: savedPaths.length,
        mode: result.mode,
        providerLabel: (result as any).providerLabel,
        latencyMs: result.usage?.latencyMs,
      };
    } catch (err: any) {
      return { ok: false, error: tierBusyMessage(err) ?? (err?.message || String(err)) };
    }
  });
}
