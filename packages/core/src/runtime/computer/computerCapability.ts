/** Determine whether OS-level Computer Use tools are available.
 *
 * The capability is plugin-controlled and disabled unless explicitly enabled.
 *
 * The gate reads the on-disk plugin registry, while the native bridge remains
 * packaged with the signed host. The plugin declares and enables the capability.
 */

/* 读注册表的那段 抽到 ../pluginCapabilityGate.ts —— GitHub PR agent 是第二个消费者。
 * registryDeclaresCapability 在这里转出去, 老的 import 路径 (测试) 不用改。
 * (测试第一版直接调 isComputerUseEnabled 断言"默认是关的", 结果在我自己机器上红了:
 *  插件真装着。测试依赖开发机状态本身就是个坑 —— 所以判定逻辑是纯函数。) */
import {
  isPluginCapabilityEnabled,
  invalidatePluginCapabilityCache,
  registryDeclaresCapability,
} from '../pluginCapabilityGate.js';
import { resolveBridgeBinary } from './osBridgeClient.js';

export { registryDeclaresCapability };

export const COMPUTER_USE_CAPABILITY = 'computer-use';

/**
 * 这个平台上有桥可用吗。
 *
 * mac 上桥是随签名包编译进去的 (swiftc 产物 + .app bundle), 所以“装了插件就有”;
 * Windows 上是一只 exe, **要它真的在**才算数 —— 构建脚本没跑过、或打包时忘了带上,
 * 那就应该闭上闸, 而不是让模型看到一个调一次错一次的工具。
 *
 * (: 这里原来是 `platform !== 'darwin' → false` 的硬编码。改成按桥可用性判,
 * 因为 Windows 桥已经做出来了 —— 见 resources/win-os-bridge。)
 */
/**
 * 平台能力判定 —— **纯函数**, 好让单测不依赖"我这台机器现在什么样"。
 *
 * (这个文件头已经写过一次这个教训: 第一版测试直接断言 isComputerUseEnabled() 是 false,
 *  在开发机上直接红了 —— 因为插件真装着。同一个坑换个形式又来了: Windows 上桥存在与否
 *  也随开发机变化, 所以判定写成 (platform, bridgePresent) → bool。)
 */
export function computerUsePlatformSupported(platform: string, bridgePresent: boolean): boolean {
  if (platform === 'darwin') return true;
  if (platform === 'win32') return bridgePresent;
  return false;
}

function hasBridgeForThisPlatform(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') return resolveBridgeBinary() !== null;
  return false;
}

/** Computer Use requires both a platform bridge and an enabled plugin
 * capability declaration. */
export function isComputerUseEnabled(): boolean {
  if (!hasBridgeForThisPlatform()) return false;
  return isPluginCapabilityEnabled(COMPUTER_USE_CAPABILITY);
}

/** 装/卸插件之后立刻生效, 不用等缓存过期。 */
export function invalidateComputerUseGate(): void {
  invalidatePluginCapabilityCache();
}
