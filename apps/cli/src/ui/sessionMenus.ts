import prompts from 'prompts';
import type { Session as PersistedSession } from '@neoxlabs/kernel/types/session.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import { formatTimeAgo } from '../utils/index.js';

interface SessionManagerLike {
  listSessions: () => Promise<Array<{ sessionId: string; itemCount: number; updatedAt: Date }>>;
  getSession: (id: string) => Promise<PersistedSession | null>;
}

export async function showSessionSelectorFlow(
  sessionManager: SessionManagerLike,
): Promise<PersistedSession | null> {
  const sessions = await sessionManager.listSessions();
  if (sessions.length === 0) {
    cliPrintln(colors.dim('  No sessions found'));
    return null;
  }

  cliPrintln('');
  cliPrintln(colors.highlight('  Select Session:'));
  cliPrintln('');

  const choices = sessions.slice(0, 50).map((s) => ({
    title: `${s.sessionId} (${s.itemCount} items, ${formatTimeAgo(s.updatedAt)})`,
    value: s.sessionId,
  }));
  choices.push({ title: 'Create new session', value: 'new' });

  const response = await prompts({
    type: 'select',
    name: 'session',
    message: 'Session',
    choices,
  });

  if (!response.session || response.session === 'new') {
    return null;
  }

  const selected = await sessionManager.getSession(response.session);
  if (selected) {
    cliPrintln(colors.dim(`  ↪ Selected: ${selected.sessionId}`));
  }
  return selected as PersistedSession | null;
}
