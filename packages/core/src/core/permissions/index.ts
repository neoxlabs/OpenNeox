/**
 * core 侧的权限装配件。
 *
 *   这个文件曾经是一个 re-export shim (把 kernel 的 PermissionManager 再导一遍),
 *    那批 shim 清理时消费者已全部改指 kernel。现在它有了自己的内容:
 *   **只放 kernel 装不下的东西** —— 也就是需要碰盘/碰宿主环境的实现。
 *   PermissionManager / ToolPermission 等类型与逻辑一律从 @openneox/kernel 引, 别在这里转口。
 */

export {
  createFilePermissionStorage,
  defaultPermissionsFilePath,
} from './filePermissionStorage.js';
