import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(resolve(HERE, '../main.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('NEOX_OPEN_WORKSPACE', () => {
  it('createWindow 里读这个 env', () => {
    expect(main).toMatch(/process\.env\.NEOX_OPEN_WORKSPACE/);
  });

  it('走的是现成的 openWindowWithWorkspace, 不另造一套开窗路径', () => {
    expect(main).toMatch(/if \(requested\)[\s\S]{0,300}openWindowWithWorkspace\(requested\)/);
  });

  it('必须先校验是目录 —— 不能拿一个文件/不存在的路径去开', () => {
    expect(main).toMatch(/statSync\(requested\)\.isDirectory\(\)/);
  });

  /* 打错一个路径不该让 app 卡在启动阶段 —— 回落正常启动, 并留一行日志 */
  it('目录不合法要回落正常启动, 且出声', () => {
    expect(main).toMatch(/console\.warn\([^)]*NEOX_OPEN_WORKSPACE/);
    expect(main).toMatch(/await createMainWindow\(\{ isDev, dirname: __dirname \}\)/);
  });
});
