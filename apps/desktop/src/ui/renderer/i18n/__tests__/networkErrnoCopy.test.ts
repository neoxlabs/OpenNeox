
import { describe, expect, test } from 'vitest';
import { classifyError } from '@neoxlabs/kernel/types/errors.js';
import { translateError } from '../errors';

/** 造一个 axios 形状的网络错误 (classifyError 靠 isAxiosLikeError 认它) */
function axiosErrno(code: string, message: string) {
  const e = new Error(message) as Error & { code: string; isAxiosError: boolean };
  e.code = code;
  e.isAxiosError = true;
  return e;
}

const ERRNOS: [string, string][] = [
  ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'],
  ['ENOTFOUND', 'getaddrinfo ENOTFOUND api.example.com'],
  ['ECONNRESET', 'socket hang up'],
  ['EPIPE', 'write EPIPE'],
];

describe('网络 errno → 中文文案', () => {
  test.each(ERRNOS)('%s 走完 classifyError → translateError 不是纯英文', (errno, raw) => {
    const ne = classifyError(axiosErrno(errno, raw)) as { code: string; message: string };
    const shown = translateError(ne.code, 'zh', ne.message).message;
    /* 纯 ASCII = 一个字都没翻, 直接把上游英文摊给了用户 */
    expect(shown, `${errno} 渲染成了英文原文: ${shown}`).toMatch(/[一-龥]/);
    expect(shown).not.toMatch(/^Network error:/);
  });

  test('四个同分支的 errno 谁都不许掉队 (漏一条就是 ECONNRESET 那次)', () => {
    const english = ERRNOS.filter(([errno, raw]) => {
      const ne = classifyError(axiosErrno(errno, raw)) as { code: string; message: string };
      return !/[一-龥]/.test(translateError(ne.code, 'zh', ne.message).message);
    });
    expect(english, `这些 errno 还在摊英文: ${english.map(e => e[0]).join(', ')}`).toEqual([]);
  });

  test('英文界面下仍给英文, 别把中文硬塞给 en 用户', () => {
    const ne = classifyError(axiosErrno('ECONNRESET', 'socket hang up')) as { code: string; message: string };
    expect(translateError(ne.code, 'en', ne.message).message).toMatch(/^[\x00-\x7F]+$/);
  });
});
