import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPptx } from '../../lib/pptx.mjs';
import { assert, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

const REQUIRED = ['Q3 复盘', '关键指标', '问题与原因', '改进项', '下一步'];
const normalize = (text) => String(text).replace(/\s+/g, '').replace(/[|｜·—–-]+/g, '');

runCheck(async () => {
  const workdir = workdirFromArgv();
  const file = path.join(workdir, 'out/review.pptx');
  assert(fs.existsSync(file), '没有生成 out/review.pptx');

  const { slides } = readPptx(file);
  assert(slides.length === 5, `应该正好 5 页, 实际 ${slides.length} 页`);

  for (const slide of slides) {
    assert(slide.text.trim().length > 0, `第 ${slide.index} 页是空页`);
  }

  const used = new Set();
  for (const title of REQUIRED) {
    const index = slides.findIndex((slide, i) => {
      if (used.has(i)) return false;
      const candidates = [slide.title, ...slide.texts].map(normalize);
      return candidates.some((text) => text.includes(normalize(title)));
    });
    assert(index >= 0, `找不到标题「${title}」（现有标题: ${slides.map((s) => s.title).join(' / ')}）`);
    used.add(index);
  }
});
