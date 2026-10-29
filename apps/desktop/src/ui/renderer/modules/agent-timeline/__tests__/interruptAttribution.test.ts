import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = (rel: string) => readFileSync(path.join(HERE, '..', rel), 'utf-8');

/** 闸必须排掉**注释**: 解释"为什么不许写这句"的注释里天然含有那句话,
 *  不剥注释的话这条断言会被自己的说明文字绊倒 (第一版就是这么挂的)。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DOCK = stripComments(R('TurnAnomalyDock.tsx'));
const HANDLER = readFileSync(
  path.join(HERE, '..', '..', '..', 'pages', 'workspace', 'hooks', 'useStreamHandler.ts'),
  'utf-8',
);
const FORWARDER = readFileSync(
  path.join(HERE, '..', '..', '..', '..', 'electron', 'services', 'runtimeEventForwarder.ts'),
  'utf-8',
);

describe('中断归因', () => {
  it('⭐️ 异常区不许再写死「由你中断」', () => {
    expect(DOCK).not.toContain('本轮由你中断');
    expect(DOCK).not.toContain('you interrupted this turn');
  });

  it('异常区的文案来自条目自己 (title + detail)', () => {
    expect(DOCK).toContain('entry.detail');
  });

  it('⭐️ 写 notice 时必须先问"是不是用户真按了停止"', () => {
    const noticeAt = HANDLER.indexOf('timeline-interrupted-${stopAnchorId}');
    expect(noticeAt).toBeGreaterThan(-1);
    /* 这个判据必须出现在写 notice 之前的那一段里 */
    const before = HANDLER.slice(Math.max(0, noticeAt - 3000), noticeAt);
    expect(before).toContain('wasRecentlyStoppedByUser(sessionId)');
  });

  it('不是用户停的就如实说原因, 不许套用户那句', () => {
    expect(HANDLER).toContain('stoppedByUserNow');
    expect(HANDLER).toContain('interruptReason');
    /* 用户那句只能挂在 stoppedByUserNow 为真的分支上 */
    expect(HANDLER).toContain("stoppedByUserNow\n            ? bi('本轮已由用户中断'");
  });

  it('⭐️ 主进程白名单要把 interruptReason 带过去 (漏一跳静默丢字段)', () => {
    const at = FORWARDER.indexOf("type: 'run_result'");
    expect(at).toBeGreaterThan(-1);
    const block = FORWARDER.slice(at, at + 1200);
    expect(block).toContain('interruptReason');
  });
});
