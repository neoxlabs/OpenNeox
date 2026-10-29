import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePptxLocal } from '../pptxParser';
import { isLocallyParseable } from '../index';

const FIXTURE = path.join(os.homedir(), 'AI/MK/neox-bench/pptx/季度汇报-原始.pptx');

describe('pptx 本地解析', () => {
  it('pptx 算本地可解析; .ppt 老格式不算', () => {
    expect(isLocallyParseable({ name: '汇报.pptx' } as File)).toBe(true);
    expect(isLocallyParseable({ name: '汇报.ppt' } as File)).toBe(false);
  });

  it.skipIf(!fs.existsSync(FIXTURE))('按放映顺序出标题 / 正文 (跨 run 拼好) / 表格 / 备注', async () => {
    const buf = fs.readFileSync(FIXTURE);
    const r = await parsePptxLocal(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(r.pages).toBe(3);
    expect(r.markdown).toContain('## 第 1 页 · 2026 年 Q3 经营汇报');
    expect(r.markdown).toContain('- 本季度营收 1,280 万元，同比增长 18%');
    expect(r.markdown).toContain('| 华东 | 620 | 21% |');
    expect(r.markdown).toContain('> 备注: 讲的时候强调 1,280 万元是历史新高');
  });
});
