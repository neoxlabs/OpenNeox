/**
 * machineIdentity.ts — 从稳定 machine-id 派生出来的机器身份。
 *
 * 任何表示机器身份的值都必须由稳定 machine-id 派生，不能使用 randomUUID。
 *
 * 两个派生值, **盐不同且都不可逆**:
 *   deviceId(scope)   给某一类客户端当身份 (desktop / cli 各自一个, 互不相同)
 *   machineFingerprint 给服务端认亲: 同一台机器上的 desktop 和 cli 拿到的是**同一个值**,
 *                      服务端据此把它们合并成"一台电脑" —— 用户要看的是有几台电脑,
 *                      不是装了几个客户端。
 *
 * 拿不到稳定 machine-id 时返回 null，由调用方决定如何处理；绝不回落随机值，避免同一台
 * 机器被识别为多个设备。
 */
import { createHash } from 'node:crypto';

/** 把 32 位 hex 摘要排成 UUID 形状 —— 兼容既有的 device_id 格式 (服务端按 text 存, 但客户端/日志都当 UUID 读)。 */
function asUuidShape(hex: string): string {
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * 某一类客户端在这台机器上的稳定 device_id。
 *
 * [scope] 是客户端类别 —— 'desktop' / 'cli'。不同 scope 得到不同 id (它们在设备表里
 * 确实是不同的登录实体), 但 machineFingerprint 相同, 所以服务端仍然知道是同一台机器。
 */
export function deviceIdFromMachineId(machineId: string | null | undefined, scope: string): string | null {
  if (!machineId) return null;
  const h = createHash('sha256').update(`neox-${scope}-device-id:${machineId}`).digest('hex');
  return asUuidShape(h);
}

/**
 * 机器指纹 —— 上报给服务端做"这几行其实是同一台机器"的判据。
 *
 * 不是 machine-id 本身 (那是本地加密密钥的派生源, 绝不上云), 而是它的单向摘要, 且盐
 * 跟 device_id 那条不同 —— 拿到 fp 既反推不出 machine-id, 也算不出任何 device_id。
 */
export function machineFingerprintFromMachineId(machineId: string | null | undefined): string | null {
  if (!machineId) return null;
  return createHash('sha256').update(`neox-machine-fp:${machineId}`).digest('hex');
}
