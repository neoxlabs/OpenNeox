import { describe, test, expect } from 'vitest';
import { escapeUnknownHtmlTags } from '../escapeUnknownHtmlTags';


describe('白名单外的标签形状转义成字面量', () => {
  test('模型自造的字段名标签 (实测触发源)', () => {
    const out = escapeUnknownHtmlTags('每条记录带 <timestamp> 和 <archiveid> 字段');
    expect(out).toBe('每条记录带 &lt;timestamp> 和 &lt;archiveid> 字段');
  });

  test('泛型写法不再被吃掉', () => {
    expect(escapeUnknownHtmlTags('返回 Map<string, Foo> 类型')).toContain('&lt;string, Foo>');
  });

  test('闭合标签同样处理, 免得留下半个未闭合元素吸走后文', () => {
    expect(escapeUnknownHtmlTags('<mytag>x</mytag>')).toBe('&lt;mytag>x&lt;/mytag>');
  });

  test('script / iframe 也进不了 DOM', () => {
    expect(escapeUnknownHtmlTags('<script>alert(1)</script>')).toBe('&lt;script>alert(1)&lt;/script>');
    expect(escapeUnknownHtmlTags('<iframe src="x">')).toBe('&lt;iframe src="x">');
  });
});

describe('我们支持的 HTML 一字不动', () => {
  test.each([
    '<br>',
    '<img src="neox-asset://a.png" alt="x">',
    '<details><summary>点开</summary>正文</details>',
    '<sub>2</sub> 和 <sup>3</sup>',
    '<span class="k">高亮</span>',
    '<table><thead><tr><th>a</th></tr></thead></table>',
  ])('%s', (html) => {
    expect(escapeUnknownHtmlTags(html)).toBe(html);
  });

  test('HTML 注释原样保留', () => {
    const s = '<!-- <timestamp> 在注释里 -->';
    expect(escapeUnknownHtmlTags(s)).toBe(s);
  });
});

describe('代码里的尖括号本来就该原样', () => {
  test('围栏代码块内不动', () => {
    const s = '前文 <timestamp>\n```ts\nconst a: Map<string, T> = new Map();\n<foo>\n```\n后文 <bar>';
    const out = escapeUnknownHtmlTags(s);
    expect(out).toContain('Map<string, T>');       /* 围栏内原样 */
    expect(out).toContain('\n<foo>\n');
    expect(out).toContain('前文 &lt;timestamp>');   /* 围栏外照转 */
    expect(out).toContain('后文 &lt;bar>');
  });

  test('~~~ 围栏同样跳过', () => {
    const out = escapeUnknownHtmlTags('a <x>\n~~~\n<y>\n~~~\nb <z>');
    expect(out).toContain('\n<y>\n');
    expect(out).toContain('a &lt;x>');
    expect(out).toContain('b &lt;z>');
  });

  test('行内 code 内不动, 同一行 code 外照转', () => {
    const out = escapeUnknownHtmlTags('用 `<timestamp>` 表示, 而 <archiveid> 是另一个');
    expect(out).toContain('`<timestamp>`');
    expect(out).toContain('&lt;archiveid>');
  });

  test('多反引号行内 code 按同长度配对', () => {
    const out = escapeUnknownHtmlTags('``含 ` 的 <x>`` 之后 <y>');
    expect(out).toContain('``含 ` 的 <x>``');
    expect(out).toContain('&lt;y>');
  });
});

describe('边界', () => {
  test('不含尖括号直接返回原串', () => {
    expect(escapeUnknownHtmlTags('普通文本')).toBe('普通文本');
    expect(escapeUnknownHtmlTags('')).toBe('');
  });

  test('比较运算符不受影响', () => {
    expect(escapeUnknownHtmlTags('if (a < b && c > d)')).toBe('if (a < b && c > d)');
    expect(escapeUnknownHtmlTags('x <= 3')).toBe('x <= 3');
  });

  test('流式在途的半截围栏不炸 (未闭合按围栏外处理不了就原样)', () => {
    expect(() => escapeUnknownHtmlTags('前文 <a href="#">链接</a>\n```ts\nconst x = <T>')).not.toThrow();
  });
});
