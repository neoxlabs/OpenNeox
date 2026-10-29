/**
 * Hook subprocesses receive only the environment variables required by the allowlist.
 */
import { describe, it, expect } from 'vitest';
import { hookBaseEnv } from '../userHooks.js';

describe('hookBaseEnv', () => {
  it('放行脚本跑起来必须的那些', () => {
    const env = hookBaseEnv({ PATH: '/usr/bin', HOME: '/h', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8' });
  });

  it('**密钥一律不给** —— 包括我们自己的 NEOX_* 全家', () => {
    const env = hookBaseEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-real', ANTHROPIC_API_KEY: 'sk-real', DEEPSEEK_API_KEY: 'sk-real',
      NEOX_GATEWAY_TOKEN: 't', NEOX_AUTH: 'a', AWS_SECRET_ACCESS_KEY: 's',
      GITHUB_TOKEN: 'g', HTTPS_PROXY: 'http://user:pass@proxy',
    });
    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('Windows 那几个缺了 cmd 都起不来的照样放行', () => {
    const env = hookBaseEnv({ SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe', PATHEXT: '.EXE' });
    expect(Object.keys(env).sort()).toEqual(['ComSpec', 'PATHEXT', 'SystemRoot']);
  });

  it('变量名大小写不同也认 (Windows 的 env 名大小写不敏感)', () => {
    expect(hookBaseEnv({ Path: 'C:\\bin' })).toEqual({ Path: 'C:\\bin' });
  });

  it('值是 undefined 的不带出来 (免得子进程收到 "undefined" 字符串)', () => {
    expect(hookBaseEnv({ PATH: undefined, HOME: '/h' })).toEqual({ HOME: '/h' });
  });
});
