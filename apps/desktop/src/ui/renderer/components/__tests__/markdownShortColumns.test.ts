import { describe, expect, test } from 'vitest';
import { pickShortColumns } from '../Markdown';

describe('pickShortColumns', () => {
  test('实拍表: 前三列短值不折, 长句列吸收挤压', () => {
    const rows = [
      ['年度', '省直', '合肥市直', '其他'],
      ['2023', '183.5–231.5', '190–220', '—'],
      ['2024', '193.5–215.5', '—', '第一梯队（省直/池州/蚌埠/安庆/滁州）均线 205；第二梯队（马鞍山/宿州/合肥/亳州/芜湖）196'],
      ['2025', '133.5–229.5', '201–255.5', '新站 184–251.5；瑶海 201–220'],
    ];
    expect(pickShortColumns(rows)).toEqual([true, true, true, false]);
  });
  test('全是短列: 一列都不标 —— 没有长列吸收, 强行不折只会横滚', () => {
    expect(pickShortColumns([['85', '189.2'], ['90', '194.2']])).toEqual([false, false]);
  });
  test('汉字按 2 个显示宽算: 8 个汉字就超出', () => {
    const long = '这是一句很长很长的话';
    expect(pickShortColumns([['省直中上', long]])).toEqual([true, false]);
    expect(pickShortColumns([['低于二零二四梯队均线', long]])).toEqual([false, false]);
  });
  test('参差行 (缺格) 按空串算', () => {
    expect(pickShortColumns([['2023', 'x'.repeat(40)], ['2024']])).toEqual([true, false]);
  });
});
