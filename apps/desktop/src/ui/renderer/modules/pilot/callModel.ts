
export interface ModelLike {
  id: string;
  name?: string;
  providerId?: string;
  baseUrl?: string;
}

const FLASH_NAMES = ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash'];

export function pickPilotCallModel<M extends ModelLike>(models: readonly M[]): M | null {
  const official = models.filter((m) => /(^|\.)deepseek\.com/i.test(hostOf(m.baseUrl)));
  for (const name of FLASH_NAMES) {
    const hit = official.find((m) => (m.name ?? m.id.split(':').pop()) === name);
    if (hit) return hit;
  }
  return null;
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : ''; } catch { return ''; }
}
