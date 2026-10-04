import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { SkillLoader } = await import('../loader.js');
const loader = new SkillLoader();

describe('frontmatter 边界', () => {
  it('UTF-8 BOM 开头 (Windows 记事本存的) → 照常解析', () => {
    const BOM = String.fromCharCode(0xfeff);
    const { metadata, body } = loader.parseSkillFile(`${BOM}---\nname: bom\ndescription: saved by notepad\n---\nbody`);
    expect(metadata.name).toBe('bom');
    expect(body.trim()).toBe('body');
  });

  it('CRLF 换行 → 照常解析, 值里不带 \\r', () => {
    const { metadata } = loader.parseSkillFile('---\r\nname: crlf\r\ndescription: windows line endings\r\n---\r\nbody\r\n');
    expect(metadata.name).toBe('crlf');
    expect(metadata.description).toBe('windows line endings');
  });

  it('文件在结束 --- 处结束 (没有正文, 也没有末尾换行) → 照常解析', () => {
    const { metadata } = loader.parseSkillFile('---\nname: tiny\ndescription: no body\n---');
    expect(metadata.name).toBe('tiny');
    expect(metadata.description).toBe('no body');
  });

  it('description 用 YAML 折叠块 (>- / |) → 拿到正文, 不是字面量 ">"', () => {
    const folded = loader.parseSkillFile(`---
name: folded
description: >-
  Use this skill when the user asks
  about release notes.
version: 1.2.0
---
body`).metadata;
    expect(folded.description).toBe('Use this skill when the user asks about release notes.');
    expect(folded.version).toBe('1.2.0');

    const literal = loader.parseSkillFile(`---
name: literal
description: |
  Line one
  Line two
---
body`).metadata;
    expect(literal.description).toBe('Line one\nLine two');
  });

  it('普通标量折行 (description 续行缩进) → 拼成一句, 不丢后半截', () => {
    const { metadata } = loader.parseSkillFile(`---
name: wrap
description: Use when the user wants
  to publish a release
paths:
  - "src/**"
---
x`);
    expect(metadata.description).toBe('Use when the user wants to publish a release');
    expect(metadata.paths).toEqual(['src/**']);
  });

  it('name 是纯数字 → 技能照常加载, name 是字符串 (registry 里会 .toLowerCase())', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-skill-num-'));
    try {
      fs.mkdirSync(path.join(dir, 'game'));
      fs.writeFileSync(path.join(dir, 'game', 'SKILL.md'), '---\nname: 2048\ndescription: play\n---\nx');
      const [skill] = await loader.loadFromDirectory(dir, 'user');
      expect(typeof skill.metadata.name).toBe('string');
      expect(skill.metadata.name.toLowerCase()).toBe('2048');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('版本号 / 纯数字名字保持字符串 (1.10 不许变成 1.1)', () => {
    const { metadata } = loader.parseSkillFile('---\nname: 2048\ndescription: d\nversion: 1.10\n---\nx');
    expect(metadata.version).toBe('1.10');
    expect(metadata.name).toBe('2048');
  });
});

describe('loadFromDirectory 目录形态', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-skill-edge-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeSkill = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} desc\n---\nbody`);
  };

  it('软链进 skills 目录的技能 → 被加载 (统一放在 git 仓里再软链进来是常见管理方式)', async () => {
    const skillsDir = path.join(root, 'skills');
    fs.mkdirSync(skillsDir);
    const real = path.join(root, 'repo', 'linked-skill');
    writeSkill(real, 'linked-skill');
    fs.symlinkSync(real, path.join(skillsDir, 'linked-skill'), 'dir');
    writeSkill(path.join(skillsDir, 'plain-skill'), 'plain-skill');

    const skills = await loader.loadFromDirectory(skillsDir, 'user');
    expect(skills.map((s) => s.id).sort()).toEqual(['linked-skill', 'plain-skill']);
  });

  it('死链 / 链到文件 → 跳过, 不影响别的', async () => {
    const skillsDir = path.join(root, 'skills');
    fs.mkdirSync(skillsDir);
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(skillsDir, 'dead'), 'dir');
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    fs.symlinkSync(path.join(root, 'file.txt'), path.join(skillsDir, 'to-file'));
    writeSkill(path.join(skillsDir, 'ok'), 'ok');
    const skills = await loader.loadFromDirectory(skillsDir, 'user');
    expect(skills.map((s) => s.id)).toEqual(['ok']);
  });
});
