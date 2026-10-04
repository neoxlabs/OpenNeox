import type { ToolCapabilitySet } from '@neoxlabs/kernel/types/index.js';

export const nodeToolCapabilities: ToolCapabilitySet = {
  terminal: true,
  editor: false,
  debug: true,
  trace: true,
  gui: false,
};

/**
 * Electron 桌面应用能力集 — 全开.
 */
export const electronToolCapabilities: ToolCapabilitySet = {
  ...nodeToolCapabilities,
  editor: true,
  gui: true,
};
