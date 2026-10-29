/**
 * TerminalExecutionPanel - LLM 工具调用的终端执行面板
 *
 * 特点：
 * - 每个 execute_shell 工具调用创建一个独立的终端
 * - 实时显示命令输出
 * - 支持用户中断（Ctrl+C）
 * - 执行完成后自动返回结果给主进程
 */

import { useI18n } from '../../../hooks/useI18n';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import Icons from '../../../components/Icons';

export interface TerminalRequest {
  requestId: string;
  command: string;
  cwd: string;
  timeout?: number;
}

interface TerminalExecutionPanelProps {
  request: TerminalRequest;
  onComplete: (requestId: string, result: { output: string; exitCode: number; error?: string }) => void;
  onCancel?: (requestId: string) => void;
  height?: number | string;
  className?: string;
}

const TerminalExecutionPanel: React.FC<TerminalExecutionPanelProps> = ({
  request,
  onComplete,
  onCancel,
  height = 300,
  className = '',
}) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const outputRef = useRef<string>('');
  const isCompletedRef = useRef<boolean>(false);
  const unsubscribeDataRef = useRef<(() => void) | null>(null);
  const unsubscribeExitRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<'initializing' | 'running' | 'completed' | 'error'>('initializing');
  const [exitCode, setExitCode] = useState<number | null>(null);

  // 清理函数
  const cleanup = useCallback(() => {
    unsubscribeDataRef.current?.();
    unsubscribeExitRef.current?.();
    if (sessionIdRef.current) {
      window.neox?.terminalDestroy?.(sessionIdRef.current);
      sessionIdRef.current = null;
    }
  }, []);

  // 完成执行
  const completeExecution = useCallback((code: number, error?: string) => {
    if (isCompletedRef.current) return;
    isCompletedRef.current = true;

    setStatus(error ? 'error' : 'completed');
    setExitCode(code);

    // 延迟一点点再返回结果，让用户看到最后的输出
    setTimeout(() => {
      onComplete(request.requestId, {
        output: outputRef.current,
        exitCode: code,
        error,
      });
    }, 500);
  }, [request.requestId, onComplete]);

  // 初始化终端并执行命令
  useEffect(() => {
    if (!terminalRef.current) return;

    // 创建 xterm 实例
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", "Fira Code", "Consolas", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#eaeaea',
        cursor: '#f39c12',
        cursorAccent: '#1a1a2e',
        selectionBackground: 'rgba(243, 156, 18, 0.3)',
        black: '#1a1a2e',
        red: '#e74c3c',
        green: '#2ecc71',
        yellow: '#f1c40f',
        blue: '#3498db',
        magenta: '#9b59b6',
        cyan: '#1abc9c',
        white: '#ecf0f1',
        brightBlack: '#7f8c8d',
        brightRed: '#e74c3c',
        brightGreen: '#2ecc71',
        brightYellow: '#f1c40f',
        brightBlue: '#3498db',
        brightMagenta: '#9b59b6',
        brightCyan: '#1abc9c',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(terminalRef.current);
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // 延迟 fit 并开始执行
    setTimeout(async () => {
      try {
        fitAddon.fit();
      } catch {}

      // 显示命令信息
      terminal.writeln('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
      terminal.writeln((zh ? `\x1b[33m▸ 工作目录:\x1b[0m ${request.cwd}` : `\x1b[33m▸ Working dir:\x1b[0m ${request.cwd}`));
      terminal.writeln((zh ? `\x1b[33m▸ 执行命令:\x1b[0m ${request.command}` : `\x1b[33m▸ Command:\x1b[0m ${request.command}`));
      terminal.writeln('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
      terminal.writeln('');

      try {
        // 创建终端会话
        const result = await window.neox?.terminalCreate?.({ cwd: request.cwd });
        if (!result?.sessionId) {
          throw new Error('Failed to create terminal session');
        }

        const terminalSessionId = result.sessionId;
        sessionIdRef.current = terminalSessionId;
        setStatus('running');

        // 订阅终端输出
        unsubscribeDataRef.current = window.neox?.onTerminalData?.((event) => {
          if (event.sessionId === terminalSessionId && xtermRef.current) {
            xtermRef.current.write(event.data);
            outputRef.current += event.data;
          }
        }) || null;

        // 订阅终端退出
        unsubscribeExitRef.current = window.neox?.onTerminalExit?.((event) => {
          if (event.sessionId === terminalSessionId) {
            terminal.writeln('');
            terminal.writeln('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
            if (event.exitCode === 0) {
              terminal.writeln((zh ? `\x1b[32m✓ 命令执行完成 (退出码: ${event.exitCode})\x1b[0m` : `\x1b[32m✓ Command finished (exit ${event.exitCode})\x1b[0m`));
            } else {
              terminal.writeln((zh ? `\x1b[31m✗ 命令执行完成 (退出码: ${event.exitCode})\x1b[0m` : `\x1b[31m✗ Command failed (exit ${event.exitCode})\x1b[0m`));
            }
            terminal.writeln('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');

            completeExecution(event.exitCode);
          }
        }) || null;

        // 监听用户输入（主要用于 Ctrl+C 中断）
        terminal.onData((data) => {
          if (sessionIdRef.current) {
            window.neox?.terminalWrite?.(sessionIdRef.current, data);
          }
        });

        // 执行命令
        window.neox?.terminalWrite?.(terminalSessionId, request.command + '\n');

        // 命令执行完成后需要 exit 来触发退出
        // 我们包装命令让它在完成后自动退出
        setTimeout(() => {
          if (sessionIdRef.current && !isCompletedRef.current) {
            // 发送 exit 命令来结束 shell 会话
            window.neox?.terminalWrite?.(sessionIdRef.current, '\nexit\n');
          }
        }, 100);

      } catch (error: any) {
        terminal.writeln((zh ? `\x1b[31m错误: ${error.message}\x1b[0m` : `\x1b[31mError: ${error.message}\x1b[0m`));
        completeExecution(1, error.message);
      }
    }, 50);

    // 窗口大小变化处理
    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
          if (sessionIdRef.current) {
            window.neox?.terminalResize?.(sessionIdRef.current, xtermRef.current.cols, xtermRef.current.rows);
          }
        } catch {}
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
      cleanup();
    };
  }, [request, completeExecution, cleanup]);

  // 手动取消/中断
  const handleCancel = useCallback(() => {
    if (sessionIdRef.current) {
      // 发送 Ctrl+C
      window.neox?.terminalWrite?.(sessionIdRef.current, '\x03');
      setTimeout(() => {
        if (!isCompletedRef.current) {
          completeExecution(130, 'User cancelled');
          onCancel?.(request.requestId);
        }
      }, 1000);
    }
  }, [request.requestId, completeExecution, onCancel]);

  return (
    <div
      className={`terminal-execution-panel ${className}`}
      style={{
        height,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: '8px',
        border: '1px solid var(--border-color, #333)',
        background: '#1a1a2e',
      }}
    >
      {/* Header */}
      <div
        className="terminal-execution-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-color, #333)',
          background: '#252542',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icons.Terminal style={{ width: 16, height: 16, color: '#f39c12' }} />
          <span style={{ color: '#eaeaea', fontSize: '13px', fontWeight: 500 }}>
            终端执行
          </span>
          {status === 'running' && (
            <span style={{
              color: '#2ecc71',
              fontSize: '12px',
              animation: 'pulse 1.5s infinite',
            }}>
              ● 运行中
            </span>
          )}
          {status === 'completed' && exitCode === 0 && (
            <span style={{ color: '#2ecc71', fontSize: '12px' }}>{zh ? '✓ 完成' : '✓ Done'}</span>
          )}
          {status === 'completed' && exitCode !== 0 && (
            <span style={{ color: '#e74c3c', fontSize: '12px' }}>{zh ? '✗ 退出码: ' : '✗ Exit code: '}{exitCode}</span>
          )}
          {status === 'error' && (
            <span style={{ color: '#e74c3c', fontSize: '12px' }}>{zh ? '✗ 错误' : '✗ Error'}</span>
          )}
        </div>

        {status === 'running' && (
          <button
            onClick={handleCancel}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 8px',
              background: '#e74c3c',
              border: 'none',
              borderRadius: '4px',
              color: 'white',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            <Icons.Stop style={{ width: 12, height: 12 }} />
            中断
          </button>
        )}
      </div>

      {/* Terminal */}
      <div
        ref={terminalRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          padding: '8px',
        }}
      />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
};

export default TerminalExecutionPanel;
