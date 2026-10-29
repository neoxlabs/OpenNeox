
const KEY = 'neox.kbCuration.enabled';

export function isKnowledgeCurationEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
