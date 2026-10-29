import type { ApprovalMode, NeoxConfig } from '@neoxlabs/platform/utils/config.js';

function normalizeScopeKey(scopeKey: string): string {
  return scopeKey.trim().toLowerCase();
}

function forcedModeFromEnv(): ApprovalMode | null {
  const raw = (process.env.NEOX_FORCE_APPROVAL_MODE ?? '').trim().toLowerCase();
  if (raw === 'manual' || raw === 'auto' || raw === 'dangerous') return raw as ApprovalMode;
  return null;
}

export class ApprovalModeResolver {
  private globalMode: ApprovalMode;
  private scopedModes: Map<string, ApprovalMode>;
  private readonly configScopeKeys: Set<string>;
  private readonly forcedMode: ApprovalMode | null = forcedModeFromEnv();

  constructor(config: Pick<NeoxConfig, 'agentApprovalMode' | 'approvalMode' | 'agentApprovalScopes'>) {
    this.globalMode = config.agentApprovalMode || config.approvalMode || 'auto';
    this.scopedModes = new Map(
      Object.entries(config.agentApprovalScopes || {}).map(([scopeKey, mode]) => [
        normalizeScopeKey(scopeKey),
        mode,
      ]),
    );
    this.configScopeKeys = new Set(this.scopedModes.keys());
  }

  getGlobalMode(): ApprovalMode {
    return this.forcedMode ?? this.globalMode;
  }

  setGlobalMode(mode: ApprovalMode): void {
    this.globalMode = mode;
  }

  setScopedMode(scopeKey: string, mode: ApprovalMode): void {
    this.scopedModes.set(normalizeScopeKey(scopeKey), mode);
  }

  clearScopedMode(scopeKey: string): void {
    this.scopedModes.delete(normalizeScopeKey(scopeKey));
  }

  /** 全局档改了: 运行时设上的 per-session 值全清。留两类: config.agentApprovalScopes 里写死的按 agent 档,
   *  和 `neox -p` 的只读会话 (print-*) —— 那是对这一次调用的承诺, 桌面切全局不能把它放开。 */
  clearRuntimeScopedModes(): number {
    let n = 0;
    for (const key of [...this.scopedModes.keys()]) {
      if (this.configScopeKeys.has(key) || key.startsWith('print-')) continue;
      this.scopedModes.delete(key);
      n++;
    }
    return n;
  }

  resolveByScope(scopeKey?: string): ApprovalMode {
    if (this.forcedMode) return this.forcedMode;
    if (scopeKey && scopeKey.trim()) {
      const normalized = normalizeScopeKey(scopeKey);
      const direct = this.scopedModes.get(normalized);
      if (direct) return direct;

      if (normalized.startsWith('worker-') || normalized.startsWith('agent-')) {
        const mapped = this.scopedModes.get('worker');
        if (mapped) return mapped;
      }

      if (normalized.startsWith('scout-') || normalized.startsWith('explorer-')) {
        const mapped = this.scopedModes.get('scout');
        if (mapped) return mapped;
      }

      if (normalized.startsWith('verifier-')) {
        const mapped = this.scopedModes.get('verifier');
        if (mapped) return mapped;
      }

      if (normalized.startsWith('compressor-')) {
        const mapped = this.scopedModes.get('compressor');
        if (mapped) return mapped;
      }

      if (normalized === 'mainagent') {
        const mapped = this.scopedModes.get('mainagent') || this.scopedModes.get('main');
        if (mapped) return mapped;
      }

      if (normalized === 'singleagent') {
        const mapped = this.scopedModes.get('singleagent');
        if (mapped) return mapped;
      }
    }

    return this.globalMode;
  }
}
