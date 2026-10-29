import { describe, expect, it } from 'vitest';
import { briefErrorDetail, classifyPreviewError, previewErrorCopy } from '../previewError';

describe('classifyPreviewError', () => {
  it('识别文件过大', () => {
    expect(classifyPreviewError('文件过大: 9000000 > 8388608 bytes')).toBe('too-large');
    expect(classifyPreviewError('File too large: 9000000 > 8388608 bytes')).toBe('too-large');
  });

  it('识别文件不存在', () => {
    expect(classifyPreviewError("ENOENT: no such file or directory, open '/tmp/x.docx'")).toBe('missing');
  });

  it('识别权限拒绝', () => {
    expect(classifyPreviewError('access denied: outside workspace')).toBe('denied');
    expect(classifyPreviewError('EACCES: permission denied')).toBe('denied');
  });

  it('识别桥接不可用', () => {
    expect(classifyPreviewError('surfaceReadFile bridge 不可用')).toBe('bridge');
    expect(classifyPreviewError('surfaceReadFile bridge unavailable')).toBe('bridge');
  });

  it('识别格式不支持与损坏', () => {
    expect(classifyPreviewError('docx surface 仅支持 file 或 inline source')).toBe('unsupported');
    expect(classifyPreviewError('Not a valid .docx file: no OOXML/Zip structure detected.')).toBe('corrupt');
    expect(classifyPreviewError('Corrupted zip: missing central directory')).toBe('corrupt');
  });

  it('认不出来归为 unknown', () => {
    expect(classifyPreviewError('')).toBe('unknown');
    expect(classifyPreviewError(null)).toBe('unknown');
    expect(classifyPreviewError('something exploded')).toBe('unknown');
  });

  it('给中英文人话文案', () => {
    expect(previewErrorCopy('ENOENT: no such file', true).title).toBe('这个文件已经不在了');
    expect(previewErrorCopy('ENOENT: no such file', false).title).toBe('This file is gone');
    expect(previewErrorCopy('File too large: 9MB', true).kind).toBe('too-large');
  });
});

describe('briefErrorDetail', () => {
  it('压平空白并截断', () => {
    expect(briefErrorDetail('a\n\n  b\tc')).toBe('a b c');
    const long = 'x'.repeat(500);
    const brief = briefErrorDetail(long, 40);
    expect(brief.length).toBe(40);
    expect(brief.endsWith('…')).toBe(true);
  });
});
