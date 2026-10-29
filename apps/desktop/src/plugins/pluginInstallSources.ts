/**
 * 额外的插件安装源 —— 本地目录 / URL / .neox-plugin 之外的来源由发行版注册。
 *
 * 共享代码 (IPC 的 INSTALL / PREFLIGHT、/plugins install --<source>) 只认这张表,
 * 不 import 任何具体的市场实现: 官方市场住在不随公开树导出的目录里, 由主进程的
 * 发行版入口 (ui/electron/mainEdition.ts) 在启动时注册进来。
 *
 * 没注册 = 这个发行版没有该来源。调用方要把它当成明确的"不支持", 不能静默当成功。
 */
import type { InstallResult } from './pluginManager.js';

export interface PluginInstallSource {
  /** 按名字 (或该来源自己的标识) 安装。 */
  install(nameOrId: string): Promise<InstallResult>;
  /** 安装前只读取清单, 给权限确认弹窗用; 读不到回 null。 */
  readManifest(nameOrId: string): Promise<unknown | null>;
}

const sources = new Map<string, PluginInstallSource>();

export function registerPluginInstallSource(id: string, source: PluginInstallSource): void {
  sources.set(id, source);
}

export function getPluginInstallSource(id: string): PluginInstallSource | undefined {
  return sources.get(id);
}
