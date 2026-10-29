/*
 * devicePresence —— 这台机器知道的设备在线状态 (pilot:H-07)。
 *
 * 节点 (手机 / 电脑) 每次 `pilot.hello` 报到时更新这里; 每轮拼提示词时按"心跳是否还新"
 * 判在线, 序列化成 `<device-state>` 交给大脑 (见 situationalContext.ts)。
 *
 * 为什么按心跳判而不是靠掉线事件: 中继断开时不会有人通知这个进程 (手机被切后台 /
 * 电脑合盖 / 网络切换都可能是静默的), 只有"多久没报到"是可靠信号。
 *
 * 纯内存注册表: 进程重启后节点会重新报到, 不需要持久化 —— 旧的在线状态反而会误导。
 */

export type DeviceKind = 'phone' | 'desktop';

/** 一次报到里的原始字段; 缺省字段不会覆盖上一次记住的值。 */
export interface DevicePresenceReport {
  deviceId: string;
  kind: DeviceKind;
  name?: string;
  batteryPct?: number | null;
  charging?: boolean | null;
  network?: string | null;
  /** 报到时刻; 缺省 Date.now()。测试里可注入。 */
  at?: number;
}

/** 读出来的设备状态 (online 已按新鲜度算好)。 */
export interface DevicePresence {
  deviceId: string;
  kind: DeviceKind;
  name?: string;
  batteryPct?: number;
  charging?: boolean;
  network?: string;
  lastSeenAt: number;
  online: boolean;
}

interface StoredPresence {
  deviceId: string;
  kind: DeviceKind;
  name?: string;
  batteryPct?: number;
  charging?: boolean;
  network?: string;
  lastSeenAt: number;
}

/** 心跳超过这么久没更新就当作离线。电脑 90s 一拍、手机 90s 一拍, 留 5 分钟余量。 */
export const DEVICE_STALE_MS = 5 * 60_000;
/** 超过这么久没出现的设备直接从表里清掉, 免得一台旧机器永远挂在提示词里。 */
const DEVICE_FORGET_MS = 24 * 60 * 60_000;
/** 最多记这么多台 (一个人通常手机 + 电脑, 留点余量给换设备)。 */
const MAX_DEVICES = 8;

const devices = new Map<string, StoredPresence>();

/** 节点报到 / 心跳。字段缺省 = 沿用上一次的值 (手机只报电量时不丢设备名)。 */
export function reportDevicePresence(report: DevicePresenceReport): void {
  const id = typeof report.deviceId === 'string' ? report.deviceId.trim() : '';
  if (!id) return;
  if (report.kind !== 'phone' && report.kind !== 'desktop') return;
  const at = typeof report.at === 'number' && report.at > 0 ? report.at : Date.now();
  const prev = devices.get(id);
  const next: StoredPresence = {
    deviceId: id,
    kind: report.kind,
    name: report.name ?? prev?.name,
    batteryPct: normalizeBattery(report.batteryPct) ?? prev?.batteryPct,
    charging: typeof report.charging === 'boolean' ? report.charging : prev?.charging,
    network: normalizeNetwork(report.network) ?? prev?.network,
    /* 迟到的心跳 (中继补发 / 时钟偏) 不该让"最后在线"倒退 */
    lastSeenAt: Math.max(at, prev?.lastSeenAt ?? 0),
  };
  devices.delete(id);
  devices.set(id, next);
  prune(at);
}

/**
 * 从 `pilot.hello` 的 params 里取设备状态。别的消息形状 / 缺 device_kind 时返回 null。
 * 单独抽出来是为了能单测字段解析, 不用把整个云端 dispatch 拉起来。
 */
export function presenceFromHello(
  deviceId: string,
  params: unknown,
  now: number = Date.now(),
): DevicePresenceReport | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  const rawKind = p.device_kind ?? (p.payload as Record<string, unknown> | undefined)?.device;
  const kind: DeviceKind | null = rawKind === 'desktop'
    ? 'desktop'
    : rawKind === 'mobile' || rawKind === 'phone'
      ? 'phone'
      : null;
  if (!kind) return null;
  return {
    deviceId,
    kind,
    name: typeof p.device_name === 'string' && p.device_name.trim() ? p.device_name.trim().slice(0, 40) : undefined,
    batteryPct: normalizeBattery(p.battery_pct),
    charging: typeof p.charging === 'boolean' ? p.charging : undefined,
    network: normalizeNetwork(p.network),
    at: now,
  };
}

/** 读当前设备状态: 在线的在前, 同组按最近报到排。 */
export function listDevicePresence(
  now: number = Date.now(),
  opts?: { staleAfterMs?: number },
): DevicePresence[] {
  const staleAfterMs = opts?.staleAfterMs ?? DEVICE_STALE_MS;
  prune(now);
  return [...devices.values()]
    .map((d) => ({
      ...d,
      online: now - d.lastSeenAt <= staleAfterMs,
    }))
    .sort((a, b) => (Number(b.online) - Number(a.online)) || (b.lastSeenAt - a.lastSeenAt));
}

/** 忘掉一台 (或全部) 设备 —— 换号 / 断开时用。 */
export function clearDevicePresence(deviceId?: string): void {
  if (deviceId) devices.delete(deviceId);
  else devices.clear();
}

/** 仅测试用。 */
export function __resetDevicePresenceForTesting(): void {
  devices.clear();
}

function prune(now: number): void {
  for (const [id, d] of devices) {
    if (now - d.lastSeenAt > DEVICE_FORGET_MS) devices.delete(id);
  }
  while (devices.size > MAX_DEVICES) {
    /* Map 保持插入顺序; 这里插入时会先 delete 再 set, 所以最前面就是最久没报到的 */
    const oldest = devices.keys().next();
    if (oldest.done) break;
    devices.delete(oldest.value);
  }
}

function normalizeBattery(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n);
}

function normalizeNetwork(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  return v.slice(0, 20);
}
