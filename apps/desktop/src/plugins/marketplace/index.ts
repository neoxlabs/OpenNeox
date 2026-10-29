/**
 * 官方市场 —— 只在商业发行版里存在 (公开树排除整个目录)。
 *
 * 共享代码不 import 这里; 需要市场能力的地方通过 pluginInstallSources /
 * registerPluginSubcommand / 主进程发行版入口 (ui/electron/mainEdition.ts) 拿到注册进来的实现。
 */
export { MarketplaceClient, createDefaultMarketplaceClient } from './marketplaceClient.js';
export type { MarketplaceConfig, SearchOptions, SearchResult } from './marketplaceClient.js';
export { marketplaceCache } from './marketplaceCache.js';
export { checkForUpdates, formatUpdateNotice } from './updateChecker.js';
export type { UpdateInfo } from './updateChecker.js';
export { installFromMarketplace, checkAllPluginUpdates, semverLess } from './marketplaceInstaller.js';
export type { PluginUpdateCheckResult } from './marketplaceInstaller.js';
/* 主进程接线 (registerOfficialMarketplace*) 顶层 import 了 electron, 不从这里导出 ——
 * 直接引 ./registerOfficialMarketplace.js。 */
