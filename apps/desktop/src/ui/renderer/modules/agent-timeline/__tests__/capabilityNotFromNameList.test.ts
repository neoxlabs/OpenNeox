import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'TimelineComposer.tsx');

describe('详情卡的能力判定不靠模型名白名单', () => {
  const src = readFileSync(SRC, 'utf8');
  /* 只看 ModelInfoCard 这一段, 别的地方(如 provider 侧回落)暂不管 */
  const start = src.indexOf('const ModelInfoCard');
  const end = src.indexOf('\nconst ', start + 10);
  const card = src.slice(start, end > start ? end : undefined);

  it('ModelInfoCard 存在且被切出来了', () => {
    expect(start).toBeGreaterThan(-1);
    expect(card.length).toBeGreaterThan(200);
  });

  it('不调用 isThinkingSupported (名字白名单)', () => {
    /* 断言**调用形式**而不是标识符 —— 上面那段注释里就写着这个名字(说明为什么不用它),
     * 按裸标识符匹配会把自己的文档判成违规. 第一版就是这么误报的. */
    expect(
      /isThinkingSupported\s*\(/.test(card),
      'ModelInfoCard 又用回了 isThinkingSupported —— 它是停在 opus-4.6 的硬编码白名单, ' +
        'OpenAI 系根本没进去, 每上一个新模型就默默错一次且不报错.',
    ).toBe(false);
  });

  it('改用 schema 档位数据判定', () => {
    const usesSchema = card.includes('hasEffortMap') || card.includes('effectiveLevels');
    expect(
      usesSchema,
      '思考能力必须由 schema 的 effort_map / 档位数推出 —— 那是档位面板的同一个数据源, ' +
        '新模型接进来自带, 不需要有人记得回来加一行白名单.',
    ).toBe(true);
  });
});
