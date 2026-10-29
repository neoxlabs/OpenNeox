import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { validateWorkspacePath, validateAgainstWorkspaceRoots } from '../fileEditHandlers.js';

/* 用当前平台的绝对路径构造, 保证 macOS / Windows 都跑得过 */
const PRIMARY = path.resolve('/tmp/work/kyx-service');
const SIBLING = path.resolve('/tmp/work/kyx-common');
const OUTSIDE = path.resolve('/tmp/elsewhere/secret.txt');

describe('多根工作区路径校验', () => {
  it('主根内的文件 — 放行 (原有行为)', () => {
    const f = path.join(PRIMARY, 'src/main/java/App.java');
    expect(validateAgainstWorkspaceRoots(PRIMARY, f, [])).toBe(f);
  });

  it('次级根内的文件 — 放行 (这就是修的那个 bug)', () => {
    const f = path.join(SIBLING, 'src/main/java/com/kyx/common/core/domain/BaseEntity.java');
    /* 只给主根 → 老行为: 抛 Path traversal */
    expect(() => validateWorkspacePath(PRIMARY, f)).toThrow(/Path traversal/);
    /* 带上已登记的次级根 → 放行 */
    expect(validateAgainstWorkspaceRoots(PRIMARY, f, [SIBLING])).toBe(f);
  });

  it('真的越权 — 所有根都不含它, 仍然拒', () => {
    expect(() => validateAgainstWorkspaceRoots(PRIMARY, OUTSIDE, [SIBLING])).toThrow();
  });

  it('绝对路径不在任何根内 → 说人话并给出路, 不用 traversal 措辞', () => {
    let msg = '';
    try { validateAgainstWorkspaceRoots(PRIMARY, OUTSIDE, [SIBLING]); } catch (e: any) { msg = e.message; }
    expect(msg).toContain('不在当前工作区的任何根目录内');
    expect(msg).toContain(PRIMARY);
    expect(msg).toContain(SIBLING);
    expect(msg).not.toContain('Path traversal');
  });

  it('相对路径越权 (../../etc/passwd) — 任何根下都拒', () => {
    expect(() => validateAgainstWorkspaceRoots(PRIMARY, '../../etc/passwd', [SIBLING])).toThrow(/Path traversal/);
  });

  it('前缀混淆 (kyx-service vs kyx-service-old) — 不能因为字符串前缀就放行', () => {
    const confusing = path.resolve('/tmp/work/kyx-service-old/x.java');
    /* 仍然拒 (措辞是"不在任何根内", 因为它是绝对路径而非相对逃逸) */
    expect(() => validateAgainstWorkspaceRoots(PRIMARY, confusing, [SIBLING])).toThrow(/不在当前工作区的任何根目录内/);
  });

  it('报错信息始终带着用户看得懂的原始路径', () => {
    expect(() => validateAgainstWorkspaceRoots(PRIMARY, OUTSIDE, [SIBLING]))
      .toThrow(new RegExp(OUTSIDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('根列表为空 / 含空串 / 含主根自身 — 都不炸', () => {
    const f = path.join(PRIMARY, 'a.txt');
    expect(validateAgainstWorkspaceRoots(PRIMARY, f, [])).toBe(f);
    expect(validateAgainstWorkspaceRoots(PRIMARY, f, ['', PRIMARY])).toBe(f);
  });
});
