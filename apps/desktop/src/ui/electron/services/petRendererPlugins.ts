/**
 * petRendererPlugins — 桌宠"渲染器插件"的按需下载 / 定位 (复用 NeoxCloud 统一商店)
 *
 * 核心安装包只内置 灵动(svg)+角色(sprite) 两种零运行时渲染器. 重渲染器 (目前是
 * 3D = three.js, 独立 pet3d.html 页面) 做成插件, 从**统一商店**按需下载, 不进核心包.
 *
 * 商店地址跟插件市场同一个 (NEOX_MARKETPLACE_URL → prod 走 cloudEndpoints 的
 * <api>/api/v1), 走它的 `/plugins/:id/download` 约定下载一个 zip (内含 pet3d.html +
 * 它的 js chunk). 不另造 URL.
 *
 * 落盘: <userData>/pet-renderers/<mode>/   (解压后的 pet3d.html + assets/)
 * 定位: 优先用下载好的; 没有则回退到核心包内置副本 (保证商店未就绪 / 离线也能用).
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import JSZip from 'jszip';
import { resolveCloudEndpoints } from './cloudEndpoints.js';

/** 渲染 mode → 统一商店里的插件 id */
const RENDERER_PLUGIN_IDS: Record<string, string> = {
  '3d': 'pet-renderer-3d',
};

/** 每个 mode 加载的 html 文件名 */
function pageFileName(mode: string): string {
  return mode === '3d' ? 'pet3d.html' : 'pet.html';
}

/** 统一商店 base — 跟插件市场同源 (pluginHandlers 用同一个 env) */
function storeBase(): string {
  if (process.env.NEOX_MARKETPLACE_URL) return process.env.NEOX_MARKETPLACE_URL.replace(/\/+$/, '');
  return resolveCloudEndpoints().api.replace(/\/+$/, '') + '/api/v1';
}

function pluginDir(mode: string): string {
  return join(app.getPath('userData'), 'pet-renderers', mode);
}

/** 该 mode 是否是需要插件的重渲染器 */
export function isPluginRenderMode(mode: string): boolean {
  return mode in RENDERER_PLUGIN_IDS;
}

/** 下载好的插件副本是否就绪 */
export function isRendererPluginInstalled(mode: string): boolean {
  if (!isPluginRenderMode(mode)) return true; /* builtin 永远就绪 */
  return existsSync(join(pluginDir(mode), pageFileName(mode)));
}

/**
 * 解析该 mode 的 pet 页面所在目录:
 *   1. 优先用下载到 userData 的插件副本
 *   2. 否则回退到核心包内置 renderer 目录 (bundledRendererDir)
 */
export function resolveRendererDir(mode: string, bundledRendererDir: string): string {
  if (isPluginRenderMode(mode)) {
    const dir = pluginDir(mode);
    if (existsSync(join(dir, pageFileName(mode)))) return dir;
  }
  return bundledRendererDir;
}

/**
 * 确保该 mode 的渲染器插件可用. builtin 直接 ok; 插件渲染器若已下载或核心包仍内置
 * (fallback 存在) 也直接 ok; 否则从统一商店下载 zip 解压.
 *
 * @param bundledRendererDir 核心包内置 renderer 目录 (用于判断是否还内置着 fallback)
 */
export async function ensureRendererPlugin(
  mode: string,
  bundledRendererDir: string,
): Promise<{ ok: true; source: 'builtin' | 'bundled' | 'downloaded' } | { ok: false; error: string }> {
  if (!isPluginRenderMode(mode)) return { ok: true, source: 'builtin' };

  /* 已下载 */
  if (isRendererPluginInstalled(mode)) return { ok: true, source: 'downloaded' };

  /* 核心包还内置着 fallback (商店未就绪阶段) → 直接用, 不下载 */
  if (existsSync(join(bundledRendererDir, pageFileName(mode)))) {
    return { ok: true, source: 'bundled' };
  }

  /* 都没有 → 从统一商店下载 */
  const id = RENDERER_PLUGIN_IDS[mode];
  const url = `${storeBase()}/plugins/${id}/download`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Neox-Desktop' },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, error: `下载失败: HTTP ${res.status} (${url})` };
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);

    const dir = pluginDir(mode);
    await fs.mkdir(dir, { recursive: true });
    const entries = Object.values(zip.files);
    for (const entry of entries) {
      if (entry.dir) continue;
      /* 防路径遍历 */
      const rel = entry.name.replace(/^\/+/, '');
      if (rel.includes('..')) continue;
      const dest = join(dir, rel);
      if (!dest.startsWith(dir)) continue;
      await fs.mkdir(join(dest, '..'), { recursive: true });
      await fs.writeFile(dest, await entry.async('nodebuffer'));
    }

    if (!isRendererPluginInstalled(mode)) {
      return { ok: false, error: '下载的插件包内未找到 ' + pageFileName(mode) };
    }
    return { ok: true, source: 'downloaded' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** 卸载下载的插件副本 (停用时调用, 回收空间) */
export async function removeRendererPlugin(mode: string): Promise<void> {
  if (!isPluginRenderMode(mode)) return;
  try {
    await fs.rm(pluginDir(mode), { recursive: true, force: true });
  } catch { /* ignore */ }
}
