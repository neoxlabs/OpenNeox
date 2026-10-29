/**
 * work:Q-11 项目口径 (受众 / 口吻 / 模板 / 禁写项) —— 走真实 IPC 的端到端
 * ═══════════════════════════════════════════════════════════════════════
 * 单元测试只证明 composeInstructions 会拼这段文字; 这里证明**点保存之后磁盘上真的变了**:
 *   · .neox-project.json 里存下四项;
 *   · .neox/INSTRUCTIONS.md 里出现「项目口径」一节 (runtime 靠父目录扫描自动带进 system prompt);
 *   · 清空四项后这一节消失 (不会留下过时的口径)。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ handlers: new Map<string, (...a: any[]) => any>(), home: '' }));

vi.mock('../ipcMainBridged.js', () => ({
  ipcMain: { handle: (channel: string, fn: (...a: any[]) => any) => h.handlers.set(channel, fn) },
}));
vi.mock('@neoxlabs/platform/platform/database.js', () => ({ getDatabase: () => ({}) }));
vi.mock('@neoxlabs/core/runtime/modeHome.js', () => ({
  ensureModeHome: () => h.home,
  getModeHomeDir: () => h.home,
}));

const { registerWorkProjectIpcHandlers } = await import('../workProjectHandlers');

let home: string;
let projectDir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-profile-'));
  h.home = home;
  h.handlers.clear();
  registerWorkProjectIpcHandlers();
  projectDir = path.join(home, '咖啡店运营');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.neox-project.json'), '{}');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** ipcMain.handle 的 fn 第一个参数是 event —— 这里补个空对象 */
const invoke = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args);
const instructions = () => fs.readFileSync(path.join(projectDir, '.neox', 'INSTRUCTIONS.md'), 'utf8');
const marker = () => JSON.parse(fs.readFileSync(path.join(projectDir, '.neox-project.json'), 'utf8'));

describe('work-project:save-profile', () => {
  it('四项存进标记文件, 并写进给 agent 看的那份', async () => {
    const r = await invoke('work-project:save-profile', projectDir, {
      audience: '加盟商和店长',
      tone: '务实，不用形容词',
      template: '沿用 2026 春季周报',
      forbidden: '不写「保证」「第一」',
    });
    expect(r.ok).toBe(true);
    expect(marker().profile).toEqual({
      audience: '加盟商和店长',
      tone: '务实，不用形容词',
      template: '沿用 2026 春季周报',
      forbidden: '不写「保证」「第一」',
    });
    const text = instructions();
    expect(text).toContain('## 项目口径');
    expect(text).toContain('受众：加盟商和店长');
    expect(text).toContain('source=project');
  });

  it('只填一项就只存一项; 清空后标记和指令里都不留', async () => {
    await invoke('work-project:save-profile', projectDir, { audience: '老板' });
    expect(marker().profile).toEqual({ audience: '老板' });
    expect(instructions()).not.toContain('口吻：');

    const cleared = await invoke('work-project:save-profile', projectDir, {});
    expect(cleared.ok).toBe(true);
    expect(marker().profile).toBeUndefined();
    expect(instructions()).not.toContain('## 项目口径');
  });

  it('detail 把口径带回来 (刷新后还在)', async () => {
    await invoke('work-project:save-profile', projectDir, { tone: '口语一点' });
    const d = await invoke('work-project:detail', projectDir);
    expect(d.ok).toBe(true);
    expect(d.profile).toEqual({ tone: '口语一点' });
  });

  it('工作目录外的路径一律拒绝 (挡掉渲染层传来的任意路径)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-outside-'));
    fs.writeFileSync(path.join(outside, '.neox-project.json'), '{}');
    try {
      const r = await invoke('work-project:save-profile', outside, { audience: 'x' });
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
