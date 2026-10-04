import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 注册表不会每秒变, 但调用方 (工具装配 / 轮询) 很频繁 —— 缓存这几秒, 免得反复读盘。 */
const CACHE_TTL_MS = 3000;
const cache = new Map<string, { at: number; value: boolean }>();

export function pluginRegistryPath(): string {
  return join(homedir(), NEOX_HOME_DIRNAME, 'plugins', 'registry.json');
}

/**
 * 注册表内容里有没有一个**已启用**且声明了这个能力的插件。
 * 纯函数, 方便测 —— 判定逻辑不该只能在"装了插件的那台机器"上验证。
 */
export function registryDeclaresCapability(raw: string, capability: string): boolean {
  try {
    const data = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    for (const entry of Object.values(data.plugins ?? {})) {
      const p = entry as { enabled?: boolean; manifest?: { capabilities?: unknown } };
      if (p?.enabled !== true) continue;
      const caps = p.manifest?.capabilities;
      if (Array.isArray(caps) && caps.includes(capability)) return true;
    }
  } catch {
    /* 注册表坏了 = 当作没装。宁可少给能力, 不可多给。 */
  }
  return false;
}

/** 装了并启用了声明这个能力的插件没有 (带几秒缓存)。 */
export function isPluginCapabilityEnabled(capability: string, now: number = Date.now()): boolean {
  const hit = cache.get(capability);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  let value = false;
  try {
    value = registryDeclaresCapability(readFileSync(pluginRegistryPath(), 'utf-8'), capability);
  } catch {
    /* 没有注册表 = 一个插件都没装 = 闸关着。这是对的默认。 */
    value = false;
  }
  cache.set(capability, { at: now, value });
  return value;
}

/** 装/卸插件之后立刻生效, 不用等缓存过期。 */
export function invalidatePluginCapabilityCache(): void {
  cache.clear();
}
