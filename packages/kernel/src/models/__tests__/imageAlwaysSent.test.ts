/** 图片请求始终保留图片内容，由上游按实际模型能力返回结果或错误。 */
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
/* 扫源码前先剥注释 —— 上面这段说明和被测文件的注释里都逐字引着这些函数名 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string) => strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const OPENAI = read('models/openai.ts');
const RUNNER = read('core/runner.ts');
const GUARD = read('utils/imageHistoryGuard.ts');

describe('图片一律发给上游', () => {
  test('provider 层不再因为"模型不支持"抛错', () => {
    expect(OPENAI).not.toMatch(/assertImageCompat/);
    expect(OPENAI).toMatch(/private noteImageCompat/);
    /* 关键: noteImageCompat 里不许有 throw —— 它只记日志 */
    const i = OPENAI.indexOf('private noteImageCompat');
    const body = OPENAI.slice(i, OPENAI.indexOf('\n  }', i));
    expect(body).not.toMatch(/throw/);
  });

  test('两个入口(chat / chatStreamed)仍然都调它 —— 日志线索不能丢', () => {
    expect(OPENAI.match(/this\.noteImageCompat\(messages, model\)/g)?.length).toBe(2);
  });

  test('runner 不再按能力表剥图', () => {
    expect(RUNNER).not.toMatch(/stripImagesForUnsupportedModel/);
    /* stripStaleImages 必须留着 —— 那管的是历史大图不重传, 是另一件事 */
    expect(RUNNER).toMatch(/stripStaleImages\(/);
  });

  test('剥图函数本身已删除, 防止别处再引', () => {
    expect(GUARD).not.toMatch(/export function stripImagesForUnsupportedModel/);
    expect(GUARD).toMatch(/export function stripStaleImages/);
  });
});
