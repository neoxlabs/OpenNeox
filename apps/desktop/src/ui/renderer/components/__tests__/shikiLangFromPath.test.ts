import { describe, it, expect } from 'vitest';
import { langFromPath, resolveShikiLang, SHIKI_LANGS } from '../shikiHighlighter';

describe('langFromPath', () => {
  it('按扩展名认语言', () => {
    expect(langFromPath('a/b/GitCard.tsx')).toBe('tsx');
    expect(langFromPath('a/b/commitLineDiff.ts')).toBe('typescript');
    expect(langFromPath('ide-workspace.css')).toBe('css');
    expect(langFromPath('deep/path/to/main.py')).toBe('python');
  });

  it('认得没有扩展名的特殊文件名', () => {
    expect(langFromPath('Dockerfile')).toBe('dockerfile');
    expect(langFromPath('some/dir/Makefile')).toBe('makefile');
  });

  it('认不出来就返回 undefined —— 绝不猜', () => {
    /* 猜错的代价是整份文件被按错误的语法染色, 比不染色难看得多 */
    expect(langFromPath('LICENSE')).toBeUndefined();
    expect(langFromPath('a/b/data.weirdext')).toBeUndefined();
    expect(langFromPath('')).toBeUndefined();
    expect(langFromPath('.gitignore')).toBeUndefined();
  });

  it('映射出来的语言必须在 SHIKI_LANGS 里 —— 否则运行时静默不高亮', () => {
    const loaded = SHIKI_LANGS as unknown as string[];
    for (const p of ['a.tsx', 'a.ts', 'a.css', 'a.py', 'a.go', 'a.rs', 'a.json',
                     'a.yaml', 'a.sh', 'a.sql', 'a.html', 'a.md', 'Dockerfile', 'Makefile']) {
      const lang = langFromPath(p);
      expect(lang, p).toBeDefined();
      expect(resolveShikiLang(lang, loaded), p).not.toBe('text');
    }
  });
});
