/**
 * PluginPermissionDialog — 安装前弹框, 列出插件请求的权限让用户确认.
 *
 * 在 install() 真正下载 / 复制之前调 pluginPreflight() 拿 manifest 摘要,
 * 把权限清单 + 贡献组件 展示给用户. 用户点 "Install" 才继续.
 */

import { useI18n } from '../../../hooks/useI18n';
import React from 'react';
import { ConfirmDialog } from '../../../components/FileDialogs.js';

export interface PluginPermissionItem {
  text: string;
  /** 主进程按权限种类标的 (网络 / 写入 / 调工具 / 连接器的写能力), 渲染端不再靠中文关键词猜 */
  sensitive: boolean;
}

export interface PluginPermissionInfo {
  name?: string;
  version?: string;
  description?: string;
  author?: { name?: string };
  permissions: PluginPermissionItem[];
  components: string[];
}

/** pluginPreflight 的返回 → 弹框数据; 读不到清单回 null (调用方直接装, 不弹框) */
export function toPermissionInfo(info: any): PluginPermissionInfo | null {
  if (!info?.available) return null;
  return {
    name: info.manifest?.name,
    version: info.manifest?.version,
    description: info.manifest?.description,
    author: info.manifest?.author,
    permissions: ((info.permissions ?? []) as unknown[]).map((p) =>
      typeof p === 'string' ? { text: p, sensitive: true } : (p as PluginPermissionItem)),
    components: (info.components ?? []) as string[],
  };
}

interface Props {
  visible: boolean;
  info: PluginPermissionInfo | null;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export const PluginPermissionDialog: React.FC<Props> = ({ visible, info, onConfirm, onClose }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  if (!visible || !info) return null;

  const hasSensitive = info.permissions.some(p => p.sensitive);

  const title = info.name ? (zh ? `安装插件: ${info.name}` : `Install plugin: ${info.name}`) : (zh ? '安装插件' : 'Install plugin');
  const description = (
    <div style={{ fontSize: 12 }}>
      {info.version && (
        <div style={{ marginBottom: 6, color: '#8a8e96' }}>
          {info.version}{info.author?.name ? ` · ${info.author.name}` : ''}
        </div>
      )}
      {info.description && (
        <div style={{ marginBottom: 10, color: '#bcbec4' }}>{info.description}</div>
      )}

      {info.components.length > 0 && (
        <>
          <div style={{ fontWeight: 600, color: '#bcbec4', marginBottom: 4 }}>{zh ? '将贡献:' : 'Provides:'}</div>
          <ul style={{ margin: '0 0 10px 16px', padding: 0 }}>
            {info.components.map((c, i) => (
              <li key={i} style={{ color: '#bcbec4' }}>{c}</li>
            ))}
          </ul>
        </>
      )}

      <div style={{ fontWeight: 600, color: '#bcbec4', marginBottom: 4 }}>{zh ? '请求权限:' : 'Requests permissions:'}</div>
      {info.permissions.length === 0 ? (
        <div style={{ color: '#6aab73' }}>{zh ? '无敏感权限需求' : 'No sensitive permissions'}</div>
      ) : (
        <ul style={{ margin: '0 0 4px 16px', padding: 0 }}>
          {info.permissions.map((p, i) => (
            <li key={i} style={{ color: p.sensitive ? '#e8a33b' : '#bcbec4' }}>{p.text}</li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <ConfirmDialog
      visible={visible}
      title={title}
      message={zh ? '确认这些权限后继续安装?' : 'Review these permissions before installing.'}
      description={description}
      variant={hasSensitive ? 'danger' : 'default'}
      confirmLabel={zh ? '安装' : 'Install'}
      cancelLabel={zh ? '取消' : 'Cancel'}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
};
