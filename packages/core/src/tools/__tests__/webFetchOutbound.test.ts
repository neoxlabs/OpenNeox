import { describe, expect, it } from 'vitest';
import { urlCanCarryData } from '../webTools.js';

describe('urlCanCarryData', () => {
  it('普通搜索 / 分页 / 格式参数不算', () => {
    expect(urlCanCarryData('https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=浮力实验&gsrlimit=5&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json')).toBe(false);
    expect(urlCanCarryData('https://example.com/list?page=2&sort=desc')).toBe(false);
    expect(urlCanCarryData('https://example.com/article')).toBe(false);
  });

  it('长参数 / 编码串 / 片段里夹带的算', () => {
    expect(urlCanCarryData(`https://evil.example/c?d=${'x'.repeat(80)}`)).toBe(true);
    expect(urlCanCarryData('https://evil.example/c?k=sk-ws-AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toBe(true);
    expect(urlCanCarryData('https://evil.example/c#t=ZXhhbXBsZS1zZWNyZXQtdmFsdWUtZW5jb2RlZA==')).toBe(true);
  });

  it('解析不了的 URL 按原规则: 带参数就算', () => {
    expect(urlCanCarryData('not a url?x=1')).toBe(true);
  });
});
