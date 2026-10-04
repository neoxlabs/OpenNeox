export interface ProviderModels { id: string; models?: Array<{ name?: string } | string> }

const namesOf = (p: ProviderModels): string[] =>
  (p.models ?? []).map((m) => (typeof m === 'string' ? m : m?.name ?? '')).filter(Boolean);

export function resolveModelFlag(
  model: string,
  providers: ProviderModels[],
  defaultProviderId?: string,
): { provider?: string; model: string } {
  const colon = model.indexOf(':');
  if (colon > 0) {
    const pid = model.slice(0, colon);
    if (providers.some((p) => p.id === pid)) return { provider: pid, model: model.slice(colon + 1) };
  }
  const owners = providers.filter((p) => namesOf(p).includes(model));
  if (owners.length === 0) return { model };
  const preferred = owners.find((p) => p.id === defaultProviderId) ?? owners[0]!;
  return { provider: preferred.id, model };
}
