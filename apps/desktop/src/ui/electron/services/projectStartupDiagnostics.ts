import * as path from 'path';
import { performance } from 'perf_hooks';

const ACTIVE_WINDOW_MS = 120_000;
const SAMPLE_INTERVAL_MS = 1_000;
const WARN_THRESHOLD_MS = 250;

const registry = new Map<string, ProjectStartupDiagnostics>();

export function getProjectStartupDiagnostics(workspaceRoot: string): ProjectStartupDiagnostics {
  const existing = registry.get(workspaceRoot);
  if (existing) return existing;

  const diagnostics = new ProjectStartupDiagnostics(workspaceRoot);
  registry.set(workspaceRoot, diagnostics);
  return diagnostics;
}

export class ProjectStartupDiagnostics {
  private readonly workspaceName: string;
  private readonly startedAt = Date.now();
  private readonly phaseStarts = new Map<string, number>();
  private lastSampleAt = performance.now();
  private interval: NodeJS.Timeout | null = null;
  private lagWarnings = 0;

  constructor(private readonly workspaceRoot: string) {
    this.workspaceName = path.basename(workspaceRoot) || workspaceRoot;
    this.log('startup-monitor-active');
    this.interval = setInterval(() => this.sampleLag(), SAMPLE_INTERVAL_MS);
    this.interval.unref();
  }

  markPhaseStart(phase: string, details?: object): void {
    this.phaseStarts.set(phase, Date.now());
    this.log(`${phase}:start`, details);
  }

  markPhaseEnd(phase: string, details?: object): void {
    const startedAt = this.phaseStarts.get(phase);
    this.phaseStarts.delete(phase);
    this.log(`${phase}:done`, {
      elapsedMs: startedAt ? Date.now() - startedAt : undefined,
      ...details,
    });
  }

  log(event: string, details?: object): void {
    console.info('[StartupDiagnostics]', {
      workspace: this.workspaceName,
      event,
      uptimeMs: Date.now() - this.startedAt,
      ...details,
    });
  }

  private sampleLag(): void {
    const now = performance.now();
    const lagMs = now - this.lastSampleAt - SAMPLE_INTERVAL_MS;
    this.lastSampleAt = now;

    if (Date.now() - this.startedAt >= ACTIVE_WINDOW_MS) {
      this.stop();
      return;
    }

    if (lagMs >= WARN_THRESHOLD_MS && this.lagWarnings < 12) {
      this.lagWarnings += 1;
      this.log('event-loop-lag', { lagMs: Math.round(lagMs) });
    }
  }

  private stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    registry.delete(this.workspaceRoot);
  }
}
