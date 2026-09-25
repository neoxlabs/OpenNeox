/**
 * @openneox/devtools — development and diagnostics monitor (not part of the
 * default desktop build).
 *
 * 两种用法:
 *   1) 进程外纯订阅(零产品改动):MonitorClient + MonitorAggregator
 *   2) in-process 深度 attach(测试构建 __NEOX_DEVTOOLS__=true):attachMonitor
 */

export { MonitorAggregator } from './aggregator.js';
export { MonitorClient, type MonitorClientOptions } from './monitorClient.js';
export { attachMonitor, attachMonitorToEventBus, type AttachOptions, type AttachBusOptions, type AttachedMonitor, type RuntimeEventHubLike, type EventBusLike } from './attach.js';
export { serve, startDashboardServer } from './serve.js';
export {
  discoverEndpoint,
  discoverEndpoints,
  parseManualTarget,
  buildWsUrl,
} from './discovery.js';
export { renderDashboard, paint } from './render/terminalDashboard.js';
export {
  emptyMonitorState,
  type MonitorState,
  type SessionMonitor,
  type AgentNode,
  type MonitorAlert,
  type MonitorMetrics,
  type ControlPlaneSnapshot,
  type ServerEndpoint,
  type RenderState,
} from './types.js';
