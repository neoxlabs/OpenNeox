/**
 * TerminalViewer Component
 *
 * 在 Timeline 卡片中显示终端输出的组件
 * 使用 xterm.js 提供真实的终端体验
 */

import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalViewerProps {
  terminalSessionId: string;
  initialOutput?: string;  // 初始输出（如果有）
  className?: string;
}

export const TerminalViewer: React.FC<TerminalViewerProps> = ({
  terminalSessionId,
  initialOutput,
  className = '',
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // 创建 xterm 实例
    const terminal = new Terminal({
      cursorBlink: false,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
      convertEol: true,
      disableStdin: true,  // 只读模式
      rows: 20,
      cols: 80,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // 如果有初始输出，写入终端
    if (initialOutput) {
      terminal.write(initialOutput);
    }

    // 监听来自主进程的终端输出
    const handleTerminalData = (data: { sessionId: string; data: string }) => {
      if (data.sessionId === terminalSessionId && xtermRef.current) {
        xtermRef.current.write(data.data);
      }
    };

    const handleTerminalExit = (data: { sessionId: string; exitCode: number }) => {
      if (data.sessionId === terminalSessionId && xtermRef.current) {
        xtermRef.current.write(`\r\n\r\n[Process exited with code ${data.exitCode}]\r\n`);
      }
    };

    // 订阅终端事件
    const unsubscribeData = window.neox?.onTerminalData?.(handleTerminalData);
    const unsubscribeExit = window.neox?.onTerminalExit?.(handleTerminalExit);

    // 窗口大小变化时调整终端大小
    const handleResize = () => {
      fitAddonRef.current?.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      unsubscribeData?.();
      unsubscribeExit?.();
      terminal.dispose();
    };
  }, [terminalSessionId, initialOutput]);

  return (
    <div className={`terminal-viewer ${className}`}>
      <div ref={terminalRef} className="terminal-container" />
    </div>
  );
};

export default TerminalViewer;
