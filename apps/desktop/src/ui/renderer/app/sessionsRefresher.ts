
/** 侧栏不渲染、但切会话时用来种上下文快照的三个重字段 —— lite 列表不带, 从旧行沿用。 */
const HEAVY_USAGE_FIELDS = ['contextBreakdown', 'latestRequestUsage', 'sessionUsage'] as const;
export function createSessionsRefresher(
  apply: (rows: any[]) => void,
  sanitize: (row: any) => any,
  /** 取上一次已知的行 —— 用来把 lite 列表缺的重字段补回去 (见文件头 #109 那段) */
  getPrevRows?: () => any[],
) {
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = async (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const api = (window as any).neox;
        /* 老 preload 没有 getSessionsLite → 回落到原来的全量 slim, 行为不变 */
        const raw = typeof api.getSessionsLite === 'function'
          ? await api.getSessionsLite()
          : await api.getSessions();
        const all = raw.map(sanitize);

        /* 字段级合并: lite 不带的重字段沿用上一次已知值。
         * 只补"新行里确实缺"的字段 —— 回落到全量路径时新行自带, 这里就是个 no-op。 */
        const prev = getPrevRows?.();
        if (prev && prev.length > 0) {
          const prevById = new Map(prev.map((r: any) => [r?.id, r]));
          for (const row of all) {
            const old = prevById.get(row?.id);
            if (!old) continue;
            for (const k of HEAVY_USAGE_FIELDS) {
              if (row[k] == null && old[k] != null) row[k] = old[k];
            }
          }
        }
        apply(all);
      } catch (err) {
        console.warn('[NeoxRuntimeBridge] refresh sessions failed', err);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  /** 突发合并 —— 400ms 内多次触发只发一次 (取最后一次) */
  return (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, 400);
  };
}
