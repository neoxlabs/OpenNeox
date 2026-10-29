export interface SendOwner {
  sessionId: string | null;
  pending: boolean;
  timer?: ReturnType<typeof setTimeout> | number;
}

/** A background conversation must never hold another conversation's send lock. */
export class SessionSendGuard {
  private owners = new Map<string | null, SendOwner>();

  get(sessionId: string | null): SendOwner | undefined {
    return this.owners.get(sessionId);
  }

  acquire(sessionId: string | null): SendOwner | undefined {
    if (this.owners.has(sessionId)) return undefined;
    const owner: SendOwner = { sessionId, pending: true };
    this.owners.set(sessionId, owner);
    return owner;
  }

  owns(owner: SendOwner): boolean {
    return this.owners.get(owner.sessionId) === owner;
  }

  bind(owner: SendOwner, sessionId: string): boolean {
    if (!this.owns(owner)) return false;
    if (owner.sessionId === sessionId) return true;
    if (this.owners.has(sessionId)) return false;
    this.owners.delete(owner.sessionId);
    owner.sessionId = sessionId;
    this.owners.set(sessionId, owner);
    return true;
  }

  release(owner: SendOwner): void {
    if (!this.owns(owner)) return;
    if (owner.timer !== undefined) clearTimeout(owner.timer);
    this.owners.delete(owner.sessionId);
  }

  cancel(sessionId: string | null): void {
    const owner = this.get(sessionId);
    if (owner) this.release(owner);
  }

  settle(sessionId: string | null): void {
    const owner = this.get(sessionId);
    if (owner && !owner.pending) this.release(owner);
  }

  clear(): void {
    for (const owner of this.owners.values()) this.release(owner);
  }
}
