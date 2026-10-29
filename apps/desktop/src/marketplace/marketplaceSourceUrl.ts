export function normalizeGitHubRepository(value: string): string {
  const trimmed = value.trim().replace(/\.git$/i, '').replace(/\/$/, '');
  if (trimmed.startsWith('file://')) {
    let local: URL;
    try { local = new URL(trimmed); } catch { throw new Error('Marketplace file source must be a valid file URL'); }
    if (local.protocol !== 'file:' || !local.pathname) throw new Error('Marketplace file source must be a valid file URL');
    return local.toString();
  }
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('Marketplace repository must be a GitHub owner/repo or URL'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Marketplace repository must use https://github.com');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('Marketplace repository URL must identify owner/repo');
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

export function validateMarketplaceRef(value?: string): string {
  const ref = value?.trim() || 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) || ref.includes('..') || ref.startsWith('/') || ref.endsWith('/')) {
    throw new Error('Marketplace ref is invalid');
  }
  return ref;
}

export function marketplaceArchiveUrl(repository: string, ref: string): string {
  if (repository.startsWith('file://')) return repository;
  return `${repository}/archive/refs/heads/${ref.split('/').map(encodeURIComponent).join('/')}.zip`;
}
