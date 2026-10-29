import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPageTool, describeWidth, normalizeSteps, resolveTarget } from '../checkPageTool';
import { findChromeExecutable } from '../../../runtime/browser/chromeLauncher';
import { parseImageResultImages, IMAGE_RESULT_PREFIX } from '../../image/imageProcessor';

describe('check_page', () => {
  test('一行人话报告', () => {
    expect(describeWidth({ width: 390, overflowPx: 0, offenders: [], tinyText: 0 })).toBe('390px: 无横向溢出');
    expect(describeWidth({ width: 390, overflowPx: 210, offenders: ['div.grid 右边到 600px'], tinyText: 3 }))
      .toBe('390px: 横向溢出 210px; 超出右边界: div.grid 右边到 600px; 3 处文字小于 12px');
  });

  test('目标: URL 原样, 相对路径按工作区拼, 不存在报错', () => {
    expect(resolveTarget('http://localhost:5173/', '/w')).toEqual({ url: 'http://localhost:5173/', label: 'http://localhost:5173/' });
    expect('error' in resolveTarget('nope.html', '/definitely/not/here')).toBe(true);
    expect('error' in resolveTarget('', '/w')).toBe(true);
  });

  test.skipIf(!findChromeExecutable())('真跑一遍: 手机宽度量出溢出和超界元素, 每个宽度一张图', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-page-'));
    const file = path.join(dir, 'p.html');
    fs.writeFileSync(file, `<!doctype html><title>选座</title><body style="margin:0">
      <div class="grid" style="width:600px;height:50px;background:#2e6b4f">座位</div>
      <script>console.error('boom')</script></body>`);
    const raw = await checkPageTool.function({ target: file, widths: [1024, 390], wait_ms: 0 });
    expect(raw.startsWith(IMAGE_RESULT_PREFIX)).toBe(true);
    expect(parseImageResultImages(raw)?.map((i) => i.label)).toEqual(['1024px', '390px']);
    const text = JSON.parse(raw.slice(IMAGE_RESULT_PREFIX.length)).text as string;
    expect(text).toContain('1024px: 无横向溢出');
    expect(text).toMatch(/390px: 横向溢出 210px; 超出右边界: div\.grid/);
    expect(text).toContain('console: boom');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('steps 合成: 旧 click 在前, 最多 20 步', () => {
    expect(normalizeSteps({ click: ['#a'], steps: [{ type: '#n', text: '张三' }] })).toEqual([{ click: '#a' }, { type: '#n', text: '张三' }]);
    expect(normalizeSteps({ steps: Array.from({ length: 30 }, () => ({ wait: 1 })) })).toHaveLength(20);
  });

  test.skipIf(!findChromeExecutable())('打字 + 深浅色 + eval; 第二次复用常驻浏览器', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-page-'));
    const file = path.join(dir, 'f.html');
    fs.writeFileSync(file, `<!doctype html><style>body{background:#fff}@media (prefers-color-scheme:dark){body{background:#000}}</style>
      <input id="n"><button id="go" onclick="document.getElementById('out').textContent='你好 '+document.getElementById('n').value">提交</button><p id="out"></p>`);
    const args = { target: file, widths: [800], color_scheme: 'both' as const, wait_ms: 0,
      steps: [{ type: '#n', text: '张三' }, { click: '#go' }],
      eval: `[document.getElementById('out').textContent, getComputedStyle(document.body).backgroundColor]` };
    const raw = await checkPageTool.function(args);
    const parsed = JSON.parse(raw.slice(IMAGE_RESULT_PREFIX.length));
    expect(parsed.images.map((i: any) => i.label)).toEqual(['800px 浅色', '800px 深色']);
    expect(parsed.text).toContain('eval: ["你好 张三"');
    const t = Date.now();
    await checkPageTool.function({ target: file, widths: [800], wait_ms: 0 });
    expect(Date.now() - t).toBeLessThan(3000);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
