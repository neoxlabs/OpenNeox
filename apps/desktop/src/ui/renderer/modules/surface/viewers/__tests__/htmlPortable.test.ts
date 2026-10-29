import { describe, expect, test } from 'vitest';
import { collectLocalRefs, inlineLocalAssets, isLocalRef, resolveRef } from '../htmlPortable';

describe('网页打包成单文件', () => {
  test('只认本地相对 / 绝对路径', () => {
    expect(isLocalRef('classroom-bg.png')).toBe(true);
    expect(isLocalRef('./img/a.jpg')).toBe(true);
    expect(isLocalRef('C:\\x\\a.png')).toBe(true);
    for (const r of ['https://cdn.jsdelivr.net/a.js', 'data:image/png;base64,xx', '#top', '//x.com/a.png', 'mailto:a@b']) {
      expect(isLocalRef(r)).toBe(false);
    }
  });

  test('收集 src / href / url() 里的本地文件, 跳过 html 链接', () => {
    const html = `<img src="bg.png"><link href="s.css" rel="stylesheet"><a href="other.html">x</a>
      <div style="background:url('img/desk.webp')"></div><script src="https://cdn.x/e.js"></script>`;
    expect(collectLocalRefs(html).sort()).toEqual(['bg.png', 'img/desk.webp', 's.css']);
  });

  test('路径拼接 (mac / windows / ..)', () => {
    expect(resolveRef('/Users/a/工作/选座', 'classroom-bg.png')).toBe('/Users/a/工作/选座/classroom-bg.png');
    expect(resolveRef('/Users/a/p', '../img/x.png')).toBe('/Users/a/img/x.png');
    expect(resolveRef('C:\\Users\\a\\p', 'x.png')).toBe('C:\\Users\\a\\p\\x.png');
  });

  test('读到的换成 data URI, 读不到的保持原样', async () => {
    const html = `<img src="bg.png"><img src="missing.png"><i style="background:url(bg.png)"></i>`;
    const r = await inlineLocalAssets(html, '/d', async (p) => (p === '/d/bg.png' ? 'QUJD' : null));
    expect(r.inlined).toBe(1);
    expect(r.html).toBe(`<img src="data:image/png;base64,QUJD"><img src="missing.png"><i style="background:url(data:image/png;base64,QUJD)"></i>`);
  });
});
