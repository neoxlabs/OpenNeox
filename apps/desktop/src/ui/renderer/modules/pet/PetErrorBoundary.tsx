/**
 * PetErrorBoundary — 桌宠 3D 渲染错误兜底
 *
 * Three.js / .glb 加载 / WebGL 上下文创建 出错时, 不让整个 React 树挂掉.
 * 把错误显示成一个 emoji + 文字 fallback, 用户至少能看到桌宠是"出问题了",
 * 不是"什么都没发生".
 *
 * 同时把错误打到 console + 一份 onError 回调让父组件能上报.
 */

import React from 'react';
import { getGlobalLanguage } from '../../hooks/useI18n';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (err: Error) => void;
}

interface State {
  error: Error | null;
}

export class PetErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[PetErrorBoundary] caught:', error, errorInfo);
    this.props.onError?.(error);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            background: 'rgba(20, 20, 24, 0.85)',
            color: '#fff',
            fontSize: 12,
            padding: 8,
            borderRadius: 8,
            textAlign: 'center',
            lineHeight: 1.4,
          }}
          title={this.state.error.message}
        >
          <div style={{ fontSize: 32, marginBottom: 4 }}>⚠️</div>
          <div style={{ opacity: 0.9 }}>{getGlobalLanguage() === 'zh' ? '3D 加载失败' : 'Failed to load 3D'}</div>
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4, maxWidth: 200, wordBreak: 'break-word' }}>
            {this.state.error.message.slice(0, 80)}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default PetErrorBoundary;
