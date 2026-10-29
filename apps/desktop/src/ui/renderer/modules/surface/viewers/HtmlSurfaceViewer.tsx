/**
 * HtmlSurfaceViewer — 静态 HTML viewer (iframe sandbox)
 *
 * sandbox 限制:
 *   - allow-scripts: 允许内嵌 JS 跑 (设计稿要的交互)
 *   - allow-same-origin: 跟 data: URL 配, 允许相对样式 link/script
 *   - 不允许 top navigation / form submission, 防止逃逸
 *
 * file 模式: 读文件内容 + visibility-aware polling 刷新
 * inline 模式: 直接渲染传入 HTML 字符串
 *
 * 工具条 (右上浮动): 复制 HTML / 另存 .html / 在系统浏览器打开
 *   · file 源: 浏览器打开直接 surfaceOpenExternal(path)
 *   · inline 源: 先另存成 .html 再自动用浏览器打开 (iframe 里的产物用户带得走)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useI18n } from '../../../hooks/useI18n';
import { useVisibilityInterval } from '../../../hooks/useVisibilityInterval';
import { dispatchHint } from '../../../components/notifyEvents';
import { useNeoxEditorTheme } from '../../editor/engine/theme';
import { inlineLocalAssets, dirOf } from './htmlPortable';
import { TakeawayTip, TAKEAWAY_TIP_KEY } from './HtmlTakeawayTip';

interface Props {
  surface: Surface;
  workspacePath?: string;
}

/**
 * 沙箱 iframe (不透明源) 拿不到宿主主题, 而 Electron 把 nativeTheme 固定成 dark,
 * 里面的 prefers-color-scheme 永远是 dark —— 白色主题下 deck 预览照样黑底。
 * 在 <html> 上打一个只读属性告诉页面宿主主题; 不认这个属性的页面不受影响。
 * 只进 srcDoc, 复制 / 另存拿的仍是原文。
 */
const THIN_SCROLLBAR = '<style data-neox-scrollbar>html{scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.35) transparent}'
  + '::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}'
  + '::-webkit-scrollbar-thumb{background:rgba(128,128,128,.35);border-radius:4px}</style>';

function withHostTheme(html: string, isDark: boolean): string {
  const attr = ` data-neox-host-theme="${isDark ? 'dark' : 'light'}"`;
  const themed = /<html[\s>]/i.test(html) ? html.replace(/<html(?=[\s>])/i, `<html${attr}`) : html;
  return /<\/head>/i.test(themed) ? themed.replace(/<\/head>/i, `${THIN_SCROLLBAR}</head>`) : THIN_SCROLLBAR + themed;
}

export const HtmlSurfaceViewer: React.FC<Props> = ({ surface, workspacePath: workspacePathProp }) => {
  const { isZh } = useI18n();
  const { isDark } = useNeoxEditorTheme();
  const [html, setHtml] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const lastContentRef = useRef('');
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    lastContentRef.current = '';

    const boundWorkspace =
      (typeof surface.metadata?.workspacePath === 'string' && surface.metadata.workspacePath)
      || workspacePathProp;

    const load = async () => {
      if (surface.source.type === 'inline') {
        if (!cancelled) setHtml(surface.source.content);
        return;
      }
      if (surface.source.type !== 'file') {
        if (!cancelled) setError(isZh ? 'HTML surface 仅支持 file 或 inline source' : 'HTML surface needs file or inline source');
        return;
      }
      try {
        const api = (window as any).neox;
        const reader = api?.surfaceReadFile ?? api?.readFile;
        const readOpts = boundWorkspace ? { workspacePath: boundWorkspace } : undefined;
        const result = await reader?.(surface.source.path, readOpts);
        if (cancelled) return;
        if (result?.success === false) {
          setError(result.error || 'read failed');
          return;
        }
        const text = typeof result === 'string' ? result : (result?.content ?? '');
        if (text === lastContentRef.current) return;
        lastContentRef.current = text;
        setHtml(text);
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      }
    };

    loadRef.current = load;
    void load();
    return () => { cancelled = true; };
  }, [surface.source, surface.metadata, workspacePathProp, isZh]);

  /* file 源 400ms 前台轮询, 后台 tab 暂停 (原 setInterval 后台也烧 CPU). */
  useVisibilityInterval(() => loadRef.current(), surface.source.type === 'file' ? 400 : 0);

  /* 网页旁边的图片 / 样式打进同一个 HTML: 预览 (不透明源读不到相对路径) 和带走 (U 盘只拷一个文件) 共用。见 htmlPortable.ts */
  const [portable, setPortable] = useState('');
  useEffect(() => {
    let cancelled = false;
    setPortable(html);
    if (!html || surface.source.type !== 'file') return;
    const baseDir = dirOf(surface.source.path);
    const boundWorkspace = (typeof surface.metadata?.workspacePath === 'string' && surface.metadata.workspacePath) || workspacePathProp;
    const api = (window as any).neox;
    const readBase64 = async (p: string) => {
      const r = await api?.surfaceReadFile?.(p, { encoding: 'base64', ...(boundWorkspace ? { workspacePath: boundWorkspace } : {}) });
      return r?.success === false ? null : (typeof r === 'string' ? r : r?.content ?? null);
    };
    void inlineLocalAssets(html, baseDir, readBase64).then((r) => { if (!cancelled && r.inlined) setPortable(r.html); });
    return () => { cancelled = true; };
  }, [html, surface.source, surface.metadata, workspacePathProp]);

  /* 演示: 整块预览全屏, 投屏 / 笔记本直接用; Esc 退出 */
  const wrapRef = useRef<HTMLDivElement>(null);
  const present = useCallback(() => {
    void wrapRef.current?.requestFullscreen?.().catch(() => dispatchHint(isZh ? '全屏没打开, 可以点「在浏览器打开」再按 F11' : 'Fullscreen failed', 'warning'));
  }, [isZh]);

  /* 第一次看到网页成品时教一遍怎么带走 (存 U 盘 → 教室电脑双击) */
  const [showTip, setShowTip] = useState(() => { try { return !localStorage.getItem(TAKEAWAY_TIP_KEY); } catch { return false; } });
  const closeTip = useCallback(() => { setShowTip(false); try { localStorage.setItem(TAKEAWAY_TIP_KEY, '1'); } catch { /* 隐私模式 */ } }, []);

  const copyHtml = useCallback(() => {
    if (!html) return;
    navigator.clipboard.writeText(html).then(
      () => dispatchHint(isZh ? '已复制 HTML' : 'HTML copied', 'success'),
      () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
    );
  }, [html, isZh]);

  /** 另存为 .html (图片等已打包进去, 单文件可带走). 返回保存路径 (取消 / 失败返 null). */
  const saveAsHtml = useCallback(async (): Promise<string | null> => {
    if (!html) return null;
    const out = portable || html;
    const api = (window as any).neox;
    if (!api?.saveFileDialog || !api?.surfaceWriteFile) {
      dispatchHint(isZh ? '保存能力不可用 (bridge 缺失)' : 'Save unavailable (bridge missing)', 'warning');
      return null;
    }
    try {
      /* 文件源用文件本身的名字 —— 面板标题可能是「源码」这类视图名 (10-21 存出来叫 源码.html) */
      const fileName = surface.source.type === 'file' ? surface.source.path.split(/[/\\]/).pop() : '';
      const base = (fileName || surface.title || 'page').replace(/\.html?$/i, '') || 'page';
      const picked = await api.saveFileDialog({
        title: isZh ? '保存网页 (可以直接选 U 盘)' : 'Save page',
        defaultPath: `${base}.html`,
        filters: [{ name: 'HTML', extensions: ['html'] }, { name: 'All Files', extensions: ['*'] }],
      });
      if (!picked) return null;
      const r = await api.surfaceWriteFile(picked, out, { encoding: 'utf-8' });
      if (r?.success === false) throw new Error(r.error || 'write failed');
      dispatchHint(isZh ? `已保存: ${picked} · 拷到别的电脑双击就能打开` : `Saved: ${picked}`, 'success');
      return picked as string;
    } catch (e: any) {
      dispatchHint((isZh ? '保存失败: ' : 'Save failed: ') + (e?.message || String(e)), 'warning');
      return null;
    }
  }, [html, portable, surface.title, isZh]);

  /* 在系统浏览器打开: file 源直接开; inline 源先落盘再开 (data URL 超长会炸, 不走). */
  const openInBrowser = useCallback(async () => {
    const api = (window as any).neox;
    if (surface.source.type === 'file') {
      const r = await api?.surfaceOpenExternal?.(surface.source.path);
      if (r?.success === false) {
        dispatchHint((isZh ? '打开失败: ' : 'Open failed: ') + (r.error || ''), 'warning');
      }
      return;
    }
    const saved = await saveAsHtml();
    if (saved) {
      const r = await api?.surfaceOpenExternal?.(saved);
      if (r?.success === false) {
        dispatchHint((isZh ? '打开失败: ' : 'Open failed: ') + (r.error || ''), 'warning');
      }
    }
  }, [surface.source, saveAsHtml, isZh]);

  /* 文件还没写出来 (Agent 先开了面板再写) 不是错误: 显示「正在生成」, 400ms 轮询会在文件出现后自动显示 */
  if (error && /ENOENT|no such file|not found|不存在/i.test(error)) {
    return (
      <div className="sfc-empty">
        <div className="sfc-empty__title">{isZh ? '网页正在生成…' : 'Generating the page…'}</div>
        <div className="sfc-empty__msg">{isZh ? '写好后这里会自动显示, 不用刷新。' : 'It will appear here automatically.'}</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="sfc-empty sfc-empty--error">
        <div className="sfc-empty__title">{isZh ? '无法加载 HTML' : 'Failed to load HTML'}</div>
        <div className="sfc-empty__msg">{error}</div>
      </div>
    );
  }
  if (!html) {
    return <div className="sfc-empty"><div className="sfc-empty__title">{isZh ? '空 HTML' : 'Empty HTML'}</div></div>;
  }

  const toolIcon = (path: React.ReactNode) => (
    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  );

  return (
    <div className="sfc-html-wrap" ref={wrapRef}>
      <div className="sfc-html__tools" role="toolbar" aria-label={isZh ? 'HTML 工具' : 'HTML tools'}>
        <button type="button" className="sfc-html__text-btn" onClick={present} title={isZh ? '全屏演示, 投屏用 (Esc 退出)' : 'Present fullscreen (Esc to exit)'}>
          {toolIcon(<><rect x="1.5" y="2.5" width="11" height="7.5" rx="1" /><path d="M5 12.5h4M7 10v2.5" /></>)}
          {isZh ? '演示' : 'Present'}
        </button>
        <button type="button" className="sfc-html__text-btn" onClick={() => void saveAsHtml()} title={isZh ? '存成一个文件, 拷到 U 盘或别的电脑双击就能用' : 'Save as one file to take anywhere'}>
          {toolIcon(<><path d="M7 2v7M4 6.5 7 9.5l3-3" /><path d="M2.5 10.5v1.5h9v-1.5" /></>)}
          {isZh ? '带走' : 'Take away'}
        </button>
        <button
          type="button"
          onClick={copyHtml}
          title={isZh ? '复制 HTML 源码' : 'Copy HTML source'}
          aria-label={isZh ? '复制' : 'Copy'}
        >
          {toolIcon(<><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" /><path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" /></>)}
        </button>
        <button
          type="button"
          onClick={() => void openInBrowser()}
          title={surface.source.type === 'file'
            ? (isZh ? '在系统浏览器打开' : 'Open in system browser')
            : (isZh ? '另存后在系统浏览器打开' : 'Save, then open in system browser')}
          aria-label={isZh ? '在浏览器打开' : 'Open in browser'}
        >
          {toolIcon(<><path d="M6 3.5 H3 V11 H10.5 V8" /><path d="M8 3 H11 V6" /><path d="M11 3 L6.5 7.5" /></>)}
        </button>
      </div>
      <iframe
        className="sfc-html"
        title={surface.title || 'html surface'}
        srcDoc={withHostTheme(portable || html, isDark)}
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
      />
      {showTip && <TakeawayTip isZh={isZh} onSave={() => { closeTip(); void saveAsHtml(); }} onClose={closeTip} />}
    </div>
  );
};

export default HtmlSurfaceViewer;
