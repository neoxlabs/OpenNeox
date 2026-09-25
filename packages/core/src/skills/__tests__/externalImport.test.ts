import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { SkillRegistry } from '../registry.js';

let tempHome: string;
let homeBackup: string | undefined;

const writeSkill = (dir: string, id: string, name: string, extra?: Record<string, string>) => {
  const d = path.join(dir, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: "${name}"\ndescription: "desc of ${name}"\n---\n\n## Overview\n\nbody\n`);
  for (const [rel, content] of Object.entries(extra ?? {})) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return d;
};

/* 改 $HOME 让 os.homedir() 指临时目录 —— 跟 installManager.test.ts 同一套做法。
 * (不 stub os.homedir: ESM 下模块导出是只读绑定, 赋值在部分 runtime 里直接抛。) */
beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-skill-ext-'));
  homeBackup = process.env.HOME;
  process.env.HOME = tempHome;
});
afterEach(() => {
  process.env.HOME = homeBackup;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('discoverExternalSkills', () => {
  it('扫到 Claude Code 和 Codex 两边的技能', () => {
    writeSkill(path.join(tempHome, '.claude', 'skills'), 'hyperframes', 'hyperframes');
    writeSkill(path.join(tempHome, '.codex', 'skills'), 'codex-only', 'codex-only');
    const found = new SkillRegistry().discoverExternalSkills();
    expect(found.map((f) => f.id).sort()).toEqual(['codex-only', 'hyperframes']);
    expect(found.find((f) => f.id === 'hyperframes')?.source).toBe('Claude Code');
    expect(found.find((f) => f.id === 'codex-only')?.source).toBe('Codex');
    expect(found.find((f) => f.id === 'hyperframes')?.description).toBe('desc of hyperframes');
  });

  it('两边都装了同一个技能只列一次 —— Claude Code 先扫到就用它', () => {
    writeSkill(path.join(tempHome, '.claude', 'skills'), 'dup', 'dup');
    writeSkill(path.join(tempHome, '.codex', 'skills'), 'dup', 'dup');
    const found = new SkillRegistry().discoverExternalSkills();
    expect(found.filter((f) => f.id === 'dup')).toHaveLength(1);
    expect(found[0].source).toBe('Claude Code');
  });

  it('已经导入过的标出来, 不让用户重复点', () => {
    writeSkill(path.join(tempHome, '.claude', 'skills'), 'already', 'already');
    fs.mkdirSync(path.join(tempHome, NEOX_HOME_DIRNAME, 'skills', 'already'), { recursive: true });
    const found = new SkillRegistry().discoverExternalSkills();
    expect(found[0].alreadyImported).toBe(true);
  });

  it('没有 SKILL.md 的目录不算技能', () => {
    fs.mkdirSync(path.join(tempHome, '.claude', 'skills', 'junk'), { recursive: true });
    expect(new SkillRegistry().discoverExternalSkills()).toEqual([]);
  });

  it('目录不存在时返回空数组而不是炸', () => {
    expect(new SkillRegistry().discoverExternalSkills()).toEqual([]);
  });

  it('数清楚附带内容 —— 导入前要让用户看见自己拿到什么', () => {
    writeSkill(path.join(tempHome, '.claude', 'skills'), 'rich', 'rich', {
      'references/a.md': 'a'.repeat(2048),
      'references/b.md': 'b',
      'scripts/run.sh': 'x',
      'agents/sub.md': 'y',
      'extra.json': '{}',
    });
    const [found] = new SkillRegistry().discoverExternalSkills();
    expect(found.assets.references).toBe(2);
    expect(found.assets.scripts).toBe(1);
    expect(found.assets.agents).toBe(1);
    expect(found.assets.other).toBe(1);
    expect(found.assets.bytes).toBeGreaterThan(2048);
  });

  it('SKILL.md 自己不算"附带内容" —— 只有一页说明的技能三个桶都是 0', () => {
    writeSkill(path.join(tempHome, '.claude', 'skills'), 'plain', 'plain');
    const [found] = new SkillRegistry().discoverExternalSkills();
    expect(found.assets).toEqual({ references: 0, scripts: 0, agents: 0, other: 0, bytes: 0 });
  });
});

describe('importFromPath 必须递归拷贝', () => {
  it('references/ scripts/ 子目录跟着一起过来', async () => {
    const src = writeSkill(path.join(tempHome, '.claude', 'skills'), 'deep', 'deep', {
      'references/guide.md': '# guide',
      'scripts/run.sh': 'echo hi',
      'agents/sub/agent.md': '# agent',
      'top.txt': 'top',
    });
    const r = await new SkillRegistry().importFromPath(src, 'user');
    expect(r.success).toBe(true);
    const dest = path.join(tempHome, NEOX_HOME_DIRNAME, 'skills', r.skillId!);
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'top.txt'))).toBe(true);
    /* 修前这三条全是 false —— 只拷顶层文件 */
    expect(fs.readFileSync(path.join(dest, 'references/guide.md'), 'utf-8')).toBe('# guide');
    expect(fs.readFileSync(path.join(dest, 'scripts/run.sh'), 'utf-8')).toBe('echo hi');
    expect(fs.readFileSync(path.join(dest, 'agents/sub/agent.md'), 'utf-8')).toBe('# agent');
  });

  it('.git / node_modules 不跟着进来 —— 有的 skill 目录就是个 clone', async () => {
    const src = writeSkill(path.join(tempHome, '.claude', 'skills'), 'repo', 'repo', {
      '.git/config': 'x',
      'node_modules/pkg/index.js': 'y',
      '.DS_Store': 'z',
      'references/a.md': 'keep',
    });
    const r = await new SkillRegistry().importFromPath(src, 'user');
    const dest = path.join(tempHome, NEOX_HOME_DIRNAME, 'skills', r.skillId!);
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.DS_Store'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'references/a.md'))).toBe(true);
  });
});

describe('description 超长不许把整个技能丢掉', () => {
  it('长描述照常加载, 只把注入用的那份截到 200', async () => {
    const long = 'x'.repeat(260);
    const dir = path.join(tempHome, NEOX_HOME_DIRNAME, 'skills', 'longdesc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: "longdesc"\ndescription: "${long}"\n---\n\n## Overview\n\nbody\n`);

    const { SkillLoader } = await import('../loader.js');
    const skills = await new SkillLoader().loadFromDirectory(path.join(tempHome, NEOX_HOME_DIRNAME, 'skills'), 'user');
    expect(skills.map((s) => s.id)).toContain('longdesc');
    const desc = skills.find((s) => s.id === 'longdesc')!.metadata.description;
    expect(desc.length).toBe(200);
    expect(desc.endsWith('…')).toBe(true);
  });

  it('name 超长仍然拒绝 —— 那是 id 的来源, 截断会撞名', async () => {
    const dir = path.join(tempHome, NEOX_HOME_DIRNAME, 'skills', 'longname');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: "${'n'.repeat(70)}"\ndescription: "ok"\n---\n\nbody\n`);
    const { SkillLoader } = await import('../loader.js');
    const skills = await new SkillLoader().loadFromDirectory(path.join(tempHome, NEOX_HOME_DIRNAME, 'skills'), 'user');
    expect(skills.map((s) => s.id)).not.toContain('longname');
  });
});
