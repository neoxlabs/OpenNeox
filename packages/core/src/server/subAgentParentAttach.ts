import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const attached = new Set<string>();
const MAX_TRACKED = 2000;

export function attachSubAgentParent(
  chains: Map<string, Promise<void>>,
  subSid: string,
  parentSid: string,
  workDir: string,
): void {
  if (!parentSid || subSid === parentSid || attached.has(subSid)) return;
  attached.add(subSid);
  if (attached.size > MAX_TRACKED) {
    const oldest = attached.values().next().value;
    if (oldest) attached.delete(oldest);
  }
  const prev = chains.get(subSid) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const storeMod: any = await import('../platform/sessionStore.js');
      const store = storeMod.sessionStore;
      const parent = await store.loadSession(parentSid).catch(() => null);
      store.adoptSubAgentRow?.(subSid, parentSid, parent?.workspacePath || workDir || '');
    })
    .catch((err: any) => {
      cliLogger.warn('SUB_AGENT', `attach parent failed for ${subSid}: ${err?.message ?? err}`);
    });
  chains.set(subSid, next);
}
