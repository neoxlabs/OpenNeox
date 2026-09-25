/**
 * `neox migrate` 的输出同时展示技能、MCP、项目指令和历史会话四类候选。
 * 每类限制可见条数并显示总数，确保用户能看到各类迁移入口而不会被单类内容
 * 占满终端。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(HERE, '../../../../../apps/cli/src/commands/migrate-cmd.ts'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('migrate 输出形状', () => {
  it('技能和会话用同一个截断上限, 不许一类刷屏', () => {
    expect(src).toMatch(/const SHOW = 8;/);
    expect(src).toMatch(/candidates\.slice\(0, SHOW\)/);
    /* 会话这块上限可以被 --sessions=N 调, 但默认仍是 8 —— 见 sessionLimit */
    expect(src).toMatch(/scan\.sessions\.slice\(0, sessionLimit\)/);
    expect(src).toMatch(/: 8;/);
  });

  it('截断后要说清还有多少 —— 不能让人以为就这么点', () => {
    expect(src).toMatch(/另有 \$\{candidates\.length - SHOW\} 个/);
    expect(src).toMatch(/另有 \$\{scan\.sessions\.length - sessionLimit\} 个/);
  });

  it('总数在标题行说清楚 —— 截断的是列表不是信息', () => {
    expect(src).toMatch(/技能  \$\{candidates\.length\} 个可见/);
  });

  /* env 默认不搬是安全默认; 跳过了必须告诉用户, 否则他不知道自己少拿了东西 */
  it('跳过 env 时必须出声, 并给出补救办法', () => {
    expect(src).toMatch(/已跳过这些 server 的 env/);
    expect(src).toMatch(/--with-env/);
  });

  /* 下半场: 会话导入做出来了, 于是这条闸从"明说没做"翻成"明说搬的是什么"。
   * 搬过来的只有对话正文 —— 图片/附件/加密思考块都不搬。用户点开导进来的会话
   * 发现图没了, 得是"我早说过"而不是"这怎么少东西"。 */
  it('会话导入要说清只搬正文, 不许让人以为图片附件也搬了', () => {
    expect(src).toMatch(/只带对话正文/);
    expect(src).toMatch(/图片、附件/);
  });

  /* API Key 这块的两条: 明文不能显示, 读不到 Key 的要给出路 */
  it('API Key 清单只显示掩码, 缺 Key 的要说清去哪补', () => {
    expect(src).toMatch(/keyPreview/);
    expect(src).not.toMatch(/p\.apiKey\s*\)\s*$/m);   /* 不许直接打印明文 */
    expect(src).toMatch(/缺 Key/);
    expect(src).toMatch(/环境变量里/);
  });
});
