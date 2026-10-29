import { describe, it, expect } from 'vitest';
import { unwrapCardXmlTags } from '../Markdown';

const FENCE = '```';

describe('unwrapCardXmlTags', () => {
  it('用户实拍那一段: XML 包着 ```json 的 diff 卡 → 归一成 neox-card:diff 围栏', () => {
    const body = '{\n  "title": "本次拉取 · 文件变更清单",\n  "files": []\n}';
    const out = unwrapCardXmlTags(
      `<neox-card:diff>\n${FENCE}json\n${body}\n${FENCE}\n</neox-card:diff>`);
    expect(out).toContain(`${FENCE}neox-card:diff`);
    expect(out).toContain('"本次拉取 · 文件变更清单"');
    /* 标签不许再露给用户 */
    expect(out).not.toContain('<neox-card:');
    expect(out).not.toContain('</neox-card');
    /* 内层的 ```json 要剥掉, 否则围栏语言仍是 json, 白名单还是不认 */
    expect(out).not.toContain(`${FENCE}json`);
  });

  it('里面没套围栏 (裸 JSON) 也认', () => {
    const out = unwrapCardXmlTags('<neox-card:summary>\n{"a":1}\n</neox-card:summary>');
    expect(out).toContain(`${FENCE}neox-card:summary\n{"a":1}\n${FENCE}`);
  });

  it('闭标签写成 </neox-card> (kind 丢了) 也收得住', () => {
    const out = unwrapCardXmlTags('<neox-card:chart>\n{"a":1}\n</neox-card>');
    expect(out).toContain(`${FENCE}neox-card:chart`);
    expect(out).not.toContain('</neox-card');
  });

  it('流式在途 —— 开标签到了闭标签没到, 也按卡片渲染, 不留裸 JSON 给用户', () => {
    const out = unwrapCardXmlTags('前面一句话\n\n<neox-card:diff>\n{"title":"写到一半');
    expect(out).toContain('前面一句话');
    expect(out).toContain(`${FENCE}neox-card:diff`);
    expect(out).not.toContain('<neox-card:');
  });

  it('前后的正文原样保留, 多张卡各自归一', () => {
    const out = unwrapCardXmlTags(
      'A\n<neox-card:diff>\n{"x":1}\n</neox-card:diff>\nB\n<neox-card:chart>\n{"y":2}\n</neox-card:chart>\nC');
    expect(out.startsWith('A')).toBe(true);
    expect(out.trimEnd().endsWith('C')).toBe(true);
    expect((out.match(/```neox-card:/g) ?? []).length).toBe(2);
  });

  it('⚠️ 不碰普通文本 —— 没有这个标签就原样返回 (同一个字符串引用)', () => {
    const plain = '普通回答, 里面提到 <div> 和 ```json 代码块';
    expect(unwrapCardXmlTags(plain)).toBe(plain);
  });

  it('⚠️ 空 body 不产出空卡片', () => {
    expect(unwrapCardXmlTags('<neox-card:diff>\n\n</neox-card:diff>')).not.toContain('neox-card:diff\n');
  });
});
