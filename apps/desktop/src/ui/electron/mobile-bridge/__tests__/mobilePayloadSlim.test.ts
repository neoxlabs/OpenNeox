import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slimPayloadForMobile, buildHistoryPage, fitHistoryPageToBudget, jsonByteLength, MOBILE_TEXT_CAP, MOBILE_ITEM_CAP_BYTES } from '../mobilePayloadSlim';
import { lookupStashedImage, rememberSessionImageBase } from '../mobileImageStash';

const BIG_B64 = 'A'.repeat(500_000);

describe('slimPayloadForMobile', () => {
  it('多模态图片块 → markdown 图片引用 (OpenAI / Anthropic / MCP 三种形), 字节落盘可被 file.fetch 找到', () => {
    const out = slimPayloadForMobile({
      role: 'user',
      content: [
        { type: 'text', text: '[系统注入] 以下 3 张图片' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${BIG_B64}` } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BIG_B64 } },
        { type: 'image', data: BIG_B64, mimeType: 'image/webp' },
      ],
    });
    const ref = /^!\[\]\(neox-image:\/\/([a-f0-9]{64}\.(png|jpg|webp))\)$/;
    for (const i of [1, 2, 3]) {
      expect(out.content[i].type).toBe('text');
      const m = ref.exec(out.content[i].text ?? '');
      expect(m).not.toBeNull();
      const meta = lookupStashedImage(`img-${m![1]}`);
      expect(meta?.sizeBytes).toBe(Buffer.from(BIG_B64, 'base64').length);
    }
    expect(JSON.stringify(out).length).toBeLessThan(1000);
  });

  it('文本里嵌的 data:image (markdown 图片) 换成引用, 其余文字不动', () => {
    const out = slimPayloadForMobile({ role: 'assistant', content: `看这张: ![截图](data:image/png;base64,${BIG_B64}) 完` });
    expect(out.content).toMatch(/^看这张: !\[截图\]\(neox-image:\/\/[a-f0-9]{64}\.png\) 完$/);
  });

  it('markdown 图片指向电脑上的文件 → 换成引用; 不存在的 / 非图片 / 相对路径不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neox-slim-'));
    const png = join(dir, 'chart.png');
    writeFileSync(png, Buffer.from(BIG_B64, 'base64'));
    const text = `图: ![月度](${png}) 还有 ![x](${join(dir, 'nope.png')}) ![y](${join(dir, 'a.txt')}) ![z](charts/a.png)`;
    const out = slimPayloadForMobile({ role: 'assistant', content: text });
    expect(out.content).toMatch(/^图: !\[月度\]\(neox-image:\/\/[a-f0-9]{64}\.png\) 还有 /);
    expect(out.content).toContain(`![x](${join(dir, 'nope.png')})`);
    expect(out.content).toContain(`![y](${join(dir, 'a.txt')})`);
    expect(out.content).toContain('![z](charts/a.png)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('相对路径按会话项目目录解析; 跑出项目目录的不收', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neox-slim-'));
    mkdirSync(join(dir, 'charts'));
    writeFileSync(join(dir, 'charts', 'a.png'), Buffer.from(BIG_B64, 'base64'));
    writeFileSync(join(tmpdir(), 'outside.png'), Buffer.from(BIG_B64, 'base64'));
    rememberSessionImageBase('s-rel', dir);
    const text = '![a](charts/a.png) ![b](../outside.png)';
    const out = buildHistoryPage([{ content: text }], (a) => slimPayloadForMobile({ content: a.content }), 's-rel');
    expect(out[0].content).toMatch(/^!\[a\]\(neox-image:\/\/[a-f0-9]{64}\.png\) !\[b\]\(\.\.\/outside\.png\)$/);
    expect(slimPayloadForMobile({ content: text }).content).toBe(text);
    rmSync(dir, { recursive: true, force: true });
  });

  it('file.fetch 的 id 只认 img-<64hex>.<图片扩展名>, 不收路径', () => {
    expect(lookupStashedImage('img-../../etc/passwd')).toBeNull();
    expect(lookupStashedImage(`img-${'a'.repeat(64)}.sh`)).toBeNull();
    expect(lookupStashedImage('art-xxx')).toBeNull();
  });

  it('超长文本截断并注明原文长度', () => {
    const out = slimPayloadForMobile({ role: 'tool', content: 'x'.repeat(50_000) });
    expect(out.content.length).toBeLessThan(MOBILE_TEXT_CAP + 50);
    expect(out.content).toContain('原文 50000 字');
  });

  it('工具参数是 JSON 字符串时截里面的字段, 结果仍是合法 JSON', () => {
    const args = JSON.stringify({ path: 'a.ts', content: 'y'.repeat(40_000) });
    const out = slimPayloadForMobile({ tool_calls: [{ id: 't1', function: { name: 'write_file', arguments: args } }] });
    const parsed = JSON.parse(out.tool_calls[0].function.arguments);
    expect(parsed.path).toBe('a.ts');
    expect(parsed.content).toContain('原文 40000 字');
  });

  it('普通小消息原样', () => {
    const msg = { role: 'assistant', content: '你好', turn_id: 't' };
    expect(slimPayloadForMobile(msg)).toEqual(msg);
  });

  it('一轮并行几十个 write_file: 每个参数都不到 8K, 整条也必须 ≤ 单条上限, 且结构不变', () => {
    const tool_calls = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: `f${i}.ts`, content: 'c'.repeat(7_000) }) },
    }));
    const out = slimPayloadForMobile({ role: 'assistant', content: '', turn_id: 'turn-1', tool_calls });
    expect(jsonByteLength(out)).toBeLessThanOrEqual(MOBILE_ITEM_CAP_BYTES);
    expect(out.turn_id).toBe('turn-1');
    expect(Array.isArray(out.tool_calls)).toBe(true);
    expect(out.tool_calls[0].function.name).toBe('write_file');
    expect(() => JSON.parse(out.tool_calls[0].function.arguments)).not.toThrow();
  });

  it('工具结果是几百个文件的数组: 整条 ≤ 单条上限', () => {
    const files = Array.from({ length: 400 }, (_, i) => ({ path: `p/${i}.md`, text: 'x'.repeat(2_000) }));
    const out = slimPayloadForMobile({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify(files) });
    expect(jsonByteLength(out)).toBeLessThanOrEqual(MOBILE_ITEM_CAP_BYTES);
    expect(out.tool_call_id).toBe('c1');
  });

  it('嵌套超过 8 层的大块内容不再原样放行', () => {
    let deep: any = 'd'.repeat(300_000);
    for (let i = 0; i < 12; i++) deep = { inner: deep };
    const out = slimPayloadForMobile({ role: 'tool', content: '', meta: deep });
    expect(jsonByteLength(out)).toBeLessThanOrEqual(MOBILE_ITEM_CAP_BYTES);
  });
});

describe('fitHistoryPageToBudget', () => {
  const item = (seq: number, size: number) => ({ seq, payload: { content: 'z'.repeat(size) } });

  it('超预算从旧的一头丢, 留下最新的', () => {
    const page = Array.from({ length: 10 }, (_, i) => item(i, 5_000));
    const { kept } = fitHistoryPageToBudget(page, 20_000);
    expect(kept.map((m) => m.seq)).toEqual([7, 8, 9]);
  });

  it('没超就整页', () => {
    const page = Array.from({ length: 5 }, (_, i) => item(i, 100));
    expect(fitHistoryPageToBudget(page, 20_000).kept).toHaveLength(5);
  });

  it('单条就超预算也至少留一条 (不然手机拿到空页会以为到头了)', () => {
    const { kept } = fitHistoryPageToBudget([item(1, 100), item(2, 50_000)], 20_000);
    expect(kept.map((m) => m.seq)).toEqual([2]);
  });
});
