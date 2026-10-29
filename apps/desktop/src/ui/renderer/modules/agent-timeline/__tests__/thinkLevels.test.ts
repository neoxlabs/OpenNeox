import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glazeOf, nearestStop, shownLevel, thinkLabel, thinkMode } from '../thinkLevels';

/** schemas/models/*.yaml 里 effort_map 下的全部档位 key */
function allSchemaLevels(): string[] {
  const dir = join(__dirname, '../../../../../../../../schemas/models');
  const keys = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const block = text.split(/^effort_map:\s*$/m)[1];
    if (!block) continue;
    for (const line of block.split('\n')) {
      if (/^\S/.test(line)) break;
      const m = /^ {2}([a-z_]+):/.exec(line);
      if (m) keys.add(m[1]!);
    }
  }
  return [...keys];
}

describe('思考档位 (10-21 滑杆)', () => {
  test('所有模型配置里出现的档位都有中文名, 不会出现英文混排或原样 key', () => {
    const levels = allSchemaLevels();
    expect(levels.length).toBeGreaterThan(8);
    for (const lv of levels) {
      const zh = thinkLabel(lv, ['off', lv, 'max'], true);
      expect(zh, lv).toMatch(/[一-龥]/);
    }
  });

  test('釉色: 关是素坯, 深浅递进, 极限金釉, 至臻贝母', () => {
    expect(glazeOf('off')).toBe('off');
    expect(glazeOf('fast')).toBe('off');
    expect(glazeOf('minimal')).toBe('low');
    expect(glazeOf('medium')).toBe('mid');
    expect(glazeOf('high')).toBe('high');
    expect(glazeOf('xhigh')).toBe('xhigh');
    expect(glazeOf('max')).toBe('max');
    expect(glazeOf('ultra')).toBe('ultra');
  });

  test('on 只有开/关时叫「开」, 跟深浅档一起时叫「标准」', () => {
    expect(thinkLabel('on', ['off', 'on'], true)).toBe('开');
    expect(thinkLabel('on', ['off', 'on', 'max'], true)).toBe('标准');
  });

  test('形态: 一档 = 固定; 关 + 一档 = 开关; 其余 = 滑杆 (GPT 带 max / ultra 也是滑杆)', () => {
    expect(thinkMode(['on'])).toBe('fixed');
    expect(thinkMode(['off', 'on'])).toBe('toggle');
    expect(thinkMode(['off', 'low', 'high', 'max'])).toBe('slider');
    expect(thinkMode(['off', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe('slider');
    expect(thinkMode(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).toBe('slider');
  });

  test('显示的档 = 实际发的档; 没指定或不在表里回默认档', () => {
    const lv = ['off', 'low', 'high', 'max'];
    expect(shownLevel('low', lv, 'high')).toBe('low');          // Work 默认发 low, 按钮也写低
    expect(shownLevel('standard', lv, 'high')).toBe('high');
    expect(shownLevel('xhigh', lv, 'high')).toBe('high');       // 换了模型, 旧档不在表里
    expect(shownLevel(undefined, ['off', 'on'], 'medium')).toBe('on');
  });

  test('拖动吸到最近一档', () => {
    expect(nearestStop(0, 4)).toBe(0);
    expect(nearestStop(0.4, 4)).toBe(1);
    expect(nearestStop(0.9, 4)).toBe(3);
    expect(nearestStop(1.5, 4)).toBe(3);
    expect(nearestStop(-1, 4)).toBe(0);
  });
});
