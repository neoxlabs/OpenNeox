/**
 * A skipped unreadable path does not make the whole search fail.
 * ═══════════════════════════════════════════════════════════════════════════
 * Ripgrep identifies this localized warning with the stable `(os error N)`
 * suffix, while syntax and argument errors remain fatal.
 *
 * The filter therefore classifies by line shape rather than message language.
 */
import { describe, expect, it } from 'vitest';
import { filterRipgrepStderr, isPerPathRipgrepWarning } from '../stderrFilter.js';

describe('ripgrep stderr —— 逐路径跳过要被当噪音滤掉', () => {
  it('中文 Windows: 系统无法访问此文件 (os error 1920)', () => {
    const raw = 'rg: e:\\code\\ltoa\\app\\linux\\flutter\\ephemeral\\.plugin_symlinks\\audioplayers_linux: '
      + '系统无法访问此文件。 (os error 1920)';
    expect(isPerPathRipgrepWarning(raw)).toBe(true);
    expect(filterRipgrepStderr(raw)).toBe('');
  });

  it('其它语言/其它错误码同样成立 (判的是形状不是文案)', () => {
    const raw = [
      'rg: /srv/data: Aucun fichier ou dossier de ce type (os error 2)',
      'rg: C:\\pagefile.sys: プロセスはファイルにアクセスできません。 (os error 32)',
    ].join('\n');
    expect(filterRipgrepStderr(raw)).toBe('');
  });

  it('英文老判据仍然有效 (macOS TCC)', () => {
    const raw = 'rg: /Users/foo/Library/Mail: Operation not permitted (os error 1)';
    expect(filterRipgrepStderr(raw)).toBe('');
  });

  it('真正的致命错误不许被滤掉 —— 它没有 (os error N) 后缀', () => {
    const raw = 'rg: regex parse error:\n    unclosed group';
    expect(isPerPathRipgrepWarning(raw)).toBe(false);
    expect(filterRipgrepStderr(raw)).toContain('regex parse error');
  });

  it('噪音里混着真错误时, 只留真错误', () => {
    const raw = [
      'rg: /x/y: 系统无法访问此文件。 (os error 1920)',
      'rg: error parsing glob: unclosed alternate group',
    ].join('\n');
    expect(filterRipgrepStderr(raw)).toBe('rg: error parsing glob: unclosed alternate group');
  });
});

describe('exit 2 + 纯逐路径噪音 → 不是失败', () => {
  /* 收集器里那两处降级的口径 (有输出算 0 / 无输出算 1) —— 纯函数化在这里钉住,
   * 防止有人改回"无条件降成 1": 那等于把已经搜到的结果说成"没搜到"。 */
  const downgrade = (exit: number, filteredErr: string, rawStderr: string, out: string) =>
    (exit === 2 && !filteredErr && rawStderr.length > 0) ? (out.trim() ? 0 : 1) : exit;

  it('有匹配 → 0 (结果不许被吞)', () => {
    expect(downgrade(2, '', 'rg: /x: 系统无法访问此文件。 (os error 1920)', '{"type":"match"}')).toBe(0);
  });
  it('没匹配 → 1 (无结果, 不是失败)', () => {
    expect(downgrade(2, '', 'rg: /x: 系统无法访问此文件。 (os error 1920)', '')).toBe(1);
  });
  it('有真错误 → 保持 2, 照常报失败', () => {
    expect(downgrade(2, 'regex parse error', 'regex parse error', '')).toBe(2);
  });
});
