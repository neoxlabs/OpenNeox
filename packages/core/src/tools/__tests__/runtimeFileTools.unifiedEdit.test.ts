import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createRuntimeFileTools } from '../files/runtimeFileTools.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-runtime-file-tools-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildRuntimeFileTools(workspaceDir: string) {
  return createRuntimeFileTools({
    formatDisplayPath: (absPath: string) => path.relative(workspaceDir, absPath),
    getWorkspaceRoot: () => workspaceDir,    resolveWorkspacePath: (requestedPath?: string) => path.resolve(workspaceDir, requestedPath || ''),
  });
}

/* edit 已改内容寻址 (old_string/new_string), 不再有 line-range + expected_hash。
 * 这套用例全部照新 API 走。 */
describe('runtime unified edit tool (content-addressed)', () => {
  it('routes targeted edit via old_string and rewrites tool name to edit', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'app.ts'), 'const a = 1;\n', 'utf-8');
      const tools = buildRuntimeFileTools(dir);
      const raw = await tools.edit.function({
        file_path: 'app.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
      });
      const result = JSON.parse(String(raw));
      expect(result.status).toBe('success');
      expect(result.tool).toBe('edit');
      const updated = await fs.readFile(path.join(dir, 'app.ts'), 'utf-8');
      expect(updated).toContain('const a = 2;');
    });
  });

  /* 起 old_string 找不到时不再一律报 string_not_found, 而是先做**一致性诊断**
   * (readLedger.checkCoherence): 三种情况给的下一步完全不同, 混成一个错误码模型只能瞎猜。
   *     unread → 没读过, old_string 是拼的  → 让它先读        (本例: 文件从未被 readfile 过)
   *     stale  → 读过但文件已变              → 让它重读
   *     fresh  → 读过且文件没变 ⇒ 自己抄错了  → 摊出文件里真实那段
   *  这个测例在改动后红了两天没人发现 —— 该文件长期不在 scripts/test-runner.ts 的
   *   TEST_MODULES 手工清单里, test:ci 从来跑不到它。 */
  it('未读过就编辑 → file_not_read (让它先读, 而不是笼统的 string_not_found)', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'app.ts'), 'const a = 1;\n', 'utf-8');
      const tools = buildRuntimeFileTools(dir);
      const raw = await tools.edit.function({
        file_path: 'app.ts',
        old_string: 'const NOPE = 9;',
        new_string: 'x',
      });
      const result = JSON.parse(String(raw));
      expect(result.status).toBe('error');
      expect(result.error).toBe('file_not_read');
    });
  });

  it('errors with ambiguous_match when old_string is not unique and replace_all is false', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'app.ts'), 'x = 1;\nx = 1;\n', 'utf-8');
      const tools = buildRuntimeFileTools(dir);
      const raw = await tools.edit.function({
        file_path: 'app.ts',
        old_string: 'x = 1;',
        new_string: 'x = 2;',
      });
      const result = JSON.parse(String(raw));
      expect(result.status).toBe('error');
      expect(result.error).toBe('ambiguous_match');
    });
  });

  it('replace_all replaces every occurrence', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'app.ts'), 'x = 1;\nx = 1;\nx = 1;\n', 'utf-8');
      const tools = buildRuntimeFileTools(dir);
      const raw = await tools.edit.function({
        file_path: 'app.ts',
        old_string: 'x = 1;',
        new_string: 'x = 2;',
        replace_all: true,
      });
      const result = JSON.parse(String(raw));
      expect(result.status).toBe('success');
      expect(result.metadata.replacements).toBe(3);
      expect((await fs.readFile(path.join(dir, 'app.ts'), 'utf-8'))).toBe('x = 2;\nx = 2;\nx = 2;\n');
    });
  });

  it('M1 edit_batch: applies multiple file edits in one call (partial success default)', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'a.ts'), 'line A1\nline A2\nline A3\n', 'utf-8');
      await fs.writeFile(path.join(dir, 'b.ts'), 'line B1\nline B2\n', 'utf-8');
      const tools = buildRuntimeFileTools(dir);

      const raw = await tools.editBatch.function({
        edits: [
          { file_path: 'a.ts', old_string: 'line A2', new_string: 'line A2 EDITED' },
          { file_path: 'b.ts', old_string: 'line B1', new_string: 'line B1 EDITED' },
        ],
      });
      const result = JSON.parse(String(raw));
      expect(result.status).toBe('success');
      expect(result.metadata.success).toBe(2);
      expect(result.metadata.failed).toBe(0);
      expect(result.metadata.results.length).toBe(2);
      expect((await fs.readFile(path.join(dir, 'a.ts'), 'utf-8'))).toContain('line A2 EDITED');
      expect((await fs.readFile(path.join(dir, 'b.ts'), 'utf-8'))).toContain('line B1 EDITED');
    });
  });

  it('M1 edit_batch: partial success — one missing old_string fails, the other succeeds', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'a.ts'), 'one\ntwo\n', 'utf-8');
      await fs.writeFile(path.join(dir, 'b.ts'), 'foo\nbar\n', 'utf-8');
      const tools = buildRuntimeFileTools(dir);

      const raw = await tools.editBatch.function({
        edits: [
          { file_path: 'a.ts', old_string: 'one', new_string: 'ONE' },
          { file_path: 'b.ts', old_string: 'NOT_PRESENT', new_string: 'FOO' },
        ],
      });
      const result = JSON.parse(String(raw));
      expect(result.metadata.success).toBe(1);
      expect(result.metadata.failed).toBe(1);
      expect(result.metadata.firstFailureIdx).toBe(1);
      /* a.ts 已成功提交, b.ts 没动 */
      expect((await fs.readFile(path.join(dir, 'a.ts'), 'utf-8'))).toContain('ONE');
      expect((await fs.readFile(path.join(dir, 'b.ts'), 'utf-8'))).toContain('foo');
      expect(result.metadata.rollback_required).toBe(false);
    });
  });

  it('M1 edit_batch: atomic=true marks rollback_required when any entry fails', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'a.ts'), 'x\n', 'utf-8');
      const tools = buildRuntimeFileTools(dir);

      const raw = await tools.editBatch.function({
        edits: [
          { file_path: 'a.ts', old_string: 'x', new_string: 'Y' },
          { file_path: 'a.ts', old_string: 'NOT_PRESENT', new_string: 'Z' },
        ],
        atomic: true,
      });
      const result = JSON.parse(String(raw));
      expect(result.metadata.atomic).toBe(true);
      expect(result.metadata.rollback_required).toBe(true);
      expect(result.metadata.failed).toBe(1);
    });
  });

  it('M1 edit_batch: empty edits → error', async () => {
    await withTempDir(async (dir) => {
      const tools = buildRuntimeFileTools(dir);
      const raw = await tools.editBatch.function({ edits: [] });
      const result = JSON.parse(String(raw));
      expect(result.status).toBe('error');
      /* createEphemeralResult 把 error 放顶层不是 metadata */
      expect(result.error).toBe('edits_required');
    });
  });

  it('rejects patch payload via edit and guides to old_string', async () => {
    await withTempDir(async (dir) => {
      const tools = buildRuntimeFileTools(dir);
      const patch = [
        '*** Begin Patch',
        '*** Add File: hello.txt',
        '+hello',
        '*** End Patch',
      ].join('\n');
      const raw = await tools.edit.function({ patch });
      const result = JSON.parse(String(raw));
      expect(result.status).toBe('error');
      expect(result.error).toBe('patch_not_supported');
    });
  });
});
