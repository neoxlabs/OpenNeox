/**
 * Tab component barrel exports.
 * All tabs are lazy-loaded via React.lazy in SettingsPage.tsx
 */
export { default as ProvidersTab } from './ProvidersTab';
export { default as RoutingTab } from './RoutingTab';
export { default as OrchestratorTab } from './OrchestratorTab';
export { default as AgentTab } from './AgentTab';
export { default as McpTab } from './McpTab';
export { default as SkillsTab } from './SkillsTab';
export { default as MemoryTab } from './MemoryTab';
export { default as BrowserTab } from './BrowserTab';
export { default as ContextTab } from './ContextTab';
/* RemoteTab 删除 — 老占位 (Coming Soon, 服务端没接), 替换为 MobileBridgeTab (真实施). */
export { default as StorageTab } from './StorageTab';
export { default as UsageTab } from './UsageTab';
export { default as ModelProfileTab } from './ModelProfileTab';
export { default as AboutTab } from './AboutTab';
export { default as ProcessesTab } from './ProcessesTab';
export { default as TtsTab } from './TtsTab';
export { default as ExperimentalTab } from './ExperimentalTab';
/* PerceptionTab 删除 — Perception 功能已从 UI 与代码移除 (主进程从无 config:get/set-perception handler). */
export { default as RunconfigTab } from './RunconfigTab';
export { default as KeymapTab } from './KeymapTab';
export { default as EditorTab } from './EditorTab';
