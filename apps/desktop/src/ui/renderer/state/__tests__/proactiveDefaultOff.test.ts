import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = readFileSync(resolve(HERE, '../notifyStore.ts'), 'utf8');

/** 从 DEFAULT_CONFIG 块里取一个字段的字面量值。 */
function defaultField(name: string): string | undefined {
  const i = STORE.indexOf('const DEFAULT_CONFIG');
  expect(i, '找不到 DEFAULT_CONFIG').toBeGreaterThan(0);
  const block = STORE.slice(i, STORE.indexOf('};', i));
  const m = new RegExp(`\\n\\s*${name}:\\s*'?([\\w]+)'?,`).exec(block);
  return m?.[1];
}

describe('用户要求过的事默认要做', () => {
  it('完成通知默认开 —— 别顺手把这个也关了', () => {
    /* 关掉它意味着用户得盯着屏幕等一个几分钟的任务跑完。 */
    expect(defaultField('enabled')).toBe('true');
    expect(defaultField('systemNotification')).toBe('true');
  });
});
