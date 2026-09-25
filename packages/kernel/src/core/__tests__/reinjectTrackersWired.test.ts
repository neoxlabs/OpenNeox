/**
 * 回灌 tracker 必须同时存在生产写入方和消费方。
 *
 *   仅测试中手动填充 tracker 不足以证明生产链路可用；缺少生产写入方时回灌会静默为空。
 *
 *   新增 tracker 时同步增加生产调用方断言。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* runner 的 tool-result 收口点是这些 tracker 唯一的喂数据处 */
const RUNNER = strip(readFileSync(resolve(HERE, '../runner.ts'), 'utf8'));

const TRACKERS = [
  'trackWorkState',
  'trackToolFailure',
  'trackFileAccess',
  'trackSkillInvocation',
];

describe('压缩回灌的 tracker 都接上了生产调用方', () => {
  for (const name of TRACKERS) {
    it(`${name} 在 runner 里被真的调用过 (不只是 import / 再导出)`, () => {
      /* 要求的是**调用**形态 `name(`, 而不是出现在 import 列表里 —— 上一次
       * 正是"import 了但没调"这种形态漏过去的。 */
      const callSites = RUNNER.split('\n').filter((l) =>
        new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(l) && !l.includes('import'),
      );
      expect(callSites.length, `${name} 在 runner.ts 里没有调用点 —— 回灌会恒为空`)
        .toBeGreaterThan(0);
    });
  }

  /* 对照组: 闸本身能亮红 */
  it('闸能抓到"只 import 不调用" (自检)', () => {
    const fake = `import { trackNothing } from './x.js';\nconst a = 1;`;
    const hits = fake.split('\n').filter((l) =>
      /(?<![\w.])trackNothing\s*\(/.test(l) && !l.includes('import'),
    );
    expect(hits).toHaveLength(0);
  });
});
