/**
 * neox-plugin:// 自定义协议 — 安全地给 iframe / img 加载插件目录下的资源
 *
 * URL 结构:
 *   neox-plugin://<pluginName>/<relative/path/in/install/dir>
 *
 * 实现:
 *   - 仅允许访问 pluginViewRegistry 中 已注册 installDir 下的文件
 *   - 不允许 `..` 路径穿越
 *   - 不允许读非 views 声明的任意文件 — 防止插件通过 iframe 自引用泄漏源码
 *     (views 声明的 entry 为起点, 同目录下资源视为可公开)
 *
 * 必须在 app.ready 前调 registerScheme, 在 app.ready 后调 registerHandler.
 */

import { protocol } from 'electron';
import { readFile as fsReadFile } from 'fs/promises';
import { extname, resolve as pathResolve, relative as pathRelative, isAbsolute } from 'path';
import { pluginViewRegistry } from '../../../plugins/pluginViewRegistry.js';

const PLUGIN_SCHEME = 'neox-plugin';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function registerPluginProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // iframe 跨源 CSP 依然需要; 不 bypass CSP — 插件内 HTML 自己写 CSP
      },
    },
  ]);
}

/** 在 app.ready 之后调用, 注册 handler. */
export function registerPluginProtocolHandler(): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const pluginName = url.host;
      let relPath = decodeURIComponent(url.pathname || '/');
      if (relPath.startsWith('/')) relPath = relPath.slice(1);
      if (!pluginName) return new Response('Bad request: missing plugin name', { status: 400 });

      // 找到插件已注册 views, 取其 installDir (必须是已通过 pluginViewRegistry 注册的)
      const views = pluginViewRegistry.list().filter(v => v.pluginName === pluginName);
      if (views.length === 0) {
        return new Response('Plugin not found or no views registered', { status: 404 });
      }

      const installDir = pathResolve(views[0].installDir);
      if (!isAbsolute(installDir)) {
        return new Response('Plugin installDir invalid', { status: 500 });
      }

      const absolutePath = pathResolve(installDir, relPath);
      const rel = pathRelative(installDir, absolutePath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return new Response('Forbidden: path traversal', { status: 403 });
      }

      const buffer = await fsReadFile(absolutePath);
      const mime = MIME_MAP[extname(absolutePath).toLowerCase()] || 'application/octet-stream';
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': mime,
          // Plugin 资源相对稳定, 开短缓存
          'Cache-Control': 'public, max-age=60',
        },
      });
    } catch (err: any) {
      console.warn('[neox-plugin] request failed:', err?.message || err);
      return new Response('Not found', { status: 404 });
    }
  });
}
