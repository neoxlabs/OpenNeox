
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { filterToolsByAgentMode, toolPackRegistry } from '../toolPack.js';
import { BUILTIN_PACKS } from '../builtinPacks.js';

/* 注册表是模块级单例; 保证内置包已注册 (幂等)。 */
for (const pack of BUILTIN_PACKS) toolPackRegistry.register(pack);

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    group: 'agent',
    parameters: { type: 'object', properties: {} },
    function: async () => '',
  } as unknown as Tool;
}

const NAMES = [
  /* 执行原语 — work 要有 */
  'execute_shell', 'bash_output', 'bash_kill',
  /* 开发环境 — work 不要 */
  'execute_python', 'run_dev_server', 'service_scan', 'PowerShell',
  /* 代码专用 — work 不要 */
  'git_status', 'set_breakpoint', 'enter_worktree', 'search_symbol', 'run_tests',
  /* pptx */
  'create_slides', 'list_slide_templates', 'deck_begin', 'deck_add_slide', 'deck_export',
  /* 通用 */
  'write_file', 'use_skill', 'open_surface',
];

const allTools = NAMES.map(fakeTool);
const namesFor = (mode: 'work' | 'code') =>
  new Set(filterToolsByAgentMode(allTools, mode).map(t => t.name));

describe('work 模式工具面', () => {
  it('能执行命令: execute_shell / bash_output / bash_kill 都在', () => {
    const work = namesFor('work');
    expect(work.has('execute_shell')).toBe(true);
    expect(work.has('bash_output')).toBe(true);
    expect(work.has('bash_kill')).toBe(true);
  });

  it('拿不到开发环境与代码专用工具', () => {
    const work = namesFor('work');
    for (const n of ['execute_python', 'run_dev_server', 'service_scan', 'PowerShell',
                     'git_status', 'set_breakpoint', 'enter_worktree', 'search_symbol', 'run_tests']) {
      expect(work.has(n), `${n} 不该出现在工作模式`).toBe(false);
    }
  });

  it('pptx 在 work 可用: 逐页三件套 (主路) + create_slides (5 页快捷口)', () => {
    const work = namesFor('work');
    for (const n of ['deck_begin', 'deck_add_slide', 'deck_export', 'create_slides', 'list_slide_templates']) {
      expect(work.has(n), `${n} 应该在工作模式可用`).toBe(true);
    }
  });
});

describe('code 模式', () => {
  it('全集不变 —— 存量行为零变化', () => {
    const code = namesFor('code');
    expect(code.size).toBe(NAMES.length);
  });
});
