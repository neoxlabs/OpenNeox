/**
 * TerminalRequestManager - 终端请求管理器
 *
 * 监听主进程的终端执行请求，为每个请求创建独立的终端面板
 */

import { useI18n } from '../../../hooks/useI18n';
import React, { useEffect, useState, useCallback, Suspense } from 'react';
import type { TerminalRequest } from './TerminalExecutionPanel';
import { runInAgentTerminal } from '../agentTerminalBridge';

/* TerminalExecutionPanel 静态引 @xterm/xterm + css — 懒加载让 xterm 不进首屏 main chunk,
 * 只在真的来了终端执行请求时才拉取 (type import 会被类型擦除, 不影响)。 */
const TerminalExecutionPanel = React.lazy(() => import('./TerminalExecutionPanel'));

interface TerminalRequestManagerProps {
  className?: string;
}

const TerminalRequestManager: React.FC<TerminalRequestManagerProps> = ({
  className = '',
}) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [requests, setRequests] = useState<TerminalRequest[]>([]);

  useEffect(() => {
    const unsubscribe = window.neox?.onTerminalRequest?.((data: TerminalRequest) => {
      const viaTerminal = runInAgentTerminal(data);
      if (viaTerminal) {
        void viaTerminal
          .then((r) => window.neox?.terminalRequestComplete?.(data.requestId, r))
          .catch((e: unknown) => window.neox?.terminalRequestComplete?.(data.requestId, {
            output: '', exitCode: 1, error: e instanceof Error ? e.message : String(e),
          }));
        return;
      }
      setRequests(prev => [...prev, data]);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  // 处理执行完成
  const handleComplete = useCallback((requestId: string, result: { output: string; exitCode: number; error?: string }) => {
    // 通知主进程执行完成
    window.neox?.terminalRequestComplete?.(requestId, result);

    // 延迟移除面板，让用户看到结果
    setTimeout(() => {
      setRequests(prev => prev.filter(r => r.requestId !== requestId));
    }, 2000);
  }, []);

  // 处理取消 — 面板自行关闭, 此处无需额外处理
  const handleCancel = useCallback((_requestId: string) => {
    /* no-op */
  }, []);

  if (requests.length === 0) {
    return null;
  }

  return (
    <div
      className={`terminal-request-manager ${className}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '12px',
        background: 'var(--bg-secondary, #1e1e2e)',
        borderTop: '1px solid var(--border-color, #333)',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        color: 'var(--text-secondary, #888)',
        fontSize: '12px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        <span>{zh ? `🖥️ 终端执行 (${requests.length})` : `🖥️ Terminal runs (${requests.length})`}</span>
      </div>

      <Suspense fallback={null}>
        {requests.map((request) => (
          <TerminalExecutionPanel
            key={request.requestId}
            request={request}
            onComplete={handleComplete}
            onCancel={handleCancel}
            height={300}
          />
        ))}
      </Suspense>
    </div>
  );
};

export default TerminalRequestManager;
