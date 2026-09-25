/**
 * readfile 读 .svg 给文本, 不走图片通道。
 *
 *   原来 svg 在 IMAGE_EXTENSIONS 里, readfile 把它以 image/svg+xml 的图片协议返回,
 *   发给模型时各家上游只收 png/jpeg/gif/webp → 400 "unsupported image", 整轮失败。
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createSmartReadTools } from '../tools.js';
import { IMAGE_RESULT_PREFIX } from '../../image/imageProcessor.js';

describe('readfile 读 svg', () => {
  it('返回 XML 正文, 不是图片协议', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-read-svg-'));
    try {
      const file = path.join(dir, 'pelican.svg');
      await fs.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <circle cx="5" cy="5" r="4" fill="#f00"/>\n</svg>\n', 'utf8');
      const tool = createSmartReadTools(dir).find(t => t.name === 'readfile');
      if (!tool) throw new Error('readfile tool not found');
      const out = await tool.function({ path: file } as any, {} as any) as string;
      expect(out.startsWith(IMAGE_RESULT_PREFIX)).toBe(false);
      expect(out).toContain('<circle cx="5" cy="5" r="4" fill="#f00"/>');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
