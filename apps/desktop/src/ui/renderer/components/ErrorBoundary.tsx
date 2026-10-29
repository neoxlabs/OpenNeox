import React from 'react';
import { getGlobalLanguage } from '../hooks/useI18n';

/**
 * ErrorBoundary — 顶层 React 错误兜底.
 *
 *   优雅原则:
 *     · 中文文案, 国内用户主战场
 *     · 不直接展示 stack trace (可能含 API URL / 文件路径), 默认折叠, 用户主动展开才看
 *     · 给三个出口: 重新加载 (主操作) / 复制错误码 (反馈给客服) / 展开技术细节 (调试)
 *     · 不留客服联系方式硬编码, 走"复制错误码 + 引导用户在群/邮箱反馈"路径
 */

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  showStack: boolean;
  copied: boolean;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, showStack: false, copied: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, showStack: false, copied: false };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleCopyError = () => {
    const { error } = this.state;
    if (!error) return;
    const text = `${error.message}\n\n${error.stack ?? ''}`;
    navigator.clipboard.writeText(text)
      .then(() => {
        this.setState({ copied: true });
        setTimeout(() => this.setState({ copied: false }), 2000);
      })
      .catch((err) => {
        console.warn('[ErrorBoundary] copy to clipboard failed:', err);
      });
  };

  toggleStack = () => {
    this.setState((s) => ({ showStack: !s.showStack }));
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { error, showStack, copied } = this.state;
    /* class 组件用不了 hook —— 直接读全局语言(useI18n 的同一份 source of truth).
     * 崩溃页不需要响应语言切换: 它出现时用户马上要重载。 */
    const zh = getGlobalLanguage() === 'zh';

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: 'var(--bg-primary, #1e2030)',
          color: 'var(--text-primary, #eef0f6)',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          padding: '2rem',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: '100%',
            background: 'var(--bg-tertiary, #262840)',
            border: '1px solid var(--border-default, rgba(255,255,255,0.14))',
            borderRadius: 'var(--radius-md, 10px)',
            padding: '2rem',
            boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.6))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '0 0 0.75rem' }}>
            <span style={{ fontSize: '1.4rem', lineHeight: 1 }} aria-hidden>⚠️</span>
            <h2 style={{ margin: 0, fontSize: '1.25rem' }}>{zh ? '应用遇到问题' : 'Something went wrong'}</h2>
          </div>
          <p
            style={{
              color: 'var(--text-secondary, #a8adc0)',
              fontSize: '0.875rem',
              margin: '0 0 1.25rem',
              lineHeight: 1.5,
            }}
          >
            {zh
              ? '点「重新加载」通常能恢复。如果反复出现,请点「复制错误信息」反馈给我们。'
              : 'Reloading usually fixes this. If it keeps happening, hit "Copy error details" and send it to us.'}
          </p>

          {/* 错误简要 — 一行, 不展示 stack */}
          {error?.message && (
            <div
              style={{
                background: 'var(--bg-code, #1a1c28)',
                color: 'var(--text-tertiary, #b8bdd1)',
                fontSize: '0.8rem',
                padding: '0.6rem 0.8rem',
                borderRadius: 'var(--radius-sm, 6px)',
                margin: '0 0 1rem',
                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
                wordBreak: 'break-word',
                /* 防长 message 撑爆 — 4 行内, 用户想看全打开"技术细节" */
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {error.message}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              onClick={this.handleReload}
              style={{
                padding: '0.55rem 1.4rem',
                borderRadius: 'var(--radius-sm, 6px)',
                border: 'none',
                background: '#3b82f6',
                color: '#fff',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {zh ? '重新加载' : 'Reload'}
            </button>
            <button
              onClick={this.handleCopyError}
              style={{
                padding: '0.55rem 1.2rem',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--border-default, rgba(255,255,255,0.14))',
                background: 'transparent',
                color: 'var(--text-secondary, #a8adc0)',
                fontSize: '0.875rem',
                cursor: 'pointer',
                transition: 'color 0.15s',
              }}
            >
              {copied ? (zh ? '✓ 已复制' : '✓ Copied') : (zh ? '复制错误信息' : 'Copy error details')}
            </button>
            {error?.stack && (
              <button
                onClick={this.toggleStack}
                style={{
                  padding: '0.55rem 0.8rem',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-tertiary, #737994)',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                {showStack ? (zh ? '收起技术细节' : 'Hide technical details') : (zh ? '展开技术细节' : 'Show technical details')}
              </button>
            )}
          </div>

          {/* 技术细节 — 默认折叠, 不让 stack 主动暴露给用户 (可能含敏感路径 / API URL) */}
          {showStack && error?.stack && (
            <pre
              style={{
                background: 'var(--bg-code, #1a1c28)',
                color: 'var(--text-tertiary, #737994)',
                fontSize: '0.72rem',
                padding: '0.75rem',
                borderRadius: 'var(--radius-sm, 6px)',
                overflow: 'auto',
                maxHeight: 200,
                margin: '1rem 0 0',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
              }}
            >
              {error.stack}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
