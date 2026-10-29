/**
 * PluginViewHost — 在 iframe 里渲染插件贡献的面板.
 *
 * URL 通过 neox-plugin:// 自定义协议加载, 主进程 pluginProtocol.ts 校验:
 *   1. plugin 必须已注册 view
 *   2. 路径不能 `..` 穿越 installDir
 *
 * iframe 用 sandbox="allow-scripts" 限制同源访问, 脚本执行 OK 但不能访问
 * 宿主 cookie / localStorage.
 *
 * postMessage 桥接预留: window.postMessage({ type: 'neox.plugin.<verb>', ... })
 * 目前只接 `resize` (让 iframe 告知高度); 后续 `invokeTool` / `readFile` 等
 * 通过此桥走.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PluginViewSummary } from '@neoxlabs/platform/shared/ipc/plugin.js';
import { usePluginHostResolvers } from './pluginHostContext.js';

interface Props {
  view: PluginViewSummary;
  /** 宿主容器的显式 width (px), 不传则 100% */
  width?: number | string;
  /** 宿主容器的显式 height (px), 不传则 100% */
  height?: number | string;
  /** 给 iframe 的扩展 sandbox (默认 'allow-scripts') */
  sandbox?: string;
  className?: string;
  /** 附在入口地址后的参数 —— 宿主用它告诉面板 theme / lang (面板读 location.search) */
  query?: Record<string, string>;
}

const DEFAULT_SANDBOX = 'allow-scripts';

export const PluginViewHost: React.FC<Props> = React.memo(function PluginViewHost({
  view,
  width,
  height,
  sandbox,
  className,
  query,
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeHeight, setIframeHeight] = useState<number | null>(null);
  const resolvers = usePluginHostResolvers();
  const resolversRef = useRef(resolvers);
  resolversRef.current = resolvers;

  const queryKey = query ? new URLSearchParams(query).toString() : '';
  const src = useMemo(() => {
    const encodedPath = view.entry.split('/').map(encodeURIComponent).join('/');
    return `neox-plugin://${view.pluginName}/${encodedPath}${queryKey ? `?${queryKey}` : ''}`;
  }, [view.pluginName, view.entry, queryKey]);

  useEffect(() => {
    function reply(callId: string, result?: unknown, error?: string): void {
      try {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'neox.plugin.reply', callId, result, error },
          '*',
        );
      } catch { /* iframe 已销毁 */ }
    }

    async function handleInvoke(callId: string, verb: string, args: any): Promise<void> {
      const host = (window as any).neox?.pluginHost;
      if (!host) return reply(callId, undefined, 'pluginHost not available');
      try {
        switch (verb) {
          case 'getActiveFile': {
            // 渲染侧 context 有真实数据就走它, 没有则 fallback 到 IPC (返回 null)
            if (resolversRef.current?.getActiveFile) {
              return reply(callId, resolversRef.current.getActiveFile());
            }
            return reply(callId, await host.getActiveFile());
          }
          case 'readPluginData':
            return reply(callId, await host.readPluginData(view.pluginName, String(args?.path ?? '')));
          case 'writePluginData':
            return reply(callId, await host.writePluginData(view.pluginName, String(args?.path ?? ''), String(args?.content ?? '')));
          case 'readFile':
            return reply(callId, await host.readFile(view.pluginName, String(args?.path ?? '')));
          case 'writeFile':
            return reply(callId, await host.writeFile(view.pluginName, String(args?.path ?? ''), String(args?.content ?? '')));
          case 'invokeTool':
            return reply(callId, await host.invokeTool(view.pluginName, String(args?.name ?? ''), args?.args ?? {}));
          default:
            return reply(callId, undefined, `Unknown verb: ${verb}`);
        }
      } catch (err: any) {
        return reply(callId, undefined, err?.message ?? String(err));
      }
    }

    function onMessage(event: MessageEvent): void {
      // 只接受来自本 iframe 的消息
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'neox.plugin.resize': {
          const h = Number(data.height);
          if (Number.isFinite(h) && h > 0 && h < 10_000) setIframeHeight(h);
          break;
        }
        case 'neox.plugin.invoke': {
          const callId = String(data.callId ?? '');
          if (!callId) break;
          void handleInvoke(callId, String(data.verb ?? ''), data.args);
          break;
        }
        default:
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [view.pluginName]);

  const resolvedHeight = height ?? iframeHeight ?? '100%';

  return (
    <iframe
      ref={iframeRef}
      title={view.title}
      src={src}
      sandbox={sandbox ?? DEFAULT_SANDBOX}
      className={className}
      style={{
        width: width ?? '100%',
        height: resolvedHeight,
        border: 'none',
        background: 'transparent',
      }}
      data-plugin-name={view.pluginName}
      data-plugin-view={view.id}
    />
  );
});
