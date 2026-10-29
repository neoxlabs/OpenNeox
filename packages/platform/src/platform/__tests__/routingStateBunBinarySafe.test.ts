import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRoutingState, getRoutingState, setRoutingState } from '../routingState.js';
import { closeDatabase } from '../database.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-routingstate-bun-'));
const dbPath = path.join(tmpDir, 'routing-state.db');
const originalDbPath = process.env.NEOX_DB_PATH;

function resetDbSingleton(): void {
  closeDatabase();
  delete (globalThis as any).__NEOX_DB__;
}

beforeAll(() => {
  process.env.NEOX_DB_PATH = dbPath;
  resetDbSingleton();
});

afterAll(() => {
  resetDbSingleton();
  if (originalDbPath === undefined) delete process.env.NEOX_DB_PATH;
  else process.env.NEOX_DB_PATH = originalDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('routingState · 无 globalThis 预置时仍可读写', () => {
  it('setRoutingState / getRoutingState 不依赖 __NEOX_DB__ 预置', () => {
    expect((globalThis as any).__NEOX_DB__).toBeUndefined();

    setRoutingState({ gatewayBase: 'https://gateway.example.test/n1' });

    const state = getRoutingState();
    expect(state?.gatewayBase).toBe('https://gateway.example.test/n1');
    expect(state?.enabled).toBe(true);
    /* 库真被创建了 —— 说明拿到的不是 null 兜底 */
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('clearRoutingState 能在同一库上清除', () => {
    setRoutingState({ gatewayBase: 'https://gateway.example.test/n1' });
    clearRoutingState();
    expect(getRoutingState()).toBeNull();
  });
});

describe('routingState · 源码不许回到运行时相对 require', () => {
  const source = fs.readFileSync(new URL('../routingState.ts', import.meta.url), 'utf8');
  /* 注释里会写 "原来用 createRequire(...)" 这类说明 —— 只看代码 */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('database 走静态 import', () => {
    expect(code).toMatch(/import\s*\{\s*getDatabase\s*\}\s*from\s*'\.\/database\.js'/);
  });

  it('没有 createRequire / 相对路径 require 解析 database', () => {
    expect(code).not.toMatch(/createRequire/);
    expect(code).not.toMatch(/require\(\s*'\.\/database\.js'\s*\)/);
  });
});
