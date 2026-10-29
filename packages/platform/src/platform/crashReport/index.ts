
export type {
  CrashKind,
  CrashApp,
  CrashProcessRole,
  CrashReportPayload,
} from './types.js';
export { CRASH_LIMITS } from './types.js';

export {
  maskSecrets,
  scrubPaths,
  sanitizeText,
  truncateMessage,
  normalizeStack,
  firstMeaningfulFrame,
  computeDedupeKey,
} from './sanitize.js';

export { RateLimiter } from './dedupe.js';
export { CrashQueue, type QueuedCrashReport } from './queue.js';
export {
  parseIps,
  findNativeCrashReports,
  defaultDiagnosticReportsDir,
  type NativeCrashInfo,
} from './ips.js';
export {
  writeRunMarker,
  clearRunMarker,
  isPidAlive,
  readRunMarkers,
  detectAbnormalExits,
  type RunMarker,
} from './runMarker.js';

export {
  CrashReporter,
  installCrashReporter,
  getCrashReporter,
  isCrashReportEnabled,
  readOrCreateInstallId,
  type CrashReporterOptions,
} from './reporter.js';
