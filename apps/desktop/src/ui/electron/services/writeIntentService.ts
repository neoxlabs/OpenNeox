/**
 * Main 进程全局 WriteIntentRegistry 单例.
 *
 * 所有 write intent 发起方 (inline-edit / fileEdit / agent apply) 走这里,
 * 所有 semantic / hover / completion read 走这里. 单例覆盖进程级锁, 不分
 * workspace —— workspace 级范围通过 file 路径前缀天然隔离.
 *
 * 不用 ProjectScope 级是因为: 一个 Electron 进程可能持有多个 workspace
 * (未来多窗口共享 main), 全局一把锁更简单, 也贴近 IntelliJ 的实际行为
 * (一个 IDE 一把锁, 所有 project 都走同一读写内核).
 */
import { WriteIntentRegistry } from '@neoxlabs/platform/shared/async/writeIntent.js';

let _instance: WriteIntentRegistry | null = null;

export function getWriteIntentRegistry(): WriteIntentRegistry {
  if (!_instance) {
    _instance = new WriteIntentRegistry();
  }
  return _instance;
}

/** 测试 / HMR 用: 销毁当前单例, 下次调用会新建. */
export function resetWriteIntentRegistryForTest(): void {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
}
