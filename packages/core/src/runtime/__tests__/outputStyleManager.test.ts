import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let home: string;
vi.mock('@neoxlabs/kernel/platform/neoxHome.js', () => ({
  neoxHome: (...parts: string[]) => join(home, ...parts),
}));

const { listOutputStyles, outputStylePrompt, BUILTIN_OUTPUT_STYLES } = await import('../outputStyleManager.js');

describe('outputStyleManager', () => {
  let work: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'neox-os-home-'));
    work = mkdtempSync(join(tmpdir(), 'neox-os-work-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('standard / 未配置 → 不追加任何东西', () => {
    expect(outputStylePrompt(undefined)).toBe('');
    expect(outputStylePrompt('standard')).toBe('');
  });

  it('其余内置档各有一段', () => {
    for (const id of BUILTIN_OUTPUT_STYLES.filter((s) => s !== 'standard')) {
      expect(outputStylePrompt(id)).toMatch(/^## Reply style:/);
    }
  });

  it('自定义风格: 读正文、剥 frontmatter; 项目目录同名优先', () => {
    mkdirSync(join(home, 'output-styles'), { recursive: true });
    writeFileSync(join(home, 'output-styles', 'pirate.md'), '---\nname: Pirate\ndescription: Talk like a pirate\n---\nSay arr.');
    writeFileSync(join(home, 'output-styles', 'teacher.md'), 'Explain like a teacher.');
    mkdirSync(join(work, '.neox', 'output-styles'), { recursive: true });
    writeFileSync(join(work, '.neox', 'output-styles', 'teacher.md'), 'Project teacher.');

    expect(outputStylePrompt('custom:pirate', work)).toBe('## Reply style: pirate\nSay arr.');
    expect(outputStylePrompt('custom:teacher', work)).toBe('## Reply style: teacher\nProject teacher.');

    const list = listOutputStyles(work);
    expect(list.slice(0, 4).map((s) => s.id)).toEqual(['standard', 'concise', 'detailed', 'code_only']);
    expect(list.find((s) => s.id === 'custom:pirate')).toMatchObject({ name: 'Pirate', description: 'Talk like a pirate', builtin: false });
    expect(list.filter((s) => s.id === 'custom:teacher')).toHaveLength(1);
  });

  it('找不到的自定义风格 / 不安全的名字 → 退回标准, 不抛错', () => {
    expect(outputStylePrompt('custom:missing', work)).toBe('');
    expect(outputStylePrompt('custom:../../etc/passwd', work)).toBe('');
    expect(outputStylePrompt('nonsense')).toBe('');
  });
});
