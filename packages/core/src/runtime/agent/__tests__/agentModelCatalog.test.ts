/* 「主 agent 能给子 agent 赋值模型 —— 前提是有」的那个「有」。
 * ═══════════════════════════════════════════════════════════════════════════
 * 在这之前 `model` 参数是一个自由字符串: 主 agent 只能猜模型名, 猜错了
 * resolveModelAlias 返回 null, 然后**静默继承主模型跑完还报成功** ——
 * 用户看到的是"我让它用重模型审计, 它答应了, 结果根本没用"。
 *
 * 三件事各有一条闸:
 *   1. 有清单时 model 参数是 enum (协议层就拒绝错名字), 清单为空时退回自由字符串
 *   2. 清单进描述, 带来路和取舍 —— 只给名字它还是不知道挑哪个
 *   3. 点名了用不了的模型 → 报错并列出可用的, **绝不静默继承**
 */
import { describe, it, expect } from 'vitest';
import { createAgentTool, describeAvailableModels, type AvailableModel } from '../agentTool.js';
import { setCustomAgentTypes } from '../agentTypes.js';

const MODELS: AvailableModel[] = [
  { id: 'neox-opus', source: 'subscription', hint: 'opus' },
  { id: 'neox-flash', source: 'subscription', hint: 'flash' },
  { id: 'my-local-qwen', source: 'byok' },
];

function makeTool(listAvailableModels?: () => AvailableModel[]) {
  return createAgentTool({
    orchestrator: {} as never,
    providerId: 'p1',
    modelName: 'main-model',
    permissionManager: {} as never,
    allTools: [],
    workDir: '/tmp',
    getParentMemory: () => ({}) as never,
    backgroundManager: {} as never,
    resolveModelAlias: (alias: string) =>
      MODELS.some(m => m.id === alias) ? { providerId: 'p1', modelName: alias } : null,
    listAvailableModels,
  });
}

const modelParam = (tool: ReturnType<typeof makeTool>) =>
  (tool.parameters as any).properties.model as { enum?: string[]; description: string };

describe('model 参数的可选清单', () => {
  it('有清单 → enum 就是那几个, 一个不多一个不少', () => {
    const p = modelParam(makeTool(() => MODELS));
    expect(p.enum).toEqual(['neox-opus', 'neox-flash', 'my-local-qwen']);
  });

  it('清单为空 → 不给 enum, 保持自由字符串', () => {
    /* 列不出来 (订阅缓存冷 / 没配 provider) 不能把这个能力关掉 —— 空 enum 等于禁用 */
    const p = modelParam(makeTool(() => []));
    expect(p.enum).toBeUndefined();
  });

  it('压根没传 lister → 也不给 enum (SDK / evals 这类宿主)', () => {
    expect(modelParam(makeTool()).enum).toBeUndefined();
  });

  it('lister 抛异常不许把工具构造带崩', () => {
    const tool = makeTool(() => { throw new Error('membership 缓存坏了'); });
    expect(modelParam(tool).enum).toBeUndefined();
  });

  it('描述里列出可选模型, 带取舍和来路 —— 只给名字它不知道挑哪个', () => {
    const d = modelParam(makeTool(() => MODELS)).description;
    expect(d).toContain('neox-opus (opus)');
    expect(d).toContain('my-local-qwen [BYOK]');
    expect(d).toContain('Available right now');
  });

  it('清单为空时描述里不许出现那句 "Available right now" —— 那会变成一句空话', () => {
    expect(modelParam(makeTool(() => [])).description).not.toContain('Available right now');
  });
});

describe('describeAvailableModels', () => {
  it('订阅的不标来路, BYOK 的标出来 (用户要能看出这条走的是自己的 key)', () => {
    expect(describeAvailableModels(MODELS))
      .toBe('neox-opus (opus), neox-flash (flash), my-local-qwen [BYOK]');
  });

  it('没有 hint 就不编一个', () => {
    expect(describeAvailableModels([{ id: 'x', source: 'subscription' }])).toBe('x');
  });
});

describe('点名了用不了的模型', () => {
  const dispatch = async (args: Record<string, unknown>) => {
    const tool = makeTool(() => MODELS);
    /* Tool 的执行入口叫 `function` (见 kernel 的 Tool 接口) —— 写成方法简写
     * `async function(args) {}`, 不是 execute/handler。 */
    return await (tool as any).function(args);
  };

  it('报错 + 列出可用的, 而不是静默继承主模型', async () => {
    const out = String(await dispatch({ description: 'x', prompt: 'y', model: '不存在的模型' }));
    expect(out).toContain('[ERROR]');
    expect(out).toContain('不存在的模型');
    expect(out, '报错里必须带上可用清单, 否则模型下一轮还得猜').toContain('neox-opus');
  });

  it('报错里要说清"去掉 model 参数就继承主模型"这条出路', async () => {
    const out = String(await dispatch({ description: 'x', prompt: 'y', model: 'nope' }));
    expect(out).toMatch(/继承主 agent 的模型|去掉 model/);
  });
});

describe('角色文件里钉的模型用不了', () => {
  it('报错并指路到那个 md 文件, 不静默换模型跑', async () => {
    /* 用户在 .neox/agents/<角色>.md 里写死了模型, 拿别的模型跑完还报成功,
     * 他看到的就是"配了没用" —— 而这正是这条洞当初的成因。 */
    setCustomAgentTypes([{ name: 'auditor', description: '审计', model: '早就下架的模型' }]);
    try {
      const tool = makeTool(() => MODELS);
      const out = String(await (tool as any).function({
        description: 'x', prompt: 'y', type: 'auditor',
      }));
      expect(out).toContain('[ERROR]');
      expect(out).toContain('早就下架的模型');
      expect(out, '要指到具体哪个文件, 否则用户不知道去哪改').toContain('.neox/agents/auditor.md');
      expect(out, '要说改完立即生效, 否则用户会去重启').toContain('立即生效');
      expect(out).toContain('neox-opus');
    } finally {
      setCustomAgentTypes([]);
    }
  });

  it('角色钉的模型能用时不许被这道闸拦下 —— 别把正常路径也堵了', async () => {
    setCustomAgentTypes([{ name: 'auditor2', description: '审计', model: 'neox-opus' }]);
    try {
      const tool = makeTool(() => MODELS);
      /* 这条会一路走到真正的派发机器 (backgroundManager 是个空壳, 必然抛)。
       * 要断言的只有一件事: **不是**被模型那道闸拦下的 —— 抛出来说明它已经走过去了。 */
      let out = '';
      try { out = String(await (tool as any).function({ description: 'x', prompt: 'y', type: 'auditor2' })); }
      catch (e) { out = `THREW: ${(e as Error).message}`; }
      expect(out).not.toContain('现在用不了');
      expect(out).not.toContain('[ERROR] 角色');
    } finally {
      setCustomAgentTypes([]);
    }
  });
});
