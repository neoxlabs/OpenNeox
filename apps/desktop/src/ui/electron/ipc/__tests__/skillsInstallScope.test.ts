import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invokeBridge } from '@neoxlabs/platform/shared/ipc.js';
import { SkillRegistry } from '@neoxlabs/core/skills/index.js';
import { registerSkillsIpcHandlers } from '../skillsHandlers.js';
import { validateAgainstWorkspaceRoots } from '../fileEditHandlers.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

let tempRoot: string;
let workspacePath: string;
let homeBackup: string | undefined;
let registry: SkillRegistry;

/* 假窗口 → 假 scope。getBySender 返回它，就等于"这个请求来自这个项目窗口"。 */
const fakeScope = {
  workspacePath: '',
  getService: () => registry,
};
const projectManager = {
  getBySender: () => fakeScope,
} as any;

/* invokeBridge 的返回是 unknown —— 这里只关心"handler 真实返回了什么", 统一断言一次 */
async function ipc<T = any>(channel: string, args: unknown[] = []): Promise<T> {
  return await invokeBridge(channel, args) as T;
}

const USER_SKILL_MD = `---
name: user-side
description: 用户级技能
description_en: A user-level skill
whenToUse: 用户说"user-side"时
version: 2.3.0
user-invocable: true
neox:
  category: custom
  allowedTools:
    - readfile
  arguments:
    - name: target
      description: 要处理的目标
      required: true
---

# User Side

正文第一段。

## Examples

保留这一节 —— 老编辑链路会把它整段丢掉。
`;

const WORKSPACE_SKILL_MD = USER_SKILL_MD
  .replace('name: user-side', 'name: ws-side')
  .replace('description: 用户级技能', 'description: 项目内技能')
  .replace('version: 2.3.0', 'version: 0.1.0');

const MARKET_SKILL_MD = `---
name: market-skill
description: 从商店装的技能
version: 1.0.0
author: tester
neox:
  category: custom
  allowedTools:
    - readfile
---

# Market Skill

装到 ~/.neox/skills/。
`;

function writeSkill(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

const userSkillsDir = () => path.join(tempRoot, NEOX_HOME_DIRNAME, 'skills');
const workspaceSkillsDir = () => path.join(workspacePath, '.neox', 'skills');

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-skills-p0-'));
  workspacePath = path.join(tempRoot, 'project');
  fs.mkdirSync(workspacePath, { recursive: true });

  /* os.homedir() 跟着 HOME 走 —— 用户级技能目录因此落在 tempRoot 里 */
  homeBackup = process.env.HOME;
  process.env.HOME = tempRoot;

  writeSkill(path.join(userSkillsDir(), 'user-side'), USER_SKILL_MD);
  writeSkill(path.join(workspaceSkillsDir(), 'ws-side'), WORKSPACE_SKILL_MD);

  registry = new SkillRegistry();
  await registry.refresh(workspacePath);
  fakeScope.workspacePath = workspacePath;

  /* 注册是模块顶层的注册动作，重复注册只会告警不会重复生效 */
  registerSkillsIpcHandlers({ projectManager });
});

afterEach(() => {
  process.env.HOME = homeBackup;
  vi.unstubAllGlobals();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('P0-1 · 卡片编辑保存 = 详情页的原文编辑 (skills:write-content)', () => {
  it('用户级技能 (工作区之外) 真的能写进磁盘', async () => {
    /* 老链路走 file:write —— 它最终落到这道校验上 (fileSystemHandlers.getValidatedPath)。
     * 用户级技能不在工作区任何根之内，直接抛；而 IPC handler 把它变成
     * { success:false } 返回、外层 catch 不触发，界面于是照常显示"保存成功"。 */
    expect(() => validateAgainstWorkspaceRoots(
      workspacePath,
      path.join(userSkillsDir(), 'user-side', 'SKILL.md'),
      [],
    )).toThrow(/不在当前工作区的任何根目录内/);

    const raw = await ipc('skills:read-raw', ['user-side']);
    expect(raw.success).toBe(true);

    const edited = String(raw.content).replace('正文第一段。', '正文第一段 —— 改过了。');
    const res = await ipc('skills:write-content', ['user-side', edited]);
    expect(res).toEqual({ success: true });

    const onDisk = fs.readFileSync(path.join(userSkillsDir(), 'user-side', 'SKILL.md'), 'utf-8');
    expect(onDisk).toContain('正文第一段 —— 改过了。');
  });

  it('保存后 frontmatter 的其它字段和正文其它小节一个都不少', async () => {
    const raw = await ipc('skills:read-raw', ['user-side']);
    const edited = String(raw.content).replace('# User Side', '# User Side (renamed)');
    await ipc('skills:write-content', ['user-side', edited]);

    const onDisk = fs.readFileSync(path.join(userSkillsDir(), 'user-side', 'SKILL.md'), 'utf-8');
    /* 老模板只留 name/description/user-invocable/neox.category/aliases/dangerLevel */
    for (const kept of ['description_en: A user-level skill', 'whenToUse:', 'version: 2.3.0',
      'allowedTools:', 'arguments:', '## Examples', '保留这一节']) {
      expect(onDisk, `保存后丢了 ${kept}`).toContain(kept);
    }
  });

  it('项目内技能保存同样是原文覆盖，不会把字段写没', async () => {
    const raw = await ipc('skills:read-raw', ['ws-side']);
    await ipc('skills:write-content', ['ws-side', String(raw.content).replace('正文第一段。', '项目里的改动。')]);

    const onDisk = fs.readFileSync(path.join(workspaceSkillsDir(), 'ws-side', 'SKILL.md'), 'utf-8');
    expect(onDisk).toContain('项目里的改动。');
    expect(onDisk).toContain('version: 0.1.0');
    expect(onDisk).toContain('## Examples');
  });

  it('写不进 / 解析不了时返回 success:false —— 界面才有机会报错 (不再是假成功)', async () => {
    const broken = await ipc('skills:write-content', ['user-side', '---\ndescription: 没有 name\n---\n正文']);
    expect(broken.success).toBe(false);
    expect(String(broken.error)).toContain('解析失败');
  });
});

describe('P0-2 · 商店装的技能 (user 级) 在设置页能卸载 / 信任 / 检查更新', () => {

  it('信任 / 取消信任 落到技能真正所在的那一份', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => MARKET_SKILL_MD })));
    const installed = await ipc('skills:install', ['https://example.com/market.md']);
    expect(installed.success).toBe(true);
    const metaFile = path.join(userSkillsDir(), 'market-skill', '.neox-skill.json');

    const trusted = await ipc('skills:trust', ['market-skill']);
    expect(trusted).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).trustLevel).toBe('trusted');

    const untrusted = await ipc('skills:untrust', ['market-skill']);
    expect(untrusted).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).trustLevel).toBe('limited');
  });

  it('检查更新 走真实下载，meta 写回用户级那份', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => MARKET_SKILL_MD })));
    await ipc('skills:install', ['https://example.com/market.md']);

    /* 同版本 → up_to_date (以前这里直接 "Skill not installed") */
    const same = await ipc('skills:update', ['market-skill']);
    expect(same.success).toBe(true);
    expect(same.status).toBe('up_to_date');

    /* 远程升到 1.1.0 → 真写盘 */
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => MARKET_SKILL_MD.replace('version: 1.0.0', 'version: 1.1.0').replace('装到', '更新后的'),
    })));
    const updated = await ipc('skills:update', ['market-skill']);
    expect(updated.success).toBe(true);
    expect(updated.status).toBe('updated');
    expect(updated.previousVersion).toBe('1.0.0');
    expect(updated.newVersion).toBe('1.1.0');

    const onDisk = fs.readFileSync(path.join(userSkillsDir(), 'market-skill', 'SKILL.md'), 'utf-8');
    expect(onDisk).toContain('更新后的');
    expect(JSON.parse(fs.readFileSync(path.join(userSkillsDir(), 'market-skill', '.neox-skill.json'), 'utf-8')).installedVersion).toBe('1.1.0');
  });

  it('卸载 删掉的是用户级那一份，列表里也随之消失', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => MARKET_SKILL_MD })));
    await ipc('skills:install', ['https://example.com/market.md']);
    expect((await ipc('skills:list-installed', [])).map((m: any) => m.skillId)).toEqual(['market-skill']);

    const res = await ipc('skills:uninstall', ['market-skill']);
    expect(res).toEqual({ success: true });
    expect(fs.existsSync(path.join(userSkillsDir(), 'market-skill'))).toBe(false);
    expect(await ipc('skills:list-installed', [])).toEqual([]);
  });

  it('工作区里恰好有同名技能时，不误删项目里那份，也不假装卸载成功', async () => {
    /* 同名技能同时存在于工作区：手写一个 (没有 .neox-skill.json，不属于商店装的) */
    writeSkill(path.join(workspaceSkillsDir(), 'market-skill'), MARKET_SKILL_MD);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => MARKET_SKILL_MD })));

    /* 安装阶段就应该拒绝 —— 否则装上了也被工作区那份盖住，用户看不见 */
    const installed = await ipc('skills:install', ['https://example.com/market.md']);
    expect(installed.success).toBe(false);
    expect(String(installed.error)).toContain('同名技能');
    expect(fs.existsSync(path.join(userSkillsDir(), 'market-skill'))).toBe(false);

    /* 工作区那份必须完好 */
    expect(fs.existsSync(path.join(workspaceSkillsDir(), 'market-skill', 'SKILL.md'))).toBe(true);
  });

  it('真的没装过的 id 仍然是 not found（别把"找不到"悄悄变成"成功"）', async () => {
    expect(await ipc('skills:uninstall', ['never-installed'])).toMatchObject({ success: false });
    expect(String((await ipc('skills:uninstall', ['never-installed'])).error)).toContain('not found');
    expect(await ipc('skills:trust', ['never-installed'])).toMatchObject({ success: false });
  });
});
