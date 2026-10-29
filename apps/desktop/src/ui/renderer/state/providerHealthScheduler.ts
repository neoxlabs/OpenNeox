import { NEOX_CLOUD_PROVIDER_ID } from '../../shared/neoxCloud';
import { isProviderHealthCheckSkipped } from '../pages/settings/providerHealthPrefs';

/** 一轮扫描完成后广播, 设置页据此刷新 healthMap (它自己不再持有定时器) */
export const PROVIDER_HEALTH_UPDATED_EVENT = 'neox:provider-health-updated';

/** 两轮扫描之间的最小间隔 — 防止"打开设置页"和"定时到点"撞在一起打两遍 */
const MIN_SWEEP_GAP_MS = 60_000;
/** 同一轮里逐个服务商错开, 避免一次性并发十几个请求 */
const STAGGER_MS = 500;

let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let sweeping = false;
let lastSweepAt = 0;

function pickProbeModel(provider: {
  models?: Array<{ name?: string }>;
  defaultModel?: string;
  lastSelectedModel?: string;
}): string {
  const names = (provider.models || []).map((m) => m?.name).filter(Boolean) as string[];
  /* 图片模型不能拿去打 chat/completions, 否则健康检测必红 (与 SettingsPage 同一套判据) */
  const preferredChat = names.find((name) => {
    const n = String(name).toLowerCase();
    return !/image|dall-?e|imagen|gpt-image|imagine|flux|sdxl/.test(n);
  });
  return (
    preferredChat
    || provider.defaultModel
    || provider.lastSelectedModel
    || names[0]
    || 'gpt-4o'
  );
}

async function probeOne(provider: { id: string }): Promise<void> {
  const model = pickProbeModel(provider as never);
  try {
    /* 只传 providerId + model —— protocol/baseUrl/apiKey 由主进程从 configService 补全
     * (provider:health-check 里的 hydrate)。渲染端拿到的 apiKey 是密文, 不该往回传。 */
    const result = await window.neox.checkProviderHealth({
      providerId: provider.id,
      model,
    } as never);
    await window.neox.updateHealthData(
      provider.id,
      result.status,
      result.latency,
      (result as { errorMessage?: string }).errorMessage,
      (result as { httpStatus?: number }).httpStatus,
      model,
    );
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    try {
      await window.neox.updateHealthData(provider.id, 'offline', 0, errText, undefined, model);
    } catch {
      /* 落盘失败不影响下一轮 */
    }
  }
}

/**
 * 跑一轮全量探测。
 * @param force 忽略 MIN_SWEEP_GAP_MS 与自动开关 (手动测速用)
 */
export async function runProviderHealthSweep(force = false): Promise<void> {
  if (sweeping) return;
  const now = Date.now();
  if (!force && now - lastSweepAt < MIN_SWEEP_GAP_MS) return;

  let providers: Array<{ id: string }> = [];
  try {
    providers = (await window.neox.getProviders()) as never;
  } catch {
    return;
  }
  const list = providers.filter(
    (p) => p.id !== NEOX_CLOUD_PROVIDER_ID && !isProviderHealthCheckSkipped(p.id),
  );
  if (list.length === 0) return;

  sweeping = true;
  lastSweepAt = now;
  try {
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      /* 每个都重查一次跳过名单 —— 一轮可能跑好几秒, 中途用户可能刚标记跳过 */
      if (isProviderHealthCheckSkipped(p.id)) continue;
      await probeOne(p);
      if (i < list.length - 1) await new Promise((r) => setTimeout(r, STAGGER_MS));
    }
  } finally {
    sweeping = false;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PROVIDER_HEALTH_UPDATED_EVENT));
    }
  }
}

async function readPrefs(): Promise<{ auto: boolean; minutes: number }> {
  const [auto, minutes] = await Promise.all([
    window.neox.getAutoHealthCheck().catch(() => false),
    window.neox.getHealthCheckInterval().catch(() => 30),
  ]);
  return { auto: !!auto, minutes: minutes && minutes > 0 ? minutes : 30 };
}

/** 按当前偏好重建定时器。自动检测关闭时不排任何定时器 (默认就是关的)。 */
export async function restartProviderHealthScheduler(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const { auto, minutes } = await readPrefs();
  if (!auto) return;
  void runProviderHealthSweep();
  timer = setInterval(() => {
    void runProviderHealthSweep();
  }, minutes * 60 * 1000);
}

/** App 启动时调用一次 (幂等)。 */
export function startProviderHealthScheduler(): void {
  if (started) return;
  started = true;
  /* 开机不抢首屏 —— 延后一点再起第一轮 */
  setTimeout(() => {
    void restartProviderHealthScheduler();
  }, 8000);
}

export function stopProviderHealthScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
