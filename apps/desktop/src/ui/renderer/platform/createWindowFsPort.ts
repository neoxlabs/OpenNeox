/**
 * createWindowFsPort —— 把 Electron 的 `window.neox.readFile/writeFile` 适配
 * 成平台层的 FileSystemPort。
 *
 * 平台层的 EditorService（以及未来其他服务）只认 FileSystemPort 这个接口，
 * 不知道 window.neox 的存在。这层适配把"renderer 实际怎么访问磁盘"这件事
 * 隔离在一个 5 行的工厂函数里 —— 未来想换成走 IPC 命令、Service Worker、
 * 或测试 mock，只要换这个函数。
 *
 * 注意：保留对 `window.neox?.readFile?.` 的可选链 —— 上下游可能在 preload
 * 还没就绪时调用，原 useEditorTabs 也是这个写法。这里把"未注入"直接转换
 * 成 success:false + error 字符串，让 EditorService 走错误路径而不是抛 TypeError。
 */

import type { FileSystemPort } from '../../../ide/index.js';

export function createWindowFsPort(): FileSystemPort {
  return {
    async readFile(filePath: string) {
      const api = window.neox;
      if (!api?.readFile) {
        return { success: false, error: 'window.neox.readFile not available' };
      }
      try {
        return await api.readFile(filePath);
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async writeFile(filePath: string, content: string) {
      const api = window.neox;
      if (!api?.writeFile) {
        return { success: false, error: 'window.neox.writeFile not available' };
      }
      try {
        return await api.writeFile(filePath, content);
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async stat(filePath: string) {
      const api = (window as any).neox;
      const fn = api?.statFile;
      if (typeof fn !== 'function') {
        return { success: false, error: 'statFile not available' };
      }
      try {
        const res = await fn(filePath);
        if (!res?.success) return { success: false, error: res?.error };
        return {
          success: true,
          size: res.stats?.size,
          isFile: res.stats?.isFile,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
