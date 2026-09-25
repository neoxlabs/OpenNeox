/**
 * Verify that rich-card guidance selects shapes by information structure.
 *
 * The prompt exposes a bounded set of renderer-supported shapes and examples.
 */
import { describe, expect, it } from 'vitest';
import { getMarkdownFormatConstraint } from '../providerSupplements.js';

/* 覆盖三档 md 规则 (轻量 / 规则型 / 带示例型) —— 选卡口径不能只在某一档正确 */
const FAMILIES = [
  { name: 'claude', model: 'claude-sonnet-5', provider: 'anthropic' },
  { name: 'deepseek', model: 'deepseek-v4-flash', provider: 'deepseek' },
  { name: 'kimi', model: 'kimi-k2', provider: 'moonshot' },
  { name: 'glm', model: 'glm-5', provider: 'zhipu' },
  { name: '未识别兜底', model: 'some-unknown-model-x', provider: 'whoknows' },
];

describe('桌面端富卡片指令', () => {
  const guiOf = (f: typeof FAMILIES[number]) =>
    getMarkdownFormatConstraint({ model: f.model, provider: f.provider, gui: true }) ?? '';

  /* The supported list is intentionally bounded and each shape must add value
   *
   *   beyond plain text. */
  const OFFERED = ['chart', 'diff', 'report', 'callout', 'summary'] as const;

  it.each(FAMILIES)('$name: 只提供这 5 种卡, 不多不少', (f) => {
    const s = guiOf(f);
    /* 只看"清单"那几行 (· `kind` 开头), 不看正文里提到的反例名字 */
    const offered = new Set([...s.matchAll(/·\s*`(\w+)`/g)].map((m) => m[1]));
    for (const kind of OFFERED) expect(offered, `缺少 ${kind}`).toContain(kind);
    for (const gone of ['metrics', 'steps', 'flow', 'timeline', 'table', 'link', 'image', 'video']) {
      expect(offered, `${gone} 已下线, 不该再出现在可选清单里`).not.toContain(gone);
    }
  });

  it.each(FAMILIES)('$name: 判据是"文字表达不了", 且 summary 要求真文件改动', (f) => {
    const s = guiOf(f);
    expect(s).toMatch(/卡片的唯一存在理由/);
    /* summary 不能再是"收尾默认掏一张"的那一档 */
    expect(s).not.toMatch(/收尾时优先给一张\s*`?\\?`?neox-card:summary/);
    expect(s).not.toMatch(/复杂改动收尾用\s*\*\*`neox-card:summary`\*\*/);
    /* 必须写明没有文件改动就不用这张卡 —— 否则模型照旧拿它当万能收尾 */
    expect(s).toMatch(/只在真改了文件时用/);
  });

  it('需被示范的那一档 (deepseek/kimi): 示例里不能只有 summary 一种卡', () => {
    for (const f of [FAMILIES[1], FAMILIES[2]]) {
      const s = guiOf(f);
      const kinds = [...s.matchAll(/```neox-card:(\w+)/g)].map(m => m[1]);
      expect(kinds.length, `${f.name} 一个卡片示例都没有`).toBeGreaterThan(1);
      expect(new Set(kinds).size, `${f.name} 的示例只示范了 ${kinds.join('/')}`).toBeGreaterThan(1);
      expect(new Set(kinds)).toContain('chart');
    }
  });

  /* Guidance also names the trigger, gives a copyable shape, and blocks
   *
   *   hand-drawn SVG and ASCII substitutes. */
  it.each(FAMILIES)('$name: 点名禁掉手画 svg 和 ASCII 条形图', (f) => {
    const s = guiOf(f);
    expect(s, '没禁手写 svg/canvas').toMatch(/<svg>|<canvas>/);
    expect(s, '没禁用方块字符堆条形图 —— 只堵 svg 的话模型会换成 ████').toMatch(/█/);
  });

  it.each(FAMILIES)('$name: 给了一个能照抄的 chart 卡形状', (f) => {
    const s = guiOf(f);
    const m = s.match(/```neox-card:chart\n(\{[\s\S]*?\})\n```/);
    expect(m, '没有可照抄的 chart 范例 —— 弱模型只看清单不会自己拼 JSON').not.toBeNull();
    /* 范例本身必须是合法 JSON 且真的带数据, 否则照抄出来就是空卡 */
    const obj = JSON.parse(m![1]);
    expect(obj.type).toBe('bar');
    expect(Array.isArray(obj.series) && obj.series.length).toBeGreaterThan(1);
    expect(obj.series[0]).toHaveProperty('value');
  });

  it('CLI (非 gui) 也要禁掉这两条土路 —— 终端同样渲染不了 svg', () => {
    for (const f of FAMILIES) {
      const s = getMarkdownFormatConstraint({ model: f.model, provider: f.provider, gui: false }) ?? '';
      expect(s, `${f.name} 的 CLI 档没禁手画 svg`).toMatch(/<svg>/);
      expect(s, `${f.name} 的 CLI 档没禁 ASCII 条形图`).toMatch(/█/);
    }
  });

  it('CLI (非 gui) 一个字都不能提 neox-card —— Ink renderer 不认那套围栏', () => {
    for (const f of FAMILIES) {
      const s = getMarkdownFormatConstraint({ model: f.model, provider: f.provider, gui: false }) ?? '';
      expect(s, `${f.name} 的 CLI 档漏了卡片`).not.toContain('neox-card');
    }
  });
});
