import { describe, it, expect } from 'vitest';
import { isTempPath } from '../ProjectPicker';

describe('isTempPath', () => {
  it.each([
    '/tmp/foo',
    '/private/tmp/claude-501/x/scratchpad/run',
    '/var/folders/ab/xyz/T/neox-test',
    '/private/var/folders/ab/xyz/T/neox-test',
    'C:\\Users\\me\\AppData\\Local\\Temp\\neox-1',
  ])('%s 是临时目录', (p) => {
    expect(isTempPath(p)).toBe(true);
  });

  it.each([
    '/Users/me/AI/OpenNeox',
    '/Users/me/Documents/Neox/工作',
    '/Users/me/projects/tmp-tools',
    '/home/me/temp/notes',
    'D:\\code\\Temp\\app',
  ])('%s 是真项目', (p) => {
    expect(isTempPath(p)).toBe(false);
  });
});
