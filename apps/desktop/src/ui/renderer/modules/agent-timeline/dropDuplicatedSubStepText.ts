import type { TimelineEntry } from '../../utils/workspaceUtils';

export function dropDuplicatedSubStepText(entries: TimelineEntry[]): TimelineEntry[] {
  const live: string[] = [];
  let hasSubStep = false;
  for (const e of entries) {
    const id = String(e.id ?? '');
    if (id.startsWith('sub-step-')) { hasSubStep = true; continue; }
    if (id.startsWith('msg-') && e.type === 'assistant_message') {
      const t = String(e.detail ?? e.description ?? '').trim();
      if (t) live.push(t);
    }
  }
  if (!hasSubStep || !live.length) return entries;
  return entries.filter((e) => {
    if (e.type !== 'assistant_message' || !String(e.id ?? '').startsWith('sub-step-')) return true;
    const t = String(e.detail ?? e.description ?? '').trim();
    return !t || !live.some((full) => full.includes(t));
  });
}
