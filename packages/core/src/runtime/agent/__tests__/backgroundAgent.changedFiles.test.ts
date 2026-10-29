/**
 * 改动文件清单单测 — updateProgress 收集 + completion XML <changed-files> + 同步尾注。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueued: string[] = [];
vi.mock('../../shell/backgroundTaskNotifier.js', () => ({
  getBackgroundTaskNotifier: () => ({
    enqueueMessageForSession: (_sid: string, msg: string) => { enqueued.push(msg); },
  }),
}));
vi.mock('../../agentThreadContext.js', () => ({
  getAgentThreadContext: () => ({ checkCanSpawnOrThrow: () => {} }),
}));
vi.mock('@neoxlabs/platform/platform/osNotifier.js', () => ({ sendOsNotification: vi.fn() }));

import { BackgroundAgentManager } from '../backgroundAgent.js';

function toolEnd(name: string, targetPath?: string, extra: Record<string, any> = {}) {
  return { type: 'tool_call_end', name, targetPath, success: true, ...extra };
}

describe('changed-files 收集与透出', () => {
  let mgr: BackgroundAgentManager;

  beforeEach(() => {
    enqueued.length = 0;
    mgr = new BackgroundAgentManager();
  });

  it('收集写工具路径并计数, 只读工具和失败写入不计', () => {
    const task = mgr.register('a1', 'desc', 'p');
    mgr.updateProgress('a1', toolEnd('write_file', 'views/index.ejs'));
    mgr.updateProgress('a1', toolEnd('edit_file', 'views/index.ejs'));
    mgr.updateProgress('a1', toolEnd('readfile', 'css/style.css'));
    mgr.updateProgress('a1', { type: 'tool_call_end', name: 'write_file', targetPath: 'bad.ejs', success: false });
    mgr.updateProgress('a1', toolEnd('edit', undefined, { args: { file_path: 'routes/pets.js' } }));

    expect(task.changedFiles.get('views/index.ejs')).toBe(2);
    expect(task.changedFiles.get('routes/pets.js')).toBe(1);
    expect(task.changedFiles.has('css/style.css')).toBe(false);
    expect(task.changedFiles.has('bad.ejs')).toBe(false);
  });

  it('getChangedFilesNote 输出尾注, 无改动返回空串', () => {
    mgr.register('a2', 'desc', 'p');
    expect(mgr.getChangedFilesNote('a2')).toBe('');
    mgr.updateProgress('a2', toolEnd('write_file', 'x.ts'));
    mgr.updateProgress('a2', toolEnd('write_file', 'x.ts'));
    const note = mgr.getChangedFilesNote('a2');
    expect(note).toContain('[Changed files]');
    expect(note).toContain('x.ts (x2)');
  });

  it('后台完成通知 XML 带 <changed-files>', () => {
    mgr.register('a3', 'desc', 'p', 'session-1');
    mgr.updateProgress('a3', toolEnd('write_file', 'views/detail.ejs'));
    mgr.complete('a3', 'done');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toContain('<changed-files>');
    expect(enqueued[0]).toContain('views/detail.ejs');
  });

  it('无改动时 XML 不含 <changed-files> 节', () => {
    mgr.register('a4', 'desc', 'p', 'session-1');
    mgr.complete('a4', 'read-only done');
    expect(enqueued[0]).not.toContain('<changed-files>');
  });
});
