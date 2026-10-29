/**
 * Plugin View Registry — 插件贡献的 UI 面板登记表
 *
 * 主进程持有真相, 渲染进程通过 IPC 查询后渲染 iframe.
 * 目前只负责 "声明与查询", 不负责真正加载 HTML — 渲染侧 (AppShell) 用本表结果
 * 在自己维护的容器里挂 iframe, 指向 neox-plugin:// 协议 URL.
 *
 * 事件: onChange 通知订阅者 (AppShell 监听以热刷)
 */

import * as path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { PluginViewDefinition, PluginViewLocation } from '@neoxlabs/platform/shared/plugin-types.js';

export interface RegisteredPluginView extends PluginViewDefinition {
  /** 所属插件 */
  pluginName: string;
  /** 展开后的绝对 entry 路径 (主进程可读, 渲染侧不应依赖) */
  absoluteEntry: string;
  /** 图标若为文件, 返回其绝对路径; 否则为 undefined */
  absoluteIcon?: string;
  /** 插件安装目录 (用于 neox-plugin:// 协议解析根) */
  installDir: string;
}

export type PluginViewChangeListener = () => void;

export class PluginViewRegistry {
  private views: RegisteredPluginView[] = [];
  private listeners = new Set<PluginViewChangeListener>();

  /** 注册某插件的所有 views. 同一插件再次调用会先反注册旧条目 (支持热重载). */
  registerPluginViews(params: {
    pluginName: string;
    installDir: string;
    views: PluginViewDefinition[];
  }): number {
    const { pluginName, installDir, views } = params;
    if (!Array.isArray(views) || views.length === 0) return 0;

    this.unregisterPlugin(pluginName, false);

    let added = 0;
    const seenIds = new Set<string>();
    for (const def of views) {
      if (!def?.id || !def.title || !def.entry || !def.location) {
        cliLogger.warn('PLUGIN_VIEW', `[${pluginName}] invalid view definition (missing id/title/entry/location)`);
        continue;
      }
      if (seenIds.has(def.id)) {
        cliLogger.warn('PLUGIN_VIEW', `[${pluginName}] duplicate view id "${def.id}"`);
        continue;
      }
      seenIds.add(def.id);

      const absoluteEntry = path.posix.resolve(installDir, def.entry);
      let absoluteIcon: string | undefined;
      if (def.icon && !isEmojiIcon(def.icon)) {
        absoluteIcon = path.posix.resolve(installDir, def.icon);
      }

      this.views.push({
        ...def,
        pluginName,
        installDir,
        absoluteEntry,
        absoluteIcon,
      });
      added++;
    }

    if (added > 0) this.emitChange();
    return added;
  }

  /** 反注册某插件所有 views */
  unregisterPlugin(pluginName: string, emit = true): number {
    const before = this.views.length;
    this.views = this.views.filter(v => v.pluginName !== pluginName);
    const removed = before - this.views.length;
    if (removed > 0 && emit) this.emitChange();
    return removed;
  }

  /** 列出全部 views */
  list(): ReadonlyArray<RegisteredPluginView> {
    return this.views;
  }

  /** 按 location 过滤 */
  listByLocation(location: PluginViewLocation): RegisteredPluginView[] {
    return this.views.filter(v => v.location === location);
  }

  /** 按 id 查找 */
  findById(id: string): RegisteredPluginView | undefined {
    return this.views.find(v => v.id === id);
  }

  /** 订阅变更 (返回取消订阅函数) */
  onChange(listener: PluginViewChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 序列化 (供 IPC 返回给渲染进程; 绝对路径只保留 pluginName+相对 entry) */
  serialize(): Array<{
    pluginName: string;
    id: string;
    title: string;
    location: PluginViewLocation;
    icon?: string;
    iconIsEmoji: boolean;
    entry: string;
    when?: string;
    preferredSize?: { width?: number; height?: number };
  }> {
    return this.views.map(v => ({
      pluginName: v.pluginName,
      id: v.id,
      title: v.title,
      location: v.location,
      icon: v.icon,
      iconIsEmoji: isEmojiIcon(v.icon ?? ''),
      entry: v.entry,
      when: v.when,
      preferredSize: v.preferredSize,
    }));
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (err: any) {
        cliLogger.debug('PLUGIN_VIEW', `onChange listener error: ${err?.message}`);
      }
    }
  }
}

function isEmojiIcon(icon: string): boolean {
  // Very rough heuristic: no extension, short, no path separator
  if (!icon) return false;
  if (icon.includes('/') || icon.includes('\\')) return false;
  if (icon.includes('.')) return false;
  return [...icon].length <= 4;
}

export const pluginViewRegistry = new PluginViewRegistry();
