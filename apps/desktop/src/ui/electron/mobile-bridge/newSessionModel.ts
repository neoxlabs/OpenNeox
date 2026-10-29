
export interface NewSessionModelDeps {
  /** 补 providerId 前缀 / 校验这台电脑认不认这个模型; 认不出返回 null */
  normalizeModelId: (raw: string | undefined | null) => Promise<string | null>;
  /** 只取 modelId/updatedAt 元数据的会话列表 */
  listSessionsSlim: (workspacePath: string) => Promise<any[]>;
  log: (msg: string) => void;
}

export async function resolveNewSessionModelId(
  opts: {
    requestedModelId?: string;
    workspacePath: string;
  },
  deps: NewSessionModelDeps,
): Promise<string | null> {
  const { normalizeModelId, listSessionsSlim, log } = deps;

  if (opts.requestedModelId) {
    let picked: string | null = null;
    try {
      picked = await normalizeModelId(opts.requestedModelId);
    } catch {
      picked = null;
    }
    if (picked) return picked;
    log(`requested modelId 无法解析, 回落继承: ${opts.requestedModelId}`);
  }

  try {
    const list = await listSessionsSlim(opts.workspacePath);
    list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const last = list.find((s) => typeof s.modelId === 'string' && s.modelId);
    if (last) {
      const inherited = await normalizeModelId(last.modelId);
      if (inherited) return inherited;
    }
  } catch { /* 列不出来就往下走默认, 不阻断新建会话 */ }

  try {
    const { subscriptionState } = await import('../services/subscriptionState.js');
    /* 按量模型扣余额, 不当默认 */
    const subs = subscriptionState.getModels().filter((m) => !m.payAsYouGo);
    if (subs.length > 0) return `neox-cloud:${subs[0]!.modelId}`;
  } catch { /* ignore */ }

  try {
    const cfgMod = await import('@neoxlabs/platform/platform/configService.js');
    const all: any[] = (cfgMod as any).configService.getAvailableModels?.() ?? [];
    const byok = all.find((m) => m.providerId !== 'neox-cloud');
    if (byok) return byok.id as string;
  } catch { /* ignore */ }

  return null;
}
