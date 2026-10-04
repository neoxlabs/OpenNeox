/**
 * 宿主能力开关 —— "放不放一整块能力出来"。
 *
 * ─── 为什么在 kernel ────────────────────────────────────────────────────────
 * 写的人是 desktop (插件管理器读 manifest 的 capabilities), 读的人是 core
 * (装配工具时决定收不收)。放在 core 里就得让 desktop 深引 core 内部模块 ——
 * 那正是 import-boundaries 棘轮拦的东西, 而且拦得对: 跨包的宿主级开关本来就属于地基。
 *
 * ─── 目前唯一的消费者: computer-use ─────────────────────────────────────────
 * OS 级操作的工具默认**根本不进 toolMap**, 装了带 `capabilities: ["computer-use"]`
 * 的插件才点亮。用户拍的板: 「Computer use 是以插件的形式存在的, 默认不带;
 * Browser use 默认携带」。
 *
 * 这只是三道闸里的第一道 —— 它只管"工具在不在", 后面还有审批档位和 macOS 的 TCC 授权。
 * 各管各的, 别指望其中一道兜住另外两道。
 */

/**
 * State lives on globalThis so separately bundled copies share one capability set.
 */
const GLOBAL_KEY = '__NEOX_HOST_CAPABILITIES__';

const enabled: Set<string> = ((globalThis as Record<string, any>)[GLOBAL_KEY] ??= new Set<string>());

export const HOST_CAPABILITY_COMPUTER_USE = 'computer-use';

export function enableHostCapability(name: string): void {
  if (typeof name === 'string' && name) enabled.add(name);
}

export function disableHostCapability(name: string): void {
  enabled.delete(name);
}

export function isHostCapabilityEnabled(name: string): boolean {
  return enabled.has(name);
}

/** 给设置页 / 诊断看的。 */
export function listHostCapabilities(): string[] {
  return [...enabled];
}
