import { describe, it, expect } from 'vitest';
import {
  registryDeclaresCapability,
  computerUsePlatformSupported,
  COMPUTER_USE_CAPABILITY,
} from '../../runtime/computer/computerCapability';
import { COMPUTER_TOOL_NAMES } from '../../runtime/computer/computerToolDefs';
import { BUILTIN_PACKS } from '../packs/builtinPacks';

/**
 * 「默认不带, 装了插件才有」这件事必须能被证明。
 *
 *  判定逻辑测的是**纯函数**, 不是 isComputerUseEnabled 的返回值 —— 后者读的是
 * 这台机器上真实的 `~/.neox/plugins/registry.json`。第一版测试写成
 * `expect(isComputerUseEnabled()).toBe(false)`, 在我自己机器上直接红了: 插件真装着。
 * 测试依赖开发机状态本身就是个坑, 它测的是"我这台机器现在什么样", 不是代码对不对。
 */
const reg = (plugins: Record<string, unknown>) => JSON.stringify({ version: 1, plugins });

describe('computer use 能力闸的判定', () => {
  it('装了并启用 → 开', () => {
    expect(registryDeclaresCapability(reg({
      'computer-use': { enabled: true, manifest: { capabilities: ['computer-use'] } },
    }), COMPUTER_USE_CAPABILITY)).toBe(true);
  });

  it('装了但禁用了 → 关', () => {
    expect(registryDeclaresCapability(reg({
      'computer-use': { enabled: false, manifest: { capabilities: ['computer-use'] } },
    }), COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('一个插件都没装 → 关', () => {
    expect(registryDeclaresCapability(reg({}), COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('装了别的插件, 但没声明这个能力 → 关', () => {
    expect(registryDeclaresCapability(reg({
      notion: { enabled: true, manifest: { capabilities: ['connector'] } },
      figma: { enabled: true, manifest: {} },
    }), COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('注册表是坏的 → 关 (宁可少给能力, 不可多给)', () => {
    expect(registryDeclaresCapability('{ 这不是 JSON', COMPUTER_USE_CAPABILITY)).toBe(false);
    expect(registryDeclaresCapability('null', COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('capabilities 不是数组也不能炸', () => {
    expect(registryDeclaresCapability(reg({
      x: { enabled: true, manifest: { capabilities: 'computer-use' } },
    }), COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  /* 平台能力 —— 判据从"平台 == darwin"改成了"这个平台上有桥吗"(Windows 桥落地)。
   * 写成纯函数而不是直接问 isComputerUseEnabled(): 后者会去读真实文件系统里的桥 exe,
   * 于是"这台机器上桥构建过没有"会决定测试红不红 —— 正是文件头警告过的那个坑。 */
  it('macOS: 桥跟包走, 有平台能力', () => {
    expect(computerUsePlatformSupported('darwin', false)).toBe(true);
    expect(computerUsePlatformSupported('darwin', true)).toBe(true);
  });

  it('Windows: 桥 exe 在才算有平台能力 (没构建 / 打包漏带 → 关闸)', () => {
    expect(computerUsePlatformSupported('win32', true)).toBe(true);
    expect(computerUsePlatformSupported('win32', false)).toBe(false);
  });

  it('其它平台一律关 —— 没桥就给模型一个永远调不通的工具是纯浪费', () => {
    expect(computerUsePlatformSupported('linux', true)).toBe(false);
    expect(computerUsePlatformSupported('freebsd', true)).toBe(false);
  });
});

describe('工具与 pack 的接线', () => {
  it('computer pack 必须在清单里 —— 摘掉它这三个工具会变成常驻', () => {
    const pack = BUILTIN_PACKS.find((p) => p.id === 'computer');
    expect(pack, 'computerPack 不在 BUILTIN_PACKS 里').toBeTruthy();
    for (const name of COMPUTER_TOOL_NAMES) {
      expect(pack!.toolNames, `${name} 不在 computer pack 的 toolNames 里`).toContain(name);
    }
  });

  it('三个工具名固定 —— 改名要同时改 pack 清单和风险评估器', () => {
    expect(COMPUTER_TOOL_NAMES).toEqual(['computer_snapshot', 'computer_run', 'computer_check_access']);
  });
});
