import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let TMP_HOME: string;
let WORK: string;
let store: typeof import('../fileSnapshotStore.js');
let cfg: typeof import('@neoxlabs/platform/utils/config.js');
let writeMod: typeof import('../writeFileTool.js');

const ORIGINAL_HOME = process.env.HOME;

beforeAll(async () => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-snap-test-'));
  process.env.HOME = TMP_HOME;
  WORK = path.join(TMP_HOME, 'work');
  fs.mkdirSync(WORK, { recursive: true });

  cfg = await import('@neoxlabs/platform/utils/config.js');
  if (!cfg.getActiveConfigDir().startsWith(TMP_HOME)) {
    throw new Error(`配置目录未重定向到沙箱 (${cfg.getActiveConfigDir()}) — 中止`);
  }
  store = await import('../fileSnapshotStore.js');
  writeMod = await import('../writeFileTool.js');
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeTool() {
  return writeMod.createWriteFileTool({
    resolveWorkspacePath: (p?: string) => path.resolve(WORK, p || ''),
  });
}

async function callWrite(args: Record<string, unknown>) {
  const tool = makeTool();
  return JSON.parse(await (tool as any).function(args));
}

describe('fileSnapshotStore', () => {
  it('存进去的内容能原样取回来', async () => {
    const saved = await store.saveFileSnapshot('/x/y.txt', 'hello\nworld');
    expect(saved.id).toBeDefined();
    expect(saved.lines).toBe(2);
    await expect(store.readFileSnapshot(saved.id!)).resolves.toBe('hello\nworld');
  });

  it('非法 id 一律拒绝 —— 防路径穿越', async () => {
    await expect(store.readFileSnapshot('../../../etc/passwd')).resolves.toBeNull();
    await expect(store.readFileSnapshot('nope')).resolves.toBeNull();
  });

  it('超大文件跳过快照, 并如实标 too_large (不假装存了)', async () => {
    const huge = 'x'.repeat(9 * 1024 * 1024);
    const r = await store.saveFileSnapshot('/x/huge.bin', huge);
    expect(r.id).toBeUndefined();
    expect(r.skipped).toBe('too_large');
  });
});

describe('write_file 覆盖前留快照', () => {
  it('覆盖已有文件 → 快照能还原出被覆盖掉的原内容', async () => {
    const target = path.join(WORK, 'notes.md');
    const original = '# 我手写了半天的东西\n第二行\n第三行';
    await fsp.writeFile(target, original, 'utf-8');

    const res = await callWrite({ file_path: 'notes.md', content: '被 agent 整个覆盖了' });
    expect(res.status).toBe('success');

    // 磁盘确实被覆盖
    await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('被 agent 整个覆盖了');

    // 但原内容能从快照拿回来 —— 这就是 Undo 的依据
    const snapId = res.metadata?.previous?.snapshot_id;
    expect(snapId).toBeTruthy();
    await expect(store.readFileSnapshot(snapId)).resolves.toBe(original);
  });

  it('返回值里不得出现原内容 —— 它是要发给 LLM 的, 塞进去就是烧 token', async () => {
    const target = path.join(WORK, 'big.txt');
    const original = Array.from({ length: 500 }, (_, i) => `原始第 ${i} 行`).join('\n');
    await fsp.writeFile(target, original, 'utf-8');

    const res = await callWrite({ file_path: 'big.txt', content: 'tiny' });
    const serialized = JSON.stringify(res);

    expect(serialized).not.toContain('原始第 0 行');
    expect(serialized).not.toContain('原始第 499 行');
    // 只带 id 和数字
    expect(res.metadata.previous.snapshot_id).toMatch(/^[a-z0-9]+-[a-f0-9]{12}$/);
    expect(res.metadata.previous.lines).toBe(500);
  });

  it('新建文件不产生快照 (没有原内容可丢)', async () => {
    const res = await callWrite({ file_path: 'brand-new.txt', content: 'first' });
    expect(res.status).toBe('success');
    expect(res.metadata.action).toBe('created');
    expect(res.metadata.previous).toBeUndefined();
  });

  it('append 不产生快照 (不销毁原内容)', async () => {
    const target = path.join(WORK, 'log.txt');
    await fsp.writeFile(target, 'line1\n', 'utf-8');
    const res = await callWrite({ file_path: 'log.txt', content: 'line2\n', mode: 'append' });
    expect(res.status).toBe('success');
    expect(res.metadata.previous).toBeUndefined();
    await expect(fsp.readFile(target, 'utf-8')).resolves.toBe('line1\nline2\n');
  });
});

describe('删除前快照 (delete_file 可恢复)', () => {
  it('单文件: 删掉后能原样恢复', async () => {
    const f = path.join(WORK, 'to-delete.txt');
    await fsp.writeFile(f, '别删我\n第二行', 'utf-8');

    const snap = await store.saveDeletionSnapshot(f);
    expect(snap.manifestId).toBeTruthy();
    expect(snap.fileCount).toBe(1);

    await fsp.rm(f);
    expect(fs.existsSync(f)).toBe(false);

    const r = await store.restoreDeletionSnapshot(snap.manifestId!);
    expect(r.success).toBe(true);
    expect(r.restored).toBe(1);
    await expect(fsp.readFile(f, 'utf-8')).resolves.toBe('别删我\n第二行');
  });

  it('目录: 递归删掉后连子目录结构一起恢复', async () => {
    const dir = path.join(WORK, 'proj');
    await fsp.mkdir(path.join(dir, 'src', 'deep'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'AAA', 'utf-8');
    await fsp.writeFile(path.join(dir, 'src', 'b.txt'), 'BBB', 'utf-8');
    await fsp.writeFile(path.join(dir, 'src', 'deep', 'c.txt'), 'CCC', 'utf-8');

    const snap = await store.saveDeletionSnapshot(dir);
    expect(snap.fileCount).toBe(3);

    await fsp.rm(dir, { recursive: true });
    expect(fs.existsSync(dir)).toBe(false);

    const r = await store.restoreDeletionSnapshot(snap.manifestId!);
    expect(r.restored).toBe(3);
    await expect(fsp.readFile(path.join(dir, 'src', 'deep', 'c.txt'), 'utf-8')).resolves.toBe('CCC');
    await expect(fsp.readFile(path.join(dir, 'a.txt'), 'utf-8')).resolves.toBe('AAA');
  });

  it('过期/不存在的 manifest 给明确原因, 不是裸报错', async () => {
    const r = await store.restoreDeletionSnapshot('zzzz-aaaaaaaaaaaa');
    expect(r.success).toBe(false);
    expect(r.error).toContain('过期');
  });
});

describe('delete_file 工具级', () => {
  async function callDelete(args: Record<string, unknown>) {
    const mut = await import('../fileMutationTools.js');
    const tool = mut.createDeleteFileTool({
      resolveWorkspacePath: (p?: string) => path.resolve(WORK, p || ''),
      formatDisplayPath: (p: string) => p,
      getWorkspaceRoot: () => WORK,    } as any);
    return JSON.parse(await (tool as any).function(args));
  }

  it('删掉的文件能靠结果里的 manifest id 恢复回来', async () => {
    const f = path.join(WORK, 'agent-will-delete.txt');
    await fsp.writeFile(f, '重要内容', 'utf-8');

    const res = await callDelete({ path: 'agent-will-delete.txt' });
    expect(res.status).toBe('success');
    expect(fs.existsSync(f)).toBe(false);
    expect(res.metadata.recoverable).toBe(true);

    const r = await store.restoreDeletionSnapshot(res.metadata.deletion_snapshot_id);
    expect(r.restored).toBe(1);
    await expect(fsp.readFile(f, 'utf-8')).resolves.toBe('重要内容');
  });

  it('返回值不含被删文件的内容 (同样会进 LLM 上下文)', async () => {
    const f = path.join(WORK, 'secret.txt');
    await fsp.writeFile(f, 'TOP-SECRET-NEEDLE', 'utf-8');
    const res = await callDelete({ path: 'secret.txt' });
    expect(JSON.stringify(res)).not.toContain('TOP-SECRET-NEEDLE');
  });

  it('回归: 目录不带 recursive 仍然拒删 (重构守卫时别改坏语义)', async () => {
    const d = path.join(WORK, 'guarded-dir');
    await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(path.join(d, 'x.txt'), 'x', 'utf-8');

    const res = await callDelete({ path: 'guarded-dir' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('recursive');
    expect(fs.existsSync(d)).toBe(true);   // 目录必须还在
  });

  it('目录带 recursive: 删得掉, 且整棵树能恢复', async () => {
    const d = path.join(WORK, 'nuke-me');
    await fsp.mkdir(path.join(d, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(d, 'sub', 'y.txt'), 'YYY', 'utf-8');

    const res = await callDelete({ path: 'nuke-me', recursive: true });
    expect(res.status).toBe('success');
    expect(fs.existsSync(d)).toBe(false);

    await store.restoreDeletionSnapshot(res.metadata.deletion_snapshot_id);
    await expect(fsp.readFile(path.join(d, 'sub', 'y.txt'), 'utf-8')).resolves.toBe('YYY');
  });
});
