import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectShareFiles, contentTypeFor, missingR2Fields, signR2Put } from '../r2Share.js';

const cfg = { accountId: 'acct123', bucket: 'my-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', publicBaseUrl: 'https://pub.example.com' };

describe('signR2Put', () => {
  it('跟 AWS SDK 算出的签名一致 (固定时间)', () => {
    const r = signR2Put(cfg, 'neox/ab12cd34/报告 page.html', Buffer.from('<h1>hi 你好</h1>'), 'text/html; charset=utf-8', new Date('2026-09-30T07:10:00Z'));
    expect(r.url).toBe('https://acct123.r2.cloudflarestorage.com/my-bucket/neox/ab12cd34/%E6%8A%A5%E5%91%8A%20page.html');
    expect(r.headers.authorization).toContain('Credential=AKIDEXAMPLE/20260930/auto/s3/aws4_request');
    expect(r.headers.authorization).toContain('Signature=3f709c24faad8831a9bbc5d4f56f8f43e7e7d7391ed9dccf8c34ddc032d76e31');
  });
});

describe('missingR2Fields / contentTypeFor', () => {
  it('列出没填的项; 按扩展名给类型', () => {
    expect(missingR2Fields({ accountId: 'a', bucket: ' ' })).toEqual(['bucket', 'accessKeyId', 'secretAccessKey', 'publicBaseUrl']);
    expect(missingR2Fields(cfg)).toEqual([]);
    expect(contentTypeFor('a/index.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.unknown')).toBe('application/octet-stream');
  });
});

describe('collectShareFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'neox-share-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('目录: 递归, 跳过隐藏文件和 node_modules, 路径用 /', () => {
    writeFileSync(join(dir, 'index.html'), 'x');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'x');
    writeFileSync(join(dir, '.env'), 'secret');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'big.js'), 'x');
    expect(collectShareFiles(dir).map((f) => f.rel).sort()).toEqual(['assets/app.js', 'index.html']);
  });

  it('单个文件: 只传它', () => {
    writeFileSync(join(dir, 'page.html'), 'x');
    expect(collectShareFiles(join(dir, 'page.html')).map((f) => f.rel)).toEqual(['page.html']);
  });
});
