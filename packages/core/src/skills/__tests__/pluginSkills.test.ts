import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { SkillRegistry } from '../registry.js';

let tempHome: string;
let homeBackup: string | undefined;

function writeSkill(dir: string, name: string, desc = `desc of ${name}`): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody\n`);
}

function installPlugin(name: string, opts: { enabled: boolean; skills: string[] }): string {
  const installPath = path.join(tempHome, NEOX_HOME_DIRNAME, 'plugins', 'installed', `${name}@1.0.0`);
  fs.mkdirSync(installPath, { recursive: true });
  const file = path.join(tempHome, NEOX_HOME_DIRNAME, 'plugins', 'registry.json');
  const reg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, plugins: [] };
  reg.plugins.push({ name, enabled: opts.enabled, installPath, manifest: { name, version: '1.0.0', skills: opts.skills } });
  fs.writeFileSync(file, JSON.stringify(reg));
  return installPath;
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-plugin-skills-'));
  homeBackup = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  process.env.HOME = homeBackup;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const nameOf = (s: any): string => s.metadata?.name ?? s.name;
const names = (r: SkillRegistry, source?: string) =>
  r.list({}).filter((s: any) => !source || s.source === source).map(nameOf).sort();

describe('SkillRegistry.loadPlugins', () => {
  it('已启用插件的 skill 进注册表, 来源是 plugin; 停用的不进', async () => {
    const on = installPlugin('office-kit', { enabled: true, skills: ['skills'] });
    writeSkill(path.join(on, 'skills'), 'weekly-report');
    writeSkill(path.join(on, 'skills'), 'meeting-minutes');
    const off = installPlugin('disabled-kit', { enabled: false, skills: ['skills'] });
    writeSkill(path.join(off, 'skills'), 'should-not-load');

    const r = new SkillRegistry();
    await r.initialize();
    expect(names(r, 'plugin')).toEqual(['meeting-minutes', 'weekly-report']);
  });

  it('清单里的路径跑出插件目录的不认', async () => {
    const dir = installPlugin('evil', { enabled: true, skills: ['../../../outside'] });
    writeSkill(path.resolve(dir, '../../../outside'), 'escaped');
    const r = new SkillRegistry();
    await r.initialize();
    expect(names(r, 'plugin')).toEqual([]);
  });

  it('用户自己的同名 skill 覆盖插件的', async () => {
    const dir = installPlugin('office-kit', { enabled: true, skills: ['skills'] });
    writeSkill(path.join(dir, 'skills'), 'weekly-report', 'from plugin');
    writeSkill(path.join(tempHome, NEOX_HOME_DIRNAME, 'skills'), 'weekly-report', 'mine');
    const r = new SkillRegistry();
    await r.initialize();
    const s: any = r.list({}).find((x: any) => nameOf(x) === 'weekly-report');
    expect(s.source).toBe('user');
  });

  it('插件 skill 没声明 allowedTools → trusted (照常用工具); 声明了 → limited 且只许那几个 (2026-09-25)', async () => {
    const dir = installPlugin('office-kit', { enabled: true, skills: ['skills'] });
    writeSkill(path.join(dir, 'skills'), 'thesis-writing');
    fs.mkdirSync(path.join(dir, 'skills', 'locked'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'locked', 'SKILL.md'),
      '---\nname: locked\ndescription: only reads\nneox:\n  allowedTools:\n    - readfile\n---\n\nbody\n');
    const r = new SkillRegistry();
    await r.initialize();
    const find = (n: string): any => r.list({}).find((x: any) => nameOf(x) === n);
    expect(find('thesis-writing').trustLevel).toBe('trusted');
    expect(find('locked').trustLevel).toBe('limited');
  });

  it('没装过插件 (没有登记表) 不报错', async () => {
    const r = new SkillRegistry();
    await expect(r.initialize()).resolves.toBeUndefined();
  });
});
