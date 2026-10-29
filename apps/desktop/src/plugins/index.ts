/**
 * Plugin System — 模块导出
 */

// Types
export type {
  PluginManifest,
  PluginAuthor,
  PluginCategory,
  PluginPermissions,
  PluginDependencies,
  PluginConfigField,
  PluginHookConfig,
  PluginHookEntry,
  PluginMcpServerConfig,
  InstalledPlugin,
  PluginSource,
  PluginRegistryData,
  MarketplacePlugin,
  MarketplacePluginSource,
  PluginLoadResult,
  PluginEvent,
  PluginEventType,
  PluginEventCallback,
} from '@neoxlabs/platform/shared/plugin-types.js';

// Registry
export { PluginRegistry, pluginRegistry } from './pluginRegistry.js';

// Loader
export { loadManifest, loadPlugin, loadAllPlugins } from './pluginLoader.js';
export type { PluginInjectors } from './pluginLoader.js';

// Manager
export {
  installFromPath,
  installFromUrl,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  getPluginInfo,
  listPlugins,
  devLoadPlugin,
} from './pluginManager.js';

// Packaging (.neox-plugin)
export {
  packPlugin,
  installFromFile,
  verifyExtractedPack,
  generateSigningKeypair,
  PACK_EXTENSION,
  PACK_FORMAT,
} from './pluginPackager.js';
export type { PackManifest, PackResult, VerifyResult, ImportResult, TrustLevel } from './pluginPackager.js';

// Connector (声明式第三方平台接入)
export {
  connectorRegistry,
  validateConnector,
  evaluateGate,
  executeCapability,
  saveCredential,
  loadCredential,
  deleteCredential,
  hasCredential,
  getConnection,
  setConnection,
  clearConnection,
  grantStore,
  budgetStore,
  setGrants,
  getGrants,
  revokeGrants,
  setBudget,
  getBudgetState,
  newPermissionsSince,
} from './connector/index.js';
export type {
  RegisteredConnector,
  GateContext,
  GateDecision,
  GateDenial,
  ExecuteResult,
  Credential,
} from './connector/index.js';

// External Agents (委派给本机其它 agent CLI)
export {
  externalAgentRegistry,
  validateExternalAgents,
  delegateToExternalAgent,
  detectExternalAgent,
} from './externalAgent/index.js';
export type {
  RegisteredExternalAgent,
  ExternalAgentHostHooks,
  DelegateResult,
} from './externalAgent/index.js';

// Security
export { validateManifest, scanPluginDirectory, checkRuntimePermission } from './pluginSecurity.js';

// CLI
export { handlePluginCommand } from './cli/pluginCommands.js';

// Integration
export { createPluginInjectors, bootstrapPlugins, activatePluginRuntime, disablePluginRuntime, installExternalAgentHostHooks } from './pluginIntegration.js';
export { pluginAuthRegistry, linkedProviderIdFor } from './pluginAuthRegistry.js';
export type { RegisteredAuthProvider, AuthProviderLike } from './pluginAuthRegistry.js';
export { registerPluginInstallSource, getPluginInstallSource } from './pluginInstallSources.js';
export type { PluginInstallSource } from './pluginInstallSources.js';
export { registerPluginSubcommand, registerPluginHelp } from './cli/pluginCommands.js';

/* 官方市场 (客户端 / 缓存 / 更新检查 / 按目录安装) 的导出在 ./marketplace/index.ts ——
 * 那个目录不随公开树导出, 这里引它会让公开树编译不过。 */
