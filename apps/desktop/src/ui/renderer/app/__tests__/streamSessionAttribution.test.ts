import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '../NeoxRuntimeBridge.tsx');

/* 注释里会引用违规写法来解释历史 (本文件自己就写了好几处), 不剥掉的话闸会拦住
 * 解释自己的那段话。跟 quotaWindowsSingleSource 那道闸同一个处理。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 取出所有 window.neox.onStream(...) 回调的函数体 */
function extractOnStreamBodies(src: string): string[] {
  const bodies: string[] = [];
  let idx = 0;
  for (;;) {
    const at = src.indexOf('onStream(', idx);
    if (at < 0) break;
    /* 从回调起点向后做括号配平, 取到本回调结束 */
    let depth = 0;
    let i = src.indexOf('{', at);
    if (i < 0) break;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(src.slice(start, i + 1));
    idx = i + 1;
  }
  return bodies;
}

describe('流事件的会话归属只有一个判断处', () => {
  const raw = fs.readFileSync(BRIDGE, 'utf8');
  const src = stripComments(raw);

  it('NeoxRuntimeBridge 里确实存在 onStream 订阅 (闸本身没有空跑)', () => {
    const bodies = extractOnStreamBodies(src);
    expect(bodies.length).toBeGreaterThan(0);
    /* 这一条是防"闸失效而不自知": 哪天 onStream 改了名或搬了家, 上面那个断言会红,
     * 而不是让整道闸静默地什么都不检查 —— 那比没有闸更糟。 */
  });

  it('onStream 回调里不得直接用 activeSession 决定事件归属', () => {
    const bodies = extractOnStreamBodies(src);
    const offenders: string[] = [];

    for (const body of bodies) {
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!/activeSession/.test(t)) continue;
        /* 允许: 不是在取归属, 而是读当前会话的其它字段 (标题/模式等) */
        if (!/\bsessionId|\bsid\b/.test(t)) continue;
        offenders.push(t);
      }
    }

    expect(
      offenders,
      `以下写法用"当前打开的会话"当事件归属 —— 会把 A 的内容写进 B。\n`
      + `请改用 streamEventSessionId(data) (见 app/streamEventSession.ts):\n  `
      + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('归属 helper 不提供任何隐式兜底', () => {
    const helper = fs.readFileSync(path.resolve(HERE, '../streamEventSession.ts'), 'utf8');
    const code = stripComments(helper);
    /* 猜错归属比丢一条事件严重得多 —— helper 内部一旦回落到"某个会话",
     * 上面那道闸就形同虚设: 调用点写得再对, 归属还是猜的。 */
    expect(code).not.toMatch(/activeSession|currentSessionId/);
  });
});
