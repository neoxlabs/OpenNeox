export interface PendingTeamResult {
  sessionId: string;
  teamId: string;
  rawResult: string;
  sourceId: string;
  traceId?: string;
  timestamp?: number;
}

export class ResultDeliveryService {
  private mainTurnStreaming = false;
  private deliveredTeamIds = new Set<string>();
  private pendingTeamResults = new Map<string, PendingTeamResult>();

  onMainTurnStart(): void {
    this.mainTurnStreaming = false;
    if (this.deliveredTeamIds.size > 20) {
      this.deliveredTeamIds.clear();
    }
  }

  onMainTextDelta(delta?: string): void {
    if (delta) this.mainTurnStreaming = true;
  }

  onMainTurnComplete(): PendingTeamResult[] {
    this.mainTurnStreaming = false;
    const pending = Array.from(this.pendingTeamResults.values());
    this.pendingTeamResults.clear();
    return pending;
  }

  shouldSkipTeam(teamId: string): boolean {
    return this.deliveredTeamIds.has(teamId);
  }

  queueOrMarkTeamResult(result: PendingTeamResult): 'queued' | 'ready' | 'duplicate' {
    if (this.deliveredTeamIds.has(result.teamId)) {
      return 'duplicate';
    }

    this.deliveredTeamIds.add(result.teamId);
    if (this.mainTurnStreaming) {
      this.pendingTeamResults.set(result.teamId, result);
      return 'queued';
    }

    return 'ready';
  }
}
