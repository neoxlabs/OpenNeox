/* 预览跟随逻辑按最新页索引和状态生成签名，并在两帧布局稳定后滚动。
 * 测试检查生成的 file:// 文档脚本，因为滚动逻辑运行在该文档内部。 */
import { describe, it, expect } from 'vitest';
import { renderDeckPreviewHtml } from '../deck-preview.js';

const PRES = { slideWidth: 1280, slideHeight: 720 } as never;
const slide = (state: string) => ({ state, title: 't', layout: 'bullet-list' } as never);
const html = (states: string[]) =>
  renderDeckPreviewHtml(PRES, states.map(slide), { title: '测试 deck', styleName: 's' });

describe('deck 预览自动跟随', () => {
  it('自检: 渲染出了卡片和脚本', () => {
    const h = html(['done', 'building', 'planned']);
    expect(h).toContain('class="card is-done"');
    expect(h).toContain('<script>');
  });

  it('去重签名必须带状态 —— 只带下标会让 building→done 那一跳不再滚', () => {
    expect(html(['done', 'building'])).toMatch(/latest\s*\+\s*['"]:['"]\s*\+\s*latestState/);
  });

  it('签名要带 deck 标识 —— 第二份 deck 不能继承上一份的进度', () => {
    /* deckId 必须参与签名，避免不同 deck 复用同一份滚动进度。 */
    expect(html(['done'])).toMatch(/var sig = deckId \+/);
  });

  it('滚动必须等布局稳定 —— 解析期量到的不是终态', () => {
    const h = html(['done', 'building']);
    expect(h).toMatch(/requestAnimationFrame\([\s\S]*requestAnimationFrame/);
    expect(h).toContain('document.fonts');
  });

  it('全是 planned 时不滚 —— 还没有任何一页开始渲染', () => {
    expect(html(['planned', 'planned'])).toContain('if (latest < 0) return;');
  });
});
