import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanForMissingModules, parseArgs, collectLogTexts } from '../check-cli-binary-smoke.mjs';

test('抓到 bunfs 里相对路径 require 的报错', () => {
  const hits = scanForMissingModules([
    {
      source: '-p',
      text: "WARN [ROUTING] getDb() failed: Cannot find module './database.js' from '/$bunfs/root/neox'",
    },
  ]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].line, /Cannot find module/);
});

test('抓到 Cannot find package 与 dynamic require 退化', () => {
  const hits = scanForMissingModules([
    { source: 'logs/a.log', text: "error: Cannot find package '@neoxlabs/native'" },
    { source: 'logs/b.log', text: 'Dynamic require of "foo" is not supported' },
  ]);
  assert.equal(hits.length, 2);
});

test('正常日志不误报', () => {
  const hits = scanForMissingModules([
    { source: '-p', text: 'neox 3.5.2\n未登录, 请运行 neox login\n' },
    { source: 'logs/x.log', text: 'INFO [ROUTING] state saved to DB\n' },
    { source: 'empty', text: '' },
  ]);
  assert.deepEqual(hits, []);
});

test('参数支持 --k v 与 --k=v 两种写法', () => {
  assert.deepEqual(parseArgs(['--bin', '/tmp/neox', '--prompt', 'hi']), {
    bin: '/tmp/neox',
    home: undefined,
    prompt: 'hi',
    keepHome: false,
  });
  const eq = parseArgs(['--bin=/tmp/neox', '--home=/tmp/h', '--keep-home']);
  assert.equal(eq.bin, '/tmp/neox');
  assert.equal(eq.home, '/tmp/h');
  assert.equal(eq.keepHome, true);
});

test('日志收集覆盖 ~/.neox 与 worktree 的 ~/.neox-* 家目录', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-smoke-home-'));
  try {
    fs.mkdirSync(path.join(home, '.neox', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, '.neox', 'logs', 'cli.log'), 'Cannot find module x');
    fs.mkdirSync(path.join(home, '.neox-w-abc', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, '.neox-w-abc', 'logs', 'cli.log'), 'ok');
    fs.mkdirSync(path.join(home, 'other', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'other', 'logs', 'cli.log'), 'ignore me');

    const texts = collectLogTexts(home);
    assert.equal(texts.length, 2);
    assert.ok(texts.some((t) => t.source.includes('.neox-w-abc')));
    assert.ok(!texts.some((t) => t.source.includes('other')));
    assert.equal(scanForMissingModules(texts).length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
