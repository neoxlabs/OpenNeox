/* 窗口缩到最小尺寸: 不横向溢出, 关键控件仍在。 */
import { setViewport, clearViewport, overflowMetrics, visibleCount, SEL, bodyText } from '../lib/ui.mjs';
import { assert } from '../lib/assert.mjs';

export default {
  id: 'layout',
  title: '窗口最小尺寸',
  scenarios: [
    {
      id: 'layout.min-760',
      title: '缩到 760x820 不横向溢出',
      run: async ({ page }) => {
        await setViewport(page, 760, 820);
        const m = await overflowMetrics(page);
        assert(m.scroll <= m.inner + 1, `760 宽横向溢出: scroll=${m.scroll} inner=${m.inner}`);
        assert((await visibleCount(page, SEL.modeBtn)) >= 2, '窄窗下模式按钮不见了');
        await clearViewport(page);
      },
    },
    {
      id: 'layout.min-1024',
      title: '1024x700 不溢出且输入框可见',
      run: async ({ page }) => {
        await setViewport(page, 1024, 700);
        const m = await overflowMetrics(page);
        assert(m.scroll <= m.inner + 1, `1024 宽横向溢出: scroll=${m.scroll} inner=${m.inner}`);
        assert((await visibleCount(page, SEL.composer)) >= 1, '输入框不可见');
        const text = await bodyText(page);
        assert(!text.includes('Cannot read propert'), '窄窗出现报错');
        await clearViewport(page);
      },
    },
    {
      id: 'layout.restore',
      title: '恢复默认视口后仍正常',
      run: async ({ page }) => {
        await setViewport(page, 760, 820);
        await clearViewport(page);
        const m = await overflowMetrics(page);
        assert(m.inner > 0, '恢复视口后 innerWidth 异常');
        assert((await visibleCount(page, SEL.composer)) >= 1, '恢复视口后输入框不见');
      },
    },
  ],
};
