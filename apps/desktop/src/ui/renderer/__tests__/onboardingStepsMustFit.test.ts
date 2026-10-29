import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  resolve(HERE, '../styles/editor-core/onboarding/migrate-step.css'),
  'utf8',
);

describe('引导页 migrate 屏必须装得下', () => {
  it('祖先链被钳住 —— 只钳这一屏, 不动其余四屏', () => {
    expect(css).toMatch(/\.onboarding-page:has\(\.migrate-step\)/);
    for (const layer of ['.onboarding-content', '.step-container']) {
      expect(css, `${layer} 没被钳住`).toContain(layer);
    }
  });

  it('链上每一层都写了 min-height: 0 —— 少一层 overflow 就不生效', () => {
    const clamp = css.slice(css.indexOf('.onboarding-page:has(.migrate-step)'));
    expect(clamp).toMatch(/min-height:\s*0/);
    expect(clamp).toMatch(/max-height:\s*100%/);
    expect(clamp).toMatch(/overflow:\s*hidden/);
  });

  it('列表区自己滚, 动作栏不参与滚动 —— 按钮必须永远在屏内', () => {
    expect(css).toMatch(/\.migrate-step \.migrate-groups \{[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.migrate-step \.step-actions\.migrate-actions[\s\S]*?flex:\s*none/);
  });

  it('组内不再套第二层滚动条 —— 双层滚动没人预期得了', () => {
    /* 外层统一滚之后, .migrate-list 必须放开限高 */
    const list = css.slice(css.lastIndexOf('.migrate-step .migrate-list'));
    expect(list).toMatch(/max-height:\s*none/);
    expect(list).toMatch(/overflow-y:\s*visible/);
  });
});
