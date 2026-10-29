import { describe, it, expect } from 'vitest';
import { ShortTermMemory } from '../../memory/shortterm.js';
import { syncDynamicSection } from '../dynamicSectionSync.js';

/* PROMPT-07 / harness-core-design §3.3-B 的行为锁。
 *
 * 修之前: 首轮把 dynamic 段拼进整段 system message, 次轮起又 upsertSystemTagged 插一条
 * 带标签的 system —— 同一段两份, 每个会话第二轮的前缀字节都要变一次。
 * 修之后: 首轮也走 tagged 消息, 之后每轮原地更新; 相同内容调用是 no-op。 */
const SECTION = '<model_orchestration>\n智能模型编排已开启\n</model_orchestration>';

function systemContents(mem: ShortTermMemory): string[] {
  return mem.getAll()
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content));
}

function makeMemory(): ShortTermMemory {
  const mem = new ShortTermMemory();
  mem.add({ role: 'system', content: '你是 Neox' });
  mem.add({ role: 'user', content: '看一下这个仓库' });
  return mem;
}

describe('dynamic_section 同步 (PROMPT-07)', () => {
  it('连续 5 轮同一段: system 字节不变, 且只有主 system + 一条 dynamic', () => {
    const mem = makeMemory();
    const snapshots: string[] = [];
    for (let i = 0; i < 5; i++) {
      syncDynamicSection(mem, SECTION);
      snapshots.push(systemContents(mem).join('\n\n'));
    }
    expect(new Set(snapshots).size).toBe(1);
    expect(systemContents(mem)).toEqual(['你是 Neox', SECTION]);
  });

  it('段内容变化时原地替换, 不新增 system 消息', () => {
    const mem = makeMemory();
    syncDynamicSection(mem, SECTION);
    syncDynamicSection(mem, SECTION.replace('已开启', '已关闭'));
    const systems = systemContents(mem);
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain('已关闭');
    expect(systems.join('\n')).not.toContain('已开启');
  });

  it('段消失时整条移除, 再出现只插回一条', () => {
    const mem = makeMemory();
    syncDynamicSection(mem, SECTION);
    syncDynamicSection(mem, undefined);
    expect(systemContents(mem)).toEqual(['你是 Neox']);
    syncDynamicSection(mem, SECTION);
    expect(systemContents(mem)).toEqual(['你是 Neox', SECTION]);
  });

  it('空串 / 纯空白不插入 system (不留空消息)', () => {
    const mem = makeMemory();
    syncDynamicSection(mem, '   \n  ');
    expect(systemContents(mem)).toEqual(['你是 Neox']);
  });

  it('首轮已把同一段拼进整段 system 时 (旧会话恢复), 不再插第二份', () => {
    /* 模拟旧行为留下的 memory: dynamic 段已经在主 system 的尾部。
     * 现在虽然首轮不再内联, 但恢复旧会话时内存/库里可能就是这种形状 —— 不能因此多一份。 */
    const mem = new ShortTermMemory();
    mem.add({ role: 'system', content: `你是 Neox\n\n${SECTION}` });
    syncDynamicSection(mem, SECTION);
    expect(systemContents(mem)).toHaveLength(1);
  });
});
