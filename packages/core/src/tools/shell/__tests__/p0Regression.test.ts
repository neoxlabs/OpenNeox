
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { performance } from 'node:perf_hooks';
import { PARALLEL_SAFE_TOOLS, isParallelSafeTool } from '@neoxlabs/kernel/core/parallelSafeTools.js';

describe('P0 Regression — 不让历史 P0 回归', () => {
  describe('P0-B: shell execa shell:true 双层包不能再来', () => {
    const SHELL = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/zsh';
    const SHELL_ARGS = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx --version'] : ['-lc', 'npx --version'];

    it('zsh -lc <multi-word> 必须正常退出, 不能卡 (修前 8min)', async () => {
      /* 复现场景: buildShellInvocation 返回 (zsh, ['-lc', 'npx --version']),
       *   execa 时禁止再 shell:true (会 sh -c 再包一层 → zsh 只接到 -c npx).
       *   这里直接 spawn 验证基础调用方式正确, npx --version 必须秒级返回. */
      const start = performance.now();
      const result = await execa(SHELL, SHELL_ARGS, {
        cwd: process.cwd(),
        reject: false,
        timeout: 10_000,
        stdin: 'ignore', // belt-and-suspenders, 防 npx 类工具误等输入
      });
      const elapsed = performance.now() - start;

      expect(result.exitCode, 'npx --version 应正常退出 exit 0').toBe(0);
      expect(result.stdout.trim(), 'stdout 应有版本号').toMatch(/^\d+\.\d+/);
      expect(elapsed, 'P0-B 修后应秒级完成, 卡 >10s 就是回归').toBeLessThan(10_000);
    }, 15_000);

    it.runIf(process.platform !== 'win32')('错误示范 (shell:true 双层包) 应能看到 stdin 等待 — sanity 反证', async () => {
      /* 反证: 加 shell: true 会导致 zsh 看不到 'npx --version' 的全部 args.
       *   走 stdin: 'ignore' 强制让进程不能等输入 → 行为偏离 (要么命令错要么 exitCode 非 0).
       *   这个 test 不一定要绿, 只是文档化 "为什么不能 shell:true".
       *
       *   实际跑出来 zsh -c npx (没参数) + stdin:ignore → npx 报 stdin 不可用退出非 0.
       *   或者 zsh -c 收到的拼接命令在你的 shell 上格式特殊. 不强求结果, 只警告. */
      const r = await execa('/bin/zsh', ['-lc', 'npx --version'], {
        shell: true,
        stdin: 'ignore',
        cwd: process.cwd(),
        reject: false,
        timeout: 8_000,
      });
      // 不强 assert exitCode (各 shell 解析行为不同), 只确认没卡 (因为 stdin:ignore 兜底).
      expect(r.timedOut, '即使 shell:true 错误用法, stdin:ignore 也必须防卡').toBeFalsy();
    }, 12_000);
  });

  describe('P0-2: explore 必须在 PARALLEL_SAFE_TOOLS 白名单', () => {
    it('explore 必须是 parallel-safe (修前缺这一行, 5 个并行变 sequential)', () => {
      expect(PARALLEL_SAFE_TOOLS.has('explore'), 'explore 必须在白名单, 否则 sub-agent 串行').toBe(true);
      expect(isParallelSafeTool('explore'), 'isParallelSafeTool API 也必须认').toBe(true);
      expect(isParallelSafeTool('EXPLORE'), '大小写不敏感').toBe(true);
    });

    it('agent 工具也必须保留 (历史就是 parallel-safe, 不能误删)', () => {
      expect(PARALLEL_SAFE_TOOLS.has('agent')).toBe(true);
    });

    it('核心只读工具必须保留 — readfile/search/grep/glob', () => {
      for (const tool of ['readfile', 'search', 'grep', 'glob', 'list_directory', 'smart_read']) {
        expect(PARALLEL_SAFE_TOOLS.has(tool), `${tool} 不该被误删出白名单`).toBe(true);
      }
    });

    it('写类工具不能误进白名单 (会破坏 state 隔离)', () => {
      for (const tool of ['write_file', 'edit', 'edit_file', 'delete']) {
        expect(PARALLEL_SAFE_TOOLS.has(tool), `${tool} 不能 parallel-safe, 会冲突`).toBe(false);
      }
    });
  });
});
