import { describe, expect, it } from 'vitest';
import { formatCompactToolArgs } from '../formatCompactToolArgs';

describe('formatCompactToolArgs', () => {
  it('write_file 只露路径, 不把 HTML contents 当路径切', () => {
    const args = JSON.stringify({
      file_path: '/ws/live-a.html',
      contents: '<section><div>hello</div></section>',
      mode: 'overwrite',
    });
    const out = formatCompactToolArgs(args);
    expect(out).toContain('live-a.html');
    expect(out).not.toMatch(/div>/);
    expect(out).not.toMatch(/mode:\s*ov/);
  });

  it('残缺 JSON 截断原文, 不抛', () => {
    expect(formatCompactToolArgs('{"file_path":"/ws/a.html","contents":"<div>')).toBeTruthy();
  });

  it('explore 小对象仍是 key: value, 但不误切 HTML', () => {
    expect(formatCompactToolArgs('{"path":"README.md","mode":"structure"}'))
      .toMatch(/README\.md/);
  });
});
