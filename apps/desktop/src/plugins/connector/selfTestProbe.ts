import type { CapabilityId, PluginConnectorDefinition } from '@neoxlabs/platform/shared/plugin-connector.js';

export type SelfTestProbe =
  | { kind: 'call'; capability: CapabilityId; input: Record<string, unknown>; placeholder: boolean }
  | { kind: 'none' };

export const SELFTEST_PLACEHOLDER = 'neox-connector-selftest';

export function pickSelfTestProbe(
  connector: Pick<PluginConnectorDefinition, 'permissions' | 'tools'>,
  granted: ReadonlySet<string>,
  requested: CapabilityId,
): SelfTestProbe {
  const tools: any[] = connector.tools ?? [];
  const perms: any[] = connector.permissions ?? [];
  const toolOf = (cap: string) => tools.find((t) => t.capability === cap);
  const required = (cap: string): string[] => {
    const req = toolOf(cap)?.input?.required;
    return Array.isArray(req) ? req : [];
  };

  if (required(requested).length === 0) return { kind: 'call', capability: requested, input: {}, placeholder: false };

  const better = perms
    .filter((p) => p.effect === 'readonly' && granted.has(p.capability))
    .map((p) => p.capability as CapabilityId)
    .find((cap) => required(cap).length === 0);
  if (better) return { kind: 'call', capability: better, input: {}, placeholder: false };

  const perm = perms.find((p) => p.capability === requested);
  const props = toolOf(requested)?.input?.properties ?? {};
  const req = required(requested);
  if (perm?.effect === 'readonly' && req.every((k) => (props[k]?.type ?? 'string') === 'string')) {
    const input: Record<string, unknown> = {};
    for (const k of req) input[k] = SELFTEST_PLACEHOLDER;
    return { kind: 'call', capability: requested, input, placeholder: true };
  }
  return { kind: 'none' };
}
