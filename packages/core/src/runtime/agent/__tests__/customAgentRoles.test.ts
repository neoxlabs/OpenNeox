/* 自定义 agent 角色 (.neox/agents/*.md) 真的能被派出去 —— 这条闸是 审计
 * 逼出来的: 注册表一直在加载这些文件、注册进表, 而 agent 工具的类型 enum / 校验 /
 * 系统提示只认写死的 6 个。用户写了 auditor.md, 开机日志说加载成功, 一派就是
 * [ERROR] Unknown agent type "auditor"。
 *
 * 所以断言必须落在**运行时那侧**的 getAvailableAgentTypes / getAgentType 上,
 * 不能只断言"注册表里有这条" —— 上一版正是那样才漏过去的。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTypeRegistry } from '../agentTypeRegistry.js';
import { getAgentType, getAvailableAgentTypes, setCustomAgentTypes } from '../agentTypes.js';

const BUILTIN_IDS = ['code', 'shell', 'plan', 'research', 'verify', 'online'];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-agents-'));
  setCustomAgentTypes([]);
});
afterEach(() => {
  setCustomAgentTypes([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);

describe('自定义 agent 角色', () => {
  it('从目录加载后, 运行时那侧就能派 —— 而且带着钉死的模型', async () => {
    write('auditor.md', `---
name: auditor
description: 安全审计, 只读
whenToUse: 需要一份不改代码的安全审计时
base: plan
model: opus-heavy
tools: [readfile, grep]
---
你是审计员。只报事实, 不改代码。`);

    const reg = new AgentTypeRegistry();
    expect(await reg.loadFromDirectory(dir, 'workspace')).toBe(1);

    const ids = getAvailableAgentTypes().map(t => t.id);
    expect(ids).toContain('auditor');
    /* 内置的一个都不能少 —— 自定义是"加"不是"换" */
    for (const b of BUILTIN_IDS) expect(ids).toContain(b);

    const auditor = getAgentType('auditor');
    expect(auditor.id).toBe('auditor');
    expect(auditor.model).toBe('opus-heavy');
    expect(auditor.source).toBe('workspace');
    expect(auditor.whenToUse).toContain('安全审计');
  });

  it('frontmatter 里的角色说明盖在底座提示之前', () => {
    setCustomAgentTypes([{ name: 'r1', description: 'd', systemPromptPrefix: '【我是角色说明】' }]);
    const prompt = getAgentType('r1').buildSystemPrompt('/w', '', 'desc', 'task');
    expect(prompt.startsWith('【我是角色说明】')).toBe(true);
    /* 底座那段还在 —— 角色说明是加在前面, 不是把工作策略整段换掉 */
    expect(prompt).toContain('task');
  });

  it('tools 缺省继承底座; base 决定能不能跑命令', () => {
    setCustomAgentTypes([
      { name: 'r-code', description: 'd' },
      { name: 'r-shell', description: 'd', base: 'shell' },
    ]);
    const asSet = (t: ReturnType<typeof getAgentType>) => t.allowedTools === '*' ? null : t.allowedTools;
    expect(asSet(getAgentType('r-code'))?.has('execute_shell')).toBe(false);
    expect(asSet(getAgentType('r-shell'))?.has('execute_shell')).toBe(true);
  });

  it('自定义角色只能更窄: 递归工具永远拿不回来', () => {
    setCustomAgentTypes([{ name: 'r2', description: 'd', tools: ['readfile', 'agent', 'team_run'] }]);
    const t = getAgentType('r2');
    /* allowedTools 里写了也没用 —— excludedTools 是后过的一道 */
    expect(t.excludedTools.has('agent')).toBe(true);
    expect(t.excludedTools.has('team_run')).toBe(true);
  });

  it('名字撞内置类型的一律拒掉, 不能靠一个 md 文件改掉 code 的工具集', () => {
    const { accepted, rejected } = setCustomAgentTypes([
      { name: 'code', description: '我要接管 code', tools: ['readfile'] },
      { name: 'my-code', description: 'ok' },
    ]);
    expect(rejected).toContain('code');
    expect(accepted).toEqual(['my-code']);
    /* 内置 code 原样 —— 仍然能编辑文件 */
    const code = getAgentType('code');
    expect(code.allowedTools === '*' || code.allowedTools.has('edit')).toBe(true);
  });

  it('改了角色文件不用重启 —— 热加载要一路推到运行时那侧', async () => {
    /* 角色是反复试出来的: 改一句提示、换个模型、收一收工具集。每改一次都重启,
     * 第二次就没人改了。所以这条断言必须落在 getAgentType 上, 不是"注册表刷新了"。 */
    write('hot.md', `---
name: hot-role
description: 第一版
model: m1
---
body`);
    const reg = new AgentTypeRegistry();
    await reg.initialize(undefined);          /* 用户目录那份, 跟这个临时目录无关 */
    await reg.loadFromDirectory(dir, 'workspace');
    expect(getAgentType('hot-role').model).toBe('m1');

    write('hot.md', `---
name: hot-role
description: 第二版
model: m2
---
body`);
    await reg.loadFromDirectory(dir, 'workspace');
    expect(getAgentType('hot-role').model, '改了文件但运行时还是旧的').toBe('m2');
    expect(getAgentType('hot-role').description).toBe('第二版');
  });

  it('插件卸载后角色跟着消失 —— 否则清单里挂着一个派不出去的名字', async () => {
    write('p1.md', `---
name: plugin-role
description: 插件带来的角色
---
body`);
    const reg = new AgentTypeRegistry();
    await reg.loadFromDirectory(dir, 'plugin', 'demo-plugin');
    expect(getAvailableAgentTypes().map(t => t.id)).toContain('plugin-role');

    reg.unregisterPlugin('demo-plugin');
    expect(getAvailableAgentTypes().map(t => t.id)).not.toContain('plugin-role');
  });
});
