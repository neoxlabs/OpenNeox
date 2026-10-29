import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { probeCommand, parseProbeOutput } from '../fixUserShellPath';

/* 07-21 ~ 10-26: 探测命令把 N 条 printf 用空格拼成了一条, 输出段数不对, 解析恒为 null ——
 * PATH / 代理从未继承, 缓存也写不进。用真 shell 跑一遍, 段数必须对得上。 */
describe.skipIf(process.platform === 'win32')('probeCommand', () => {
  it('真 shell 跑出来的每个变量各占一段', () => {
    const out = execSync(probeCommand('/bin/sh'), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LANG: 'xx_TEST.UTF-8' },
    });
    const map = parseProbeOutput(out);
    expect(map).not.toBeNull();
    expect(map!.PATH).toContain('/');
    expect(map!.LANG).toBe('xx_TEST.UTF-8');
  });
});
