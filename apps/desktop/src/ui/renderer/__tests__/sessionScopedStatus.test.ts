import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SRC = strip(readFileSync(
  resolve(HERE, '../pages/workspace/hooks/useStreamHandler.ts'), 'utf8'));

describe('dispatchStatus 必须带会话归属', () => {
  it('没有一处 dispatchStatus 是只传文案的', () => {
    const bare: string[] = [];
    const lines = SRC.split('\n');
    lines.forEach((line, i) => {
      const at = line.indexOf('dispatchStatus(');
      if (at < 0) return;
      /* 从调用点往后拼几行 —— 有些调用是跨行的 (三元表达式的文案)。
       * 只要这段里出现第二个实参 (sessionId / sid / event.sessionId) 就算合格。 */
      const chunk = lines.slice(i, i + 5).join(' ');
      if (/dispatchStatus\([\s\S]*?(sessionId|\bsid\b)/.test(chunk)) return;
      bare.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
    });
    expect(bare, `这些 dispatchStatus 没传 sessionId, 会兜底写到"用户当前正在看的会话"上:\n  ${bare.join('\n  ')}`)
      .toEqual([]);
  });

  it('团队事件不许兜底到当前会话', () => {
    const start = SRC.indexOf("event.type === 'team_run_start'");
    expect(start, '找不到 team_run 分支').toBeGreaterThan(0);
    const block = SRC.slice(start, start + 600);
    expect(block).not.toMatch(/\|\|\s*activeSessionIdRef\.current/);
  });

  /* 对照组: 闸能亮红 */
  it('闸能抓到裸调用 (自检)', () => {
    const probe = (src: string) => {
      const lines = src.split('\n');
      return lines.filter((line, i) => {
        if (!line.includes('dispatchStatus(')) return false;
        return !/dispatchStatus\([\s\S]*?(sessionId|\bsid\b)/.test(lines.slice(i, i + 5).join(' '));
      });
    };
    expect(probe(`  dispatchStatus('Ready');`)).toHaveLength(1);
    expect(probe(`  dispatchStatus('Ready', sessionId);`)).toHaveLength(0);
    expect(probe(`  dispatchStatus(msg, event.sessionId);`)).toHaveLength(0);
  });
});
