/**
 * CLI-11: 非 TTY 下的纯文本输出 —— 口径函数。
 * 真正「跑一遍 CLI 看 stdout 里有没有转义符」的端到端用例在
 * apps/cli/src/__tests__/e2e/print-plain-output.test.ts。
 */
import { describe, it, expect, afterEach } from 'vitest';
import chalk from 'chalk';
import {
  forcePlainColors,
  isPlainOutput,
  resolveOutputFormat,
  stripAnsi,
  toPlainText,
} from '../bootstrap/plainOutput.js';

describe('plainOutput · resolveOutputFormat', () => {
  it('认得 text / plain / json', () => {
    expect(resolveOutputFormat('text')).toBe('text');
    expect(resolveOutputFormat('TEXT')).toBe('text');
    expect(resolveOutputFormat('plain')).toBe('text');
    expect(resolveOutputFormat('json')).toBe('json');
  });

  it('不认识的值返回 undefined (由调用方给提示, 不静默改口径)', () => {
    expect(resolveOutputFormat('yaml')).toBeUndefined();
    expect(resolveOutputFormat(undefined)).toBeUndefined();
    expect(resolveOutputFormat('')).toBeUndefined();
  });
});

describe('plainOutput · isPlainOutput', () => {
  it('显式 text / json 一律纯文本 (哪怕 stdout 是 TTY)', () => {
    expect(isPlainOutput('text', true)).toBe(true);
    expect(isPlainOutput('json', true)).toBe(true);
  });

  it('没给格式时按 stdout 是否 TTY: 管道 / 重定向 / CI 走纯文本', () => {
    expect(isPlainOutput(undefined, false)).toBe(true);
    expect(isPlainOutput(undefined, true)).toBe(false);
  });
});

describe('plainOutput · stripAnsi / toPlainText', () => {
  it('去掉颜色码, 正文照旧', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m ok')).toBe('red ok');
    expect(stripAnsi('\u001b[1;32mbold green\u001b[39m')).toBe('bold green');
  });

  it('去掉光标移动 / 清屏 / 备用屏这类 TUI 控件', () => {
    expect(stripAnsi('\u001b[2J\u001b[Hhello')).toBe('hello');
    expect(stripAnsi('\u001b[?1049h alt \u001b[?1049l')).toBe(' alt ');
  });

  it('去掉 OSC (窗口标题等)', () => {
    expect(stripAnsi('\u001b]0;title\u0007body')).toBe('body');
  });

  it('toPlainText 保留换行与制表符, 去掉其余控制字符', () => {
    const out = toPlainText('a\tb\nc\u0007d\u001b[31me\u001b[0m');
    expect(out).toBe('a\tb\ncde');
  });
});

describe('plainOutput · forcePlainColors', () => {
  const original = chalk.level;
  afterEach(() => { chalk.level = original; });

  it('把 chalk 关到 0 并钉住 FORCE_COLOR (CI 镜像常设 FORCE_COLOR=1)', () => {
    process.env.FORCE_COLOR = '1';
    forcePlainColors();
    expect(chalk.level).toBe(0);
    expect(process.env.FORCE_COLOR).toBe('0');
  });
});
