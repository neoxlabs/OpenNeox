/**
 * TerminalManager - 终端窗口管理器
 * 支持多终端窗口、标签切换、拖拽调整大小
 */

import { useI18n } from '../../../hooks/useI18n';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import TerminalPanel, { type TerminalHandle } from './TerminalPanel';
import { dispatchHint } from '../../../components/notifyEvents';
import Icons from '../../../components/Icons';
import {
  registerAgentTerminalRunner, wrapCommand, matchDone, stripMarker,
  buildPromptHook, matchOscDone, stripOsc,
  type AgentTerminalRequest, type AgentTerminalResult,
} from '../agentTerminalBridge';

interface TerminalTab {
  id: string;
  sessionId?: string;
  title: string;
  cwd?: string;
  /** agent 开的那种 tab —— 页签上带个标记, 让"谁干的"一眼分得清 */
  agent?: boolean;
}

export interface TerminalToolsState {
  terminals: TerminalTab[];
  activeId: string | null;
  onCreate: () => void;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
}

interface TerminalManagerProps {
  visible: boolean;
  onClose: () => void;
  workspacePath?: string;
  theme?: 'dark' | 'light';
  initialHeight?: number;
  onHeightChange?: (height: number) => void;
  embedded?: boolean;
  fill?: boolean;
  openInCwd?: string | null;
  onOpenInCwdHandled?: () => void;
  /** 把终端管理状态上报给父组件, 让父组件在 head 行渲染控件 */
  onToolsStateChange?: (state: TerminalToolsState) => void;
}

const TerminalManager: React.FC<TerminalManagerProps> = ({
  visible,
  onClose,
  workspacePath,
  theme = 'dark',
  initialHeight = 300,
  onHeightChange,
  embedded = false,
  fill = false,
  openInCwd,
  onOpenInCwdHandled,
  onToolsStateChange,
}) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [terminals, setTerminals] = useState<TerminalTab[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [height, setHeight] = useState(initialHeight);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  /* 每个终端的命令句柄 (copy/selectAll) — 工具栏复制/全选作用于 active 终端 */
  const handlesRef = useRef<Map<string, TerminalHandle>>(new Map());
  const resizeStartY = useRef<number>(0);
  const resizeStartHeight = useRef<number>(0);
  const terminalsRef = useRef<TerminalTab[]>([]);
  useEffect(() => { terminalsRef.current = terminals; }, [terminals]);

  const runAgentCommand = useCallback((req: AgentTerminalRequest): Promise<AgentTerminalResult> => {
    const tabId = `agent-${req.requestId}`;
    const short = req.command.trim().split(/\s+/).slice(0, 3).join(' ');
    setTerminals((prev) => [...prev, {
      id: tabId,
      title: `${zh ? 'Agent' : 'Agent'} · ${short.length > 22 ? short.slice(0, 22) + '…' : short}`,
      cwd: req.cwd,
      agent: true,
    }]);
    setActiveTerminalId(tabId);

    return new Promise<AgentTerminalResult>((resolve) => {
      let output = '';
      let settled = false;
      let commandSent = false;
      let sentAt = 0;
      let unsubData: (() => void) | undefined;
      let unsubExit: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number, error?: string) => {
        if (settled) return;
        settled = true;
        unsubData?.(); unsubExit?.();
        if (timer) clearTimeout(timer);
        resolve({ output: stripOsc(stripMarker(output, req.requestId)), exitCode, error });
      };

      /* PTY 是 TerminalPanel 建的, 这里等它把 sessionId 报上来再写命令。
       * 轮询而不是回调: sessionId 落在 terminals 这个 state 上, 拿回调要把
       * TerminalPanel 的接口撬开一层, 而这里只是等一个已经在路上的值。 */
      const started = Date.now();
      const waitForSession = () => {
        if (settled) return;
        const tab = terminalsRef.current.find((t) => t.id === tabId);
        if (tab?.sessionId) {
          const sid = tab.sessionId;
          let hookAlive = false;
          unsubData = (window as any).neox?.onTerminalData?.((e: { sessionId: string; data: string }) => {
            if (e.sessionId !== sid) return;
            output += e.data;
            if (matchOscDone(output)) hookAlive = true;
            /* 命令发出之前收到的标记是注入本身触发的, 不算命令跑完 */
            if (!commandSent) return;
            const done = hookAlive
              ? matchOscDone(output.slice(sentAt))
              : matchDone(output, req.requestId);
            if (done) finish(done.exitCode);
          });
          /* shell 自己没了 (用户点了重启/关闭, 或者命令把它带走了) 也要收尾,
           * 否则 agent 一直等到超时 */
          unsubExit = (window as any).neox?.onTerminalExit?.((e: { sessionId: string; exitCode: number }) => {
            if (e.sessionId === sid) finish(e.exitCode ?? 1, zh ? '终端会话结束了' : 'Terminal session ended');
          });

          /* 1) 注入钩子 + 清屏 —— 清屏把注入那一行本身也扫掉, 用户看到的第一屏是干净的 */
          (window as any).neox?.terminalWrite?.(sid, buildPromptHook());
          (window as any).neox?.terminalWrite?.(sid, 'clear\n');
          /* 2) 给钩子 1.2s 表态, 然后按结果选模式发命令 */
          setTimeout(() => {
            if (settled) return;
            /* 从这里往后的输出才算命令的 —— 注入和 clear 的回显不算 */
            sentAt = output.length;
            commandSent = true;
            (window as any).neox?.terminalWrite?.(
              sid,
              hookAlive ? `${req.command}\n` : wrapCommand(req.command, req.requestId),
            );
          }, 1200);
          return;
        }
        /* PTY 起不来就别让 agent 干等 —— 8 秒还没 sessionId 就认输, 让它退回直接执行 */
        if (Date.now() - started > 8000) {
          finish(1, zh ? '终端没能启动' : 'Terminal failed to start');
          return;
        }
        setTimeout(waitForSession, 80);
      };
      waitForSession();

      const limit = req.timeout ?? 600000;
      timer = setTimeout(() => finish(124, zh ? `超过 ${Math.round(limit / 1000)} 秒还没结束` : `Timed out after ${Math.round(limit / 1000)}s`), limit);
    });
  }, [zh]);

  useEffect(() => {
    registerAgentTerminalRunner(runAgentCommand);
    return () => registerAgentTerminalRunner(null);
  }, [runAgentCommand]);

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);

  const isDark = theme === 'dark';

  // 创建新终端
  const createTerminal = useCallback((cwd?: string) => {
    const newId = `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const terminalCwd = cwd || workspacePath;
    const newTerminal: TerminalTab = {
      id: newId,
      title: cwd
        ? (zh ? `终端 (${cwd.split('/').pop()})` : `Terminal (${cwd.split('/').pop()})`)
        : (zh ? `终端 ${terminals.length + 1}` : `Terminal ${terminals.length + 1}`),
      cwd: terminalCwd,
    };
    setTerminals((prev) => [...prev, newTerminal]);
    setActiveTerminalId(newId);
  }, [terminals.length, workspacePath, zh]);

  // 关闭终端 —
  //   多 tab → 关当前, 切到剩余 tab.
  //   最后一个 → 整个底部面板收起 (调 onClose), 跟 VSCode/IDEA 一致 ("用户不想看终端了").
  //   关掉的 session 也真销毁, 不留 idle PTY 在后台烧资源.
  //   下次再展开 panel 时 useEffect "visible && length===0 → createTerminal" 自动起新 shell.
  const closeTerminal = useCallback((id: string) => {
    setTerminals((prev) => {
      const target = prev.find((t) => t.id === id);
      const filtered = prev.filter((t) => t.id !== id);
      /* 真销毁后端 PTY — 否则 shell 进程残留 */
      if (target?.sessionId) {
        try { void (window as unknown as { neox?: { terminalDestroy?: (id: string) => unknown } }).neox?.terminalDestroy?.(target.sessionId); } catch { /* ignore */ }
      }
      if (filtered.length === 0) {
        /* 通知父级 collapse 整个 bottom panel — 跟点工具栏"隐藏"按钮等价 */
        onClose();
        return [];
      }
      if (activeTerminalId === id) {
        setActiveTerminalId(filtered[filtered.length - 1].id);
      }
      return filtered;
    });
  }, [activeTerminalId, onClose]);

  // 创建第一个终端
  useEffect(() => {
    if (visible && terminals.length === 0) {
      createTerminal();
    }
  }, [visible, terminals.length, createTerminal]);

  // 处理外部请求打开指定目录的终端
  useEffect(() => {
    if (openInCwd && visible) {
      createTerminal(openInCwd);
      onOpenInCwdHandled?.();
    }
  }, [openInCwd, visible, createTerminal, onOpenInCwdHandled]);

  // 当终端显示/隐藏时通知高度变化
  useEffect(() => {
    if (visible) {
      onHeightChange?.(height);
    } else {
      onHeightChange?.(0);
    }
  }, [visible, height, onHeightChange]);

  // 开始调整大小
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = height;
  }, [height]);

  // 调整大小
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = resizeStartY.current - e.clientY;
      const newHeight = Math.max(150, Math.min(800, resizeStartHeight.current + delta));
      setHeight(newHeight);
      onHeightChange?.(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    onToolsStateChange?.({
      terminals,
      activeId: activeTerminalId,
      onCreate: () => createTerminal(),
      onSwitch: setActiveTerminalId,
      onClose: closeTerminal,
    });
  }, [terminals, activeTerminalId, createTerminal, closeTerminal, onToolsStateChange]);

  if (!visible) return null;

  const activeTerminal = terminals.find((t) => t.id === activeTerminalId);

  /* fill 模式不设 height —— 高度由父容器的 flex 决定 (见 .terminal-manager.fill)。
   * 设了的话内联样式会盖过 CSS 的 flex:1, 又回到固定 300px。 */
  const containerStyle: React.CSSProperties = fill ? {} : { height: `${height}px` };

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      className={`terminal-manager ${embedded ? 'embedded' : 'floating'} ${fill ? 'fill' : ''} ${isDark ? 'dark' : 'light'}`}
    >
      {/* IDEA 风格 tab 栏 — 多 tab 切换 + 右侧工具按钮 */}
      <div className="tm-tabbar">
        <div className="tm-tabbar-left">
          {terminals.map((terminal, i) => (
            <span
              key={terminal.id}
              onClick={() => setActiveTerminalId(terminal.id)}
              className={`tm-tab ${activeTerminalId === terminal.id ? 'active' : ''}${terminal.agent ? ' agent' : ''}`}
              title={terminal.agent ? (zh ? `${terminal.title} · Agent 开的` : `${terminal.title} · opened by the agent`) : terminal.title}
            >
              {terminal.agent && <span className="tm-tab-dot" aria-hidden />}
              <span className="tm-tab-name">{terminal.title || (zh ? `未命名${i > 0 ? ` (${i + 1})` : ''}` : `Untitled${i > 0 ? ` (${i + 1})` : ''}`)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTerminal(terminal.id); }}
                className="tm-tab-close"
                title={zh ? '关闭终端' : 'Close terminal'}
              >×</button>
            </span>
          ))}
          {/* + 新建终端 */}
          <button className="tm-add-btn" onClick={() => createTerminal()} title={zh ? '新建终端' : 'New terminal'} aria-label={zh ? '新建终端' : 'New terminal'}><Icons.Plus /></button>
        </div>
        <div className="tm-tabbar-right">
          <button
            className="tm-action-btn tm-action-btn--label"
            disabled={!activeTerminalId}
            onClick={async () => {
              const active = terminals.find((t) => t.id === activeTerminalId);
              if (active?.sessionId) {
                /* \x1bc = Full reset; 比 \x1b[2J 干净 (连滚动缓冲一起清) */
                try { await (window as any).neox?.terminalWrite?.(active.sessionId, '\x1bc'); } catch { /* ignore */ }
              }
            }}
            title={zh ? '清空当前终端的输出' : 'Clear this terminal'}
            aria-label={zh ? '清屏' : 'Clear'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 4l6 6" /><path d="M5 21l5-5" />
              <path d="M19 11l-8 8a3 3 0 0 1-4 0l-1-1a3 3 0 0 1 0-4l8-8" /><path d="M13 5l6 6" />
            </svg>
            <span>{zh ? '清屏' : 'Clear'}</span>
          </button>

          <div className="tm-more-wrap" ref={moreRef}>
            <button
              className={`tm-action-btn${moreOpen ? ' is-on' : ''}`}
              onClick={() => setMoreOpen((v) => !v)}
              title={zh ? '更多' : 'More'}
              aria-label={zh ? '更多' : 'More'}
              aria-haspopup="true"
              aria-expanded={moreOpen}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
                <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
                <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
              </svg>
            </button>
            {moreOpen && (
              <div className="tm-more-menu" role="menu">
                <button
                  className="tm-more-item"
                  disabled={!activeTerminalId}
                  onClick={() => {
                    setMoreOpen(false);
                    if (!activeTerminalId) return;
                    const ok = handlesRef.current.get(activeTerminalId)?.copySelection();
                    if (!ok) dispatchHint(zh ? '先在终端里选中文本再复制' : 'Select some text in the terminal first', 'info');
                  }}
                >{zh ? '复制选中的文本' : 'Copy selection'}</button>
                <button
                  className="tm-more-item"
                  disabled={!activeTerminalId}
                  onClick={() => { setMoreOpen(false); if (activeTerminalId) handlesRef.current.get(activeTerminalId)?.selectAll(); }}
                >{zh ? '全选所有输出' : 'Select all output'}</button>
                <div className="tm-more-sep" />
                <button
                  className="tm-more-item"
                  disabled={!activeTerminalId}
                  onClick={async () => {
                    setMoreOpen(false);
                    const active = terminals.find((t) => t.id === activeTerminalId);
                    if (!active) return;
                    if (active.sessionId) {
                      try { await (window as any).neox?.terminalDestroy?.(active.sessionId); } catch { /* ignore */ }
                    }
                    setTerminals((prev) => prev.map((t) => t.id === active.id ? { ...t, sessionId: undefined } : t));
                  }}
                >{zh ? '重启这个 shell' : 'Restart this shell'}</button>
                <button
                  className="tm-more-item tm-more-item--danger"
                  disabled={!activeTerminalId}
                  onClick={() => { setMoreOpen(false); if (activeTerminalId) closeTerminal(activeTerminalId); }}
                >{zh ? '关闭这个终端' : 'Close this terminal'}</button>
                {!fill && (
                  <>
                    <div className="tm-more-sep" />
                    <button className="tm-more-item" onClick={() => { setMoreOpen(false); onClose(); }}>
                      {zh ? '隐藏终端面板' : 'Hide terminal panel'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 终端内容区 — 所有 tab 的 TerminalPanel 都常驻挂载, 靠 active prop 切 display.
       *   旧方案 key={activeTerminal.id} 单实例切换时整个 React 卸载重建 + xterm.dispose + 重新
       *   createSession, 用户报"切 tab 有重新加载的感觉". 现在 xterm 和 PTY 全保留, 切换只是
       *   CSS display 翻转, 历史输出/光标位置/正在运行的命令全部原地保留. */}
      <div className="terminal-manager-body">
        {terminals.map((terminal) => (
          <TerminalPanel
            key={terminal.id}
            ref={(h) => { if (h) handlesRef.current.set(terminal.id, h); else handlesRef.current.delete(terminal.id); }}
            sessionId={terminal.sessionId}
            cwd={terminal.cwd}
            theme={theme}
            active={terminal.id === activeTerminalId}
            onSessionCreated={(sessionId) => {
              setTerminals((prev) =>
                prev.map((t) => (t.id === terminal.id ? { ...t, sessionId } : t)),
              );
            }}
            onSessionDestroyed={() => {
              /* exit overlay 上抛已经在 onCloseTab 处理, 这里不再做 */
            }}
            onCloseTab={() => closeTerminal(terminal.id)}
            height="100%"
          />
        ))}
      </div>
    </div>
  );
};

export default TerminalManager;
