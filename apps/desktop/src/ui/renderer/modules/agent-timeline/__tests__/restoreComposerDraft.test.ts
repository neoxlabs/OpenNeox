import { describe, expect, it } from 'vitest';
import { restoreComposerDraft } from '../restoreComposerDraft';

describe('restore rejected composer draft', () => {
  it('returns a message once even when multiple rejections arrive', () => {
    const text = 'first line\nsecond line';
    const restored = restoreComposerDraft('', text);
    expect(restoreComposerDraft(restored, text)).toBe(text);
  });

  it('preserves newer typing and does not append the same return twice', () => {
    const restored = restoreComposerDraft('new draft', 'unsent message');
    expect(restored).toBe('new draft\nunsent message');
    expect(restoreComposerDraft(restored, 'unsent message')).toBe(restored);
  });

  it('does not mistake a substring for an already restored message', () => {
    expect(restoreComposerDraft('some message', 'message')).toBe('some message\nmessage');
    expect(restoreComposerDraft('  unsent  ', 'unsent')).toBe('  unsent  ');
  });
});
