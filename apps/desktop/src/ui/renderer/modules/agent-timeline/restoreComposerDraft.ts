/** Repeated rejection notifications must not duplicate an already restored draft. */
export function restoreComposerDraft(current: string, returned: string): string {
  const draft = current.trim();
  const text = returned.trim();
  if (!text || draft === text || draft.endsWith(`\n${text}`)) return current;
  return draft ? `${current}\n${returned}` : returned;
}
